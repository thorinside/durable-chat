import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRuntime, type AppRuntime } from "../src/harness.ts";
import { createJobInCommit, findJobConversation, jobOptionsOf, scanJobs } from "../src/jobs.ts";

function testPaths(thinkingLevel: string): { store: string; config: string } {
	const dir = mkdtempSync(join(tmpdir(), "durable-chat-thinking-"));
	const config = join(dir, "config.yaml");
	writeFileSync(config, `provider: faux\nthinkingLevel: ${thinkingLevel}\nmcp:\n  enabled: false\n`);
	return { store: join(dir, "store.sqlite"), config };
}

/** The read-only api the task tool needs, as jobs.test.ts builds it. */
function toolApi(runtime: AppRuntime) {
	return {
		conversationId: runtime.root.id,
		agent: () => runtime.root.agent(runtime.context),
		snapshot: (token: unknown, context: unknown) => runtime.harness.snapshot(token as never, context as never),
		commit: (change: (tx: unknown) => unknown, context: unknown) => runtime.harness.commit(change as never, context as never),
	};
}

async function agentThinkingLevel(runtime: AppRuntime, taskId: number): Promise<string> {
	const conversation = await findJobConversation(runtime.harness, taskId, runtime.context);
	assert.ok(conversation !== undefined);
	return (await conversation.agent(runtime.context)).thinkingLevel;
}

test("the session thinking level updates main and the jobs already created", async () => {
	const { store, config } = testPaths("low");
	const runtime = await openRuntime({ storePath: store, configPath: config, provider: "faux", withMcp: false });
	const existing = await runtime.root.commit(
		(tx) => createJobInCommit(tx, "existing work", runtime.model, runtime.jobExtensions, runtime.cwd, jobOptionsOf(runtime.config)),
		runtime.context,
	);
	await runtime.harness.waitForTask(existing.taskId, runtime.context);

	assert.equal(runtime.thinkingLevel, "low");
	assert.equal(await runtime.setThinkingLevel("high"), "high");

	assert.equal((await runtime.root.agent(runtime.context)).thinkingLevel, "high");
	assert.equal(await agentThinkingLevel(runtime, Number(existing.taskId)), "high");
	await runtime.close();
});

test("a job created after the change inherits the session level", async () => {
	const { store, config } = testPaths("off");
	const runtime = await openRuntime({ storePath: store, configPath: config, provider: "faux", withMcp: false });
	await runtime.setThinkingLevel("xhigh");

	const task = runtime.tasksExtension.tools?.find((tool) => tool.name === "task");
	assert.ok(task !== undefined);
	const reply = await task.execute({ action: "create", brief: "work after the change" } as never, toolApi(runtime) as never, runtime.context);
	assert.match(JSON.stringify(reply), /Started job #/);
	const job = (await scanJobs(runtime.harness, runtime.context))[0];
	assert.ok(job !== undefined);
	assert.equal(await agentThinkingLevel(runtime, Number(job.id)), "xhigh");

	await runtime.harness.waitForTask(job.id, runtime.context);
	await runtime.close();
});

test("an invalid thinking level is refused and leaves the level unchanged", async () => {
	const { store, config } = testPaths("medium");
	const runtime = await openRuntime({ storePath: store, configPath: config, provider: "faux", withMcp: false });
	await assert.rejects(() => runtime.setThinkingLevel("huge"), /must be one of/);
	assert.equal(runtime.thinkingLevel, "medium");
	assert.equal((await runtime.root.agent(runtime.context)).thinkingLevel, "medium");
	await runtime.close();
});

test("a session thinking level is not written to the config file, so a reopen starts from it", async () => {
	const { store, config } = testPaths("low");
	let runtime = await openRuntime({ storePath: store, configPath: config, provider: "faux", withMcp: false });
	await runtime.setThinkingLevel("high");
	await runtime.close();

	runtime = await openRuntime({ storePath: store, configPath: config, provider: "faux", withMcp: false });
	assert.equal(runtime.thinkingLevel, "low");
	assert.equal((await runtime.root.agent(runtime.context)).thinkingLevel, "low");
	await runtime.close();
});
