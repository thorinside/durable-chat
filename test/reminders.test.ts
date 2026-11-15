import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import type { Conversation, TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createRepositoryInstructions } from "../src/agent-instructions.ts";
import { jobEnvironment } from "../src/workspaces.ts";
import { cancelReminderInCommit, createReminderInCommit, MAX_PENDING_REMINDERS, normalizeReminder, PendingReminders, ReminderTools } from "../src/reminders.ts";

const epoch = Date.parse("2030-01-01T00:00:00Z");
async function fixture(t: TestContext, respond?: FauxResponseFactory) {
	const dir = mkdtempSync(join(tmpdir(), "dchat-reminders-"));
	let now = epoch;
	const closes: (() => Promise<void>)[] = [];
	t.after(async () => { for (const close of closes.reverse()) await close(); rmSync(dir, { recursive: true, force: true }); });
	async function open() {
		const faux = fauxProvider(); // Immediate responses; all scheduling uses the simulated Harness clock.
		const script: FauxResponseFactory = async (...args) => {
			faux.appendResponses([script]);
			if (respond !== undefined) return respond(...args);
			const messages = args[0].messages;
			const user = messages.findLast((message) => message.role === "user");
			if (typeof user?.content === "string" && user.content.startsWith("{") && messages.at(-1)?.role !== "toolResult") {
				return fauxAssistantMessage(fauxToolCall("reminder", JSON.parse(user.content)), { stopReason: "toolUse" });
			}
			return fauxAssistantMessage("Acknowledged.");
		};
		faux.setResponses([script]);
		const models = createModels(); models.setProvider(faux.provider);
		const instructions = createRepositoryInstructions(dir);
		const registry = createRegistry(); registry.install(ReminderTools); registry.install(instructions);
		const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "store.sqlite")), {
			models, registry, now: () => now, onWake: () => {},
			env: (target, callContext) => jobEnvironment(target, callContext, dir),
		}, context);
		const root = await harness.root(context);
		await root.configure({ model: { provider: faux.getModel().provider, modelId: faux.getModel().id }, cwd: dir, extensions: [ReminderTools, instructions] }, context);
		let closed = false;
		const close = async () => { if (!closed) { closed = true; await harness.close(context); } };
		closes.push(close);
		return { harness, root, close, dir };
	}
	return { open, advance: (ms: number) => { now += ms; }, session: await open() };
}

async function sleeping(harness: Harness, id: TaskId) {
	const graph = await harness.watchTaskGraph(context);
	try {
		if (graph.value.tasks[String(id)]?.state.status === "sleeping") return;
		const done = Promise.withResolvers<void>();
		graph.start(async (call) => {
			if (call.kind === "value" && call.value.tasks[String(id)]?.state.status === "sleeping") done.resolve();
		});
		harness.resume();
		await done.promise;
	} finally { await graph.stop(); }
}

async function notices(session: { root: Conversation }) {
	return (await session.root.context(context)).entries.filter((entry) => entry.kind === "app.reminder");
}

test("reminder input rejects ambiguous, impossible, past, excessive, and empty requests", () => {
	for (const at of [undefined, "2030-01-01T01:00:00", "2030-02-30T00:00:00Z", "2030-01-01T00:00:00Z", "2032-01-01T00:00:00Z", "2030-01-01T25:00:00Z", "2030-01-01T24:00:00Z"]) {
		assert.throws(() => normalizeReminder(at, "check", epoch));
	}
	assert.throws(() => normalizeReminder("2030-01-01T01:00:00Z", "  ", epoch));
	assert.throws(() => normalizeReminder("2030-01-01T01:00:00Z", "x".repeat(4001), epoch));
	assert.deepEqual(normalizeReminder("2030-01-01T02:00:00+01:00", " check ", epoch), { at: epoch + 3600000, message: "check" });
});

