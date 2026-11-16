import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, defineTool, Harness, InboxDoc, LiveDoc, ProviderDoc } from "@earendil-works/pi-durable";
import type { Conversation, Extension } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { applyStartupJobModel, createJobInCommit, findJobConversation, MAIN_INSTRUCTIONS, scanJobs } from "../src/jobs.ts";
import { JobHandoffDoc, JobLink, JobTask } from "../src/tasks.ts";
import { JobHandoffTools } from "../src/handoff.ts";
import { createTaskExtension } from "../src/tool.ts";
import { selectForkSource } from "../src/forks.ts";
import { ensureWorkspace, jobEnvironment, planWorkspace } from "../src/workspaces.ts";
import { JobTags, resolveTaggedSource } from "../src/tags.ts";
import type { AppRuntime } from "../src/harness.ts";
import { Dashboard } from "../src/tui/app.ts";

async function fixture(t: TestContext, respond: FauxResponseFactory, extraJobExtensions: readonly Extension[] = []) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "dchat-context-forks-")));
	const repo = join(dir, "repo");
	mkdirSync(repo);
	const closes: (() => Promise<void>)[] = [];
	t.after(async () => {
		for (const close of closes.reverse()) await close();
		rmSync(dir, { recursive: true, force: true });
	});
	async function open() {
		const faux = fauxProvider(); // Immediate scripted responses: no token pacing or real-time sleeps.
		const script: FauxResponseFactory = (...args) => { faux.appendResponses([script]); return respond(...args); };
		faux.setResponses(Array.from({ length: 32 }, () => script));
		const models = createModels();
		models.setProvider(faux.provider);
		const model = { provider: faux.getModel().provider, modelId: faux.getModel().id };
		const jobExtensions = [CodingTools, JobHandoffTools, ...extraJobExtensions];
		const tasksExtension = createTaskExtension({ model, jobExtensions, cwd: repo, jobOptions: { maxTurns: 20, thinkingLevel: "off", autoContinue: false } });
		const registry = createRegistry();
		for (const extension of [...jobExtensions, tasksExtension, defineExtension({ name: "durable-chat.jobs", tasks: [JobTask] })]) registry.install(extension);
		const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "store.sqlite")), {
			models, registry, now: () => 1000, env: (target, callContext) => jobEnvironment(target, callContext, repo),
		}, context);
		const root = await harness.root(context);
		await root.configure({ model, cwd: repo, instructions: MAIN_INSTRUCTIONS, extensions: [tasksExtension] }, context);
		let closed = false;
		const close = async () => { if (!closed) { closed = true; await harness.close(context); } };
		closes.push(close);
		return { harness, root, model, jobExtensions, tasksExtension, faux, close };
	}
	return { dir, repo, open, session: await open() };
}

function latestUser(messages: readonly { role: string; content: unknown }[]): string {
	const message = messages.findLast((item) => item.role === "user");
	if (typeof message?.content === "string") return message.content;
	return JSON.stringify(message?.content) ?? "";
}

async function submit(root: Conversation, content: string) {
	return (await root.submit({ type: "input", content }, context)).wait(context);
}

function initGit(repo: string): void {
	for (const args of [["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"], ["config", "commit.gpgSign", "false"], ["config", "core.hooksPath", "/dev/null"], ["add", "."], ["commit", "-qm", "prepared base"]]) {
		execFileSync("git", ["-C", repo, ...args], { timeout: 15_000 });
	}
}

