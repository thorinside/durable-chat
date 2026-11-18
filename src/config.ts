import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml, parseDocument } from "yaml";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export type ProviderKind = "faux" | "openai" | "local" | "openai-codex";

const KINDS: readonly ProviderKind[] = ["faux", "openai", "local", "openai-codex"];

/** One configured provider. Values inherit the flat keys, then the environment still wins. */
export type ProviderEntry = {
	name: string;
	kind: ProviderKind;
	model?: string;
	baseUrl?: string;
	apiKey?: string;
	apiKeyEnv?: string;
	contextWindow: number;
	maxTokens: number;
	streamTimeoutMs: number;
	thinkingLevel: ModelThinkingLevel;
};

export type McpConfig = {
	enabled: boolean;
	servers: string[];
	tools: string[];
	configPath?: string;
};

export type ResolvedConfig = {
	configPath: string;
	configFound: boolean;
	configPaths: string[];
	explicitConfigPath?: string;
	warnings: string[];
	storePath: string;
	/** Active provider name: the entry key, or its kind when no entry names it. */
	provider: string;
	providers: ProviderEntry[];
	active: ProviderEntry;
	model?: string;
	baseUrl?: string;
	apiKey?: string;
	apiKeyEnv?: string;
	contextWindow: number;
	maxTokens: number;
	streamTimeoutMs: number;
	retries: number;
	thinkingLevel: ModelThinkingLevel;
	maxTurns: number;
	jobMaxTurns: number;
	autoContinue: boolean;
	codemode: boolean;
	contextPanel: boolean;
	mcp: McpConfig;
};

type RawConfig = {
	store?: string;
	provider?: string;
	model?: string;
	baseUrl?: string;
	apiKeyEnv?: string;
	contextWindow?: number;
	maxTokens?: number;
	streamTimeoutMs?: number;
	retries?: number;
	thinkingLevel?: ModelThinkingLevel;
	maxTurns?: number;
	jobMaxTurns?: number;
	autoContinue?: boolean;
	codemode?: boolean;
	contextPanel?: boolean;
	providers?: Record<string, Record<string, unknown>>;
	mcp?: {
		enabled?: boolean;
		servers?: string[];
		tools?: string[];
		config?: string;
	};
};

export const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** A slash command override for this run; the config file still decides the next run. */
export function parseThinkingLevel(raw: string): ModelThinkingLevel {
	return readThinking("session", "thinking", raw.trim());
}
const KNOWN_KEYS = new Set([
	"store", "provider", "model", "baseUrl", "apiKeyEnv", "contextWindow", "maxTokens",
	"streamTimeoutMs", "retries", "thinkingLevel", "maxTurns", "jobMaxTurns", "autoContinue", "codemode", "contextPanel", "providers", "mcp",
]);
const KNOWN_MCP_KEYS = new Set(["enabled", "servers", "tools", "config"]);
const KNOWN_PROVIDER_KEYS = new Set([
	"kind", "model", "baseUrl", "apiKeyEnv", "contextWindow", "maxTokens", "streamTimeoutMs", "thinkingLevel",
]);
const PROVIDER_MAX: Record<string, number> = { contextWindow: 2_000_000, maxTokens: 200_000, streamTimeoutMs: 900_000 };

const BUILTIN = {
	store: ".durable-chat/store.sqlite",
	provider: "faux" as ProviderKind,
	contextWindow: 128_000,
	maxTokens: 8192,
	streamTimeoutMs: 180_000,
	streamTimeoutLocalMs: 600_000,
	streamTimeoutCodexMs: 300_000,
	retries: 1,
	thinkingLevel: "off" as ModelThinkingLevel,
	maxTurns: 60,
	jobMaxTurns: 120,
	autoContinue: true,
	codemode: true,
	contextPanel: true,
};

function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	return value;
}

