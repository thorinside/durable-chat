import { test } from "node:test";
import type { Extension } from "@earendil-works/pi-durable";
import { ReminderTools } from "../src/reminders.ts";
import { openCodemode } from "../src/codemode.ts";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { Message } from "@earendil-works/pi-ai";
import { canonicalInstructionPath, createRepositoryInstructions, loadRepositoryInstructions } from "../src/agent-instructions.ts";
import { openRuntime } from "../src/harness.ts";
import { applyStartupJobModel, createJobInCommit, findJobConversation } from "../src/jobs.ts";
import { selectForkSource } from "../src/forks.ts";
import { JobLink, JobTask } from "../src/tasks.ts";
import { ensureWorkspace, jobEnvironment, planWorkspace } from "../src/workspaces.ts";

function directory(t: TestContext) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "dchat-instructions-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function put(path: string, text: string) { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); }
const snapshots = (messages: readonly Message[]) => messages.filter((message) => message.role === "user" && typeof message.content === "string" && message.content.startsWith("Repository instructions (automatically loaded"));
const snapshot = (messages: readonly Message[]) => snapshots(messages).map((message) => message.content).join("\n");

async function fixture(t: TestContext, cwd: string, respond: FauxResponseFactory, extra: Extension[] = []) {
	const faux = fauxProvider();
	const script: FauxResponseFactory = (...args) => { faux.appendResponses([script]); return respond(...args); };
	faux.setResponses(Array.from({ length: 16 }, () => script));
	const models = createModels(); models.setProvider(faux.provider);
	const model = { provider: faux.getModel().provider, modelId: faux.getModel().id };
	const instructions = createRepositoryInstructions(cwd);
	const jobExtensions = [CodingTools, instructions, ...extra];
	const registry = createRegistry();
	for (const extension of [...jobExtensions, ReminderTools, defineExtension({ name: "jobs", tasks: [JobTask] })]) registry.install(extension);
	const harness = await Harness.open(await openNodeSqliteStorage(join(directory(t), "store.sqlite")), {
		models, registry, now: () => 1000,
		env: (target, callContext) => jobEnvironment(target, callContext, cwd),
	}, context);
	t.after(() => harness.close(context));
	const root = await harness.root(context);
	await root.configure({ model, cwd, instructions: "Trusted coordinator policy", extensions: [...jobExtensions, ReminderTools], maxTurns: 12 }, context);
	return { harness, root, model, jobExtensions, instructions };
}

test("AGENTS hierarchy is root-to-leaf, never scans siblings, and resolves symlinks and nonexistent write directories", async (t) => {
	const dir = directory(t);
	put(join(dir, "AGENTS.md"), "ancestor-rule");
	put(join(dir, "repo", "AGENTS.md"), "repository-rule");
	put(join(dir, "repo", "src", "AGENTS.md"), "specific-rule");
	put(join(dir, "repo", "other", "AGENTS.md"), "sibling-rule");
	put(join(dir, "repo", "src", "empty", "AGENTS.md"), " \n");
	const files = await loadRepositoryInstructions(join(dir, "repo", "src", "empty", "new"));
	assert.deepEqual(files.filter((file) => file.path.startsWith(dir)).map((file) => file.text), ["ancestor-rule", "repository-rule", "specific-rule"]);
	symlinkSync(join(dir, "repo", "src"), join(dir, "alias"));
	assert.equal(await canonicalInstructionPath(join(dir, "alias", "missing", "file.ts")), join(dir, "repo", "src", "missing", "file.ts"));
	assert.deepEqual(await loadRepositoryInstructions(join(dir, "alias")), await loadRepositoryInstructions(join(dir, "repo", "src")));
});

test("invalid and oversized instruction files fail visibly instead of silently omitting rules", async (t) => {
	const dir = directory(t);
	mkdirSync(join(dir, "AGENTS.md"));
	await assert.rejects(loadRepositoryInstructions(dir), /not a regular file/);
	rmSync(join(dir, "AGENTS.md"), { recursive: true });
	put(join(dir, "AGENTS.md"), "x".repeat(128 * 1024 + 1));
	await assert.rejects(loadRepositoryInstructions(dir), /exceed/);
});

