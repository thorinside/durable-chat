import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { jobView } from "../src/format.ts";
import { openRuntime } from "../src/harness.ts";
import { announceJobStart, createJobInCommit, jobConversationId, jobInputDraft, jobOptionsOf, jobRecord, readLog, scanJobs } from "../src/jobs.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

function testPaths(): { store: string; config: string } {
	const dir = mkdtempSync(join(tmpdir(), "durable-chat-test-"));
	const config = join(dir, "config.yaml");
	writeFileSync(config, "provider: faux\nmcp:\n  enabled: false\n");
	return { store: join(dir, "store.sqlite"), config };
}

test("a background job answers in its own conversation and its receipt survives reopen", async () => {
	const { store: path, config } = testPaths();
	let runtime = await openRuntime({ storePath: path, configPath: config, provider: "faux", withMcp: false });
	const started = await runtime.root.commit(
		(tx) => createJobInCommit(tx, "say hello", runtime.model, runtime.jobExtensions, runtime.cwd, jobOptionsOf(runtime.config)),
		runtime.context,
	);
	const settled = await runtime.harness.waitForTask(started.taskId, runtime.context);
	assert.equal(settled.state.outcome.status, "completed");
	assert.match(settled.state.outcome.result.answer ?? "", /Offline faux model/);
	assert.equal(await jobConversationId(runtime.harness, Number(started.taskId), runtime.context), Number(started.conversationId));
	await runtime.close();

	runtime = await openRuntime({ storePath: path, configPath: config, provider: "faux", withMcp: false });
	const record = await jobRecord(runtime.harness, Number(started.taskId), runtime.context);
	assert.equal(jobView(record!).status, "completed");
	assert.match(jobView(record!).answer ?? "", /Offline faux model/);
	await runtime.close();
});

test("cancelling a pending job records an aborted outcome that survives reopen", async () => {
	const { store: path, config } = testPaths();
	let runtime = await openRuntime({ storePath: path, configPath: config, provider: "faux", withMcp: false });
	const started = await runtime.root.commit(
		(tx) => createJobInCommit(tx, "never starts", runtime.model, runtime.jobExtensions, runtime.cwd, jobOptionsOf(runtime.config)),
		runtime.context,
	);
	assert.equal(await runtime.harness.abortTask(started.taskId, runtime.context), "marked");
	const settled = await runtime.harness.waitForTask(started.taskId, runtime.context);
	assert.equal(settled.state.outcome.status, "aborted");
	await runtime.close();

	runtime = await openRuntime({ storePath: path, configPath: config, provider: "faux", withMcp: false });
	const record = await jobRecord(runtime.harness, Number(started.taskId), runtime.context);
	assert.equal(jobView(record!).status, "aborted");
	await runtime.close();
});

test("the main conversation settles while a background job is still live", { timeout: 30_000 }, async () => {
	const { store: path, config } = testPaths();
	const runtime = await openRuntime({ storePath: path, configPath: config, provider: "faux", withMcp: false });
	// A long brief makes the faux job's streamed answer take longer than the main reply.
	const longBrief = `report on ${"durable work ".repeat(240)}`;
	const started = await runtime.root.commit(
		(tx) => createJobInCommit(tx, longBrief, runtime.model, runtime.jobExtensions, runtime.cwd, jobOptionsOf(runtime.config)),
		runtime.context,
	);
	const submission = await runtime.root.submit({ type: "input", content: "hello" }, runtime.context);
	const settled = await submission.wait(runtime.context);
	assert.equal(settled.status, "done");
	const live = await scanJobs(runtime.harness, runtime.context);
	const job = live.find((record) => Number(record.id) === Number(started.taskId));
	assert.ok(job !== undefined);
	assert.notEqual(jobView(job).status, "completed");
	await runtime.harness.abortTask(started.taskId, runtime.context);
	await runtime.harness.waitForTask(started.taskId, runtime.context);
	await runtime.close();
});

