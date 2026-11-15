import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDoc } from "@earendil-works/pi-durable";
import type { EntryId } from "@earendil-works/pi-durable";
import { openRuntime } from "../src/harness.ts";
import { createJobInCommit, findJobConversation, jobOptionsOf } from "../src/jobs.ts";
import { selectForkSource } from "../src/forks.ts";
import { JobLink } from "../src/tasks.ts";

test("the startup model configures main, queued and completed jobs, successor templates, and forks from historical context", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dchat-job-model-"));
	const configPath = join(dir, "config.yaml");
	writeFileSync(configPath, "provider: faux\nbaseUrl: http://unused.invalid/v1\nmcp:\n  enabled: false\n");
	let runtime = await openRuntime({ configPath, storePath: join(dir, "store.sqlite"), withMcp: false });
	try {
		const scout = await runtime.root.commit((tx) => createJobInCommit(tx, "prepared scout", runtime.model, runtime.jobExtensions, runtime.cwd, jobOptionsOf(runtime.config)), runtime.context);
		await runtime.harness.waitForTask(scout.taskId, runtime.context);
		await runtime.close();
		runtime = await openRuntime({ configPath, storePath: join(dir, "store.sqlite"), withMcp: false });
		const pending = await runtime.root.commit((tx) => createJobInCommit(tx, "remain queued", runtime.model, runtime.jobExtensions, runtime.cwd, jobOptionsOf(runtime.config)), runtime.context);
		await runtime.close();
		runtime = await openRuntime({ configPath, storePath: join(dir, "store.sqlite"), withMcp: false, provider: "local", model: "startup-model" });
		assert.deepEqual((await runtime.root.agent(runtime.context)).model, runtime.model);
		for (const id of [scout.taskId, pending.taskId]) {
			const conversation = (await findJobConversation(runtime.harness, Number(id), runtime.context))!;
			assert.deepEqual((await conversation.agent(runtime.context)).model, runtime.model);
		}
		const link = await runtime.harness.snapshot(JobLink, pending.taskId, runtime.context);
		assert.deepEqual(link?.template?.model, runtime.model);
		const origin = await runtime.root.commit((tx) => selectForkSource(tx, String(scout.taskId)), runtime.context);
		const source = (await findJobConversation(runtime.harness, Number(scout.taskId), runtime.context))!;
		const historical = await runtime.harness.snapshotAsOf(AgentDoc, source.id, origin.entryId as EntryId, runtime.context);
		assert.equal(historical?.model?.provider, "faux");
		const fork = await runtime.root.commit((tx) => createJobInCommit(tx, "new variant", runtime.model, runtime.jobExtensions, runtime.cwd, { ...jobOptionsOf(runtime.config), fork: origin }), runtime.context);
		const conversation = (await findJobConversation(runtime.harness, Number(fork.taskId), runtime.context))!;
		assert.deepEqual((await conversation.agent(runtime.context)).model, runtime.model);
	} finally {
		await runtime.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