test("main can scout once and fork three jobs with inherited tool evidence, independent contexts, and completion reports", async (t) => {
	let sourceId = 0;
	let reads = 0;
	const evidence = "ONLY-IN-SCOUT-FILE-9d7a";
	const env = await fixture(t, ({ messages }) => {
		const input = latestUser(messages);
		if (input === "scout") {
			if (messages.at(-1)?.role !== "toolResult") { reads++; return fauxAssistantMessage(fauxToolCall("read", { path: "facts.txt" }), { stopReason: "toolUse" }); }
			return fauxAssistantMessage("Scouting complete; detailed evidence remains in the read result.");
		}
		if (input === "make variants" && messages.at(-1)?.role !== "toolResult") {
			return fauxAssistantMessage(["A", "B", "C"].map((variant) => fauxToolCall("fork", { source: "tag:reviewer", brief: `variant ${variant}`, workspace: "shared" })), { stopReason: "toolUse" });
		}
		if (input.startsWith("variant ")) {
			assert.ok(messages.some((message) => message.role === "toolResult" && JSON.stringify(message.content).includes(evidence)));
			return fauxAssistantMessage(`${input} used the inherited evidence.`);
		}
		return fauxAssistantMessage("Variants delegated.");
	});
	writeFileSync(join(env.repo, "facts.txt"), evidence);
	const { harness, root, model, jobExtensions } = env.session;
	const scout = await root.commit((tx) => createJobInCommit(tx, "scout", model, jobExtensions, env.repo, { maxTurns: 20, thinkingLevel: "off", tags: ["Reviewer", "reviewer"] }), context);
	sourceId = Number(scout.taskId);
	await harness.waitForTask(scout.taskId, context);
	const source = (await findJobConversation(harness, sourceId, context))!;
	// Fork-initial handoff intent must not cause a new variant to hand off an old job's work.
	await harness.commit(async (tx) => { (await tx.doc(JobHandoffDoc, source.id)).brief = "old intent"; }, context);
	await submit(root, "make variants");
	const variants = (await scanJobs(harness, context)).filter((job) => Number(job.id) !== sourceId);
	assert.equal(variants.length, 3);
	for (const job of variants) {
		assert.deepEqual(job.tags, []);
		const settled = await harness.waitForTask(job.id, context);
		assert.equal(settled.state.outcome.status, "completed");
		const child = (await findJobConversation(harness, Number(job.id), context))!;
		const state = await child.agent(context);
		assert.deepEqual(state.model, model);
		assert.ok(state.tools.some((tool) => tool.name === "read"));
		assert.ok(state.tools.every((tool) => tool.name !== "fork" && tool.name !== "task"));
		const origin = (job.input as { fork: { conversationId: number; entryId: number } }).fork;
		assert.equal(origin.conversationId, Number(source.id));
		const record = await harness.commit((tx) => tx.conversation(child.id), context);
		assert.deepEqual(record?.parent, { conversationId: source.id, at: origin.entryId });
		assert.notEqual((await harness.snapshot(ProviderDoc, child.id, context))?.sessionId, (await harness.snapshot(ProviderDoc, source.id, context))?.sessionId);
		assert.equal((await harness.snapshot(JobHandoffDoc, child.id, context))?.brief ?? "", "");
		const history = await child.entries({ order: "ascending" }, 100, undefined, context);
		const ownUsers = history.items.filter((entry) => entry.conversationId === child.id && entry.kind === "pi.user");
		assert.equal(ownUsers.length, 1);
		assert.match(JSON.stringify(ownUsers), /variant [ABC]/);
	}
	assert.equal(reads, 1);
	assert.doesNotMatch(JSON.stringify((await source.entries({ order: "ascending" }, 100, undefined, context)).items), /variant [ABC]/);
	const notices = JSON.stringify((await root.entries({ order: "ascending" }, 100, undefined, context)).items);
	for (const variant of variants) assert.ok(notices.includes(`Background job #${variant.id} completed`));
});

