import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { entryUpdates, readFrames, type AcpMessage } from "./acp.ts";
import { openRuntime, type AppRuntime } from "./harness.ts";
import { acquireRegistryLock } from "./acp-registry-lock.ts";
import type { McpServerEntry } from "./mcp.ts";
import { PACKAGE_VERSION } from "./version.ts";

type Value = Record<string, any>;
type Identity = { version: 1; sessionId: string; cwd: string; mcpHash: string };
type Session = { runtime: AppRuntime; detach?: () => void; pending: boolean };
const ID = /^acp-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const MAX_OPEN = 16;
class RpcError extends Error {
	readonly code: number;
	constructor(message: string, code = -32602) { super(message); this.code = code; }
}
const invalid = (message: string): never => { throw new RpcError(message); };
const object = (value: unknown): value is Value => value !== null && typeof value === "object" && !Array.isArray(value);

function sessionCwd(value: unknown): string {
	if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) invalid("cwd must be an existing absolute directory");
	try {
		if (!statSync(value as string).isDirectory()) invalid("cwd must be an existing absolute directory");
		return realpathSync(value as string);
	} catch { return invalid("cwd must be an existing absolute directory"); }
}

/** ACP schema-v1.33.0: stdio has no `type` discriminator, and env is a name/value array. */
export function acpMcpServers(value: unknown, cwd: string): Record<string, McpServerEntry> {
	if (!Array.isArray(value) || value.length > 8) invalid("mcpServers must be an array of at most 8 stdio servers");
	const entries: Record<string, McpServerEntry> = Object.create(null);
	const names = new Set<string>();
	for (const server of value as any[]) {
		if (!object(server) || (server.type !== undefined && server.type !== "stdio") || server.url !== undefined || server.headers !== undefined)
			invalid("Only stdio MCP servers are supported; HTTP/SSE and unknown transports are unsupported");
		if (typeof server.name !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(server.name)) invalid("Invalid MCP server name");
		const normalized = server.name.replace(/[^A-Za-z0-9_]/g, "_");
		if (names.has(normalized)) invalid("Duplicate or colliding MCP server names");
		names.add(normalized);
		if (typeof server.command !== "string" || !isAbsolute(server.command) || server.command.includes("\0")) invalid("MCP command must be an absolute executable path");
		if (!Array.isArray(server.args) || server.args.length > 256 || server.args.some((arg: unknown) => typeof arg !== "string" || arg.length > 8192 || arg.includes("\0"))) invalid("Invalid MCP arguments");
		if (!Array.isArray(server.env) || server.env.length > 256) invalid("MCP env must be a name/value array");
		const env: Record<string, string> = Object.create(null);
		for (const item of server.env) {
			if (!object(item) || typeof item.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.name) || typeof item.value !== "string" || item.value.length > 8192 || item.value.includes("\0") || Object.hasOwn(env, item.name)) invalid("Invalid or duplicate MCP environment variable");
			env[item.name] = item.value;
		}
		// Values are literal, never expanded against another session's environment/config.
		entries[server.name] = { command: server.command, args: server.args, env: Object.fromEntries(Object.entries(env).sort()), cwd, timeout: 10 };
	}
	return Object.fromEntries(Object.entries(entries).sort());
}
const fingerprint = (entries: Record<string, McpServerEntry>) => createHash("sha256").update(JSON.stringify(entries)).digest("hex");

function privateDirectory(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const info = lstatSync(path);
	if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error("Unsafe ACP session directory");
}

export function defaultSessionsDirectory(): string {
	return resolve(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "durable-chat/acp");
}

