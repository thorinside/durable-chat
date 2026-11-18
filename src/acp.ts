import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	realpathSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LiveDoc, defineDoc } from "@earendil-works/pi-durable";
import type {
	ConversationView,
	EntryRecord,
	Submission,
} from "@earendil-works/pi-durable";
import { resolveConfig } from "./config.ts";
import type { AppRuntime } from "./harness.ts";

export const SHARED_MAIN = "io.github.thorinside.durable-chat/shared-main";
const MAX_FRAME = 4 * 1024 * 1024;
const MAX_OUTPUT = 8 * 1024 * 1024;
type RecordValue = Record<string, any>;
export type AcpMessage = {
	jsonrpc?: string;
	id?: string | number;
	method?: string;
	params?: RecordValue;
	result?: unknown;
	error?: unknown;
};
const Requests = defineDoc<{
	requests: Record<string, { hash: string; submission: number }>;
}>({
	kind: "durable-chat.acp-requests",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ requests: {} }),
	checkpointWhen: () => false,
});
const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");

/** Deterministic per-DB rendezvous, not cwd/process discovery. Never opens storage. */
export function ownerAddress(store: string, directory?: string): string {
	const uid = process.getuid?.();
	if (uid === undefined)
		throw new Error("Local ACP attachment requires Unix user isolation");
	const candidate = directory ?? process.env.XDG_RUNTIME_DIR ?? tmpdir();
	let base = join(candidate, `dchat-${uid}`);
	// Darwin's socket path limit is short; the fallback remains a private, checked directory.
	if (Buffer.byteLength(base) > 65) base = `/tmp/dchat-${uid}`;
	try {
		mkdirSync(base, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const info = lstatSync(base);
	if (
		!info.isDirectory() ||
		info.isSymbolicLink() ||
		info.uid !== uid ||
		(info.mode & 0o077) !== 0
	)
		throw new Error("Unsafe dchat IPC directory");
	return join(base, `${hash(realpathSync(resolve(store))).slice(0, 24)}.sock`);
}

export function readFrames(
	socket: NodeJS.ReadableStream,
	receive: (message: AcpMessage) => void,
	fail: (error: Error) => void,
): void {
	let buffer = "";
	socket.setEncoding?.("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		if (Buffer.byteLength(buffer) > MAX_FRAME) {
			fail(new Error("ACP frame exceeds limit"));
			return;
		}
		for (;;) {
			const end = buffer.indexOf("\n");
			if (end < 0) break;
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			try {
				const message = JSON.parse(line);
				if (!message || Array.isArray(message) || message.jsonrpc !== "2.0")
					throw new Error("Invalid ACP frame");
				receive(message);
			} catch {
				fail(new Error("Invalid ACP JSON-RPC frame"));
				return;
			}
		}
	});
}

function text(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content)
		? content
				.flatMap((block) => (block?.type === "text" ? [block.text] : []))
				.join("")
		: "";
}

/** Public Main-only translation. Private reasoning/system entries and child conversations never enter this projection. */
export function entryUpdates(
	entry: EntryRecord,
	toolIds = new Map<string, string>(),
): RecordValue[] {
	if (entry.kind === "pi.system") return [];
	const result: RecordValue[] = [];
	for (const [index, message] of (entry.model ?? []).entries()) {
		const id = `entry:${entry.id}:${index}`;
		if (message.role === "user" || message.role === "assistant") {
			const value = text(message.content);
			if (value)
				result.push({
					sessionUpdate:
						message.role === "user"
							? "user_message_chunk"
							: "agent_message_chunk",
					messageId: id,
					content: { type: "text", text: value },
				});
			if (message.role === "assistant")
				for (const [blockIndex, block] of message.content.entries())
					if (block.type === "toolCall") {
						const toolCallId = `call:${entry.id}:${index}:${blockIndex}`;
						toolIds.set(block.id, toolCallId);
						result.push({
							sessionUpdate: "tool_call",
							toolCallId,
							title: block.name,
							name: block.name,
							kind: "other",
							status: "pending",
							rawInput: block.arguments,
						});
					}
		} else if (message.role === "toolResult") {
			const toolCallId = toolIds.get(message.toolCallId);
			if (!toolCallId)
				throw new Error("Main tool result has no preceding native call");
			result.push({
				sessionUpdate: "tool_call_update",
				toolCallId,
				status: message.isError ? "failed" : "completed",
				content: [
					{
						type: "content",
						content: { type: "text", text: text(message.content) },
					},
				],
			});
		}
	}
	return result;
}