test("main can tag completed contexts, resolve those tags after restart, and reject ambiguous tag forks without admitting work", async (t) => {
	let sourceId = 0;
	let childId = 0;
	const env = await fixture(t, ({ messages }) => {
		const input = latestUser(messages);
		if (messages.at(-1)?.role !== "toolResult") {
			if (input === "create scout") return fauxAssistantMessage(fauxToolCall("task", { action: "create", brief: "prepare context", tags: ["Scout"] }), { stopReason: "toolUse" });
			if (input === "tag scout") return fauxAssistantMessage(fauxToolCall("task", { action: "tag", id: String(sourceId), tags: ["Reviewer", "primed"] }), { stopReason: "toolUse" });
			if (input === "fork reviewer") return fauxAssistantMessage(fauxToolCall("fork", { source: "tag:reviewer", brief: "review variant" }), { stopReason: "toolUse" });
			if (input === "duplicate label") return fauxAssistantMessage(fauxToolCall("task", { action: "tag", id: String(childId), tags: ["reviewer"] }), { stopReason: "toolUse" });
			if (input === "clear duplicate") return fauxAssistantMessage(fauxToolCall("task", { action: "tag", id: String(childId), tags: [] }), { stopReason: "toolUse" });
		}
		return fauxAssistantMessage("Prepared or handled.");
	});
	let session = env.session;
	await submit(session.root, "create scout");
	const scout = (await scanJobs(session.harness, context))[0]!;
	sourceId = Number(scout.id);
	await session.harness.waitForTask(scout.id, context);
	assert.deepEqual((await scanJobs(session.harness, context))[0]?.tags, ["scout"]);
	await submit(session.root, "tag scout");
	assert.deepEqual((await scanJobs(session.harness, context))[0]?.tags, ["reviewer", "primed"]);
	await session.close();
	session = await env.open();
	await submit(session.root, "fork reviewer");
	const variants = (await scanJobs(session.harness, context)).filter((job) => Number(job.id) !== sourceId);
	assert.equal(variants.length, 1);
	childId = Number(variants[0]!.id);
	await session.harness.waitForTask(variants[0]!.id, context);
	await submit(session.root, "duplicate label");
	await submit(session.root, "fork reviewer");
	assert.equal((await scanJobs(session.harness, context)).length, 2);
	assert.match(JSON.stringify((await session.root.entries({ order: "ascending" }, 100, undefined, context)).items), /Tag reviewer matches jobs/);
	await submit(session.root, "clear duplicate");
	const labels = await session.harness.snapshot(JobTags, context);
	assert.equal(resolveTaggedSource("tag:Reviewer", labels), String(sourceId));
	assert.throws(() => resolveTaggedSource("tag:missing", labels), /No job has tag/);
});

test("forking main cuts before its in-flight fork call and the fork authority remains main-only even if accidentally installed on a worker", async (t) => {
	const env = await fixture(t, ({ messages }) => {
		const input = latestUser(messages);
		if ((input === "fork main now" || input === "try forbidden fork") && messages.at(-1)?.role !== "toolResult") {
			return fauxAssistantMessage(fauxToolCall("fork", { source: "main", brief: "independent variant" }), { stopReason: "toolUse" });
		}
		return fauxAssistantMessage("Prepared context or finished assignment.");
	});
	const { root, harness, tasksExtension, jobExtensions } = env.session;
	await root.configure({ tools: [...tasksExtension.tools!], modelTools: [...tasksExtension.tools!] }, context);
	const primed = await submit(root, "prepare main context");
	assert.equal(primed.status, "done");
	await submit(root, "fork main now");
	const jobs = await scanJobs(harness, context);
	assert.equal(jobs.length, 1);
	await harness.waitForTask(jobs[0]!.id, context);
	const child = (await findJobConversation(harness, Number(jobs[0]!.id), context))!;
	const record = await harness.commit((tx) => tx.conversation(child.id), context);
	assert.equal(record?.parent?.at, primed.status === "done" && primed.type === "input" ? primed.answer : undefined);
	assert.ok((await child.agent(context)).tools.some((tool) => tool.name === "read"));
	await child.configure({ extensions: [...jobExtensions, tasksExtension] }, context);
	await submit(child, "try forbidden fork");
	assert.equal((await scanJobs(harness, context)).length, 1);
	assert.match(JSON.stringify((await child.entries({ order: "ascending" }, 100, undefined, context)).items), /Only main may fork/);
});

test("fork selection rejects missing sources and requires a completed turn in the active context", async (t) => {
	const env = await fixture(t, () => fauxAssistantMessage("Prepared."));
	const { root, harness } = env.session;
	await assert.rejects(root.commit((tx) => selectForkSource(tx, "main"), context), /no completed assistant turn/);
	await assert.rejects(root.commit((tx) => selectForkSource(tx, "99999"), context), /No source job/);
	await submit(root, "prepare");
	await root.reset(undefined, context);
	await harness.waitForIdle(context);
	await assert.rejects(root.commit((tx) => selectForkSource(tx, "main"), context), /no completed assistant turn/);
});

