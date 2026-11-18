import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Source CLI coverage uses a real Harness, but no inherited credentials, config, stores or MCP.
const root = mkdtempSync("/tmp/dchat-acp-serve-");
const clean = { PATH: process.env.PATH!, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), DCHAT_IPC_DIR: join(root, "ipc"), TMPDIR: root };
for (const path of Object.values(clean).slice(1)) mkdirSync(path, { recursive: true, mode: 0o700 });
for (const key of Object.keys(process.env)) if (key !== "NODE_TEST_CONTEXT") delete process.env[key];
Object.assign(process.env, clean);
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const { openRuntime } = await import("../src/harness.ts");
const { readFrames, listMains } = await import("../src/acp.ts");
const { scanJobs, findJobConversation } = await import("../src/jobs.ts");
const { AgentDoc, createSession } = await import("@earendil-works/pi-durable");
const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
const { BACKGROUND_CONTEXT: context } = await import("@earendil-works/chord/context");
const { fauxAssistantMessage, fauxText } = await import("@earendil-works/pi-ai/providers/faux");
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
type Frame = Record<string, any>;

function fixture(t: TestContext) {
	const directory = mkdtempSync(join(root, "fixture-"));
	const cwd = join(directory, "one");
	const other = join(directory, "two");
	const launch = join(directory, "launch");
	for (const path of [cwd, other, launch]) mkdirSync(path);
	const config = join(directory, "offline.yaml");
	const terminalStore = join(directory, "terminal.sqlite");
	writeFileSync(config, `provider: faux\ncodemode: false\nautoContinue: false\nstore: ${JSON.stringify(terminalStore)}\nmcp:\n  enabled: false\n`);
	const sessionsDir = join(directory, "sessions");
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return { directory, cwd, other, launch, config, sessionsDir, terminalStore };
}