export function mainSessionCheck(sessionId: unknown, expected: string): void {
	if (sessionId !== expected)
		throw Object.assign(new Error("Unknown Main session"), { rpcCode: -32002 });
}

/** The existing DB owner serves ACP; every frontend is just a pipe to this endpoint. */
export async function serveMain(
	runtime: AppRuntime,
): Promise<() => Promise<void>> {
	const address = ownerAddress(runtime.storePath);
	const db = statSync(runtime.storePath);
	const sessionId = `main:${hash(`${realpathSync(runtime.storePath)}:${db.ino}:${db.birthtimeMs}`).slice(0, 32)}`;
	const runtimeId = randomUUID();
	const sockets = new Set<Socket>();
	// Only called after acquiring the store's exclusive owner lock. A prior owner's stale socket is not another runtime.
	try {
		const old = lstatSync(address);
		if (!old.isSocket() || old.uid !== process.getuid!())
			throw new Error("Unsafe dchat IPC endpoint");
		await new Promise<void>((resolve, reject) => {
			const probe = createConnection(address);
			probe.setTimeout(1000, () => {
				probe.destroy();
				reject(new Error("Cannot verify stale ACP endpoint"));
			});
			probe.once("connect", () => {
				probe.destroy();
				reject(new Error("This state already has a live ACP owner"));
			});
			probe.once("error", (error: NodeJS.ErrnoException) => {
				probe.destroy();
				if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve();
				else reject(error);
			});
		});
		if (lstatSync(address).ino !== old.ino)
			throw new Error("ACP endpoint changed during owner registration");
		unlinkSync(address);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const server = createServer((socket) => {
		sockets.add(socket);
		let initialized = false;
		let loaded = false;
		let detach: (() => void) | undefined;
		let loading = false;
		let pendingViews: ConversationView[] = [];
		const seen = new Set<number>();
		const chunks = new Map<string, string>();
		const toolIds = new Map<string, string>();
		let latestRun: string | null = null;
		const send = (message: AcpMessage) => {
			if (socket.destroyed) return;
			if (socket.writableLength > MAX_OUTPUT) {
				socket.destroy(
					new Error("ACP consumer too slow; reconnect and load history"),
				);
				return;
			}
			socket.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
		};
		const update = (value: RecordValue) =>
			send({ method: "session/update", params: { sessionId, update: value } });
		const entries = (values: readonly EntryRecord[]) => {
			for (const entry of values) {
				if (seen.has(Number(entry.id))) continue;
				seen.add(Number(entry.id));
				for (const value of entryUpdates(entry, toolIds)) update(value);
			}
		};
		const view = (value: ConversationView) => {
			entries(value.entries);
			const live = value.docs["pi.live"] as RecordValue | undefined;
			latestRun = live?.run ? String(live.run.taskId) : null;
			const generation = live?.generation;
			const activeMessageId = generation?.message
				? `live:${latestRun}:${generation.attempt}`
				: null;
			if (generation?.message) {
				const id = `live:${latestRun}:${generation.attempt}`;
				const current = text(generation.message.content);
				const before = chunks.get(id) ?? "";
				if (current.startsWith(before) && current.length > before.length)
					update({
						sessionUpdate: "agent_message_chunk",
						messageId: id,
						content: { type: "text", text: current.slice(before.length) },
						_meta: { [SHARED_MAIN]: { live: true } },
					});
				chunks.set(id, current);
			}
			update({
				sessionUpdate: "session_info_update",
				_meta: {
					[SHARED_MAIN]: {
						runtimeId,
						activeRunId: latestRun,
						state: live?.run ? "running" : "idle",
						permissionOwner: "terminal",
						activeMessageId,
					},
				},
			});
		};
		const stopObserving = () => {
			detach?.();
			detach = undefined;
		};
		const attach = async () => {
			stopObserving();
			// A reload replaces the stream; until it completes, this socket has no loaded Main.
			loaded = false;
			loading = true;
			pendingViews = [];
			seen.clear();
			chunks.clear();
			toolIds.clear();
			try {
				await replay();
			} catch (error) {
				// A failed replay must not keep observing and buffering views nobody will receive.
				stopObserving();
				loading = false;
				pendingViews = [];
				throw error;
			}
		};
		const replay = async () => {
			const observation = await runtime.harness.observeConversation(
				runtime.root.id,
				{
					advance(call) {
						if (call.kind !== "value") return;
						if (loading) {
							if (pendingViews.length >= 2048)
								socket.destroy(new Error("ACP replay overflow; retry load"));
							else pendingViews.push(call.value);
						} else {
							try {
								view(call.value);
							} catch {
								socket.destroy(new Error("Invalid Main history contract"));
							}
						}
					},
					end() {
						socket.end();
					},
				},
				runtime.context,
			);
			detach = observation.detach;
			if (socket.destroyed) {
				detach();
				return;
			}
			const initial = observation.value;
			if (initial.before !== undefined) {
				let cursor;
				do {
					const page = await runtime.root.entries(
						{ order: "ascending", maxEntryId: initial.before },
						128,
						cursor,
						runtime.context,
					);
					for (const entry of page.items) {
						entries([entry]);
						if (socket.writableNeedDrain)
							await new Promise<void>((resolve) => {
								const finish = () => {
									socket.off("drain", finish);
									socket.off("close", finish);
									resolve();
								};
								socket.once("drain", finish);
								socket.once("close", finish);
							});
					}
					cursor = page.next;
					if (socket.destroyed) return;
				} while (cursor !== undefined);
			}
			view(initial);
			for (const next of pendingViews) view(next);
			pendingViews = [];
			loading = false;
			loaded = true;
		};
		// Serialize admission, not long-running prompt waits: stop/new input must remain responsive.
		let admission = Promise.resolve();
		const handle = async (message: AcpMessage) => {
			const { id, method, params = {} } = message;
			const reply = (result: unknown) => {
				if (id !== undefined) send({ id, result });
			};
			try {
				if (method === "initialize") {
					if (initialized) throw new Error("Already initialized");
					initialized = true;
					reply({
						protocolVersion: 1,
						agentInfo: { name: "durable-chat", version: "1.0.0" },
						agentCapabilities: {
							loadSession: true,
							sessionCapabilities: { list: {} },
							_meta: { [SHARED_MAIN]: { version: 1 } },
						},
						authMethods: [],
						_meta: { [SHARED_MAIN]: { runtimeId } },
					});
					return;
				}
				if (!initialized)
					throw Object.assign(new Error("Initialize first"), {
						rpcCode: -32600,
					});
				if (method === "session/list") {
					reply({
						sessions:
							params.cwd && params.cwd !== runtime.cwd
								? []
								: [{ sessionId, cwd: runtime.cwd, title: "dchat Main" }],
					});
					return;
				}
				if (method === "session/new")
					throw new Error(
						"Creation disabled: attach existing Main using session/list and session/load",
					);
				mainSessionCheck(params.sessionId, sessionId);
				if (method === "session/load") {
					if (
						params.cwd !== runtime.cwd ||
						!Array.isArray(params.mcpServers) ||
						params.mcpServers.length > 0 ||
						params.systemPrompt ||
						params.additionalDirectories?.length
					)
						throw Object.assign(
							new Error(
								"Attach preserves owner's cwd, instructions and MCP tools",
							),
							{ rpcCode: -32602 },
						);
					await attach();
					reply({});
					return;
				}
				if (!loaded)
					throw Object.assign(new Error("Load Main first"), {
						rpcCode: -32002,
					});
				if (method === "session/cancel") {
					const expected = params._meta?.[SHARED_MAIN];
					if (expected?.runtimeId && expected.runtimeId !== runtimeId) return;
					// Native scope, including queued input on either frontend; never background job tasks.
					const completion = runtime.root.abort(runtime.context);
					void completion.catch(() => socket.destroy());
					return;
				}
				if (method !== "session/prompt")
					throw Object.assign(new Error("Unsupported ACP method"), {
						rpcCode: -32601,
					});
				if (!Array.isArray(params.prompt) || params.prompt.length === 0)
					throw Object.assign(new Error("Nonempty prompt required"), {
						rpcCode: -32602,
					});
				const content = params.prompt
					.map((block: RecordValue) => {
						if (block.type === "text" && typeof block.text === "string")
							return block.text;
						if (block.type === "resource_link" && typeof block.uri === "string")
							return `${block.name ?? "Resource"}: ${block.uri}`;
						throw Object.assign(
							new Error("Only text and resource_link prompts are supported"),
							{ rpcCode: -32602 },
						);
					})
					.join("\n");
				const key = params._meta?.[SHARED_MAIN]?.requestId;
				if (typeof key !== "string" || key.length > 128 || !key)
					throw Object.assign(
						new Error("A shared-main requestId is required for safe admission"),
						{ rpcCode: -32602 },
					);
				if (content.length > 100_000)
					throw Object.assign(
						new Error("Main input exceeds 100000 characters"),
						{ rpcCode: -32602 },
					);
				const fingerprint = hash(content);
				let submissionId = 0;
				await runtime.root.commit(async (tx) => {
					const requests = await tx.doc(Requests, runtime.root.id);
					const existing = requests.requests[key];
					if (existing && existing.hash !== fingerprint)
						throw new Error("requestId already identifies different input");
					submissionId =
						existing?.submission ??
						Number(
							await runtime.root.submit(tx, {
								type: "input",
								content,
								whenBusy: "followUp",
								requestId: `acp:${key}`,
							}),
						);
					if (!existing)
						requests.requests[key] = {
							hash: fingerprint,
							submission: submissionId,
						};
				}, runtime.context);
				update({
					sessionUpdate: "session_info_update",
					_meta: {
						[SHARED_MAIN]: { requestId: key, submissionId, status: "accepted" },
					},
				});
				const submission = await runtime.harness.submission(
					submissionId as Submission["id"],
					runtime.context,
				);
				void submission!
					.wait(runtime.context)
					.then((settled) => {
						if (settled.status === "done") reply({ stopReason: "end_turn" });
						else if (settled.reason === "aborted")
							reply({ stopReason: "cancelled" });
						else
							send({
								id,
								error: {
									code: -32603,
									message: `Main did not answer: ${settled.reason}`,
								},
							});
					})
					.catch(() => {
						if (!socket.destroyed)
							send({
								id,
								error: { code: -32603, message: "Main owner unavailable" },
							});
					});
			} catch (error) {
				if (id !== undefined)
					send({
						id,
						error: {
							code: (error as { rpcCode?: number }).rpcCode ?? -32603,
							message:
								error instanceof Error ? error.message : "ACP operation failed",
						},
					});
			}
		};
		readFrames(
			socket,
			(message) => {
				admission = admission
					.then(() => handle(message))
					.catch(() => {
						socket.destroy();
					});
			},
			() => {
				socket.destroy();
			},
		);
		socket.on("error", () => {});
		socket.on("close", () => {
			detach?.();
			sockets.delete(socket);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(address, () => {
			chmodSync(address, 0o600);
			resolve();
		});
	});
	return async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		try {
			unlinkSync(address);
		} catch {}
	};
}

/** Stdio frontend: config resolution + private pipe only; deliberately has no openRuntime dependency. */
export async function acpFrontend(
	options: { store?: string; configPath?: string } = {},
): Promise<void> {
	const config = resolveConfig(options);
	const address = ownerAddress(config.storePath);
	const stat = lstatSync(address);
	if (
		!stat.isSocket() ||
		stat.uid !== process.getuid!() ||
		(stat.mode & 0o077) !== 0
	)
		throw new Error("Unsafe dchat owner socket");
	const socket = createConnection(address);
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	process.stdin.pipe(socket);
	socket.pipe(process.stdout);
	await new Promise<void>((resolve, reject) => {
		socket.on("error", reject);
		socket.on("close", resolve);
	});
	process.stdin.unpipe(socket);
	process.stdin.pause();
}
