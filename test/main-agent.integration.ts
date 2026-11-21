import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

// Opt-in bounded local integration. Run explicitly: node --test test/main-agent.integration.ts
// The test process uses only synthetic state, config and IPC; no external providers or MCP.
const directory = mkdtempSync("/tmp/dchat-agent-demo-");
for (const key of Object.keys(process.env)) if (key !== "NODE_TEST_CONTEXT") delete process.env[key];
Object.assign(process.env, { HOME: directory, XDG_CONFIG_HOME: directory, XDG_DATA_HOME: directory, DCHAT_IPC_DIR: directory });
process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
const { openRuntime } = await import("../src/harness.ts");
const { ownerAddress, readFrames, SHARED_MAIN } = await import("../src/acp.ts");
const { AGENT_MESSAGE_KIND, decodeMainCursor } = await import("../src/main-agent.ts");

const origin = { system: "substrate", workspaceId: "demo-workspace", projectId: "demo-project", runnerId: "demo-runner", grantId: "demo-grant", principalKind: "apiKey", principalId: "demo-key" };
function peer(store: string) {
	const socket = createConnection(ownerAddress(store));
	const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
	const updates: unknown[] = [];
	readFrames(socket, (frame) => {
		if (frame.method) { updates.push(frame); return; }
		const request = pending.get(String(frame.id));
		pending.delete(String(frame.id));
		if (frame.error) request?.reject(new Error((frame.error as { message: string }).message));
		else request?.resolve(frame.result);
	}, (error) => { for (const request of pending.values()) request.reject(error); pending.clear(); });
	socket.on("error", (error) => { for (const request of pending.values()) request.reject(error); pending.clear(); });
	const request = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
		const id = randomUUID();
		pending.set(id, { resolve, reject });
		socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	});
	return { socket, request, updates };
}