test("Main receives fresh lower-priority repository context without repeated durable entries or sibling leakage", async (t) => {
	const dir = directory(t);
	put(join(dir, "AGENTS.md"), "root-rule");
	put(join(dir, "a", "AGENTS.md"), "a-rule");
	put(join(dir, "b", "AGENTS.md"), "b-rule");
	let expected = "a-rule";
	let absent = "b-rule";
	const env = await fixture(t, join(dir, "a"), ({ messages }) => {
		assert.equal(snapshots(messages).length, 1);
		assert.match(snapshot(messages), /root-rule/);
		assert.ok(snapshot(messages).includes(expected));
		assert.ok(!snapshot(messages).includes(absent));
		assert.ok(!messages.filter((message) => message.role === "system").some((message) => JSON.stringify(message).includes(expected)));
		return fauxAssistantMessage("done");
	});
	const submit = async () => (await env.root.submit({ type: "input", content: "work" }, context)).wait(context);
	await submit(); await submit();
	put(join(dir, "a", "AGENTS.md"), "updated-rule"); expected = "updated-rule"; absent = "a-rule";
	await submit();
	await env.root.configure({ cwd: join(dir, "b") }, context); expected = "b-rule"; absent = "updated-rule";
	await submit();
	const entries = await env.root.entries({ order: "ascending" }, 100, undefined, context);
	assert.doesNotMatch(JSON.stringify(entries.items), /root-rule|a-rule|updated-rule|b-rule/);
});

test("nested writes pause before mutation, refresh changed rules, and retry only after model delivery", async (t) => {
	const dir = directory(t);
	put(join(dir, "AGENTS.md"), "root-rule");
	put(join(dir, "nested", "AGENTS.md"), "nested-rule-v1");
	put(join(dir, "sibling", "AGENTS.md"), "never-load-sibling");
	let round = 0;
	const env = await fixture(t, dir, ({ messages }) => {
		round++;
		assert.doesNotMatch(snapshot(messages), /never-load-sibling/);
		if (round === 1) {
			assert.doesNotMatch(snapshot(messages), /nested-rule/);
			return fauxAssistantMessage(fauxToolCall("write", { path: "nested/new/output.txt", content: "one" }), { stopReason: "toolUse" });
		}
		if (round === 2) {
			assert.equal(existsSync(join(dir, "nested/new/output.txt")), false);
			assert.match(snapshot(messages), /nested-rule-v1/);
			return fauxAssistantMessage(fauxToolCall("write", { path: "nested/new/output.txt", content: "one" }), { stopReason: "toolUse" });
		}
		if (round === 3) {
			assert.equal(readFileSync(join(dir, "nested/new/output.txt"), "utf8"), "one");
			put(join(dir, "nested", "AGENTS.md"), "nested-rule-v2");
			return fauxAssistantMessage(fauxToolCall("write", { path: "nested/new/output.txt", content: "two" }), { stopReason: "toolUse" });
		}
		if (round === 4) {
			assert.equal(readFileSync(join(dir, "nested/new/output.txt"), "utf8"), "one");
			assert.match(snapshot(messages), /nested-rule-v2/);
			assert.doesNotMatch(snapshot(messages), /nested-rule-v1/);
			return fauxAssistantMessage(fauxToolCall("write", { path: "nested/new/output.txt", content: "two" }), { stopReason: "toolUse" });
		}
		assert.equal(readFileSync(join(dir, "nested/new/output.txt"), "utf8"), "two");
		return fauxAssistantMessage("done");
	});
	await (await env.root.submit({ type: "input", content: "write" }, context)).wait(context);
	assert.equal(round, 5);
});