function pathFrom(value: string, base = process.cwd()): string {
	const expanded = expandHome(value);
	return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.DURABLE_CHAT_CONFIG;
	if (explicit !== undefined && explicit.trim() !== "") return pathFrom(explicit);
	const base = env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME.trim() !== ""
		? env.XDG_CONFIG_HOME
		: join(homedir(), ".config");
	// Prefer .yaml, but accept file discovery of .yml in loadConfigFile.
	return join(pathFrom(base), "durable-chat", "config.yaml");
}

function configCandidates(env: NodeJS.ProcessEnv): { candidates: string[]; explicit: boolean } {
	const explicit = env.DURABLE_CHAT_CONFIG;
	if (explicit !== undefined && explicit.trim() !== "") {
		return { candidates: [pathFrom(explicit)], explicit: true };
	}
	const preferred = defaultConfigPath(env);
	return { candidates: [preferred, preferred.replace(/\.yaml$/, ".yml")], explicit: false };
}

/** Only the launch folder is inspected; parent folders do not contribute config. */
export function localConfigPath(cwd = process.cwd()): string {
	const preferred = resolve(cwd, ".durable-chat/config.yaml");
	const alternate = preferred.replace(/\.yaml$/, ".yml");
	return existsSync(preferred) ? preferred : existsSync(alternate) ? alternate : preferred;
}

/** Select an edit target without parsing, so invalid configs can still be repaired. */
export function configEditPath(explicitPath?: string, env: NodeJS.ProcessEnv = process.env): string {
	if (explicitPath !== undefined) return pathFrom(explicitPath);
	const { candidates, explicit } = configCandidates(env);
	const local = localConfigPath();
	if (!explicit && existsSync(local)) return local;
	return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

class ConfigError extends Error {
	constructor(path: string, key: string, problem: string) {
		super(`${path}: ${key} ${problem}`);
	}
}

function readString(path: string, key: string, value: unknown): string {
	if (typeof value !== "string" || value.trim() === "") throw new ConfigError(path, key, "must be a non-empty string");
	return value.trim();
}

function readNumber(path: string, key: string, value: unknown, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new ConfigError(path, key, "must be a positive number");
	}
	return Math.min(Math.trunc(value), max);
}

function readBoolean(path: string, key: string, value: unknown): boolean {
	if (typeof value !== "boolean") throw new ConfigError(path, key, "must be true or false");
	return value;
}

function readStringArray(path: string, key: string, value: unknown): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new ConfigError(path, key, "must be a list of strings");
	}
	return value.map((item) => (item as string).trim()).filter(Boolean);
}

function envBoolean(name: string, value: string | undefined): boolean | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	throw new Error(`environment: ${name} must be true or false`);
}

function readProvider(path: string, key: string, value: unknown, knownNames: readonly string[] = []): string {
	const name = typeof value === "string" ? value.trim() : "";
	// A configured entry name is as good a provider value as a provider kind.
	if (knownNames.includes(name)) return name;
	if (!KINDS.includes(name as ProviderKind)) throw new ConfigError(path, key, `must be ${KINDS.map((kind) => `"${kind}"`).join(", ")}${knownNames.length === 0 ? "" : ` or a configured provider name (${knownNames.join(", ")})`}`);
	return name as ProviderKind;
}

function readThinking(path: string, key: string, value: unknown): ModelThinkingLevel {
	if (typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)) {
		return value as ModelThinkingLevel;
	}
	throw new ConfigError(path, key, `must be one of ${THINKING_LEVELS.join(", ")}`);
}

