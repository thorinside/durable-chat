import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createConnection } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// This file runs in its own test process. Neither owner nor stdio child may inherit
// credentials, user configuration, repository instructions, MCP or provider settings.
const directory = mkdtempSync("/tmp/dchat-acp-compat-");
const clean = {
	PATH: process.env.PATH!, HOME: join(directory, "home"),
	XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data"),
	DCHAT_IPC_DIR: join(directory, "ipc"), TMPDIR: directory,
};
for (const path of [...Object.values(clean).slice(1), join(directory, "cwd")])
	mkdirSync(path, { recursive: true, mode: 0o700 });
// Keep only Node's test-runner coordination in the parent (never in the child).
for (const key of Object.keys(process.env))
	if (key !== "NODE_TEST_CONTEXT") delete process.env[key];
Object.assign(process.env, clean);
process.chdir(join(directory, "cwd"));
process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
const { openRuntime } = await import("../src/harness.ts");
const { ownerAddress, readFrames, SHARED_MAIN } = await import("../src/acp.ts");
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
type Frame = Record<string, any>;

function peer(input: NodeJS.ReadableStream, output: NodeJS.WritableStream) {
	const frames: Frame[] = [];
	const listeners = new Set<() => void>();
	let failure: Error | undefined;
	readFrames(input, (frame) => {
		frames.push(frame);
		for (const listener of listeners) listener();
	}, (error) => { failure = error; for (const listener of listeners) listener(); });
	input.on("end", () => {
		failure = new Error("ACP transport ended before expected event");
		for (const listener of listeners) listener();
	});
	const wait = (predicate: (frame: Frame) => boolean, start = 0) =>
		new Promise<Frame>((resolve, reject) => {
			// A bounded deadline for real socket/child events, not simulated model pacing.
			const timer = setTimeout(() => finish(new Error("ACP event deadline exceeded")), 10_000);
			const finish = (error?: Error, frame?: Frame) => {
				clearTimeout(timer);
				listeners.delete(check);
				if (error) reject(error); else resolve(frame!);
			};
			const check = () => {
				const frame = frames.slice(start).find(predicate);
				if (frame) finish(undefined, frame);
				else if (failure) finish(failure);
			};
			listeners.add(check);
			check();
		});
	let next = 0;
	const notify = (method: string, params: object) =>
		output.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	const request = (method: string, params: object = {}, id: string | number = ++next) => {
		const start = frames.length;
		output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		return wait((frame) => frame.id === id, start);
	};
	const ok = async (method: string, params: object = {}, id?: string | number) => {
		const frame = await request(method, params, id);
		assert.equal(frame.error, undefined);
		return frame.result;
	};
	return { frames, wait, request, ok, notify };
}
type Peer = ReturnType<typeof peer>;
const updates = (frames: Frame[]) => frames.filter((f) => f.method === "session/update").map((f) => f.params.update);
const agents = (frames: Frame[]) => updates(frames).filter((u) => u.sessionUpdate === "agent_message_chunk");
const answer = (input: string) => `Offline faux model. You said: ${input}\n\nSet DURABLE_PROVIDER=openai and DURABLE_MODEL_ID for a real model, or send "task: <objective>" to create a durable task.`;
const prompt = (sessionId: string, text: string, requestId?: unknown) => ({
	sessionId, prompt: [{ type: "text", text }],
	...(requestId === undefined ? {} : { _meta: { [SHARED_MAIN]: { requestId } } }),
});
async function attach(client: Peer, capabilities: object = {}) {
	const initialized = await client.ok("initialize", { protocolVersion: 1, clientCapabilities: capabilities });
	assert.equal(initialized.protocolVersion, 1);
	assert.equal(initialized.agentCapabilities.loadSession, true);
	assert.deepEqual(initialized.agentCapabilities.sessionCapabilities.list, {});
	assert.equal(initialized.agentCapabilities._meta[SHARED_MAIN].version, 1);
	const listed = await client.ok("session/list");
	assert.equal(listed.sessions.length, 1);
	const { sessionId, cwd } = listed.sessions[0];
	const load = { sessionId, cwd, mcpServers: [] };
	assert.deepEqual(await client.ok("session/load", load), {});
	return { sessionId, load };
}
async function fixture(t: TestContext) {
	const config = join(directory, "offline.yaml");
	const store = join(directory, "state.sqlite");
	writeFileSync(config, `provider: faux\ncodemode: false\nstore: ${JSON.stringify(store)}\nmcp:\n  enabled: false\n`);
	const runtime = await openRuntime({ configPath: config, provider: "faux", withMcp: false });
	t.after(async () => {
		await runtime.close();
		for (const suffix of ["", "-wal", "-shm", ".lock"])
			rmSync(`${store}${suffix}`, { force: true });
	});
	const endpoint = ownerAddress(store);
	const frontend = spawn(process.execPath, [cli, "acp", "--endpoint", endpoint], {
		env: clean, cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"],
	});
	frontend.stderr.resume(); // Diagnostics never enter the protocol projection.
	t.after(() => frontend.kill());
	return { runtime, endpoint, frontend, generic: peer(frontend.stdout, frontend.stdin) };
}
function oneAnswer(frames: Frame[], expected: string) {
	const chunks = agents(frames);
	assert.equal(chunks.map((u) => u.content.text).join(""), expected, "append-only projection must not repeat a live prefix");
	const messages = new Map<string, string>();
	for (const chunk of chunks)
		messages.set(chunk.messageId, (messages.get(chunk.messageId) ?? "") + chunk.content.text);
	assert.deepEqual([...messages.values()], [expected], "standard messageId projection must contain exactly one answer");
	assert.ok(chunks.every((u) => !u._meta?.[SHARED_MAIN]?.live));
	return chunks[0].messageId;
}