test("background jobs and context forks receive their own directory rules rather than inherited sibling scopes", async (t) => {
	const dir = directory(t);
	put(join(dir, "AGENTS.md"), "common-rule");
	put(join(dir, "a", "AGENTS.md"), "source-only-rule");
	put(join(dir, "b", "AGENTS.md"), "fork-only-rule");
	const env = await fixture(t, dir, ({ messages }) => {
		const input = messages.findLast((message) => message.role === "user")?.content;
		assert.match(snapshot(messages), /common-rule/);
		if (input === "source") {
			assert.match(snapshot(messages), /source-only-rule/);
			assert.doesNotMatch(snapshot(messages), /fork-only-rule/);
		} else {
			assert.equal(input, "variant");
			assert.match(snapshot(messages), /fork-only-rule/);
			assert.doesNotMatch(snapshot(messages), /source-only-rule/);
		}
		return fauxAssistantMessage("completed");
	});
	const options = { maxTurns: 12, thinkingLevel: "off" as const, autoContinue: false };
	const source = await env.root.commit((tx) => createJobInCommit(tx, "source", env.model, env.jobExtensions, join(dir, "a"), options), context);
	await env.harness.waitForTask(source.taskId, context);
	const origin = await env.root.commit((tx) => selectForkSource(tx, String(source.taskId)), context);
	const fork = await env.root.commit((tx) => createJobInCommit(tx, "variant", env.model, env.jobExtensions, join(dir, "b"), { ...options, fork: origin }), context);
	assert.equal((await env.harness.waitForTask(fork.taskId, context)).state.outcome.status, "completed");
});

test("managed worktrees load their committed instructions and external ancestors, not source checkout edits", async (t) => {
	const dir = directory(t);
	const repo = join(dir, "repo"); mkdirSync(repo);
	put(join(dir, "AGENTS.md"), "outside-rule");
	put(join(repo, "AGENTS.md"), "committed-root-rule");
	put(join(repo, "src", "AGENTS.md"), "committed-src-rule");
	for (const args of [["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"], ["config", "commit.gpgSign", "false"], ["add", "."], ["commit", "-qm", "base"]]) execFileSync("git", ["-C", repo, ...args]);
	const workspace = await planWorkspace(join(repo, "src"), "worktree");
	await ensureWorkspace(workspace);
	put(join(repo, "AGENTS.md"), "source-edit-must-not-leak");
	const files = await loadRepositoryInstructions(workspace.cwd);
	assert.deepEqual(files.filter((file) => file.path.startsWith(dir)).map((file) => file.text), ["outside-rule", "committed-root-rule", "committed-src-rule"]);
	const env = await fixture(t, repo, ({ messages }) => {
		assert.match(snapshot(messages), /committed-root-rule/);
		assert.match(snapshot(messages), /committed-src-rule/);
		assert.doesNotMatch(snapshot(messages), /source-edit-must-not-leak/);
		return fauxAssistantMessage("done");
	});
	const job = await env.root.commit((tx) => createJobInCommit(tx, "worktree", env.model, env.jobExtensions, workspace.cwd, { maxTurns: 12, thinkingLevel: "off", workspace }), context);
	assert.equal((await env.harness.waitForTask(job.taskId, context)).state.outcome.status, "completed");
});