test("main's worktree fork rejects a dirty source before admitting a job and then runs a clean variant in its assigned checkout", async (t) => {
	const env = await fixture(t, ({ messages }) => {
		const input = latestUser(messages);
		if (input === "fork a worktree" && messages.at(-1)?.role !== "toolResult") return fauxAssistantMessage(fauxToolCall("fork", { source: "main", brief: "edit the worktree", workspace: "worktree" }), { stopReason: "toolUse" });
		if (input === "edit the worktree" && messages.at(-1)?.role !== "toolResult") return fauxAssistantMessage(fauxToolCall("write", { path: "variant.txt", content: "isolated result\n" }), { stopReason: "toolUse" });
		return fauxAssistantMessage("Prepared or complete.");
	});
	writeFileSync(join(env.repo, "base.txt"), "prepared\n");
	initGit(env.repo);
	const { harness, root } = env.session;
	await submit(root, "prime");
	writeFileSync(join(env.repo, "unfinished.txt"), "preserve\n");
	await submit(root, "fork a worktree");
	assert.equal((await scanJobs(harness, context)).length, 0);
	assert.match(JSON.stringify((await root.entries({ order: "ascending" }, 100, undefined, context)).items), /clean source checkout/);
	rmSync(join(env.repo, "unfinished.txt"));
	await submit(root, "fork a worktree");
	const jobs = await scanJobs(harness, context);
	assert.equal(jobs.length, 1);
	assert.equal((await harness.waitForTask(jobs[0]!.id, context)).state.outcome.status, "completed");
	const child = (await findJobConversation(harness, Number(jobs[0]!.id), context))!;
	const cwd = (await child.agent(context)).cwd!;
	assert.equal(readFileSync(join(cwd, "variant.txt"), "utf8"), "isolated result\n");
	assert.equal(existsSync(join(env.repo, "variant.txt")), false);
});

test("a fork resumes its saved worktree and stable submission after setup occurred before shutdown", async (t) => {
	const env = await fixture(t, ({ messages }) => messages.at(-1)?.role === "toolResult"
		? fauxAssistantMessage("Variant complete.")
		: latestUser(messages) === "write variant"
			? fauxAssistantMessage(fauxToolCall("write", { path: "variant.txt", content: "only in the variant\n" }), { stopReason: "toolUse" })
			: fauxAssistantMessage("Prepared."));
	writeFileSync(join(env.repo, "base.txt"), "prepared\n");
	initGit(env.repo);
	let session = env.session;
	await submit(session.root, "prepare source");
	const origin = await session.root.commit((tx) => selectForkSource(tx, "main"), context);
	const workspace = await planWorkspace(env.repo, "worktree");
	await session.close();
	session = await env.open(); // Paused scheduler: persist the fork before its setup phase can run.
	const started = await session.root.commit((tx) => createJobInCommit(tx, "write variant", session.model, session.jobExtensions, workspace.cwd, {
		maxTurns: 20, thinkingLevel: "off", fork: origin, workspace, notifyMain: true, tags: ["variant-work"],
	}), context);
	await ensureWorkspace(workspace);
	writeFileSync(join(workspace.cwd, "unfinished.txt"), "retain across restart\n");
	await session.close();
	session = await env.open();
	const result = await session.harness.waitForTask(started.taskId, context);
	assert.equal(result.state.outcome.status, "completed");
	assert.deepEqual((await scanJobs(session.harness, context)).find((job) => job.id === started.taskId)?.tags, ["variant-work"]);
	assert.equal(readFileSync(join(workspace.cwd, "variant.txt"), "utf8"), "only in the variant\n");
	assert.equal(readFileSync(join(workspace.cwd, "unfinished.txt"), "utf8"), "retain across restart\n");
	assert.equal(existsSync(join(env.repo, "variant.txt")), false);
	const child = (await findJobConversation(session.harness, Number(started.taskId), context))!;
	assert.equal((await child.agent(context)).cwd, workspace.cwd);
	const users = (await child.entries({ order: "ascending" }, 100, undefined, context)).items.filter((entry) => entry.conversationId === child.id && entry.kind === "pi.user");
	assert.equal(users.length, 1);
});