test("the faux coordinator's task tool starts a job that the CLI reports as completed", async () => {
	const { store: path, config } = testPaths();
	const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
	const env = { ...process.env, DURABLE_STORE: path, DURABLE_CHAT_CONFIG: config };
	const ask = execFileSync(process.execPath, [cli, "--store", path, "--no-mcp", "ask", "task: check the repository"], {
		cwd: root, env, encoding: "utf8",
	});
	assert.match(ask, /Task created/);
	execFileSync(process.execPath, [cli, "--store", path, "--no-mcp", "watch"], { cwd: root, env, encoding: "utf8" });
	const tasks = execFileSync(process.execPath, [cli, "--store", path, "tasks"], { cwd: root, env, encoding: "utf8" });
	assert.match(tasks, /completed/);
	assert.match(tasks, /check the repository/);
});

test("job input drafts use steer ingress when steering is selected", () => {
	assert.equal(jobInputDraft("tighten the scope", true).whenBusy, "steer");
	assert.equal(jobInputDraft("next task", false).whenBusy, "followUp");
});

test("a user-started job writes host notices into the main conversation", async () => {
	const { store: path, config } = testPaths();
	const runtime = await openRuntime({ storePath: path, configPath: config, provider: "faux", withMcp: false });
	const brief = "say hello";
	const started = await runtime.root.commit(
		(tx) => createJobInCommit(tx, brief, runtime.model, runtime.jobExtensions, runtime.cwd, {
			...jobOptionsOf(runtime.config),
			notifyMain: true,
		}),
		runtime.context,
	);
	await announceJobStart(runtime.root, started, brief, runtime.context);
	const settled = await runtime.harness.waitForTask(started.taskId, runtime.context);
	assert.equal(settled.state.outcome.status, "completed");
	const view = await runtime.root.context(runtime.context);
	const text = view.messages.flatMap((message) => {
		if (typeof message.content === "string") return [message.content];
		return Array.isArray(message.content) ? message.content.flatMap((block) => block.type === "text" ? [block.text] : []) : [];
	}).join("\n");
	assert.match(text, /\[host\] The user started background job #\d+/);
	assert.match(text, /\[host\] Background job #\d+ completed/);
	assert.equal(view.entries.filter((entry) => entry.kind === "app.job-notice").length, 2);
	await runtime.close();
});

function messageText(view: { messages: readonly { content: unknown }[] }): string {
	return view.messages.flatMap((message) => {
		if (typeof message.content === "string") return [message.content];
		return Array.isArray(message.content)
			? message.content.flatMap((block) => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" ? [(block as { text: string }).text] : [])
			: [];
	}).join("\n");
}

test("a job can hand off to main, which receives a native input", async () => {
	const { store: path, config } = testPaths();
	const runtime = await openRuntime({ storePath: path, configPath: config, provider: "faux", withMcp: false });
	const brief = "handoff: main Continue the README";
	const started = await runtime.root.commit(
		(tx) => createJobInCommit(tx, brief, runtime.model, runtime.jobExtensions, runtime.cwd, {
			...jobOptionsOf(runtime.config),
			notifyMain: true,
		}),
		runtime.context,
	);
	await announceJobStart(runtime.root, started, brief, runtime.context);
	const settled = await runtime.harness.waitForTask(started.taskId, runtime.context);
	const result = settled.state.outcome.status === "completed" ? settled.state.outcome.result : undefined;
	assert.equal(result?.status, "handed_off");
	assert.deepEqual(result?.handoff, { target: "main" });
	await runtime.harness.waitForIdle(runtime.context);
	const main = await runtime.root.context(runtime.context);
	assert.match(messageText(main), /\[job #\d+ handoff\]/);
	assert.ok(main.entries.some((entry) => entry.kind === "app.job-handoff"));
	await runtime.close();
});

test("a job can hand off to a successor job that receives the summary", async () => {
	const { store: path, config } = testPaths();
	const runtime = await openRuntime({ storePath: path, configPath: config, provider: "faux", withMcp: false });
	const brief = "handoff: job Inspect the test suite";
	const started = await runtime.root.commit(
		(tx) => createJobInCommit(tx, brief, runtime.model, runtime.jobExtensions, runtime.cwd, {
			...jobOptionsOf(runtime.config),
			notifyMain: true,
		}),
		runtime.context,
	);
	await announceJobStart(runtime.root, started, brief, runtime.context);
	const parent = await runtime.harness.waitForTask(started.taskId, runtime.context);
	const result = parent.state.outcome.status === "completed" ? parent.state.outcome.result : undefined;
	assert.equal(result?.status, "handed_off");
	assert.equal(result?.handoff?.target, "job");
	const successorId = result?.handoff?.id;
	assert.ok(successorId !== undefined);
	const successor = await runtime.harness.waitForTask(successorId as never, runtime.context);
	assert.equal(successor.state.outcome.status, "completed");
	const conversationId = await jobConversationId(runtime.harness, successorId!, runtime.context);
	assert.ok(conversationId !== undefined);
	const log = await readLog(runtime.harness, conversationId!, runtime.context, 20);
	assert.ok(log.some((entry) => entry.text.includes(`Handoff from job #${started.taskId}`)));
	await runtime.close();
});

test("a job started by main's task tool notifies main when it finishes", async () => {
	const { store: path, config } = testPaths();
	const runtime = await openRuntime({ storePath: path, configPath: config, provider: "faux", withMcp: false });
	const submission = await runtime.root.submit({ type: "input", content: "task: check the readme" }, runtime.context);
	await submission.wait(runtime.context);
	const jobs = await scanJobs(runtime.harness, runtime.context);
	const job = jobs.at(-1);
	assert.ok(job !== undefined);
	await runtime.harness.waitForTask(job.id, runtime.context);
	await runtime.harness.waitForIdle(runtime.context);
	const view = await runtime.root.context(runtime.context);
	assert.match(messageText(view), /\[host\] Background job #\d+ completed/);
	await runtime.close();
});

test("autoContinue starts a main run when a job completes", async () => {
	const { store: path, config } = testPaths();
	const runtime = await openRuntime({ storePath: path, configPath: config, provider: "faux", withMcp: false });
	const brief = "say hello";
	const started = await runtime.root.commit(
		(tx) => createJobInCommit(tx, brief, runtime.model, runtime.jobExtensions, runtime.cwd, {
			...jobOptionsOf(runtime.config),
			notifyMain: true,
			autoContinue: true,
		}),
		runtime.context,
	);
	await announceJobStart(runtime.root, started, brief, runtime.context);
	await runtime.harness.waitForTask(started.taskId, runtime.context);
	await runtime.harness.waitForIdle(runtime.context);
	const view = await runtime.root.context(runtime.context);
	const notice = view.entries.findIndex((entry) =>
		entry.kind === "app.job-notice" && (entry.data as { phase?: unknown } | undefined)?.phase === "completed");
	assert.ok(notice >= 0);
	assert.ok(view.entries.slice(notice + 1).some((entry) => entry.kind === "pi.assistant"));
	await runtime.close();
});

test("task show refuses to poll a live job twice", async () => {
	const { store: path, config } = testPaths();
	const runtime = await openRuntime({ storePath: path, configPath: config, provider: "faux", withMcp: false });
	const started = await runtime.root.commit(
		(tx) => createJobInCommit(tx, "stay pending", runtime.model, runtime.jobExtensions, runtime.cwd, jobOptionsOf(runtime.config)),
		runtime.context,
	);
	const tool = runtime.tasksExtension.tools?.find((candidate) => candidate.name === "task");
	assert.ok(tool !== undefined);
	const api = {
		conversationId: runtime.root.id,
		getTask: (id: unknown, context: unknown) => runtime.harness.getTask(id as never, context as never),
		snapshot: (token: unknown, context: unknown) => runtime.harness.snapshot(token as never, context as never),
		commit: (change: (tx: unknown) => unknown, context: unknown) => runtime.harness.commit(change as never, context as never),
	};
	const first = await tool.execute({ action: "show", id: String(started.taskId) } as never, api as never, runtime.context);
	const second = await tool.execute({ action: "show", id: String(started.taskId) } as never, api as never, runtime.context);
	assert.match(JSON.stringify(first), /Still running/);
	assert.equal(second.control?.terminate, true);
	await runtime.close();
});
