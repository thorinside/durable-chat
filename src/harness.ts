import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import type { MutableModels, Provider } from "@earendil-works/pi-ai/models";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";
import type { Conversation, Extension, ModelRef } from "@earendil-works/pi-durable";
import { createRepositoryInstructions } from "./agent-instructions.ts";
import { jobEnvironment } from "./workspaces.ts";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { resolveConfig, parseThinkingLevel, type ProviderEntry, type ResolvedConfig } from "./config.ts";
import { PiAuthStore } from "./auth.ts";
import { createFauxResponder } from "./faux.ts";
import { applyStartupJobModel, applyThinkingLevel, MAIN_INSTRUCTIONS, type JobCreateOptions } from "./jobs.ts";
import { connectMcp, type McpSetup } from "./mcp.ts";
import { createTaskExtension } from "./tool.ts";
import { openCodemode, type CodemodeSetup } from "./codemode.ts";
import { supportsImages as modelSupportsImages } from "./images.ts";
import { ReminderTools } from "./reminders.ts";
import { JobTask } from "./tasks.ts";
import { JobHandoffTools } from "./handoff.ts";
import { installRollbackSnapshot, rollbackSource } from "./rollback.ts";
import { defaultModelId, modelChoices, selectModel, type ModelChoice, type ModelChoices } from "./models.ts";
import { RebootArchive, rebootClosedStore } from "./reboot.ts";

type FauxResponder = ReturnType<typeof createFauxResponder>;

type ProviderSetup = {
	models: MutableModels;
	model: ModelRef;
	label: string;
	faux?: { ensure(): void };
};

/** Register a built-in under its configured name, including the models used for request dispatch. */
function registerProvider(models: MutableModels, provider: Provider, name: string, config: ResolvedConfig): void {
	models.setProvider(name === provider.id ? provider : {
		...provider,
		id: name,
		getModels: () => provider.getModels().map((model) => ({ ...model, provider: name })),
		getAllModels: () => (provider.getAllModels?.() ?? provider.getModels()).map((model) => ({ ...model, provider: name })),
	});
	// Pre-named-provider checkpoints can still poll the original provider. Explicit entries win.
	if (name !== provider.id && !config.providers.some((entry) => entry.name === provider.id)) models.setProvider(provider);
}

/** Every configured entry is registered on one catalog, so `/model` can list across providers. */
export function setupProviders(config: ResolvedConfig): ProviderSetup {
	const authenticated = config.providers.filter((entry) => entry.kind === "openai-codex" || entry.kind === "openai");
	const models = createModels({
		...(authenticated.length === 0 ? {} : {
			credentials: new PiAuthStore(undefined, new Map(authenticated.map((entry) => [entry.name, entry.kind]))),
		}),
	});
	// Each faux entry gets its own offline instance, so a switch to another entry still reaches
	// a scripted responder and lists its configured model.
	const responders = new Map<string, FauxResponder>();
	for (const entry of config.providers) {
		if (entry.kind === "openai-codex") {
			const provider = openaiCodexProvider();
			registerProvider(models, provider, entry.name, config);
			if (models.getModel(entry.name, defaultModelId(entry)) === undefined) {
				throw new Error(`The OpenAI Codex catalog does not list model "${entry.model}".`);
			}
			continue;
		}
		if (entry.kind === "faux") {
			// A faux entry names its own model, so the listed model is the configured one.
			const offline = fauxProvider({ provider: entry.name, tokensPerSecond: 60, ...(entry.model === undefined ? {} : { models: [{ id: entry.model, contextWindow: entry.contextWindow, maxTokens: entry.maxTokens }] }) });
			models.setProvider(offline.provider);
			responders.set(entry.name, createFauxResponder(offline));
			continue;
		}
		if (entry.kind === "openai") {
			const provider = openaiProvider();
			registerProvider(models, provider, entry.name, config);
			if (models.getModel(entry.name, defaultModelId(entry)) === undefined) {
				throw new Error(`The OpenAI catalog does not list model "${entry.model}".`);
			}
			continue;
		}
		const apiKey = entry.apiKey ?? "local-no-auth";
		const localModel: Model<"openai-completions"> = {
			id: defaultModelId(entry),
			name: defaultModelId(entry),
			api: "openai-completions",
			provider: entry.name,
			baseUrl: entry.baseUrl!,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: entry.contextWindow,
			maxTokens: entry.maxTokens,
			compat: {
				// llama.cpp and vLLM servers commonly reject the OpenAI `developer` role.
				supportsDeveloperRole: false,
				thinkingFormat: "chat-template",
				chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } },
			},
		};
		models.setProvider(createProvider({
			id: entry.name,
			name: `Local OpenAI-compatible (${entry.name})`,
			baseUrl: entry.baseUrl!,
			auth: { apiKey: { name: "Local API key", resolve: async () => ({ auth: { apiKey } }) } },
			models: [localModel],
			api: openAICompletionsApi(),
		}));
	}
	const active = config.active;
	return {
		models,
		model: { provider: active.name, modelId: defaultModelId(active) },
		label: `${active.name}/${defaultModelId(active)}${active.kind === "faux" ? " (offline)" : ""}`,
		...(responders.get(active.name) === undefined ? {} : { faux: responders.get(active.name) }),
	};
}