test("changing the startup model leaves an outstanding deferred response pinned to its prepared model", { timeout: 20_000 }, async (t) => {
	const env = await fixture(t, () => fauxAssistantMessage("", {
		stopReason: "deferred",
		deferred: { provider: "faux", modelId: "faux-1", api: "faux", id: "retained-response", pollAfterMs: 60_000 },
	}));
	const { harness, root, model } = env.session;
	const watch = await harness.watchTaskGraph(context);
	const polling = Promise.withResolvers<void>();
	watch.start(async (call) => {
		if (call.kind === "value" && Object.values(call.value.tasks).some((node) => node.kind === "pi.generation" && JSON.stringify(node.state).includes('"phase":"poll"'))) polling.resolve();
	});
	try {
		await root.submit({ type: "input", content: "defer until later" }, context);
		await polling.promise;
		await applyStartupJobModel(harness, { provider: "local", modelId: "another-model" }, context);
		// The job-wide model is advisory; the admitted poll keeps the model it was prepared with.
		const tasks = (await harness.inspect(context)).tasks;
		assert.ok(tasks.some((task) => task.record.kind === "pi.generation" && JSON.stringify(task.record.state.checkpoint).includes('"modelId":"faux-1"')));
		assert.deepEqual((await root.agent(context)).model, model);
	} finally {
		await watch.stop();
	}
});

test("workspace setup failure reports to main before any worker request or file mutation", async (t) => {
	const env = await fixture(t, () => fauxAssistantMessage("Prepared."));
	writeFileSync(join(env.repo, "base.txt"), "prepared\n");
	initGit(env.repo);
	const { root, harness, model, jobExtensions, faux } = env.session;
	await submit(root, "prepare");
	const origin = await root.commit((tx) => selectForkSource(tx, "main"), context);
	const workspace = await planWorkspace(env.repo, "worktree");
	assert.equal(workspace.kind, "worktree");
	if (workspace.kind !== "worktree") return;
	mkdirSync(workspace.path, { recursive: true });
	writeFileSync(join(workspace.path, "keep.txt"), "existing work");
	const started = await root.commit((tx) => createJobInCommit(tx, "must not run", model, jobExtensions, workspace.cwd, {
		maxTurns: 20, thinkingLevel: "off", fork: origin, workspace, notifyMain: true,
	}), context);
	const calls = faux.state.callCount;
	const receipt = await harness.waitForTask(started.taskId, context);
	assert.equal(receipt.state.outcome.status, "failed");
	assert.equal(faux.state.callCount, calls);
	assert.equal(readFileSync(join(workspace.path, "keep.txt"), "utf8"), "existing work");
	assert.match(JSON.stringify((await root.entries({ order: "ascending" }, 100, undefined, context)).items), /Workspace setup failed/);
});

// Draft-only steering tests cannot prove main has a model-callable control or stays responsive.
test("main can steer a running job and answer before the worker consumes the new direction", { timeout: 10_000 }, async (t) => {
	const workerReady = Promise.withResolvers<void>();
	const releaseWorker = Promise.withResolvers<void>();
	t.after(() => releaseWorker.resolve());
	let workerId = 0;
	const env = await fixture(t, async ({ messages }) => {
		const input = latestUser(messages);
		if (input === "original work") {
			workerReady.resolve();
			await releaseWorker.promise;
			return fauxAssistantMessage("Initial work complete.");
		}
		if (input === "use the corrected scope") return fauxAssistantMessage("Finished using the corrected scope.");
		if (input === "redirect the worker") {
			if (messages.at(-1)?.role !== "toolResult") return fauxAssistantMessage(fauxToolCall("task", { action: "steer", id: String(workerId), message: "use the corrected scope" }), { stopReason: "toolUse" });
			assert.equal(messages.at(-1)?.role === "toolResult" && messages.at(-1)?.isError, false);
			assert.match(JSON.stringify(messages.at(-1)?.content), /steering.*queued|queued.*steering/i);
			return fauxAssistantMessage("Steering queued; the job is still running.");
		}
		return fauxAssistantMessage("Ready.");
	});
	const { harness, root, model, jobExtensions } = env.session;
	const started = await root.commit((tx) => createJobInCommit(tx, "original work", model, jobExtensions, env.repo, { maxTurns: 20, thinkingLevel: "off", notifyMain: true, autoContinue: false }), context);
	workerId = Number(started.taskId);
	harness.resume();
	await workerReady.promise;
	assert.equal((await submit(root, "redirect the worker")).status, "done");
	assert.notEqual((await harness.getTask(started.taskId, context))?.state.status, "terminal");
	releaseWorker.resolve();
	const receipt = await harness.waitForTask(started.taskId, context);
	assert.equal(receipt.state.outcome.status, "completed", JSON.stringify(receipt.state.outcome));
	if (receipt.state.outcome.status === "completed") assert.match(receipt.state.outcome.result.answer ?? "", /corrected scope/);
	const worker = (await findJobConversation(harness, workerId, context))!;
	const entries = (await worker.entries({ order: "ascending" }, 100, undefined, context)).items;
	assert.equal(entries.filter((entry) => entry.kind === "pi.user" && JSON.stringify(entry.model).includes("use the corrected scope")).length, 1);
	assert.match(JSON.stringify((await root.entries({ order: "ascending" }, 100, undefined, context)).items), /corrected scope/);
});

