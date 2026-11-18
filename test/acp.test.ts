import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openRuntime } from "../src/harness.ts";
import {
	acpFrontend,
	entryUpdates,
	listMains,
	mainSessionCheck,
	ownerAddress,
	readFrames,
	SHARED_MAIN,
} from "../src/acp.ts";

// Endpoints of this run live apart from the user's own running dchat, which discovery must never probe here.
const ipc = mkdtempSync("/tmp/dchat-acp-ipc-");
process.env.DCHAT_IPC_DIR = ipc;
process.on("exit", () => rmSync(ipc, { recursive: true, force: true }));
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "dchat-acp-"));
	const config = join(directory, "config.yaml");
	const store = join(directory, "state.sqlite");
	writeFileSync(
		config,
		`provider: faux\ncodemode: false\nstore: ${JSON.stringify(store)}\nmcp:\n  enabled: false\n`,
	);
	return { directory, config, store };
}

test("ACP Main IDs cannot address jobs or reveal private reasoning/system content", () => {
	assert.throws(
		() => mainSessionCheck("job:1", "main:one"),
		/Unknown Main session/,
	);
	assert.doesNotThrow(() => mainSessionCheck("main:one", "main:one"));
	const updates = entryUpdates({
		id: 1,
		conversationId: 1,
		kind: "pi.assistant",
		model: [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "private" },
					{ type: "text", text: "public" },
				],
			},
		],
	} as never);
	assert.equal(JSON.stringify(updates).includes("private"), false);
	assert.equal(updates[0]?.content.text, "public");
	assert.deepEqual(
		entryUpdates({
			id: 2,
			kind: "pi.system",
			model: [{ role: "user", content: "private system instructions" }],
		} as never),
		[],
	);
});

test("provider tool IDs reused after an aborted assistant retain distinct native call/result identities", () => {
	const ids = new Map<string, string>();
	const call = (id: number) =>
		entryUpdates(
			{
				id,
				model: [
					{
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "provider-reused",
								name: "task",
								arguments: {},
							},
						],
					},
				],
			} as never,
			ids,
		)[0]!;
	const result = (id: number) =>
		entryUpdates(
			{
				id,
				model: [
					{
						role: "toolResult",
						toolCallId: "provider-reused",
						content: [{ type: "text", text: "done" }],
					},
				],
			} as never,
			ids,
		)[0]!;
	const first = call(1);
	const firstResult = result(2);
	const retry = call(3);
	const retryResult = result(4);
	assert.notEqual(first.toolCallId, retry.toolCallId);
	assert.equal(firstResult.toolCallId, first.toolCallId);
	assert.equal(retryResult.toolCallId, retry.toolCallId);
});

test("ACP frontend without an existing owner never creates a store or starts a Harness", (t) => {
	const setup = fixture();
	t.after(() => rmSync(setup.directory, { recursive: true, force: true }));
	const result = spawnSync(
		process.execPath,
		[
			fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
			"acp",
			"--config",
			setup.config,
		],
		{ encoding: "utf8", timeout: 10_000 },
	);
	assert.notEqual(result.status, 0);
	assert.equal(existsSync(setup.store), false);
	assert.equal(existsSync(`${setup.store}.lock`), false);
	assert.equal(
		result.stdout,
		"",
		"diagnostics must not contaminate ACP stdout",
	);
});