export class StoreInUseError extends Error {
	readonly storePath: string;
	readonly pid: number;

	constructor(storePath: string, pid: number) {
		super(`The store ${storePath} is already open by pid ${pid}. One process owns it.`);
		this.name = "StoreInUseError";
		this.storePath = storePath;
		this.pid = pid;
	}
}

/** One process owns a store; a stale lock from a dead pid is reclaimed. */
export function acquireStoreLock(storePath: string): () => void {
	const lockPath = `${storePath}.lock`;
	mkdirSync(dirname(storePath), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(lockPath, "wx");
			writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
			closeSync(fd);
			return () => {
				try {
					unlinkSync(lockPath);
				} catch {
					// Already gone.
				}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let pid: number | undefined;
			try {
				pid = (JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number }).pid;
			} catch {
				pid = undefined;
			}
			if (pid !== undefined && isAlive(pid)) {
				throw new StoreInUseError(storePath, pid);
			}
			try {
				unlinkSync(lockPath);
			} catch {
				// Another opener removed it.
			}
		}
	}
	throw new Error(`Could not lock the store ${storePath}.`);
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export type ModelSwitchResult = { runtime: AppRuntime; error?: string };

export type AppRuntime = {
	harness: Harness;
	root: Conversation;
	context: Context;
	config: ResolvedConfig;
	storePath: string;
	model: ModelRef;
	modelLabel: string;
	thinkingLevel: ModelThinkingLevel;
	cwd: string;
	mcpNotes: string[];
	mcpAttempted: boolean;
	mcpConnected: boolean;
	tasksExtension: Extension;
	jobExtensions: Extension[];
	codemodeExtension?: Extension;
	faux?: { ensure(): void };
	previousStateArchive?: string;
	restoredFrom?: string;
	listModels(signal?: AbortSignal): Promise<ModelChoices>;
	switchModel(input: string): Promise<ModelSwitchResult>;
	switchProvider(name: string): Promise<ModelSwitchResult>;
	setThinkingLevel(level: string): Promise<ModelThinkingLevel>;
	supportsImages(): boolean;
	rollback(sourcePath: string): Promise<AppRuntime>;
	reboot(): Promise<AppRuntime>;
	close(): Promise<void>;
};

export async function openRuntime(options: {
	storePath?: string;
	provider?: string;
	model?: string;
	configPath?: string;
	verbose?: boolean;
	withMcp?: boolean;
}): Promise<AppRuntime> {
	const config = resolveConfig({
		...(options.storePath === undefined ? {} : { store: options.storePath }),
		...(options.provider === undefined ? {} : { provider: options.provider }),
		...(options.model === undefined ? {} : { model: options.model }),
		...(options.configPath === undefined ? {} : { configPath: options.configPath }),
	});
	return openConfiguredRuntime(config, {
		cwd: process.cwd(), withMcp: options.withMcp ?? config.mcp.enabled, verbose: options.verbose === true,
		modelLimits: { contextWindow: config.contextWindow, maxTokens: config.maxTokens },
	}, acquireStoreLock(resolve(config.storePath)));
}