test("main steering survives a restart during worker tool execution without duplicate input", { timeout: 10_000 }, async (t) => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	t.after(() => release.resolve());
	let attempts = 0;
	const heldWork = defineExtension({ name: "test.steering-work", tools: [defineTool({
		name: "controlled_work", description: "A test-controlled job boundary.", parameters: obj({}), replay: "safe",
		execute: async (_args, _api, callContext) => {
			attempts++;
			if (attempts === 1) {
				const onAbort = () => release.resolve();
				callContext.abortSignal?.addEventListener("abort", onAbort, { once: true });
				try {
					entered.resolve();
					await release.promise;
					callContext.abortSignal?.throwIfAborted();
				} finally { callContext.abortSignal?.removeEventListener("abort", onAbort); }
			}
			return { output: [{ type: "text", text: "Work boundary reached." }] };
		},
	})] });
	let workerId = 0;
	const env = await fixture(t, ({ messages }) => {
		const input = latestUser(messages);
		if (input === "original work") return fauxAssistantMessage(fauxToolCall("controlled_work", {}), { stopReason: "toolUse" });
		if (input === "use the corrected scope") return fauxAssistantMessage("Finished using the corrected scope.");
		if (input === "redirect the worker" && messages.at(-1)?.role !== "toolResult") return fauxAssistantMessage(fauxToolCall("task", { action: "steer", id: String(workerId), message: "use the corrected scope" }), { stopReason: "toolUse" });
		return fauxAssistantMessage("Steering queued.");
	}, [heldWork]);
	const { harness, root, model, jobExtensions } = env.session;
	const started = await root.commit((tx) => createJobInCommit(tx, "original work", model, jobExtensions, env.repo, { maxTurns: 20, thinkingLevel: "off", notifyMain: true, autoContinue: false }), context);
	workerId = Number(started.taskId);
	harness.resume();
	await entered.promise;
	assert.equal((await submit(root, "redirect the worker")).status, "done");
	await env.session.close();
	const reopened = await env.open();
	const receipt = await reopened.harness.waitForTask(started.taskId, context);
	assert.equal(receipt.state.outcome.status, "completed", JSON.stringify(receipt.state.outcome));
	if (receipt.state.outcome.status === "completed") assert.match(receipt.state.outcome.result.answer ?? "", /corrected scope/);
	assert.equal(attempts, 2);
	const worker = (await findJobConversation(reopened.harness, workerId, context))!;
	const entries = (await worker.entries({ order: "ascending" }, 100, undefined, context)).items;
	assert.equal(entries.filter((entry) => entry.kind === "pi.user" && JSON.stringify(entry.model).includes("use the corrected scope")).length, 1);
});