test("Main schedules without waiting, lists, and receives exactly one due reminder after its turn", { timeout: 10000 }, async (t) => {
	const env = await fixture(t); const session = env.session;
	const scheduled = await session.root.submit({ type: "input", content: JSON.stringify({ action: "schedule", at: "2030-01-01T00:01:00Z", message: "Check the build" }) }, context);
	assert.equal((await scheduled.wait(context)).status, "done");
	const pending = (await session.harness.snapshot(PendingReminders, context))!.byId;
	const id = Number(Object.keys(pending)[0]) as TaskId;
	await sleeping(session.harness, id);
	assert.equal((await notices(session)).length, 0);
	const list = await session.root.submit({ type: "input", content: '{"action":"list"}' }, context); await list.wait(context);
	assert.match(JSON.stringify((await session.root.context(context)).messages), /#.*2030-01-01T00:01:00.*Check the build/);
	env.advance(60000); session.harness.resume();
	assert.equal((await session.harness.waitForTask(id, context)).state.outcome.status, "completed");
	await session.root.waitForIdle(context);
	assert.equal((await notices(session)).length, 1);
	assert.deepEqual((await session.harness.snapshot(PendingReminders, context))!.byId, {});
	session.harness.resume(); await session.close();
	const reopened = await env.open(); reopened.harness.resume(); await reopened.root.waitForIdle(context);
	assert.equal((await notices(reopened)).length, 1);
});

test("sleeping reminders survive restart and overdue reminders recover on resume without duplicate admission", { timeout: 10000 }, async (t) => {
	const env = await fixture(t); let session = env.session;
	const id = await session.harness.commit((tx) => createReminderInCommit(tx, { at: epoch + 60000, message: "Check detached process" }), context);
	await sleeping(session.harness, id); await session.close();
	session = await env.open();
	assert.equal(Object.keys((await session.harness.snapshot(PendingReminders, context))!.byId).length, 1);
	await sleeping(session.harness, id); assert.equal((await notices(session)).length, 0);
	await session.close(); env.advance(120000);
	session = await env.open(); session.harness.resume();
	await session.harness.waitForTask(id, context); await session.root.waitForIdle(context);
	assert.equal((await notices(session)).length, 1);
	await session.close(); session = await env.open(); session.harness.resume(); await session.root.waitForIdle(context);
	assert.equal((await notices(session)).length, 1);
});

test("cancellation suppresses delivery durably and cannot retract a delivered reminder", { timeout: 10000 }, async (t) => {
	const env = await fixture(t); let session = env.session;
	const id = await session.harness.commit((tx) => createReminderInCommit(tx, { at: epoch + 60000, message: "Do not send" }), context);
	await sleeping(session.harness, id);
	const cancel = await session.root.submit({ type: "input", content: JSON.stringify({ action: "cancel", id: String(id) }) }, context); await cancel.wait(context);
	assert.equal(await session.harness.commit((tx) => cancelReminderInCommit(tx, String(id)), context), false);
	await session.close(); env.advance(60000); session = await env.open(); session.harness.resume();
	const receipt = await session.harness.waitForTask(id, context);
	assert.equal(receipt.state.outcome.result?.status, "cancelled");
	assert.equal((await notices(session)).length, 0);
	const delivered = await session.harness.commit((tx) => createReminderInCommit(tx, { at: epoch, message: "Already due" }), context);
	await session.harness.waitForTask(delivered, context);
	assert.equal(await session.harness.commit((tx) => cancelReminderInCommit(tx, String(delivered)), context), false);
	await session.root.waitForIdle(context); assert.equal((await notices(session)).length, 1);
});

test("due reminders queue behind a busy Main instead of creating concurrent turns", { timeout: 10000 }, async (t) => {
	const started = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
	let active = 0; let maxActive = 0;
	const env = await fixture(t, async ({ messages }) => {
		const snapshots = messages.filter((message) => message.role === "user" && typeof message.content === "string" && message.content.startsWith("Repository instructions (automatically loaded"));
		assert.equal(snapshots.length, 1);
		assert.match(JSON.stringify(snapshots), /busy-main-rule/);
		active++; maxActive = Math.max(maxActive, active);
		try {
			if (messages.at(-1)?.content === "busy") { started.resolve(); await release.promise; }
			return fauxAssistantMessage("Done.");
		} finally { active--; }
	});
	const session = env.session;
	writeFileSync(join(session.dir, "AGENTS.md"), "busy-main-rule");
	const id = await session.harness.commit((tx) => createReminderInCommit(tx, { at: epoch + 60000, message: "Check later" }), context);
	await sleeping(session.harness, id);
	const busy = await session.root.submit({ type: "input", content: "busy" }, context);
	await started.promise;
	try {
		env.advance(60000); session.harness.resume(); await session.harness.waitForTask(id, context);
		const inspection = await session.harness.inspect(context);
		assert.ok(inspection.submissions.some((item) => item.requestId === `reminder:${id}` && item.status === "queued"));
		assert.equal(active, 1);
	} finally { release.resolve(); }
	await busy.wait(context); await session.root.waitForIdle(context);
	assert.equal(maxActive, 1); assert.equal((await notices(session)).length, 1);
});

test("pending reminder limit bounds accidental scheduling loops", { timeout: 10000 }, async (t) => {
	const { session } = await fixture(t);
	for (let i = 0; i < MAX_PENDING_REMINDERS; i++) await session.harness.commit((tx) => createReminderInCommit(tx, { at: epoch + 60000, message: "check" }), context);
	await assert.rejects(session.harness.commit((tx) => createReminderInCommit(tx, { at: epoch + 60000, message: "overflow" }), context), /Too many pending/);
});

test("non-Main conversations cannot schedule even if explicitly given the reminder tool", { timeout: 10000 }, async (t) => {
	const { session } = await fixture(t);
	const worker = await session.harness.createConversation({
		ownership: { kind: "ownerless" },
		agent: { model: (await session.root.agent(context)).model, extensions: [ReminderTools] },
	}, context);
	const submission = await worker.submit({ type: "input", content: JSON.stringify({ action: "schedule", at: "2030-01-01T00:01:00Z", message: "Not allowed" }) }, context);
	await submission.wait(context);
	assert.match(JSON.stringify((await worker.context(context)).messages), /Only main may manage reminders/);
	assert.deepEqual((await session.harness.snapshot(PendingReminders, context))?.byId ?? {}, {});
});

test("host abort removes a sleeping reminder from the pending index without delivering it", { timeout: 10000 }, async (t) => {
	const { session } = await fixture(t);
	const id = await session.harness.commit((tx) => createReminderInCommit(tx, { at: epoch + 60000, message: "Abort this" }), context);
	await sleeping(session.harness, id);
	await session.harness.abortTask(id, context);
	assert.equal((await session.harness.waitForTask(id, context)).state.outcome.status, "aborted");
	assert.deepEqual((await session.harness.snapshot(PendingReminders, context))!.byId, {});
	assert.equal((await notices(session)).length, 0);
});

test("overdue reminder recovery refreshes Main repository instructions without persisting context or redelivering", { timeout: 10000 }, async (t) => {
	let expected = "initial-reminder-rule";
	let requests = 0;
	// The request-only user context must not hide the actual reminder input or become
	// a durable history entry that would leak into a later fork or restart.
	const env = await fixture(t, ({ messages }) => {
		requests++;
		const snapshots = messages.filter((message) => message.role === "user" && typeof message.content === "string" && message.content.startsWith("Repository instructions (automatically loaded"));
		assert.equal(snapshots.length, 1);
		assert.match(JSON.stringify(snapshots), new RegExp(expected));
		assert.doesNotMatch(JSON.stringify(messages.filter((message) => message.role === "system")), /initial-reminder-rule|updated-reminder-rule/);
		if (expected === "updated-reminder-rule") {
			assert.doesNotMatch(JSON.stringify(snapshots), /initial-reminder-rule/);
			assert.match(JSON.stringify(messages.findLast((message) => message.role === "user")?.content), /Check deployment/);
		}
		return fauxAssistantMessage("Checked.");
	});
	let session = env.session;
	writeFileSync(join(session.dir, "AGENTS.md"), expected);
	await (await session.root.submit({ type: "input", content: "prepare" }, context)).wait(context);
	const id = await session.harness.commit((tx) => createReminderInCommit(tx, { at: epoch + 60000, message: "Check deployment" }), context);
	await sleeping(session.harness, id);
	await session.close();
	expected = "updated-reminder-rule";
	writeFileSync(join(session.dir, "AGENTS.md"), expected);
	env.advance(120000);
	session = await env.open(); session.harness.resume();
	await session.harness.waitForTask(id, context); await session.root.waitForIdle(context);
	assert.equal(requests, 2);
	assert.equal((await notices(session)).length, 1);
	assert.doesNotMatch(JSON.stringify((await session.root.context(context)).entries), /initial-reminder-rule|updated-reminder-rule/);
	await session.close();
	session = await env.open(); session.harness.resume(); await session.root.waitForIdle(context);
	assert.equal(requests, 2);
	assert.equal((await notices(session)).length, 1);
});