// Actual I/O is needed to catch a second-runtime launch, ID leakage and history/live subscription races.
// Uses a fresh SQLite store and offline faux provider; never connects MCP or a network model.
test("existing Main replays history and reflects TTY input while detach leaves its owner alive", {
	timeout: 25_000,
}, async (t) => {
	const setup = fixture();
	const runtime = await openRuntime({
		configPath: setup.config,
		withMcp: false,
	});
	t.after(async () => {
		await runtime.close();
		rmSync(setup.directory, { recursive: true, force: true });
	});
	const socket = createConnection(ownerAddress(setup.store));
	t.after(() => socket.destroy());
	const pending = new Map<
		string,
		{ resolve: (result: any) => void; reject: (error: Error) => void }
	>();
	const updates: any[] = [];
	readFrames(
		socket,
		(frame) => {
			if (frame.method === "session/update") updates.push(frame.params!.update);
			else {
				const request = pending.get(String(frame.id));
				pending.delete(String(frame.id));
				if (frame.error)
					request?.reject(new Error((frame.error as any).message));
				else request?.resolve(frame.result);
			}
		},
		(error) => {
			throw error;
		},
	);
	const request = (method: string, params: object = {}) => {
		const id = randomUUID();
		return new Promise<any>((resolve, reject) => {
			pending.set(id, { resolve, reject });
			socket.write(
				`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
			);
		});
	};
	await request("initialize", { protocolVersion: 1 });
	await assert.rejects(
		request("session/new", { cwd: runtime.cwd, mcpServers: [] }),
		/Creation disabled/,
	);
	const listing = await request("session/list");
	assert.equal(listing.sessions.length, 1);
	const sessionId = listing.sessions[0].sessionId;
	await assert.rejects(
		request("session/load", {
			sessionId: "job:1",
			cwd: runtime.cwd,
			mcpServers: [],
		}),
		/Unknown Main session/,
	);
	await request("session/load", {
		sessionId,
		cwd: runtime.cwd,
		mcpServers: [],
	});
	const input = "synthetic remote greeting";
	const key = randomUUID();
	assert.equal(
		(
			await request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: input }],
				_meta: { [SHARED_MAIN]: { requestId: key } },
			})
		).stopReason,
		"end_turn",
	);
	assert.equal(
		(
			await request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: input }],
				_meta: { [SHARED_MAIN]: { requestId: key } },
			})
		).stopReason,
		"end_turn",
	);
	assert.equal(
		updates.filter(
			(update) =>
				update.sessionUpdate === "user_message_chunk" &&
				update.content.text === input,
		).length,
		1,
	);
	await assert.rejects(
		request("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: "different input" }],
			_meta: { [SHARED_MAIN]: { requestId: key } },
		}),
		/different input/,
	);
	const tty = await runtime.root.submit(
		{
			type: "input",
			content: "synthetic terminal greeting",
			whenBusy: "followUp",
		},
		runtime.context,
	);
	await tty.wait(runtime.context);
	assert.ok(
		updates.some(
			(update) =>
				update.sessionUpdate === "user_message_chunk" &&
				update.content.text.includes("synthetic terminal greeting"),
		),
	);
	assert.ok(
		updates.some(
			(update) =>
				update.sessionUpdate === "agent_message_chunk" &&
				update.content.text.includes(input),
		),
	);
	const before = updates.length;
	await request("session/load", {
		sessionId,
		cwd: runtime.cwd,
		mcpServers: [],
	});
	assert.ok(
		updates
			.slice(before)
			.some(
				(update) =>
					update.sessionUpdate === "user_message_chunk" &&
					update.content.text === input,
			),
	);
	socket.end();
	const afterDetach = await runtime.root.submit(
		{ type: "input", content: "owner survives detach" },
		runtime.context,
	);
	assert.equal((await afterDetach.wait(runtime.context)).status, "done");
});

// Discovery is what lets a client offer running Mains without being told a store or project first.
test("a running Main is discoverable and attachable through its listed endpoint alone", {
	timeout: 25_000,
}, async (t) => {
	const setup = fixture();
	const runtime = await openRuntime({
		configPath: setup.config,
		withMcp: false,
	});
	t.after(async () => {
		await runtime.close();
		rmSync(setup.directory, { recursive: true, force: true });
	});
	const listed = await new Promise<string>((resolve, reject) =>
		execFile(
			process.execPath,
			[cli, "acp", "list"],
			{ timeout: 10_000, cwd: tmpdir() },
			(error, stdout) => (error ? reject(error) : resolve(stdout)),
		),
	);
	const { mains } = JSON.parse(listed);
	assert.equal(mains.length, 1);
	assert.equal(mains[0].endpoint, ownerAddress(setup.store));
	assert.equal(mains[0].cwd, runtime.cwd);
	assert.equal(mains[0].model, runtime.modelLabel);
	// No --store or --config: the endpoint is the whole selection.
	const frontend = spawn(
		process.execPath,
		[cli, "acp", "--endpoint", mains[0].endpoint],
		{ cwd: tmpdir(), stdio: ["pipe", "pipe", "ignore"] },
	);
	t.after(() => frontend.kill());
	const replies: any[] = [];
	const answered = new Promise<void>((resolve) =>
		readFrames(
			frontend.stdout,
			(frame) => {
				replies.push(frame);
				if (frame.id === "list") resolve();
			},
			() => {},
		),
	);
	frontend.stdin.write(
		`${JSON.stringify({ jsonrpc: "2.0", id: "initialize", method: "initialize", params: { protocolVersion: 1 } })}\n${JSON.stringify({ jsonrpc: "2.0", id: "list", method: "session/list", params: {} })}\n`,
	);
	await answered;
	assert.equal(replies.at(-1).result.sessions[0].sessionId, mains[0].sessionId);
	frontend.stdin.end();
	await once(frontend, "exit");
	await runtime.close();
	assert.deepEqual(await listMains(), []);
	await assert.rejects(
		acpFrontend({ endpoint: join(setup.directory, "state.sqlite") }),
		/Not a dchat owner endpoint/,
	);
});