/** A foreground stdio host. Every registry identity owns one isolated durable runtime/store. */
export async function acpServe(options: {
	sessionsDir?: string;
	configPath?: string;
	provider?: string;
	model?: string;
	noMcp?: boolean;
} = {}): Promise<void> {
	const directory = resolve(options.sessionsDir ?? defaultSessionsDirectory());
	privateDirectory(directory);
	// Serialize registry mutation across hosts, not just stores; no daemon or IPC owner socket.
	const release = acquireRegistryLock(directory);
	const sessions = new Map<string, Session>();
	let initialized = false;
	let closing = false;
	let admission = Promise.resolve();
	let finish!: () => void;
	const finished = new Promise<void>((done) => { finish = done; });
	const send = (message: AcpMessage) => {
		if (closing) return;
		if (process.stdout.writableLength > 8 * 1024 * 1024) { shutdown(); return; }
		process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
	};
	const update = (sessionId: string, value: Value) => send({ method: "session/update", params: { sessionId, update: value } });
	const identity = (sessionId: unknown): Identity => {
		if (typeof sessionId !== "string" || !ID.test(sessionId)) throw new RpcError("Unknown ACP-owned session", -32002);
		try {
			const path = join(directory, sessionId);
			const info = lstatSync(path);
			if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
			const file = join(path, "session.json");
			if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error();
			const value = JSON.parse(readFileSync(file, "utf8"));
			if (value.version !== 1 || value.sessionId !== sessionId || typeof value.cwd !== "string" || !isAbsolute(value.cwd) || typeof value.mcpHash !== "string" || !/^[0-9a-f]{64}$/.test(value.mcpHash)) throw new Error();
			return value;
		} catch { throw new RpcError("Unknown ACP-owned session", -32002); }
	};
	const attach = async (sessionId: string, session: Session) => {
		session.detach?.();
		const { runtime } = session;
		const seen = new Set<number>();
		const toolIds = new Map<string, string>();
		let loading = true;
		const queued: ConversationView[] = [];
		const entries = (values: readonly EntryRecord[]) => {
			for (const entry of values) {
				if (seen.has(Number(entry.id))) continue;
				seen.add(Number(entry.id));
				for (const value of entryUpdates(entry, toolIds)) update(sessionId, value);
			}
		};
		const observation = await runtime.harness.observeConversation(runtime.root.id, {
			advance(call) {
				if (call.kind !== "value" || closing) return;
				try {
					if (loading) {
						if (queued.length >= 2048) throw new Error();
						queued.push(call.value);
					} else entries(call.value.entries);
				} catch { shutdown(); }
			},
			end() {},
		}, runtime.context);
		session.detach = observation.detach;
		try {
			// Replay the entire committed public history before replying, never pi.live drafts.
			let cursor;
			do {
				const page = await runtime.root.entries({ order: "ascending" }, 128, cursor, runtime.context);
				entries(page.items);
				cursor = page.next;
			} while (cursor !== undefined && !closing);
			entries(observation.value.entries);
			for (const view of queued) entries(view.entries);
			loading = false;
			runtime.harness.resume();
		} catch (error) { session.detach(); session.detach = undefined; throw error; }
	};
	const open = async (value: Identity, mcpServers: Record<string, McpServerEntry>, create = false): Promise<Session> => {
		const storePath = join(directory, value.sessionId, "state.sqlite");
		if (!create) {
			try {
				const info = lstatSync(storePath);
				if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error();
			} catch { throw new RpcError("ACP session store unavailable", -32002); }
		}
		if (sessions.size >= MAX_OPEN) invalid("At most 16 sessions may be open; close a session first");
		const runtime = await openRuntime({
			storePath, cwd: value.cwd,
			configPath: options.configPath, provider: options.provider, model: options.model,
			announceOwner: false, redactErrors: true,
			withMcp: Object.keys(mcpServers).length > 0, mcpServers,
		});
		const session: Session = { runtime, pending: false };
		sessions.set(value.sessionId, session);
		return session;
	};
	const closeSession = async (sessionId: string, cancelMain = false) => {
		const session = sessions.get(sessionId);
		if (!session) return;
		if (cancelMain) await session.runtime.root.abort(session.runtime.context);
		session.detach?.();
		await session.runtime.close(); // Harness.close checkpoints tasks, rather than cancelling jobs.
		sessions.delete(sessionId);
	};
	const handle = async ({ id, method, params = {} }: AcpMessage) => {
		if (closing) return;
		if (id !== undefined && typeof id !== "string" && typeof id !== "number") return;
		const reply = (result: unknown) => { if (id !== undefined) send({ id, result }); };
		const error = (failure: unknown) => {
			if (id !== undefined) send({ id, error: { code: failure instanceof RpcError ? failure.code : -32603, message: failure instanceof RpcError ? failure.message : "ACP operation failed (details redacted)" } });
		};
		try {
			if (!object(params)) invalid("params must be an object");
			if (method === "initialize") {
				if (initialized) invalid("Already initialized");
				if (!Number.isInteger(params.protocolVersion)) invalid("protocolVersion must be an integer");
				initialized = true;
				reply({ protocolVersion: 1, agentInfo: { name: "durable-chat", version: PACKAGE_VERSION }, agentCapabilities: { loadSession: true, mcpCapabilities: { http: false, sse: false }, sessionCapabilities: { list: {}, close: {} } }, authMethods: [] });
				return;
			}
			if (!initialized) throw new RpcError("Initialize first", -32600);
			if (method === "session/list") {
				const values = readdirSync(directory).filter((name) => ID.test(name)).sort().flatMap((name) => {
					try { const value = identity(name); return !params.cwd || params.cwd === value.cwd ? [{ sessionId: value.sessionId, cwd: value.cwd, title: "dchat ACP session" }] : []; } catch { return []; }
				});
				const offset = params.cursor === undefined ? 0 : Number(params.cursor);
				if (!Number.isSafeInteger(offset) || offset < 0 || offset > values.length) invalid("Invalid list cursor");
				reply({ sessions: values.slice(offset, offset + 100), ...(offset + 100 < values.length ? { nextCursor: String(offset + 100) } : {}) });
				return;
			}
			if (method === "session/new" || method === "session/load") {
				if (params.systemPrompt != null || (params.additionalDirectories != null && (!Array.isArray(params.additionalDirectories) || params.additionalDirectories.length > 0))) invalid("Custom systemPrompt and additionalDirectories are unsupported");
				const cwd = sessionCwd(params.cwd);
				const mcpServers = acpMcpServers(params.mcpServers, cwd);
				if (options.noMcp && Object.keys(mcpServers).length > 0) invalid("Forwarded MCP servers are disabled by --no-mcp");
				const mcpHash = fingerprint(mcpServers);
				if (method === "session/new") {
					if (sessions.size >= MAX_OPEN) invalid("At most 16 sessions may be open; close a session first");
					const sessionId = `acp-${randomUUID()}`;
					const path = join(directory, sessionId);
					mkdirSync(path, { mode: 0o700 });
					const value: Identity = { version: 1, sessionId, cwd, mcpHash };
					writeFileSync(join(path, "session.json"), JSON.stringify(value), { flag: "wx", mode: 0o600 });
					try {
						const session = await open(value, mcpServers, true);
						await attach(sessionId, session);
						reply({ sessionId });
					} catch (failure) { await closeSession(sessionId); rmSync(path, { recursive: true, force: true }); throw failure; }
				} else {
					const value = identity(params.sessionId);
					if (value.cwd !== cwd || value.mcpHash !== mcpHash) invalid("Load requires the original cwd and identical MCP configuration");
					const session = sessions.get(value.sessionId) ?? await open(value, mcpServers);
					try { await attach(value.sessionId, session); }
					catch (failure) { await closeSession(value.sessionId); throw failure; }
					reply({});
				}
				return;
			}
			const value = identity(params.sessionId);
			const session = sessions.get(value.sessionId);
			if (method === "session/close") { await closeSession(value.sessionId, true); reply({}); return; }
			if (!session) throw new RpcError("Load session first", -32002);
			if (method === "session/cancel") { await session.runtime.root.abort(session.runtime.context); return; }
			if (method !== "session/prompt") throw new RpcError("Unsupported ACP method", -32601);
			if (session.pending) invalid("Session already has an active prompt");
			if (!Array.isArray(params.prompt) || params.prompt.length === 0) invalid("Nonempty prompt required");
			const content = params.prompt.map((block: unknown) => {
				if (object(block) && block.type === "text" && typeof block.text === "string") return block.text;
				if (object(block) && block.type === "resource_link" && typeof block.uri === "string") return `${typeof block.name === "string" ? block.name : "Resource"}: ${block.uri}`;
				return invalid("Only text and resource_link prompts are supported");
			}).join("\n");
			if (content.length > 100_000) invalid("Input exceeds 100000 characters");
			const { runtime } = session;
			// The public submit API atomically persists input and its durable submission.
			const submission = await runtime.root.submit({ type: "input", content, whenBusy: "followUp", requestId: `acp:${randomUUID()}` }, runtime.context);
			session.pending = true;
			// Only admission is serialized; cancel/other sessions remain responsive during a run.
			void submission.wait(runtime.context).then((settled) => {
				if (settled.status === "done") reply({ stopReason: "end_turn" });
				else if (settled.reason === "aborted") reply({ stopReason: "cancelled" });
				else error(new Error());
			}).catch(error).finally(() => { session.pending = false; });
		} catch (failure) { error(failure); }
	};
	function shutdown() {
		if (closing) return;
		closing = true;
		process.stdin.pause();
		// Wait for admitted opens before closing, including MCP children created during startup.
		void admission.then(async () => {
			const results = await Promise.allSettled([...sessions.keys()].map((sessionId) => closeSession(sessionId)));
			if (results.some((result) => result.status === "rejected")) {
				process.stderr.write("ACP shutdown failed (details redacted)\n");
				process.exitCode = 1;
			}
		}).finally(() => { release(); finish(); });
	}
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
	process.stdin.once("end", shutdown);
	process.stdin.once("error", shutdown);
	process.stdout.once("error", shutdown);
	try {
		readFrames(process.stdin, (message) => {
			admission = admission.then(() => handle(message)).catch(() => shutdown());
		}, () => { process.stderr.write("Invalid ACP frame\n"); process.exitCode = 1; shutdown(); });
		await finished;
	} finally {
		process.off("SIGINT", shutdown);
		process.off("SIGTERM", shutdown);
		process.stdin.off("end", shutdown);
		process.stdin.off("error", shutdown);
		process.stdout.off("error", shutdown);
	}
}