test("runtime selects instruction loading for Main and jobs and upgrades existing job successor templates", async (t) => {
	const dir = directory(t);
	const config = join(dir, "config.yaml"); put(config, "provider: faux\ncodemode: false\nmcp: { enabled: false }\n");
	const runtime = await openRuntime({ configPath: config, storePath: join(dir, "store.sqlite"), withMcp: false });
	t.after(() => runtime.close());
	const name = "durable-chat.repository-instructions";
	assert.ok((await runtime.root.agent(runtime.context)).extensions.some((extension) => extension.name === name));
	assert.ok(runtime.jobExtensions.some((extension) => extension.name === name));
	const legacyExtensions = runtime.jobExtensions.filter((extension) => extension.name !== name);
	const job = await runtime.root.commit((tx) => createJobInCommit(tx, "legacy", runtime.model, legacyExtensions, runtime.cwd, { maxTurns: 12, thinkingLevel: "off" }), runtime.context);
	await applyStartupJobModel(runtime.harness, runtime.model, runtime.context, runtime.jobExtensions.find((extension) => extension.name === name));
	const child = (await findJobConversation(runtime.harness, Number(job.taskId), runtime.context))!;
	assert.ok((await child.agent(runtime.context)).extensions.some((extension) => extension.name === name));
	const link = await runtime.harness.snapshot(JobLink, job.taskId, runtime.context);
	// A running legacy job must pass the extension on to a successor after startup migration.
	assert.ok(link?.template?.extensionNames.includes(name));
	await runtime.harness.waitForTask(job.taskId, runtime.context);
});

test("bash explicit cwd loads nested rules before starting the command and does not change later commands", async (t) => {
	const dir = directory(t);
	put(join(dir, "AGENTS.md"), "root-rule");
	put(join(dir, "nested", "AGENTS.md"), "shell-scope-rule");
	let round = 0;
	const env = await fixture(t, dir, ({ messages }) => {
		round++;
		if (round <= 2) {
			assert.equal(existsSync(join(dir, "nested", "created")), false);
			if (round === 2) assert.match(snapshot(messages), /shell-scope-rule/);
			return fauxAssistantMessage(fauxToolCall("bash", { cwd: "nested", command: "printf success > created" }), { stopReason: "toolUse" });
		}
		if (round === 3) {
			assert.equal(readFileSync(join(dir, "nested", "created"), "utf8"), "success");
			return fauxAssistantMessage(fauxToolCall("bash", { command: "printf original > original" }), { stopReason: "toolUse" });
		}
		assert.equal(readFileSync(join(dir, "original"), "utf8"), "original");
		assert.equal(existsSync(join(dir, "nested", "original")), false);
		return fauxAssistantMessage("done");
	});
	await (await env.root.submit({ type: "input", content: "shell" }, context)).wait(context);
	assert.equal(round, 4);
	// Changing the conversation cwd discards previously discovered scopes.
	await env.root.configure({ cwd: join(dir, "elsewhere") }, context);
	mkdirSync(join(dir, "elsewhere"));
	// Directly exercise the selected hook with real committed agent state, without another scripted tool round.
	const handlers = env.instructions.hooks![0]!.handlers as { beforeRequest: Function };
	const result = await handlers.beforeRequest({ messages: [] }, { conversationId: env.root.id, snapshot: env.harness.snapshot.bind(env.harness) }, context);
	assert.doesNotMatch(snapshot(result.messages), /shell-scope-rule/);
});

test("codemode nested writes cannot bypass instruction discovery even when script output is suppressed", async (t) => {
	const dir = directory(t);
	put(join(dir, "nested", "AGENTS.md"), "nested-codemode-rule");
	const codemode = openCodemode();
	t.after(() => codemode.close());
	let round = 0;
	const env = await fixture(t, dir, ({ messages }) => {
		round++;
		if (round === 1 || round === 2) {
			assert.equal(existsSync(join(dir, "nested", "created")), false);
			if (round === 2) assert.match(snapshot(messages), /nested-codemode-rule/);
			return fauxAssistantMessage(fauxToolCall("codemode", { code: 'try { await tools.write({path: "nested/created", content: "done"}); } catch {}' }), { stopReason: "toolUse" });
		}
		assert.equal(readFileSync(join(dir, "nested", "created"), "utf8"), "done");
		return fauxAssistantMessage("done");
	}, [codemode.extension]);
	await (await env.root.submit({ type: "input", content: "nested" }, context)).wait(context);
	assert.equal(round, 3);
});