function validate(path: string, raw: unknown, warnings: string[]): RawConfig {
	if (raw === null || raw === undefined) return {};
	if (typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError(path, "root", "must be a mapping");
	const record = raw as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!KNOWN_KEYS.has(key)) warnings.push(`${path}: unknown key "${key}" ignored`);
	}
	const config: RawConfig = {};
	if (record.store !== undefined) config.store = readString(path, "store", record.store);
	if (record.provider !== undefined) config.provider = readProvider(path, "provider", record.provider, Object.keys(record.providers !== undefined && typeof record.providers === "object" && !Array.isArray(record.providers) ? record.providers as Record<string, unknown> : {}));
	if (record.model !== undefined) config.model = readString(path, "model", record.model);
	if (record.baseUrl !== undefined) config.baseUrl = readString(path, "baseUrl", record.baseUrl);
	if (record.apiKeyEnv !== undefined) config.apiKeyEnv = readString(path, "apiKeyEnv", record.apiKeyEnv);
	if (record.contextWindow !== undefined) config.contextWindow = readNumber(path, "contextWindow", record.contextWindow, 2_000_000);
	if (record.maxTokens !== undefined) config.maxTokens = readNumber(path, "maxTokens", record.maxTokens, 200_000);
	if (record.streamTimeoutMs !== undefined) config.streamTimeoutMs = readNumber(path, "streamTimeoutMs", record.streamTimeoutMs, 900_000);
	if (record.retries !== undefined) config.retries = readNumber(path, "retries", record.retries, 5);
	if (record.thinkingLevel !== undefined) config.thinkingLevel = readThinking(path, "thinkingLevel", record.thinkingLevel);
	if (record.maxTurns !== undefined) config.maxTurns = readNumber(path, "maxTurns", record.maxTurns, 1000);
	if (record.jobMaxTurns !== undefined) config.jobMaxTurns = readNumber(path, "jobMaxTurns", record.jobMaxTurns, 1000);
	if (record.autoContinue !== undefined) config.autoContinue = readBoolean(path, "autoContinue", record.autoContinue);
	if (record.codemode !== undefined) config.codemode = readBoolean(path, "codemode", record.codemode);
	if (record.contextPanel !== undefined) config.contextPanel = readBoolean(path, "contextPanel", record.contextPanel);
	if (record.providers !== undefined) {
		if (typeof record.providers !== "object" || record.providers === null || Array.isArray(record.providers)) {
			throw new ConfigError(path, "providers", "must be a mapping of provider names to settings");
		}
		const providers: Record<string, Record<string, unknown>> = {};
		for (const [name, value] of Object.entries(record.providers)) {
			if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new ConfigError(path, "providers", `name "${name}" must be a simple id`);
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				throw new ConfigError(path, `providers.${name}`, "must be a mapping");
			}
			const entry: Record<string, unknown> = {};
			for (const key of Object.keys(value)) {
				const at = `providers.${name}.${key}`;
				if (!KNOWN_PROVIDER_KEYS.has(key)) warnings.push(`${path}: unknown key "${at}" ignored`);
				else if (key === "kind") entry[key] = readProvider(path, at, value[key]);
				else if (key === "thinkingLevel") entry.thinkingLevel = readThinking(path, at, value[key]);
				else if (key === "contextWindow" || key === "maxTokens" || key === "streamTimeoutMs") entry[key] = readNumber(path, at, value[key], PROVIDER_MAX[key]!);
				else entry[key] = readString(path, at, value[key]);
			}
			providers[name] = entry;
		}
		config.providers = providers;
	}
	if (record.mcp !== undefined) {
		if (typeof record.mcp !== "object" || record.mcp === null || Array.isArray(record.mcp)) {
			throw new ConfigError(path, "mcp", "must be a mapping");
		}
		const mcp = record.mcp as Record<string, unknown>;
		for (const key of Object.keys(mcp)) {
			if (!KNOWN_MCP_KEYS.has(key)) warnings.push(`${path}: unknown key "mcp.${key}" ignored`);
		}
		config.mcp = {};
		if (mcp.enabled !== undefined) config.mcp.enabled = readBoolean(path, "mcp.enabled", mcp.enabled);
		if (mcp.servers !== undefined) config.mcp.servers = readStringArray(path, "mcp.servers", mcp.servers);
		if (mcp.tools !== undefined) config.mcp.tools = readStringArray(path, "mcp.tools", mcp.tools);
		if (mcp.config !== undefined) config.mcp.config = readString(path, "mcp.config", mcp.config);
	}
	return config;
}