test("main steering rejects invalid targets and idle or finished jobs without starting work", async (t) => {
	const env = await fixture(t, () => fauxAssistantMessage("Complete."));
	const { harness, root, model, jobExtensions, tasksExtension } = env.session;
	const started = await root.commit((tx) => createJobInCommit(tx, "complete once", model, jobExtensions, env.repo, { maxTurns: 20, thinkingLevel: "off" }), context);
	const worker = (await findJobConversation(harness, Number(started.taskId), context))!;
	const tool = tasksExtension.tools!.find((candidate) => candidate.name === "task")!;
	const api = {
		conversationId: root.id,
		getTask: (id: Parameters<typeof harness.getTask>[0]) => harness.getTask(id, context),
		commit: (body: Parameters<typeof harness.commit>[0]) => harness.commit(body, context),
		conversation: (id: Parameters<typeof harness.conversation>[0]) => harness.conversation(id, context),
	};
	const pendingEntries = (await worker.entries({ order: "ascending" }, 100, undefined, context)).items;
	const idle = await tool.execute!({ action: "steer", id: String(started.taskId), message: "redirect" }, api as never, context);
	assert.equal(idle.isError, true);
	assert.match(JSON.stringify(idle.output), /no active run/i);
	assert.deepEqual((await worker.entries({ order: "ascending" }, 100, undefined, context)).items, pendingEntries);
	await harness.waitForTask(started.taskId, context);
	const before = (await worker.entries({ order: "ascending" }, 100, undefined, context)).items;
	for (const [args, error] of [
		[{ action: "steer", message: "redirect" }, /job id/i],
		[{ action: "steer", id: String(started.taskId), message: " " }, /needs a brief/i],
		[{ action: "steer", id: "99999999999999999999", message: "redirect" }, /job id/i],
		[{ action: "steer", id: "999999", message: "redirect" }, /No job/],
		[{ action: "steer", id: String(started.taskId), message: "redirect" }, /no longer running/i],
	] as const) {
		const result = await tool.execute!(args, api as never, context);
		assert.equal(result.isError, true);
		assert.match(JSON.stringify(result.output), error);
	}
	const forbidden = await tool.execute!({ action: "steer", id: String(started.taskId), message: "redirect" }, { ...api, conversationId: worker.id } as never, context);
	assert.equal(forbidden.isError, true);
	assert.match(JSON.stringify(forbidden.output), /Only main/i);
	const record = (await harness.getTask(started.taskId, context))!;
	// Model the completion race: the coordinator task still appears live after its conversation went idle.
	const raced = await tool.execute!({ action: "steer", id: String(started.taskId), message: "redirect" }, {
		...api, getTask: async () => ({ ...record, state: { status: "running", checkpoint: { phase: "run" } } }),
	} as never, context);
	assert.equal(raced.isError, true);
	assert.match(JSON.stringify(raced.output), /no longer running/i);
	assert.deepEqual((await worker.entries({ order: "ascending" }, 100, undefined, context)).items, before);
	assert.equal((await scanJobs(harness, context)).length, 1);
});