test("Main creates ordinary background jobs in its current configured cwd rather than its startup cwd", async (t) => {
	const dir = directory(t);
	const config = join(dir, "config.yaml"); put(config, "provider: faux\ncodemode: false\nmcp: { enabled: false }\n");
	const runtime = await openRuntime({ configPath: config, storePath: join(dir, "store.sqlite"), withMcp: false });
	t.after(() => runtime.close());
	await runtime.root.configure({ cwd: dir }, runtime.context);
	await (await runtime.root.submit({ type: "input", content: "task: inspect the configured directory" }, runtime.context)).wait(runtime.context);
	const tasks = await runtime.harness.commit((tx) => tx.scanTasks({ kind: "durable-chat.job" }, 10), runtime.context);
	assert.equal(tasks.items.length, 1);
	const task = tasks.items[0]!;
	await runtime.harness.waitForTask(task.id, runtime.context);
	const child = (await findJobConversation(runtime.harness, Number(task.id), runtime.context))!;
	assert.equal((await child.agent(runtime.context)).cwd, dir);
});

test("read filename fallback resolves the actual instruction scope before returning file contents", async (t) => {
	const dir = directory(t);
	put(join(dir, "reader’s", "AGENTS.md"), "actual-read-scope-rule");
	put(join(dir, "reader’s", "facts.txt"), "actual-read-evidence");
	let round = 0;
	const env = await fixture(t, dir, ({ messages }) => {
		round++;
		if (round <= 2) {
			if (round === 2) {
				assert.match(snapshot(messages), /actual-read-scope-rule/);
				assert.doesNotMatch(JSON.stringify(messages.filter((message) => message.role === "toolResult")), /actual-read-evidence/);
			}
			return fauxAssistantMessage(fauxToolCall("read", { path: "@reader's/facts.txt" }), { stopReason: "toolUse" });
		}
		assert.match(JSON.stringify(messages.at(-1)), /actual-read-evidence/);
		return fauxAssistantMessage("done");
	});
	await (await env.root.submit({ type: "input", content: "read" }, context)).wait(context);
	assert.equal(round, 3);
});

test("forking Main retains target directory instructions but does not inherit reminder management", async (t) => {
	const dir = directory(t);
	put(join(dir, "main", "AGENTS.md"), "main-only-reminder-scope");
	put(join(dir, "worker", "AGENTS.md"), "worker-only-reminder-scope");
	let requests = 0;
	const env = await fixture(t, join(dir, "main"), ({ messages }) => {
		requests++;
		const input = messages.findLast((message) => message.role === "user")?.content;
		if (input === "prepare Main") {
			assert.match(snapshot(messages), /main-only-reminder-scope/);
			assert.doesNotMatch(snapshot(messages), /worker-only-reminder-scope/);
		} else {
			assert.equal(input, "forked worker");
			assert.match(snapshot(messages), /worker-only-reminder-scope/);
			assert.doesNotMatch(snapshot(messages), /main-only-reminder-scope/);
		}
		return fauxAssistantMessage("done");
	});
	assert.ok((await env.root.agent(context)).tools.some((tool) => tool.name === "reminder"));
	await (await env.root.submit({ type: "input", content: "prepare Main" }, context)).wait(context);
	const origin = await env.root.commit((tx) => selectForkSource(tx, "main"), context);
	const fork = await env.root.commit((tx) => createJobInCommit(tx, "forked worker", env.model, env.jobExtensions, join(dir, "worker"), { maxTurns: 12, thinkingLevel: "off", fork: origin }), context);
	assert.equal((await env.harness.waitForTask(fork.taskId, context)).state.outcome.status, "completed");
	const worker = (await findJobConversation(env.harness, Number(fork.taskId), context))!;
	const agent = await worker.agent(context);
	assert.ok(agent.extensions.some((extension) => extension.name === "durable-chat.repository-instructions"));
	assert.ok(!agent.extensions.some((extension) => extension.name === ReminderTools.name));
	assert.ok(!agent.callable.some((tool) => tool.name === "reminder"));
	assert.equal(requests, 2);
});