function loadConfigFile(
	env: NodeJS.ProcessEnv,
	warnings: string[],
	explicitPath?: string,
): { path: string; found: boolean; config: RawConfig } {
	const { candidates, explicit } = explicitPath === undefined
		? configCandidates(env)
		: { candidates: [pathFrom(explicitPath)], explicit: true };
	const found = candidates.find((candidate) => existsSync(candidate));
	if (found === undefined) {
		if (explicit) throw new Error(`Config file not found: ${candidates[0]}`);
		return { path: candidates[0]!, found: false, config: {} };
	}
	let parsed: unknown;
	try {
		parsed = parseYaml(readFileSync(found, "utf8"));
	} catch (error) {
		throw new Error(`${found}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return { path: found, found: true, config: validate(found, parsed, warnings) };
}

export type ConfigOverrides = {
	/** Session-local discovery and relative paths, without changing process.cwd(). */
	cwd?: string;
	store?: string;
	provider?: string;
	model?: string;
	noMcp?: boolean;
	configPath?: string;
};

/** CLI > environment > folder-local config > global config > built-ins. Explicit files stand alone. */
export function resolveConfig(overrides: ConfigOverrides = {}, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
	const warnings: string[] = [];
	const file = loadConfigFile(env, warnings, overrides.configPath);
	const explicit = overrides.configPath !== undefined || configCandidates(env).explicit;
	const localPath = localConfigPath(overrides.cwd);
	const local = !explicit && existsSync(localPath) ? loadConfigFile(env, warnings, localPath) : undefined;
	const activeFile = local ?? file;
	const raw: RawConfig = {
		...file.config,
		...local?.config,
		...(file.config.mcp === undefined && local?.config.mcp === undefined
			? {}
			: { mcp: { ...file.config.mcp, ...local?.config.mcp } }),
	};

	const envBaseUrl = env.DURABLE_BASE_URL !== undefined && env.DURABLE_BASE_URL.trim() !== "" ? env.DURABLE_BASE_URL.trim() : undefined;
	const envText = (name: string): string | undefined => env[name] !== undefined && env[name].trim() !== "" ? env[name]!.trim() : undefined;
	const envNumber = (name: string, max: number): number | undefined => {
		const value = env[name];
		return value !== undefined && value.trim() !== "" ? readNumber("environment", name, Number(value), max) : undefined;
	};
	const envThinking = envText("DURABLE_THINKING_LEVEL") === undefined ? undefined : readThinking("environment", "DURABLE_THINKING_LEVEL", envText("DURABLE_THINKING_LEVEL")!);

	// A `provider` value names a configured entry when it matches one, and is a kind otherwise.
	const configured = raw.providers ?? {};
	let flatKind: ProviderKind | undefined;
	let activeName: string | undefined;
	const sources: readonly [string, string | undefined][] = [["--provider", overrides.provider], ["environment", env.DURABLE_PROVIDER], ["config file", raw.provider]];
	for (const [source, value] of sources) {
		if (typeof value !== "string" || value.trim() === "") continue;
		const trimmed = value.trim();
		if (Object.hasOwn(configured, trimmed)) activeName ??= trimmed;
		else flatKind ??= readProvider(source, "provider", trimmed, Object.keys(configured)) as ProviderKind;
	}
	flatKind ??= raw.baseUrl !== undefined || envBaseUrl !== undefined ? "local" : BUILTIN.provider;

	const entryFor = (name: string, rawEntry: Record<string, unknown>): ProviderEntry => {
		// An entry keeps its own kind; its name or its endpoint can imply one; otherwise the flat kind applies.
		const kind = (rawEntry.kind as ProviderKind | undefined)
			?? (KINDS.includes(name as ProviderKind) ? name as ProviderKind : rawEntry.baseUrl !== undefined ? "local" : flatKind!);
		const isActive = name === (activeName ?? flatKind!);
		const model = (isActive ? overrides.model ?? envText("DURABLE_MODEL_ID") ?? envText("PI_MODEL_ID") : undefined)
			?? (rawEntry.model as string | undefined) ?? raw.model ?? (kind === "openai-codex" ? "gpt-6.1-sol" : undefined);
		const baseUrl = envBaseUrl ?? (rawEntry.baseUrl as string | undefined) ?? raw.baseUrl;
		const apiKeyEnv = env.DURABLE_API_KEY_ENV ?? (rawEntry.apiKeyEnv as string | undefined) ?? raw.apiKeyEnv;
		const apiKey = (isActive ? env.DURABLE_API_KEY : undefined) ?? (apiKeyEnv === undefined ? undefined : env[apiKeyEnv]);
		const contextWindow = envNumber("DURABLE_CONTEXT_WINDOW", 2_000_000) ?? (rawEntry.contextWindow as number | undefined) ?? raw.contextWindow ?? BUILTIN.contextWindow;
		const maxTokens = envNumber("DURABLE_MAX_TOKENS", 200_000) ?? (rawEntry.maxTokens as number | undefined) ?? raw.maxTokens ?? BUILTIN.maxTokens;
		const streamTimeoutMs = envNumber("DURABLE_STREAM_TIMEOUT_MS", 900_000) ?? (rawEntry.streamTimeoutMs as number | undefined) ?? raw.streamTimeoutMs
			?? (kind === "local" ? BUILTIN.streamTimeoutLocalMs : kind === "openai-codex" ? BUILTIN.streamTimeoutCodexMs : BUILTIN.streamTimeoutMs);
		const thinkingLevel = envThinking ?? (rawEntry.thinkingLevel as ModelThinkingLevel | undefined) ?? raw.thinkingLevel ?? (kind === "openai-codex" ? "medium" : BUILTIN.thinkingLevel);
		if (kind === "local" && (baseUrl === undefined || model === undefined || model === "")) {
			throw new Error(`provider "${name}": the local provider needs baseUrl and model (${activeFile.path}).`);
		}
		if ((kind === "openai" || kind === "openai-codex") && (model === undefined || model === "")) {
			throw new Error(`provider "${name}": the ${kind} provider needs a model (${activeFile.path}).`);
		}
		return {
			name, kind,
			...(model === undefined ? {} : { model }),
			...(baseUrl === undefined ? {} : { baseUrl }),
			...(apiKey === undefined ? {} : { apiKey }),
			...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
			contextWindow, maxTokens, streamTimeoutMs, thinkingLevel,
		};
	};
	// Only configured entries are listed; a provider value with no entry stays a plain kind.
	const entries = Object.entries(configured).map(([name, entry]) => entryFor(name, entry));
	const active = entries.find((entry) => entry.name === (activeName ?? flatKind)) ?? entryFor(activeName ?? flatKind!, {});
	if (!entries.includes(active)) entries.unshift(active);

	const retries = envNumber("DURABLE_RETRIES", 5) ?? raw.retries ?? BUILTIN.retries;
	const maxTurns = envNumber("DURABLE_MAX_TURNS", 1000) ?? raw.maxTurns ?? BUILTIN.maxTurns;
	const jobMaxTurns = envNumber("DURABLE_JOB_MAX_TURNS", 1000) ?? raw.jobMaxTurns ?? BUILTIN.jobMaxTurns;
	const autoContinue = envBoolean("DURABLE_AUTO_CONTINUE", env.DURABLE_AUTO_CONTINUE) ?? raw.autoContinue ?? BUILTIN.autoContinue;
	const codemode = envBoolean("DURABLE_CODEMODE", env.DURABLE_CODEMODE) ?? raw.codemode ?? BUILTIN.codemode;

	const storeRaw = overrides.store
		?? (env.DURABLE_STORE !== undefined && env.DURABLE_STORE.trim() !== "" ? env.DURABLE_STORE.trim() : undefined)
		?? raw.store
		?? BUILTIN.store;

	const envMcpEnabled = envBoolean("DURABLE_MCP_ENABLED", env.DURABLE_MCP_ENABLED);
	const mcpEnabled = overrides.noMcp === true ? false : envMcpEnabled ?? raw.mcp?.enabled ?? true;
	const envServers = env.DURABLE_MCP_SERVERS !== undefined && env.DURABLE_MCP_SERVERS.trim() !== ""
		? env.DURABLE_MCP_SERVERS.split(",").map((name) => name.trim()).filter(Boolean)
		: undefined;
	const envTools = env.DURABLE_MCP_TOOLS !== undefined && env.DURABLE_MCP_TOOLS.trim() !== ""
		? env.DURABLE_MCP_TOOLS.split(",").map((name) => name.trim()).filter(Boolean)
		: undefined;
	const mcpConfigRaw = (env.DURABLE_MCP_CONFIG !== undefined && env.DURABLE_MCP_CONFIG.trim() !== "" ? env.DURABLE_MCP_CONFIG.trim() : undefined)
		?? raw.mcp?.config;

	return {
		configPath: activeFile.path,
		configFound: activeFile.found,
		configPaths: [file, ...(local === undefined ? [] : [local])].filter((source) => source.found).map((source) => source.path),
		...(explicit ? { explicitConfigPath: file.path } : {}),
		warnings,
		storePath: pathFrom(storeRaw, overrides.cwd),
		provider: active.name,
		providers: entries,
		active,
		...(active.model === undefined ? {} : { model: active.model }),
		...(active.baseUrl === undefined ? {} : { baseUrl: active.baseUrl }),
		...(active.apiKey === undefined ? {} : { apiKey: active.apiKey }),
		...(active.apiKeyEnv === undefined ? {} : { apiKeyEnv: active.apiKeyEnv }),
		contextWindow: active.contextWindow,
		maxTokens: active.maxTokens,
		streamTimeoutMs: active.streamTimeoutMs,
		retries,
		thinkingLevel: active.thinkingLevel,
		maxTurns,
		jobMaxTurns,
		autoContinue,
		codemode,
		contextPanel: raw.contextPanel ?? BUILTIN.contextPanel,
		mcp: {
			enabled: mcpEnabled,
			servers: envServers ?? raw.mcp?.servers ?? ["substrate"],
			tools: envTools ?? raw.mcp?.tools ?? [],
			...(mcpConfigRaw === undefined ? {} : { configPath: pathFrom(mcpConfigRaw, overrides.cwd) }),
		},
	};
}

/** The config written by `durable-chat config init`; local inference is the default. */
export function configTemplate(): string {
	return `# durable-chat defaults. CLI flags override environment variables, which override this file.
provider: local
model: nemotron-bolt
baseUrl: http://dev.local:1234/v1
contextWindow: 262144
maxTokens: 32768
# A cold local model start can take minutes.
streamTimeoutMs: 600000
retries: 1
thinkingLevel: "off"
maxTurns: 60
jobMaxTurns: 120
autoContinue: true
# QuickJS scripts that call the conversation's tools; only the script's output comes back.
codemode: true
# Ctrl-X toggles this in the dashboard; enabled context still hides when space is limited.
contextPanel: true
# More than one provider can be configured. The provider key selects the active entry by name, and
# each entry inherits the values above for keys it does not set. Entry names are provider ids.
# providers:
#   codex: { kind: openai-codex, model: gpt-6.1-sol }
#   ollama: { model: llama3, baseUrl: http://127.0.0.1:11434/v1, contextWindow: 131072 }
store: ~/.local/share/durable-chat/store.sqlite
mcp:
  enabled: true
  servers:
    - substrate
  tools: []
  config: ~/.pi/agent/mcp.json
`;
}

export function initConfigFile(path: string, options: { force?: boolean; local?: boolean } = {}): string {
	mkdirSync(dirname(path), { recursive: true });
	try {
		const template = options.local === true
			? "# Folder-local overrides; unspecified keys inherit global defaults.\n# For a folder-local database, set: store: .durable-chat/store.sqlite\n{}\n"
			: configTemplate();
		writeFileSync(path, template, { flag: options.force === true ? "w" : "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error(`${path} already exists; pass --force to overwrite it.`);
		}
		throw error;
	}
	return path;
}

/** Printable summary. Never includes secret values. */
export function describeConfig(config: ResolvedConfig): string[] {
	const lines = [
		`Config: ${config.configPath}${config.configFound ? "" : " (not found; using built-ins)"}`,
		...(config.configPaths.length > 1 ? [`Config layers (low → high): ${config.configPaths.join(" → ")}`] : []),
		`provider: ${config.provider}`,
		...(config.providers.length > 1
			? [`providers: ${config.providers.map((entry) => `${entry.name}${entry.name === config.provider ? " (active)" : ""}`).join(", ")}`]
			: []),
		`model: ${config.model ?? "(provider default)"}`,
		`baseUrl: ${config.baseUrl ?? "(provider default)"}`,
		`store: ${config.storePath}`,
		`contextWindow: ${config.contextWindow}`,
		`maxTokens: ${config.maxTokens}`,
		`streamTimeoutMs: ${config.streamTimeoutMs}`,
		`retries: ${config.retries}`,
		`thinkingLevel: ${config.thinkingLevel}`,
		`maxTurns: ${config.maxTurns}`,
		`jobMaxTurns: ${config.jobMaxTurns}`,
		`autoContinue: ${config.autoContinue}`,
		`codemode: ${config.codemode ? "enabled" : "disabled"}`,
		`contextPanel: ${config.contextPanel}`,
		`apiKey: ${config.apiKey === undefined ? "(none)" : config.apiKeyEnv === undefined ? "(set)" : `from ${config.apiKeyEnv}`}`,
		`mcp: ${config.mcp.enabled ? "enabled" : "disabled"}, servers: ${config.mcp.servers.join(", ") || "(none)"}`,
		...(config.mcp.tools.length === 0 ? [] : [`mcp extra tools: ${config.mcp.tools.join(", ")}`]),
		`mcp config: ${config.mcp.configPath ?? "(default)"}`,
		...config.warnings.map((warning) => `warning: ${warning}`),
	];
	return lines;
}

const KEY_PATHS: Record<string, readonly string[]> = {
	store: ["store"],
	provider: ["provider"],
	model: ["model"],
	baseUrl: ["baseUrl"],
	apiKeyEnv: ["apiKeyEnv"],
	contextWindow: ["contextWindow"],
	maxTokens: ["maxTokens"],
	streamTimeoutMs: ["streamTimeoutMs"],
	retries: ["retries"],
	thinkingLevel: ["thinkingLevel"],
	maxTurns: ["maxTurns"],
	jobMaxTurns: ["jobMaxTurns"],
	autoContinue: ["autoContinue"],
	codemode: ["codemode"],
	contextPanel: ["contextPanel"],
	providers: ["providers"],
	"mcp.enabled": ["mcp", "enabled"],
	"mcp.servers": ["mcp", "servers"],
	"mcp.tools": ["mcp", "tools"],
	"mcp.config": ["mcp", "config"],
};

export function configKeys(): string[] {
	return Object.keys(KEY_PATHS);
}

export function configKeyPath(key: string): readonly string[] | undefined {
	const path = KEY_PATHS[key];
	if (path !== undefined) return path;
	// Accept a nested `mcp` key write only through its subkeys.
	if (key === "mcp") return undefined;
	// One provider entry is written through its subkeys, as in `providers.codex.model`.
	const parts = key.split(".");
	if (parts.length === 3 && parts[0] === "providers" && KNOWN_PROVIDER_KEYS.has(parts[2]!)) return parts;
	return undefined;
}

function loadDocument(path: string) {
	if (!existsSync(path)) return parseDocument("");
	const doc = parseDocument(readFileSync(path, "utf8"));
	if (doc.errors.length > 0) {
		throw new Error(`${path}: ${doc.errors[0]?.message ?? "invalid YAML"}`);
	}
	return doc;
}

function setAt(target: Record<string, unknown>, keyPath: readonly string[], value: unknown): void {
	let cursor = target;
	for (const part of keyPath.slice(0, -1)) {
		const next = cursor[part];
		if (typeof next !== "object" || next === null || Array.isArray(next)) cursor[part] = {};
		cursor = cursor[part] as Record<string, unknown>;
	}
	cursor[keyPath[keyPath.length - 1]!] = value;
}


function parseCliValue(raw: string): unknown {
	const text = raw.trim();
	if (text === "") throw new Error("A value is required.");
	try {
		const parsed = parseYaml(text);
		// A bare word stays a string; YAML null only when the user typed null/tilde.
		if (parsed === null || parsed === undefined) return text;
		return parsed;
	} catch {
		return text;
	}
}

export function setConfigValue(path: string, key: string, rawValue: string): { key: string; value: unknown } {
	const keyPath = configKeyPath(key);
	if (keyPath === undefined) {
		throw new Error(`Unknown config key "${key}". Known keys: ${configKeys().join(", ")}`);
	}
	const doc = loadDocument(path);
	const value = parseCliValue(rawValue);
	const candidate = (doc.toJS() ?? {}) as Record<string, unknown>;
	setAt(candidate, keyPath, value);
	// Type-check the whole file before writing, so a typo never lands.
	validate(path, candidate, []);
	doc.setIn(keyPath, value);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, doc.toString(), "utf8");
	return { key, value };
}

export function unsetConfigValue(path: string, key: string): boolean {
	const keyPath = configKeyPath(key);
	if (keyPath === undefined) {
		throw new Error(`Unknown config key "${key}". Known keys: ${configKeys().join(", ")}`);
	}
	if (!existsSync(path)) return false;
	const doc = loadDocument(path);
	const before = JSON.stringify(doc.toJS() ?? {});
	doc.deleteIn(keyPath);
	const after = JSON.stringify(doc.toJS() ?? {});
	if (before === after) return false;
	writeFileSync(path, doc.toString(), "utf8");
	return true;
}

/** Effective value for `config get`; secrets are reported as present, never printed. */
export function effectiveValue(config: ResolvedConfig, key: string): string {
	switch (key) {
		case "store": return config.storePath;
		case "provider": return config.provider;
		case "providers": return config.providers.map((entry) => `${entry.name}${entry.name === config.provider ? " (active)" : ""}`).join(", ");
		case "model": return config.model ?? "(provider default)";
		case "baseUrl": return config.baseUrl ?? "(provider default)";
		case "apiKey": return config.apiKey === undefined ? "(none)" : config.apiKeyEnv === undefined ? "(set)" : `(set from ${config.apiKeyEnv})`;
		case "apiKeyEnv": return config.apiKeyEnv ?? "(none)";
		case "contextWindow": return String(config.contextWindow);
		case "maxTokens": return String(config.maxTokens);
		case "streamTimeoutMs": return String(config.streamTimeoutMs);
		case "retries": return String(config.retries);
		case "thinkingLevel": return config.thinkingLevel;
		case "maxTurns": return String(config.maxTurns);
		case "jobMaxTurns": return String(config.jobMaxTurns);
		case "autoContinue": return String(config.autoContinue);
		case "codemode": return String(config.codemode);
		case "contextPanel": return String(config.contextPanel);
		case "mcp.enabled": return String(config.mcp.enabled);
		case "mcp.servers": return config.mcp.servers.join(", ") || "(none)";
		case "mcp.tools": return config.mcp.tools.join(", ") || "(none)";
		case "mcp.config": return config.mcp.configPath ?? "(default)";
		default:
			throw new Error(`Unknown config key "${key}". Known keys: ${configKeys().join(", ")}`);
	}
}