// Existing tests always supplied private IDs and checked only .some(includes(input)).
// Raw stdio frames, exact append/ID projections and the response barrier expose both gaps.
test("standard ACP prompts need no private key and emit one committed answer before end_turn and on replay", { timeout: 25_000 }, async (t) => {
	const { generic, frontend } = await fixture(t);
	const { sessionId, load } = await attach(generic);
	const input = "standard ACP admission";
	const start = generic.frames.length;
	assert.deepEqual(await generic.ok("session/prompt", prompt(sessionId, input), "reused-rpc-id"), { stopReason: "end_turn" });
	const turn = generic.frames.slice(start);
	const messageId = oneAnswer(turn, answer(input));
	assert.equal(turn.at(-1)!.id, "reused-rpc-id", "committed output must precede prompt completion");
	assert.equal(updates(turn).filter((u) => u.sessionUpdate === "user_message_chunk").length, 1);
	const accepted = updates(turn).filter((u) => u._meta?.[SHARED_MAIN]?.status === "accepted");
	assert.equal(accepted.length, 1);
	assert.match(accepted[0]._meta[SHARED_MAIN].requestId, /^[0-9a-f-]{36}$/);

	const replay = generic.frames.length;
	await generic.ok("session/load", load);
	assert.equal(oneAnswer(generic.frames.slice(replay), answer(input)), messageId);
	// RPC correlation IDs are explicitly not durable retry keys: this is a second admission.
	const second = generic.frames.length;
	await generic.ok("session/prompt", prompt(sessionId, input), "reused-rpc-id");
	oneAnswer(generic.frames.slice(second), answer(input));
	const secondKey = updates(generic.frames.slice(second)).find((u) => u._meta?.[SHARED_MAIN]?.status === "accepted")._meta[SHARED_MAIN].requestId;
	assert.notEqual(secondKey, accepted[0]._meta[SHARED_MAIN].requestId);
	assert.equal(updates(generic.frames.slice(second)).filter((u) => u.sessionUpdate === "user_message_chunk").length, 1);
	frontend.stdin.end();
	await once(frontend, "exit");
});

test("supplied ACP admission keys retain deduplication and invalid keys or ownership changes never admit input", { timeout: 25_000 }, async (t) => {
	const { generic } = await fixture(t);
	// Advertising another version must not opt in to disposable shared-Main chunks.
	const { sessionId, load } = await attach(generic, { _meta: { [SHARED_MAIN]: { version: 2 } } });
	const input = "keyed admission";
	const start = generic.frames.length;
	await generic.ok("session/prompt", prompt(sessionId, input, "stable-key"));
	oneAnswer(generic.frames.slice(start), answer(input));
	const retry = generic.frames.length;
	await generic.ok("session/prompt", prompt(sessionId, input, "stable-key"));
	assert.equal(agents(generic.frames.slice(retry)).length, 0);
	assert.equal(updates(generic.frames.slice(retry)).filter((u) => u.sessionUpdate === "user_message_chunk").length, 0);
	const invalid = generic.frames.length;
	for (const key of [null, "", 1, "x".repeat(129)]) {
		const reply = await generic.request("session/prompt", prompt(sessionId, "not admitted", key));
		assert.equal(reply.error.code, -32602);
		assert.equal(JSON.stringify(reply).includes("not admitted"), false);
	}
	assert.match((await generic.request("session/prompt", prompt(sessionId, "different", "stable-key"))).error.message, /different input/);
	assert.equal((await generic.request("session/prompt", prompt("job:1", "not admitted"))).error.code, -32002);
	assert.equal((await generic.request("session/load", { ...load, cwd: directory })).error.code, -32602);
	assert.equal((await generic.request("session/load", { ...load, mcpServers: [{ name: "forbidden", command: "unused", args: [], env: [] }] })).error.code, -32602);
	assert.match((await generic.request("session/new", { cwd: load.cwd, mcpServers: [] })).error.message, /Creation disabled/);
	assert.equal(updates(generic.frames.slice(invalid)).filter((u) => u.sessionUpdate === "user_message_chunk").length, 0);
	const replay = generic.frames.length;
	await generic.ok("session/load", load);
	oneAnswer(generic.frames.slice(replay), answer(input));
});

