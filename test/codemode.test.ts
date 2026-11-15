import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@earendil-works/pi-durable";
import { openRuntime, type AppRuntime } from "../src/harness.ts";
import { createJobInCommit, findJobConversation, jobOptionsOf } from "../src/jobs.ts";

function testPaths(codemode: boolean): { store: string; config: string } {
	const dir = mkdtempSync(join(tmpdir(), "durable-chat-test-"));
	const config = join(dir, "config.yaml");
	writeFileSync(config, `provider: faux\ncodemode: ${codemode ? "true" : "false"}\nmcp:\n  enabled: false\n`);
	return { store: join(dir, "store.sqlite"), config };
}

/** Create a job and read the agent its conversation was configured with. */
async function jobAgent(runtime: AppRuntime, brief: string): Promise<{ agent: Agent; taskId: number }> {
	const started = await runtime.root.commit(
		(tx) => createJobInCommit(tx, brief, runtime.model, runtime.jobExtensions, runtime.cwd, jobOptionsOf(runtime.config)),
		runtime.context,
	);
	const conversation = await findJobConversation(runtime.harness, Number(started.taskId), runtime.context);
	assert.ok(conversation !== undefined);
	return { agent: await conversation.agent(runtime.context), taskId: Number(started.taskId) };
}

const names = (agent: Agent) => agent.tools.map((tool) => tool.name);

test("main and jobs both get the codemode tool from the runtime", async () => {
	const { store, config } = testPaths(true);
	const runtime = await openRuntime({ storePath: store, configPath: config, provider: "faux", withMcp: false });

	// Main stays a coordinator: a script can only call the tools its own conversation has.
	const main = await runtime.root.agent(runtime.context);
	assert.deepEqual(names(main), ["task", "fork", "reminder", "codemode"]);

	const job = await jobAgent(runtime, "check the wiring");
	assert.ok(names(job.agent).includes("codemode"));
	// The job's coding tools stay reachable from its script, which is what makes codemode useful there.
	assert.ok(job.agent.callable.some((tool) => tool.name === "read"));
	assert.ok(!names(job.agent).includes("reminder"));

	await runtime.harness.abortTask(job.taskId, runtime.context);
	await runtime.harness.waitForTask(job.taskId, runtime.context);
	await runtime.close();
});

test("turning codemode off leaves main with only its coordinator tools", async () => {
	const { store, config } = testPaths(false);
	const runtime = await openRuntime({ storePath: store, configPath: config, provider: "faux", withMcp: false });

	assert.equal(runtime.codemodeExtension, undefined);
	assert.deepEqual(names(await runtime.root.agent(runtime.context)), ["task", "fork", "reminder"]);

	const job = await jobAgent(runtime, "check the wiring without scripts");
	assert.ok(!names(job.agent).includes("codemode"));
	assert.ok(names(job.agent).includes("read"));

	await runtime.harness.abortTask(job.taskId, runtime.context);
	await runtime.harness.waitForTask(job.taskId, runtime.context);
	await runtime.close();
});