// Main's tool tests cannot prove the direct composer selects steering, or distinguish it from follow-up.
for (const followUp of [false, true]) {
	test(`direct job composer ${followUp ? "Command-Shift-Enter follow-up waits for the final boundary in order" : "defaults to steering at the post-tool boundary in the same run"}`, { timeout: 10_000 }, async (t) => {
		const entered = Promise.withResolvers<void>();
		const releaseTool = Promise.withResolvers<void>();
		const nextRequest = Promise.withResolvers<string>();
		const releaseAnswer = Promise.withResolvers<void>();
		t.after(() => { releaseTool.resolve(); releaseAnswer.resolve(); });
		let toolFinished = false;
		const requests: string[] = [];
		const controlled = defineExtension({ name: "test.direct-input", tools: [defineTool({
			name: "controlled_boundary", description: "A controlled tool boundary.", parameters: obj({}), replay: "safe",
			execute: async () => {
				entered.resolve();
				await releaseTool.promise;
				toolFinished = true;
				return { output: [{ type: "text", text: "Tool finished normally." }] };
			},
		})] });
		const env = await fixture(t, async ({ messages }) => {
			const input = latestUser(messages);
			requests.push(input);
			if (input === "original work" && messages.at(-1)?.role !== "toolResult") {
				return fauxAssistantMessage(fauxToolCall("controlled_boundary", {}), { stopReason: "toolUse" });
			}
			nextRequest.resolve(input);
			await releaseAnswer.promise;
			return fauxAssistantMessage(input === "original work" ? "Original answer." : `Handled: ${input}`);
		}, [controlled]);
		const { harness, root, model, jobExtensions } = env.session;
		const started = await root.commit((tx) => createJobInCommit(tx, "original work", model, jobExtensions, env.repo, { maxTurns: 20, thinkingLevel: "off", autoContinue: false }), context);
		harness.resume();
		await entered.promise;
		const worker = (await findJobConversation(harness, Number(started.taskId), context))!;
		const originalRun = (await harness.snapshot(LiveDoc, worker.id, context))!.run!;
		const dashboard = new Dashboard({
			runtime: { root, harness, context, config: { contextWindow: 128000, configPath: "/unused", thinkingLevel: "off" }, modelLabel: "faux", storePath: join(env.dir, "store.sqlite"), jobExtensions } as unknown as AppRuntime,
			rows: () => 24, requestRender() {}, onQuit() {},
		});
		try {
			await dashboard.start();
			dashboard.render(160);
			await dashboard.handleInput("\t");
			await dashboard.handleInput("\r"); // Pin + composer, with no extra Tab needed.
			const marker = "late direction\nkeep this formatting";
			await dashboard.handleInput(marker);
			await dashboard.handleInput(followUp ? "\x1b[13;10u" : "\r"); // Admission returns while the tool is held.
			if (followUp) {
				await dashboard.handleInput("second queued message");
				await dashboard.handleInput("\x1b[13;10u"); // Each follow-up is explicitly one-shot.
			}
			assert.equal(toolFinished, false, "admission must not interrupt or wait for the executing tool");
			assert.deepEqual(requests, ["original work"], "no concurrent model turn starts on admission");
			assert.equal((await harness.snapshot(LiveDoc, worker.id, context))!.run!.taskId, originalRun.taskId);
			const inbox = (await harness.snapshot(InboxDoc, worker.id, context))!.items;
			assert.deepEqual(inbox.map((item) => item.mode), followUp ? ["followUp", "followUp"] : ["steer"]);
			assert.deepEqual(inbox.map((item) => "content" in item ? item.content : undefined), followUp ? [marker, "second queued message"] : [marker]);
			assert.doesNotMatch(JSON.stringify((await worker.entries({ order: "ascending" }, 100, undefined, context)).items), /late direction/);
			if (!followUp) assert.equal((await harness.snapshot(JobLink, started.taskId, context))?.steering?.message, marker);
			assert.equal((await root.entries({ order: "ascending" }, 100, undefined, context)).items.filter((entry) => entry.kind === "pi.user").length, 0);
			releaseTool.resolve();
			assert.equal(await nextRequest.promise, followUp ? "original work" : marker);
			const afterTools = (await harness.snapshot(LiveDoc, worker.id, context))!.run!;
			assert.equal(afterTools.first, originalRun.first, "generations hand over the same logical run");
			assert.ok(originalRun.inputs.every((id) => afterTools.inputs.includes(id)), "the original input has not settled into a successor run");
			if (followUp) assert.equal((await harness.snapshot(InboxDoc, worker.id, context))!.items.length, 2, "follow-ups stay queued at the post-tool boundary");
			releaseAnswer.resolve();
			for (const item of inbox) assert.equal((await (await harness.submission(item.id, context))!.wait(context)).status, "done");
			await harness.waitForTask(started.taskId, context);
			const entries = (await worker.entries({ order: "ascending" }, 100, undefined, context)).items;
			const users = entries.filter((entry) => entry.kind === "pi.user").map((entry) => latestUser(entry.model ?? []));
			assert.deepEqual(users, followUp ? ["original work", marker, "second queued message"] : ["original work", marker]);
			const receipt = await harness.waitForTask(started.taskId, context);
			assert.equal(receipt.state.outcome.status, "completed");
			if (!followUp && receipt.state.outcome.status === "completed") assert.match(receipt.state.outcome.result.answer ?? "", /Handled: late direction/);
			if (followUp) {
				const originalAnswer = entries.findIndex((entry) => entry.kind === "pi.assistant" && JSON.stringify(entry.model).includes("Original answer."));
				const lateInput = entries.findIndex((entry) => entry.kind === "pi.user" && JSON.stringify(entry.model).includes("late direction"));
				assert.ok(originalAnswer >= 0 && lateInput > originalAnswer, "follow-up lands only after the original answer");
			}
		} finally { await dashboard.stop(); }
	});
}