test("shared-Main v1 keeps disposable streaming and cleanup while generic load and cancellation never expose live prefixes", { timeout: 25_000 }, async (t) => {
	const { generic, endpoint } = await fixture(t);
	const { sessionId, load } = await attach(generic);
	const socket = createConnection(endpoint);
	t.after(() => socket.destroy());
	const shared = peer(socket, socket);
	await attach(shared, { session: { notices: {} }, _meta: { [SHARED_MAIN]: { version: 1 } } });
	const input = "profile still streams";
	const sharedStart = shared.frames.length;
	const genericStart = generic.frames.length;
	assert.deepEqual(await shared.ok("session/prompt", prompt(sessionId, input, "profile-key")), { stopReason: "end_turn" });
	const sharedTurn = shared.frames.slice(sharedStart);
	const live = agents(sharedTurn).filter((u) => u._meta?.[SHARED_MAIN]?.live);
	assert.ok(live.length > 0);
	assert.ok(answer(input).startsWith(live.map((u) => u.content.text).join("")));
	assert.equal(new Set(live.map((u) => u.messageId)).size, 1);
	assert.equal(agents(sharedTurn).filter((u) => !u._meta?.[SHARED_MAIN]?.live).map((u) => u.content.text).join(""), answer(input));
	assert.equal(updates(sharedTurn).at(-1)!._meta[SHARED_MAIN].activeMessageId, null);
	// Model the negotiated cleanup semantics (not a standard messageId replacement rule).
	const projected = new Map<string, string>();
	const disposable = new Set<string>();
	for (const update of updates(sharedTurn)) {
		const meta = update._meta?.[SHARED_MAIN];
		if (update.sessionUpdate === "agent_message_chunk") {
			projected.set(update.messageId, (projected.get(update.messageId) ?? "") + update.content.text);
			if (meta?.live) disposable.add(update.messageId);
		} else if (meta && Object.hasOwn(meta, "activeMessageId")) {
			for (const id of disposable) if (id !== meta.activeMessageId) { projected.delete(id); disposable.delete(id); }
		}
	}
	assert.deepEqual([...projected.values()], [answer(input)]);
	await generic.wait((f) => f.params?.update?.sessionUpdate === "agent_message_chunk" && f.params.update.content.text === answer(input), genericStart);
	oneAnswer(generic.frames.slice(genericStart), answer(input));

	// The negotiated stream is an actual running-generation gate; no sleeps or polling.
	const running = shared.frames.length;
	const cancelStart = generic.frames.length;
	const completing = generic.ok("session/prompt", prompt(sessionId, "cancel before commit"));
	const liveFrame = await shared.wait((f) => f.params?.update?._meta?.[SHARED_MAIN]?.live === true, running);
	const loading = generic.frames.length;
	await generic.ok("session/load", load); // replay while a generation is active
	assert.equal(agents(generic.frames.slice(loading)).some((u) => u._meta?.[SHARED_MAIN]?.live), false);
	generic.notify("session/cancel", { sessionId });
	assert.deepEqual(await completing, { stopReason: "cancelled" });
	await shared.wait((f) => f.params?.update?._meta?.[SHARED_MAIN]?.state === "idle", shared.frames.indexOf(liveFrame) + 1);
	const cancelled = generic.frames.slice(cancelStart);
	// Native abort commits its public partial answer. It is not a disposable live
	// chunk, and must appear once, with the same ID/content on subsequent replay.
	assert.equal(agents(cancelled).length, 2);
	assert.equal(agents(cancelled)[0].content.text, answer(input));
	const partial = agents(cancelled)[1];
	assert.ok(partial.content.text.length > 0);
	assert.ok(answer("cancel before commit").startsWith(partial.content.text));
	assert.equal(agents(cancelled).some((u) => u._meta?.[SHARED_MAIN]?.live), false);
	assert.equal(new Set(agents(cancelled).map((u) => u.messageId)).size, 2);
	const replay = generic.frames.length;
	await generic.ok("session/load", load);
	assert.deepEqual(agents(generic.frames.slice(replay)), agents(cancelled));
	// Cancellation ends the turn, not attachment or the owner's ability to accept new input.
	const after = generic.frames.length;
	await generic.ok("session/prompt", prompt(sessionId, "after cancellation"));
	oneAnswer(generic.frames.slice(after), answer("after cancellation"));
});

// A terminal Harness failure must settle the standard RPC without projecting private
// system/model diagnostics as answer text; a rejected-parameter test cannot cover it.
test("generic ACP terminal failures return a public reason without leaking owner instructions or model diagnostics", { timeout: 25_000 }, async (t) => {
	const { runtime, generic } = await fixture(t);
	const { sessionId, load } = await attach(generic);
	const secret = "synthetic-private-owner-canary";
	await runtime.root.configure({
		instructions: secret,
		model: { provider: "faux", modelId: secret },
	}, runtime.context);
	const start = generic.frames.length;
	const failed = await generic.request("session/prompt", prompt(sessionId, "unavailable model"));
	assert.deepEqual(failed.error, { code: -32603, message: "Main did not answer: no_model" });
	assert.equal(agents(generic.frames.slice(start)).length, 0);
	await generic.ok("session/load", load);
	assert.equal(agents(generic.frames.slice(start)).length, 0);
	assert.equal(JSON.stringify(generic.frames).includes(secret), false);
});