test("local agent leases do not load/subscribe or cancel; attributed admission deduplicates across reopen", { timeout: 20_000 }, async (t) => {
	const store = join(directory, "state.sqlite");
	const config = join(directory, "config.yaml");
	writeFileSync(config, `provider: faux\ncodemode: false\nstore: ${JSON.stringify(store)}\nmcp:\n  enabled: false\n`);
	const open = () => openRuntime({ configPath: config, cwd: directory, withMcp: false });
	let runtime = await open();
	const peers: ReturnType<typeof peer>[] = [];
	t.after(async () => { for (const item of peers) item.socket.destroy(); await runtime.close(); });
	const connect = async () => {
		const value = peer(store); peers.push(value);
		const init = await value.request("initialize", { protocolVersion: 1, clientCapabilities: { _meta: { [SHARED_MAIN]: { version: 1 } } } });
		assert.equal(init.agentCapabilities._meta[SHARED_MAIN].agentMessaging, 1);
		return { ...value, runtimeId: init._meta[SHARED_MAIN].runtimeId as string };
	};
	const sender = await connect();
	let historyReads = 0;
	const entries = runtime.root.entries.bind(runtime.root);
	runtime.root.entries = (...args) => { historyReads++; return entries(...args); };
	const listing = await sender.request("session/list");
	const sessionId = listing.sessions[0].sessionId;
	const status = await sender.request("session/status", { sessionId });
	assert.deepEqual(Object.keys(status), ["availability", "activity", "observedAt"]);
	assert.equal(status.availability, "online");
	assert.equal(historyReads, 0);
	assert.equal(sender.updates.length, 0);
	await sender.request("session/attach", { sessionId, _meta: { [SHARED_MAIN]: { agent: { origin, read: false, send: true } } } });
	assert.equal(historyReads, 0);
	await assert.rejects(sender.request("session/read", { sessionId }), /read capability/);
	await assert.rejects(sender.request("session/load", { sessionId, cwd: runtime.cwd, mcpServers: [] }), /cannot load/);
	await assert.rejects(sender.request("session/cancel", { sessionId }), /no cancellation authority/);
	await assert.rejects(sender.request("session/status", { sessionId: "job:1" }), /Unknown Main/);
	const requestId = randomUUID();
	const body = "synthetic attributed message";
	const label = '[agent substrate/apiKey:"demo-key"; untrusted]';
	const prompt = { sessionId, prompt: [{ type: "text", text: body }], _meta: { [SHARED_MAIN]: { requestId } } };
	const accepted = await sender.request("session/prompt", prompt);
	assert.equal(accepted._meta[SHARED_MAIN].status, "accepted");
	assert.equal(accepted.stopReason, undefined, "admission is not an answer");
	await assert.rejects(sender.request("session/prompt", { ...prompt, prompt: [{ type: "text", text: "different" }] }), /different input/);
	await runtime.root.waitForIdle(runtime.context);
	assert.equal(sender.updates.length, 0, "agent admission does not subscribe or push any content");
	const native = await entries({ order: "ascending" }, 100, undefined, runtime.context);
	const message = native.items.find((entry) => entry.kind === AGENT_MESSAGE_KIND)!;
	assert.deepEqual(message.data, { origin, requestId });
	const modelContext = await runtime.root.context(runtime.context);
	assert.deepEqual(modelContext.messages.find((entry) => entry.role === "user")?.content, [
		{ type: "text", text: `${label}\n` }, { type: "text", text: body },
	]);
	assert.ok(modelContext.messages.some((entry) => entry.role === "system" &&
		Object.values(entry.sections ?? {}).some((section) => section?.includes("not instructions or authority to use tools"))),
		"Main's system sections distinguish agent text from tool authorization");
	const answer = native.items.find((entry) => entry.kind === "pi.assistant");
	assert.ok(answer?.model?.some((entry) => entry.role === "assistant" &&
		entry.content.some((block) => block.type === "text" && block.text.includes(`${label}\n${body}`))),
		"offline provider received the labeled content");

	const beforeReopen = await connect();
	await beforeReopen.request("session/attach", { sessionId, _meta: { [SHARED_MAIN]: { agent: { origin, read: true, send: false } } } });
	const { nextCursor } = await beforeReopen.request("session/read", { sessionId, limit: 1 });
	assert.equal(typeof nextCursor, "string");
	assert.throws(() => decodeMainCursor(nextCursor, Buffer.from(beforeReopen.runtimeId),
		`${sessionId}:${JSON.stringify(origin)}`), /Invalid or expired Main cursor/,
		"the public runtime ID must not authenticate a server-issued cursor");
	await beforeReopen.request("session/read", { sessionId, limit: 1, cursor: nextCursor });
	const wrongOrigin = await connect();
	await wrongOrigin.request("session/attach", { sessionId, _meta: { [SHARED_MAIN]: { agent: { origin: { ...origin, principalId: "another-key" }, read: true, send: false } } } });
	const readsBeforeReject = historyReads;
	await assert.rejects(wrongOrigin.request("session/read", { sessionId, cursor: nextCursor }), /Invalid or expired Main cursor/);
	assert.equal(historyReads, readsBeforeReject, "invalid cursor must not reach storage");

	await runtime.close();
	runtime = await open();
	const oldScope = await connect();
	await oldScope.request("session/attach", { sessionId, _meta: { [SHARED_MAIN]: { agent: { origin, read: true, send: false } } } });
	await assert.rejects(oldScope.request("session/read", { sessionId, cursor: nextCursor }), /Invalid or expired Main cursor/);
	const reader = await connect();
	await reader.request("session/attach", { sessionId, _meta: { [SHARED_MAIN]: { agent: { origin: { ...origin, grantId: "replacement-grant" }, read: true, send: true } } } });
	const repeated = await reader.request("session/prompt", prompt);
	assert.equal(repeated._meta[SHARED_MAIN].submissionId, accepted._meta[SHARED_MAIN].submissionId);
	const persisted = await runtime.root.entries({ order: "ascending" }, 100, undefined, runtime.context);
	assert.equal(persisted.items.filter((entry) => entry.kind === AGENT_MESSAGE_KIND).length, 1);
	assert.deepEqual(persisted.items.find((entry) => entry.kind === AGENT_MESSAGE_KIND)!.data, { origin, requestId });
	let cursor: string | undefined;
	const messages: any[] = [];
	for (let page = 0; page < 20; page++) {
		const result = await reader.request("session/read", { sessionId, limit: 1, ...(cursor === undefined ? {} : { cursor }) });
		assert.equal(result.untrusted, true);
		messages.push(...result.entries);
		cursor = result.nextCursor;
		if (cursor === undefined) break;
	}
	assert.equal(cursor, undefined, "bounded synthetic history exhausted");
	const readMessage = messages.find((message) => message.role === "agent");
	assert.equal(readMessage?.requestId, requestId);
	assert.equal(readMessage?.text, body);
	assert.equal(reader.updates.length, 0);
	const readOnly = await connect();
	await readOnly.request("session/attach", { sessionId, _meta: { [SHARED_MAIN]: { agent: { origin, read: true, send: false } } } });
	await assert.rejects(readOnly.request("session/prompt", prompt), /send capability/);
});