function host(t: TestContext, setup: ReturnType<typeof fixture>, extra: string[] = [], cliPath = cli, env: Record<string, string> = clean) {
	const child = spawn(process.execPath, [cliPath, "acp", "serve", "--sessions-dir", setup.sessionsDir, ...extra], { cwd: setup.launch, env, stdio: ["pipe", "pipe", "pipe"] });
	let stderr = "";
	let stdout = "";
	child.stderr.on("data", (value) => { stderr += value; });
	child.stdout.on("data", (value) => { stdout += value; });
	const exited = once(child, "exit");
	t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
	const frames: Frame[] = [];
	const listeners = new Set<() => void>();
	let failure: Error | undefined;
	readFrames(child.stdout, (frame) => { frames.push(frame); for (const listener of listeners) listener(); }, (error) => { failure = error; for (const listener of listeners) listener(); });
	child.stdout.on("end", () => { failure = new Error(`Host ended unexpectedly: ${stderr}`); for (const listener of listeners) listener(); });
	const wait = (predicate: (frame: Frame) => boolean, start = 0) => new Promise<Frame>((resolve, reject) => {
		// Bounded waits for external child/pipe events, never model pacing sleeps.
		const timer = setTimeout(() => finish(new Error(`ACP deadline: ${stderr}`)), 15_000);
		const finish = (error?: Error, frame?: Frame) => { clearTimeout(timer); listeners.delete(check); error ? reject(error) : resolve(frame!); };
		const check = () => { const frame = frames.slice(start).find(predicate); if (frame) finish(undefined, frame); else if (failure) finish(failure); };
		listeners.add(check);
		check();
	});
	let next = 0;
	const notify = (method: string, params: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	const request = (method: string, params: object = {}) => {
		const id = ++next;
		const start = frames.length;
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		return wait((frame) => frame.id === id, start);
	};
	const ok = async (method: string, params: object = {}) => { const frame = await request(method, params); assert.equal(frame.error, undefined); return frame.result; };
	const stop = async (signal?: "SIGINT" | "SIGTERM") => {
		if (signal) child.kill(signal); else child.stdin.end();
		const [code, received] = await exited;
		assert.equal(code, 0, stderr);
		assert.equal(received, null, stderr);
		for (const line of stdout.trim().split("\n").filter(Boolean)) assert.equal(JSON.parse(line).jsonrpc, "2.0");
		assert.equal(existsSync(join(setup.sessionsDir, "registry.lock")), false);
		for (const name of readdirSync(setup.sessionsDir).filter((name) => name.startsWith("acp-"))) assert.equal(existsSync(join(setup.sessionsDir, name, "state.sqlite.lock")), false);
	};
	return { child, frames, wait, request, ok, notify, stop, exited, diagnostics: () => ({ stderr, stdout }) };
}
const initialize = (client: ReturnType<typeof host>) => client.ok("initialize", { protocolVersion: 1, clientInfo: { name: "zed", version: "1.29.1" }, clientCapabilities: {} });
const prompt = (sessionId: string, text: string) => ({ sessionId, prompt: [{ type: "text", text }] });
const sessionArgs = (sessionId: string, cwd: string, mcpServers: object[] = []) => ({ sessionId, cwd, mcpServers });
const chunks = (client: ReturnType<typeof host>, sessionId: string) => client.frames.filter((frame) => frame.method === "session/update" && frame.params.sessionId === sessionId).map((frame) => frame.params.update);

// Attach tests only address one existing Main. These protect creation, registry ownership and process-cwd isolation.
test("Zed New Thread creates isolated durable sessions, uses session-local config/cwd, and reopens public history before load reply", { timeout: 60_000 }, async (t) => {
	const setup = fixture(t);
	for (const [cwd, model] of [[setup.cwd, "one-model"], [setup.other, "two-model"]]) {
		mkdirSync(join(cwd!, ".durable-chat"));
		writeFileSync(join(cwd!, ".durable-chat/config.yaml"), `provider: faux\nmodel: ${model}\ncodemode: false\nautoContinue: false\nstore: ./never-terminal.sqlite\nmcp:\n  enabled: true\n`);
	}
	const client = host(t, setup);
	const info = await initialize(client);
	assert.equal(info.agentInfo.version, version);
	assert.deepEqual(info.agentCapabilities.sessionCapabilities, { list: {}, close: {} });
	const a = (await client.ok("session/new", { cwd: setup.cwd, mcpServers: [] })).sessionId;
	const b = (await client.ok("session/new", { cwd: setup.other, mcpServers: [] })).sessionId;
	assert.notEqual(a, b);
	assert.equal((await client.ok("session/prompt", prompt(a, "one-public-canary"))).stopReason, "end_turn");
	assert.equal((await client.ok("session/prompt", prompt(b, "two-public-canary"))).stopReason, "end_turn");
	for (const [id, own, other] of [[a, "one-public-canary", "two-public-canary"], [b, "two-public-canary", "one-public-canary"]]) {
		const values = chunks(client, id);
		assert.equal(values.filter((value) => value.sessionUpdate === "agent_message_chunk").length, 1, "generic clients get committed output, not duplicate pi.live drafts");
		assert.ok(JSON.stringify(values).includes(own));
		assert.ok(!JSON.stringify(values).includes(other));
		assert.ok(!JSON.stringify(values).includes("permissionOwner"));
	}
	assert.equal((await client.ok("session/list")).sessions.length, 2);
	assert.deepEqual((await client.ok("session/list", { cwd: realpathSync(setup.cwd) })).sessions.map((value: any) => value.sessionId), [a]);
	assert.deepEqual(await listMains(), [], "ACP sessions must not advertise terminal-owner sockets");
	await client.stop();
	assert.equal(existsSync(setup.terminalStore), false);
	for (const [id, cwd, model] of [[a, setup.cwd, "one-model"], [b, setup.other, "two-model"]]) {
		const saved = JSON.parse(readFileSync(join(setup.sessionsDir, id, "session.json"), "utf8"));
		assert.equal(saved.cwd, realpathSync(cwd));
		// Inspect the saved agent document without openRuntime reconfiguring it first.
		const storage = await openNodeSqliteStorage(join(setup.sessionsDir, id, "state.sqlite"));
		const session = createSession(storage);
		try {
			const conversations = await storage.scanConversations({}, 10, undefined, context);
			assert.equal(conversations.items.length, 1);
			const agent = await session.snapshot(AgentDoc, conversations.items[0]!.id, context);
			assert.equal(agent?.cwd, realpathSync(cwd));
			assert.equal(agent?.model?.modelId, model);
		} finally { await session.close(context); }
		assert.equal(existsSync(join(cwd, "never-terminal.sqlite")), false);
	}
	// Seed real private entries: unit projection tests alone cannot catch a CLI replay bypass.
	const seeded = await openRuntime({ storePath: join(setup.sessionsDir, a, "state.sqlite"), cwd: realpathSync(setup.cwd), withMcp: false, announceOwner: false });
	try {
		await seeded.root.commit(async (tx) => {
			await tx.appendEntry(seeded.root.id, { kind: "pi.system", model: [{ role: "user", content: "private-system-canary", timestamp: 0 }] });
			await tx.appendEntry(seeded.root.id, { kind: "pi.assistant", model: [fauxAssistantMessage([{ type: "thinking", thinking: "private-reasoning-canary" }, fauxText("public-seeded-answer")])] });
		}, seeded.context);
	} finally { await seeded.close(); }
	const reopened = host(t, setup);
	await initialize(reopened);
	assert.deepEqual(new Set((await reopened.ok("session/list")).sessions.map((value: any) => value.sessionId)), new Set([a, b]));
	assert.equal((await reopened.request("session/load", sessionArgs("main:terminal", setup.cwd))).error.code, -32002);
	assert.equal((await reopened.request("session/load", sessionArgs(a, setup.other))).error.code, -32602);
	await reopened.ok("session/load", sessionArgs(a, setup.cwd));
	const loadIndex = reopened.frames.length - 1;
	assert.equal(reopened.frames[loadIndex].result !== undefined, true);
	assert.ok(JSON.stringify(reopened.frames.slice(0, loadIndex)).includes("one-public-canary"));
	assert.ok(!JSON.stringify(reopened.frames).includes("two-public-canary"));
	assert.ok(JSON.stringify(reopened.frames).includes("public-seeded-answer"));
	assert.ok(!JSON.stringify(reopened.diagnostics()).includes("private-system-canary"));
	assert.ok(!JSON.stringify(reopened.diagnostics()).includes("private-reasoning-canary"));
	assert.equal((await reopened.ok("session/prompt", prompt(a, "after-reopen"))).stopReason, "end_turn");
	await reopened.stop();
});

test("cancel addresses only its ACP session and session close frees the store while EOF checkpoints durable jobs", { timeout: 60_000 }, async (t) => {
	const setup = fixture(t);
	const client = host(t, setup, ["--config", setup.config]);
	await initialize(client);
	const a = (await client.ok("session/new", { cwd: setup.cwd, mcpServers: [] })).sessionId;
	const b = (await client.ok("session/new", { cwd: setup.other, mcpServers: [] })).sessionId;
	const pending = client.ok("session/prompt", prompt(a, "cancel-me"));
	await client.wait((frame) => frame.params?.sessionId === a && frame.params.update.sessionUpdate === "user_message_chunk");
	const other = client.ok("session/prompt", prompt(b, "keep-me"));
	client.notify("session/cancel", { sessionId: a });
	assert.equal((await pending).stopReason, "cancelled");
	assert.equal((await other).stopReason, "end_turn");
	await client.ok("session/close", { sessionId: a });
	assert.equal(existsSync(join(setup.sessionsDir, a, "state.sqlite.lock")), false);
	await client.ok("session/load", sessionArgs(a, setup.cwd));
	await client.ok("session/prompt", prompt(a, "task: isolated-job-canary"));
	await client.stop();
	const runtime = await openRuntime({ storePath: join(setup.sessionsDir, a, "state.sqlite"), cwd: setup.cwd, configPath: setup.config, withMcp: false, announceOwner: false });
	try {
		const jobs = await scanJobs(runtime.harness, runtime.context);
		assert.equal(jobs.length, 1);
		assert.match(JSON.stringify(jobs), /isolated-job-canary/);
		const job = (await findJobConversation(runtime.harness, Number(jobs[0]!.id), runtime.context))!;
		assert.equal((await job.agent(runtime.context)).cwd, realpathSync(setup.cwd), "a job created in A after B opens must retain A\'s native-tool cwd");
		runtime.harness.resume();
		await runtime.harness.waitForTask(jobs[0]!.id, runtime.context);
	} finally { await runtime.close(); }
	const reopened = host(t, setup, ["--config", setup.config]);
	await initialize(reopened);
	await reopened.ok("session/load", sessionArgs(a, setup.cwd));
	assert.ok(JSON.stringify(chunks(reopened, a)).includes("isolated-job-canary"));
	await reopened.stop();
});

// Local MCP fixtures exercise the real existing transport; never a live/personal MCP server.
const mcpScript = `import {createInterface} from 'node:readline';
import {writeFileSync, appendFileSync} from 'node:fs';
writeFileSync(process.env.RECORD, JSON.stringify({pid:process.pid,cwd:process.cwd(),value:process.env.ISOLATED}));
process.stderr.write('private-mcp-stderr-canary');
const input=createInterface({input:process.stdin});
input.on('line',line=>{const m=JSON.parse(line); if(m.id===undefined)return;
const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[]} : {};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});
input.on('close',()=>{appendFileSync(process.env.RECORD,'.closed');process.exit(0)});
`;

for (const signal of [undefined, "SIGINT", "SIGTERM"] as const) test(`forwarded stdio MCP is session-isolated and ${signal ?? "EOF"} checkpoints active work and closes children/locks`, { timeout: 30_000 }, async (t) => {
	const setup = fixture(t);
	const script = join(setup.directory, "mcp.mjs");
	writeFileSync(script, mcpScript);
	const client = host(t, setup, ["--config", setup.config]);
	await initialize(client);
	const records = [];
	for (const [cwd, value] of [[setup.cwd, "one"], [setup.other, "two"]]) {
		const record = join(setup.directory, value! + ".json");
		const mcpServers = [{ name: "fixture", command: process.execPath, args: [script], env: [{ name: "RECORD", value: record }, { name: "ISOLATED", value: `\${HOME}/${value}` }] }];
		const { sessionId } = await client.ok("session/new", { cwd, mcpServers });
		const saved = JSON.parse(readFileSync(record, "utf8"));
		assert.equal(saved.cwd, realpathSync(cwd!));
		assert.equal(saved.value, `\${HOME}/${value}`, "forwarded values must stay literal, not expand against global HOME");
		records.push({ record, saved, sessionId, cwd, mcpServers });
		assert.equal(readFileSync(join(setup.sessionsDir, sessionId, "session.json"), "utf8").includes("ISOLATED"), false, "MCP secrets/config are fingerprinted, not persisted");
	}
	assert.notEqual(records[0]!.saved.pid, records[1]!.saved.pid);
	const checkpoint = records[0]!;
	const start = client.frames.length;
	const interrupted = client.request("session/prompt", prompt(checkpoint.sessionId, "checkpoint-active-canary")).catch(() => undefined);
	await client.wait((frame) => frame.params?.sessionId === checkpoint.sessionId && frame.params.update.sessionUpdate === "user_message_chunk", start);
	await client.stop(signal);
	await interrupted;
	for (const { record, saved } of records) {
		assert.ok(readFileSync(record, "utf8").endsWith(".closed"));
		assert.throws(() => process.kill(saved.pid, 0), { code: "ESRCH" });
	}
	assert.ok(!JSON.stringify(client.diagnostics()).includes("private-mcp-stderr-canary"));
	const reopened = host(t, setup, ["--config", setup.config]);
	await initialize(reopened);
	const original = records[0]!;
	assert.equal((await reopened.request("session/load", sessionArgs(original.sessionId, original.cwd!, []))).error.code, -32602);
	await reopened.ok("session/load", sessionArgs(original.sessionId, original.cwd!, original.mcpServers));
	await reopened.wait((frame) => frame.params?.sessionId === original.sessionId && frame.params.update.sessionUpdate === "agent_message_chunk" && frame.params.update.content.text.includes("checkpoint-active-canary"));
	assert.equal(chunks(reopened, original.sessionId).filter((value) => value.sessionUpdate === "agent_message_chunk").length, 1, "a reopened run emits one committed answer, never stale drafts");
	const pid = JSON.parse(readFileSync(original.record, "utf8")).pid;
	await reopened.stop();
	assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("ACP rejects invalid cwd/MCP/auth payloads without exposing private provider/config/transport errors", { timeout: 30_000 }, async (t) => {
	const setup = fixture(t);
	const client = host(t, setup, ["--config", setup.config]);
	assert.equal((await client.request("session/list")).error.code, -32600);
	await initialize(client);
	const contender = host(t, setup, ["--config", setup.config]);
	assert.deepEqual(await contender.exited, [1, null], "a second host must not steal the registry/store owner locks");
	assert.equal(contender.frames.length, 0);
	for (const cwd of ["relative", join(setup.directory, "absent-private-cwd-canary"), setup.config]) assert.equal((await client.request("session/new", { cwd, mcpServers: [] })).error.code, -32602);
	for (const mcpServers of [null, {}, [{ type: "http", name: "remote", url: "https://private-url-canary.invalid" }], [{ type: "unknown" }], [{ name: "x", command: "relative", args: [], env: [] }], [{ name: "x", command: process.execPath, args: [], env: { SECRET: "private-env-canary" } }]]) {
		assert.equal((await client.request("session/new", { cwd: setup.cwd, mcpServers })).error.code, -32602);
	}
	assert.equal((await client.request("session/new", { cwd: setup.cwd, mcpServers: [{ name: "x", command: "/absent/private-command-canary", args: [], env: [] }] })).error.code, -32603);
	const invalidConfig = join(setup.directory, "invalid.yaml");
	writeFileSync(invalidConfig, "provider: private-provider-config-canary\n");
	const broken = host(t, { ...setup, sessionsDir: join(setup.directory, "broken") }, ["--config", invalidConfig]);
	await initialize(broken);
	assert.equal((await broken.request("session/new", { cwd: setup.cwd, mcpServers: [] })).error.code, -32603);
	await broken.stop();
	assert.ok(!JSON.stringify(broken.diagnostics()).includes("private-provider-config-canary"));
	assert.equal((await client.ok("session/list")).sessions.length, 0, "failed creation leaves no registered session");
	await client.stop();
	const disabled = host(t, setup, ["--config", setup.config, "--no-mcp"]);
	await initialize(disabled);
	assert.equal((await disabled.request("session/new", { cwd: setup.cwd, mcpServers: [{ name: "valid", command: process.execPath, args: [], env: [] }] })).error.code, -32602);
	await disabled.stop();
	assert.ok(!/private-(?:cwd|url|env|command)-canary/.test(JSON.stringify(client.diagnostics())));
	assert.equal(existsSync(setup.terminalStore), false);
});