/** Reboots retain the startup configuration and transfer the still-held store lock to the new runtime. */
async function openConfiguredRuntime(
	config: ResolvedConfig,
	options: { cwd: string; withMcp: boolean; verbose: boolean; modelLimits: { contextWindow: number; maxTokens: number } },
	releaseLock: () => void,
	releaseOnFailure = true,
	archivePath?: string,
	restoredFrom?: string,
): Promise<AppRuntime> {
	const storePath = resolve(config.storePath);
	const { cwd, withMcp } = options;
	const context = BACKGROUND_CONTEXT;
	let mcp: McpSetup | undefined;
	let codemode: CodemodeSetup | undefined;
	let harness: Harness | undefined;
	let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined;
	try {
		const setup = setupProviders(config);
		const mcpSetup = withMcp
			? await connectMcp({
				...(config.mcp.configPath === undefined ? {} : { configPath: config.mcp.configPath }),
				servers: config.mcp.servers,
				tools: config.mcp.tools,
				verbose: options.verbose === true,
			})
			: { extensions: [] as Extension[], notes: [] as string[], close: async () => undefined };
		mcp = mcpSetup;
		codemode = config.codemode ? openCodemode() : undefined;
		const repositoryInstructions = createRepositoryInstructions(cwd);
		const jobExtensions: Extension[] = [
			repositoryInstructions,
			CodingTools,
			JobHandoffTools,
			...(codemode === undefined ? [] : [codemode.extension]),
			...mcpSetup.extensions.filter((extension) => extension.name !== "durable-chat.tasks"),
		];
		const jobOptions: JobCreateOptions = {
			maxTurns: config.jobMaxTurns, thinkingLevel: config.thinkingLevel, autoContinue: config.autoContinue,
		};
		const tasksExtension = createTaskExtension({
			model: setup.model,
			jobExtensions,
			cwd,
			jobOptions,
		});

		const registry = createRegistry();
		registry.install(CodingTools);
		registry.install(repositoryInstructions);
		registry.install(JobHandoffTools);
		registry.install(defineExtension({ name: "durable-chat.jobs", tasks: [JobTask] }));
		registry.install(tasksExtension);
		registry.install(ReminderTools);
		if (codemode !== undefined) registry.install(codemode.extension);
		for (const extension of mcpSetup.extensions) registry.install(extension);

		storage = await openNodeSqliteStorage(storePath);
		harness = await Harness.open(storage, {
			models: setup.models,
			registry,
			settings: {
				retry: { maxRetries: config.retries },
				stream: { maxRetries: config.retries, timeoutMs: config.streamTimeoutMs },
			},
			env: (target, callContext) => jobEnvironment(target, callContext, cwd),
			onReport: (report) => {
				const error = report.error instanceof Error ? report.error.message : String(report.error);
				const task = "task" in report && report.task !== undefined ? ` #${report.task.id}` : "";
				process.stderr.write(`[durable-chat] ${report.kind}${task}: ${error}\n`);
			},
		}, context);

		setup.faux?.ensure();
		const root = await harness.root(context, { agent: { model: setup.model } });
		await applyStartupJobModel(harness, setup.model, context, repositoryInstructions);
		await root.configure({
			model: setup.model,
			thinkingLevel: config.thinkingLevel,
			maxTurns: config.maxTurns,
			instructions: MAIN_INSTRUCTIONS,
			extensions: [tasksExtension, repositoryInstructions, ReminderTools, ...(codemode === undefined ? [] : [codemode.extension])],
			tools: null,
			modelTools: null,
			cwd,
		}, context);

		if (archivePath !== undefined) {
			await harness.commit(async (tx) => {
				const archive = await tx.doc(RebootArchive);
				archive.path = archivePath;
				if (restoredFrom !== undefined) archive.restoredFrom = restoredFrom;
			}, context);
		}
		const archiveInfo = await harness.snapshot(RebootArchive, context);
		const previousStateArchive = archiveInfo?.path;
		let closing: Promise<void> | undefined;
		const close = (release: boolean): Promise<void> => {
			closing ??= (async () => {
				try {
					await harness?.close(context);
				} finally {
					try { await mcp?.close(); }
					finally { try { await codemode?.close(); } finally { if (release) releaseLock(); } }
				}
			})();
			return closing;
		};
		const replace = async (sourcePath?: string): Promise<AppRuntime> => {
			if (closing !== undefined) throw new Error("This runtime is already closing or closed.");
			const source = sourcePath === undefined ? undefined : rollbackSource(sourcePath, [], storePath);
			const releaseSource = source === undefined ? undefined : acquireStoreLock(source);
			try {
				await close(false);
				return await rebootClosedStore(storePath, async (archive) => {
					if (source !== undefined) installRollbackSnapshot(source, storePath);
					return openConfiguredRuntime(config, options, releaseLock, false, archive, source);
				}, source === undefined ? "Reboot" : "Rollback");
			} catch (error) {
				releaseLock();
				throw error;
			} finally { releaseSource?.(); }
		};
		let choices: ModelChoices | undefined;
		const listModels = async (signal?: AbortSignal): Promise<ModelChoices> => {
			if (closing !== undefined) throw new Error("This runtime is already closing or closed.");
			const result = await modelChoices(config, setup.models, setup.model, signal);
			choices = result;
			return result;
		};
		const switchTo = async (
			entry: ProviderEntry,
			modelId: string,
			selected: { contextWindow: number; maxTokens: number },
		): Promise<ModelSwitchResult> => {
			if (closing !== undefined) throw new Error("This runtime is already closing or closed.");
			const target = { provider: entry.name, modelId };
			if (target.provider === setup.model.provider && target.modelId === setup.model.modelId) return { runtime: app };
			// Shutdown preserves durable checkpoints; the replacement configures subsequent requests.
			// The startup limits carry an environment override; a different entry brings its own.
			const base = entry.name === config.provider ? options.modelLimits : { contextWindow: entry.contextWindow, maxTokens: entry.maxTokens };
			const nextActive = { ...entry, model: modelId };
			const nextConfig: ResolvedConfig = {
				...config,
				// Keep the active entry inside the listed providers, so the picker reports the model in use.
				providers: config.providers.map((candidate) => candidate === entry ? nextActive : candidate),
				...(entry.model === undefined ? {} : { model: entry.model }),
				...(entry.baseUrl === undefined ? {} : { baseUrl: entry.baseUrl }),
				...(entry.apiKey === undefined ? {} : { apiKey: entry.apiKey }),
				...(entry.apiKeyEnv === undefined ? {} : { apiKeyEnv: entry.apiKeyEnv }),
				provider: entry.name, active: nextActive, model: modelId,
				contextWindow: Math.min(base.contextWindow, selected.contextWindow),
				maxTokens: Math.min(base.maxTokens, selected.maxTokens),
				streamTimeoutMs: entry.streamTimeoutMs,
				// A session thinking override survives a switch within the same provider.
				thinkingLevel: entry.name === config.provider ? config.thinkingLevel : entry.thinkingLevel,
			};
			try { await close(false); }
			catch (error) { releaseLock(); throw error; }
			try {
				return { runtime: await openConfiguredRuntime(nextConfig, options, releaseLock, false) };
			} catch (error) {
				try {
					const recovered = await openConfiguredRuntime(config, options, releaseLock, false);
					return { runtime: recovered, error: `Model unchanged: ${error instanceof Error ? error.message : String(error)}` };
				} catch (recoveryError) {
					releaseLock();
					throw new AggregateError([error, recoveryError], `Model switch and recovery failed. State remains at ${storePath}; restart with ${setup.label}.`);
				}
			}
		};
		const app: AppRuntime = {
			harness,
			root,
			context,
			config,
			storePath,
			model: setup.model,
			modelLabel: setup.label,
			get thinkingLevel() { return jobOptions.thinkingLevel; },
			supportsImages: () => {
				const model = setup.models.getModel(setup.model.provider, setup.model.modelId);
				return model === undefined ? false : modelSupportsImages(model);
			},
			cwd,
			mcpNotes: mcpSetup.notes,
			mcpAttempted: withMcp,
			mcpConnected: mcpSetup.extensions.some((extension) => extension.name === "durable-chat.mcp.substrate" && !extension.tools?.some((tool) => tool.name === "mcp_substrate_unavailable")),
			tasksExtension,
			jobExtensions,
			...(codemode === undefined ? {} : { codemodeExtension: codemode.extension }),
			...(setup.faux === undefined ? {} : { faux: setup.faux }),
			...(previousStateArchive == null ? {} : { previousStateArchive }),
			...(archiveInfo?.restoredFrom === undefined ? {} : { restoredFrom: archiveInfo.restoredFrom }),
			listModels,
			async switchModel(input) {
				const selected = selectModel(input, (choices ?? await listModels()).items);
				const entry = config.providers.find((candidate) => candidate.name === selected.provider) ?? config.active;
				return switchTo(entry, selected.id, { contextWindow: selected.contextWindow, maxTokens: selected.maxTokens });
			},
			async switchProvider(name) {
				const entry = config.providers.find((candidate) => candidate.name === name.trim());
				if (entry === undefined) {
					return { runtime: app, error: `No configured provider "${name.trim()}". Known: ${config.providers.map((candidate) => candidate.name).join(", ")}.` };
				}
				return switchTo(entry, defaultModelId(entry), { contextWindow: entry.contextWindow, maxTokens: entry.maxTokens });
			},
			reboot: () => replace(),
			async setThinkingLevel(raw) {
				if (closing !== undefined) throw new Error("This runtime is already closing or closed.");
				const level = parseThinkingLevel(raw);
				// The effective config for this run; the config file still decides the next run.
				config.thinkingLevel = level;
				jobOptions.thinkingLevel = level;
				await root.configure({ thinkingLevel: level }, context);
				await applyThinkingLevel(harness!, level, context);
				return level;
			},
			rollback: (source) => replace(source),
			close: () => close(true),
		};
		return app;
	} catch (error) {
		try {
			await harness?.close(context);
		} catch {
			// Preserve the original startup error.
		}
		try { await storage?.close(context); }
		catch { /* Reboot recovery checks journal closure before moving replacement files. */ }
		try { await mcp?.close(); }
		catch { /* Preserve the original startup error. */ }
		try { await codemode?.close(); }
		catch { /* Preserve the original startup error. */ }
		finally { if (releaseOnFailure) releaseLock(); }
		throw error;
	}
}
