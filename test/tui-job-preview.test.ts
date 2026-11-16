import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EntryRecord, UserInput } from "@earendil-works/pi-durable";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { openRuntime, type AppRuntime } from "../src/harness.ts";
import { createJobInCommit, findJobConversation, jobOptionsOf } from "../src/jobs.ts";
import { JOB_KIND } from "../src/tasks.ts";
import { Dashboard } from "../src/tui/app.ts";

// Pure selection tests cannot protect transcript watch lifetime, async races, or send routing.
// Controlled conversation watches keep streaming/startup tests deterministic, without a model clock.
function conversation(id: number, initial: string) {
	const entries: EntryRecord[] = [];
	const listeners = new Set<(call: unknown) => void>();
	const sent: UserInput[] = [];
	const drafts: { content: UserInput; whenBusy?: string; whenIdle?: string; requestId?: string }[] = [];
	let submitError: Error | undefined;
	let live: unknown;
	let gate: Promise<void> | undefined;
	let failure = false;
	const view = () => ({ entries, docs: { "pi.live": live } });
	const append = (text: string) => {
		entries.push({ id: entries.length + 1, kind: "pi.user", model: [{ role: "user", content: text, timestamp: 0 }] } as EntryRecord);
		for (const listener of listeners) listener({ kind: "value", value: view() });
	};
	append(initial);
	return {
		id, sent, drafts, append,
		setSubmitError(error?: Error) { submitError = error; },
		get watchers() { return listeners.size; },
		setGate(value: Promise<void> | undefined) { gate = value; },
		setFailure(value: boolean) { failure = value; },
		stream(text: string) {
			live = { generation: { message: { content: text } } };
			for (const listener of listeners) listener({ kind: "value", value: view() });
		},
		async entries() {
			await gate;
			if (failure) throw new Error("read unavailable");
			return { items: [...entries].reverse() };
		},
		async context() { return { entries: [], messages: [], contributions: [] }; },
		async watch() {
			let active: ((call: unknown) => void) | undefined;
			return {
				get value() { return view(); },
				start(listener: (call: unknown) => void) { active = listener; listeners.add(listener); },
				async stop() { if (active !== undefined) listeners.delete(active); },
			};
		},
		async submit(inputOrTx: { content: UserInput }, draftOrContext?: typeof drafts[number]) {
			if (submitError !== undefined) throw submitError;
			const input = "content" in inputOrTx ? inputOrTx : draftOrContext!;
			drafts.push(input);
			sent.push(input.content);
		},
	};
}

async function fixture(t: TestContext, count = 2) {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1000 });
	const main = conversation(100, "MAIN-HISTORY");
	const jobs = [conversation(101, "JOB-ONE-HISTORY"), conversation(102, "JOB-TWO-HISTORY")];
	const available = new Map(jobs.map((job, index) => [index + 1, job.id]));
	const records = jobs.slice(0, count).map((job, index) => ({ id: index + 1, kind: JOB_KIND, input: { brief: `brief-${index + 1}` }, state: { status: "terminal", outcome: { status: "completed", result: { conversationId: job.id } } } }));
	const links = new Map<number, { steering?: { requestId: string; message: string } }>();
	let graphListener: (call: unknown) => void = () => {};
	const renders = new Set<() => void>();
	const dashboard = new Dashboard({
		runtime: {
			root: main, context: BACKGROUND_CONTEXT, config: { contextWindow: 128000, configPath: "/config", thinkingLevel: "medium" },
			modelLabel: "faux", storePath: "/store", jobExtensions: [],
			harness: {
				async commit(run: (tx: unknown) => unknown) {
					return run({
						async scanTasks() { return { items: records }; },
						async task(id: number) { return records.find((record) => record.id === id); },
						async doc(_token: unknown, id: number) { if (!links.has(id)) links.set(id, {}); return links.get(id); },
						async scanConversations(filter: { ownerTaskId: number }) { const id = available.get(filter.ownerTaskId); return { items: id === undefined ? [] : [{ id }] }; },
					});
				},
				async getTask(id: number) { return records.find((record) => record.id === id); },
				async snapshot() { return undefined; },
				async conversation(id: number) { return jobs.find((job) => job.id === id); },
				async watchTaskGraph() { return { start(listener: typeof graphListener) { graphListener = listener; }, async stop() {} }; },
				resume() {},
			},
		} as unknown as AppRuntime,
		rows: () => 24, requestRender: () => { for (const render of renders) render(); }, onQuit() {},
	});
	t.after(async () => { await dashboard.stop(); });
	await dashboard.start();
	const frame = () => dashboard.render(160).map(stripTerminalSequences).join("\n");
	frame();
	const until = async (predicate: (frame: string) => boolean) => {
		if (predicate(frame())) return;
		await new Promise<void>((resolve) => {
			const render = () => { if (predicate(frame())) { renders.delete(render); resolve(); } };
			renders.add(render);
		});
	};
	return {
		dashboard, main, jobs, records, available, links, frame, until,
		async key(key: string) { await dashboard.handleInput(key); },
		refresh(tasks: Record<string, unknown> = {}) { graphListener({ kind: "value", value: { tasks } }); t.mock.timers.tick(120); },
	};
}

const navigationKeys = [
	["j/k", "j", "k"],
	["CSI arrow keys", "\x1b[B", "\x1b[A"],
	["application arrow keys", "\x1bOB", "\x1bOA"],
	["modified-protocol arrow keys", "\x1b[1;1B", "\x1b[1;1A"],
	["repeated arrow events", "\x1b[1;1:2B", "\x1b[1;1:2A"],
] as const;

for (const [name, down, up] of navigationKeys) {
	test(`${name} previews the highlighted job before Enter without retargeting the draft`, { timeout: 5000 }, async (t) => {
		const app = await fixture(t);
		await app.key("unsent-main-draft");
		await app.key("\t");
		await app.until((frame) => frame.includes("JOB-TWO-HISTORY"));
		assert.match(app.frame(), /job #2 \(preview\)/);
		await app.key(down!);
		assert.doesNotMatch(app.frame(), /JOB-TWO-HISTORY/, "old content clears immediately, even before async read completes");
		await app.until((frame) => frame.includes("JOB-ONE-HISTORY"));
		for (let repeat = 0; repeat < 3; repeat++) await app.key(down);
		assert.match(app.frame(), /job #1 \(preview\)/, "repeated navigation clamps at the last row");
		assert.match(app.frame(), /to main › unsent-main-draft/);
		await app.key(up!);
		await app.until((frame) => frame.includes("JOB-TWO-HISTORY"));
		for (let repeat = 0; repeat < 3; repeat++) await app.key(up);
		assert.match(app.frame(), /job #2 \(preview\)/, "repeated navigation clamps at the first row");
		await app.key("\t"); // May scroll the preview without activating it.
		assert.match(app.frame(), /focus transcript/);
		await app.key("\t"); // Back to composer restores the actual destination's transcript.
		assert.match(app.frame(), /MAIN-HISTORY/);
		await app.key("\r");
		assert.deepEqual(app.main.sent, ["unsent-main-draft"]);
		assert.deepEqual(app.jobs.map((job) => job.sent), [[], []]);
	});
}

test("Enter activates the preview while later browsing preserves a pinned job's target, draft and actions", { timeout: 5000 }, async (t) => {
	const app = await fixture(t);
	await app.key("\t");
	await app.until((frame) => frame.includes("JOB-TWO-HISTORY"));
	await app.key("\r");
	assert.match(app.frame(), /focus composer/);
	assert.match(app.frame(), /to job #2 ›/);
	await app.key("job-two-draft");
	await app.key("\t");
	await app.key("j");
	await app.until((frame) => frame.includes("JOB-ONE-HISTORY"));
	assert.match(app.frame(), /to job #2 › job-two-draft/);
	await app.key("\x1b[Z"); // Shift-Tab: jobs -> composer.
	await app.until((frame) => frame.includes("JOB-TWO-HISTORY"));
	await app.key("\r");
	assert.deepEqual(app.jobs[0]!.sent, []);
	assert.deepEqual(app.jobs[1]!.sent, ["job-two-draft"]);
	await app.key("\t");
	await app.until((frame) => frame.includes("JOB-ONE-HISTORY"));
	await app.key("c");
	assert.match(app.frame(), /Cancel job #2\?/); // Actions, like sends, still require explicit activation.
	await app.key("n");
	assert.deepEqual(app.main.sent, []);
});

test("running preview streams and committed updates stay current, revisits read latest, and new arrivals do not steal selection", { timeout: 5000 }, async (t) => {
	const app = await fixture(t);
	await app.key("\t");
	await app.key("j");
	await app.until((frame) => frame.includes("JOB-ONE-HISTORY"));
	app.records[0]!.state = { status: "running" } as typeof app.records[number]["state"];
	app.refresh({ "1": { id: 1, kind: JOB_KIND, state: { status: "running" } } });
	await app.until((frame) => frame.includes("running"));
	app.jobs[0]!.stream("STREAMING-UPDATE");
	assert.match(app.frame(), /STREAMING-UPDATE/);
	app.jobs[0]!.append("COMMITTED-UPDATE");
	assert.match(app.frame(), /COMMITTED-UPDATE/);
	app.records.push({ id: 3, kind: JOB_KIND, input: { brief: "new-arrival" }, state: { status: "terminal", outcome: { status: "completed", result: { conversationId: 103 } } } });
	app.refresh({ "1": { id: 1, kind: JOB_KIND, state: { status: "running" } } });
	await app.until((frame) => frame.includes("new-arrival"));
	assert.match(app.frame(), /job #1 \(preview\)/);
	await app.key("G"); // Last visible row is job #2 after the running overlay.
	await app.until((frame) => frame.includes("JOB-TWO-HISTORY"));
	assert.equal(app.jobs[0]!.watchers, 0);
	app.jobs[0]!.append("LATEST-WHILE-AWAY");
	await app.key("g");
	await app.until((frame) => frame.includes("LATEST-WHILE-AWAY"));
	assert.equal(app.jobs[0]!.watchers, 1);
	assert.equal(app.jobs[1]!.watchers, 0);
});

test("late preview loads cannot overwrite a newer selection or a return to Main and all stale watches stop", { timeout: 5000 }, async (t) => {
	const app = await fixture(t);
	const delayed = Promise.withResolvers<void>();
	app.jobs[1]!.setGate(delayed.promise);
	await app.key("\t");
	await app.key("j");
	await app.until((frame) => frame.includes("JOB-ONE-HISTORY"));
	delayed.resolve();
	await app.key("\t");
	await app.key("\t");
	// Flush pending promise work through a subsequent load completion, not a real-time sleep.
	await app.key("\t");
	await app.key("k");
	await app.until((frame) => frame.includes("JOB-TWO-HISTORY"));
	await app.key("\x1b");
	assert.match(app.frame(), /MAIN-HISTORY/);
	assert.equal(app.jobs[0]!.watchers, 0);
	assert.equal(app.jobs[1]!.watchers, 0);
	assert.match(app.frame(), /to main ›/);
});

test("missing or failed job previews never show another transcript and startup retries on refresh", { timeout: 5000 }, async (t) => {
	const app = await fixture(t);
	// A live task may have no owned conversation when its graph row first appears.
	app.records[1]!.state = { status: "running" } as typeof app.records[number]["state"];
	app.available.delete(2);
	app.refresh();
	await app.until((frame) => frame.includes("running"));
	await app.key("\t");
	await app.until((frame) => frame.includes("No conversation is available"));
	assert.doesNotMatch(app.frame(), /MAIN-HISTORY|JOB-ONE-HISTORY/);
	app.available.set(2, 102);
	app.refresh();
	await app.until((frame) => frame.includes("JOB-TWO-HISTORY"));
	app.jobs[0]!.setFailure(true);
	await app.key("j");
	await app.until((frame) => frame.includes("read unavailable"));
	assert.doesNotMatch(app.frame(), /JOB-TWO-HISTORY/);
	await app.key("\x1b[Z");
	assert.match(app.frame(), /MAIN-HISTORY/);
});

test("an empty jobs list and the new-job shortcut preserve Main as the active destination", { timeout: 5000 }, async (t) => {
	const app = await fixture(t, 0);
	await app.key("\t");
	await app.key("j");
	await app.key("\r");
	assert.match(app.frame(), /MAIN-HISTORY/);
	await app.key("n");
	assert.match(app.frame(), /new job ›/);
	await app.key("\x1b");
	assert.match(app.frame(), /to main ›/);
});

// The controlled watches above cannot establish that durable conversation notifications are wired up.
test("durable job navigation reads fresh history and watches new entries without activating the job", { timeout: 10000 }, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "dchat-preview-"));
	const configPath = join(dir, "config.yaml");
	writeFileSync(configPath, "provider: faux\nautoContinue: false\nmcp:\n  enabled: false\n");
	const runtime = await openRuntime({ configPath, storePath: join(dir, "store.sqlite"), withMcp: false });
	const renders = new Set<() => void>();
	const dashboard = new Dashboard({ runtime, rows: () => 24, requestRender: () => { for (const render of renders) render(); }, onQuit() {} });
	t.after(async () => {
		await dashboard.stop();
		await runtime.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const started = await runtime.root.commit(async (tx) => {
		const jobs = [];
		for (const brief of ["older-job", "newer-job"]) jobs.push(await createJobInCommit(tx, brief, runtime.model, runtime.jobExtensions, runtime.cwd, jobOptionsOf(runtime.config)));
		return jobs;
	}, runtime.context);
	// Settling before dashboard.start avoids relying on model timing or real sleeps.
	for (const job of started) {
		await runtime.harness.abortTask(job.taskId, runtime.context);
		await runtime.harness.waitForTask(job.taskId, runtime.context);
	}
	const older = await findJobConversation(runtime.harness, Number(started[0]!.taskId), runtime.context);
	const newer = await findJobConversation(runtime.harness, Number(started[1]!.taskId), runtime.context);
	assert.ok(older && newer);
	await runtime.root.commit(async (tx) => {
		for (const [conversation, text] of [[runtime.root, "DURABLE-MAIN"], [older, "DURABLE-OLDER"], [newer, "DURABLE-NEWER"]] as const) {
			await tx.appendEntry(conversation.id, { kind: "pi.user", model: [{ role: "user", content: text, timestamp: 0 }] });
		}
	}, runtime.context);
	await dashboard.start();
	const frame = () => dashboard.render(160).map(stripTerminalSequences).join("\n");
	const until = async (content: string) => {
		if (frame().includes(content)) return;
		await new Promise<void>((resolve) => {
			const render = () => { if (frame().includes(content)) { renders.delete(render); resolve(); } };
			renders.add(render);
		});
	};
	frame();
	await dashboard.handleInput("durable-main-draft");
	await dashboard.handleInput("\t");
	await until("DURABLE-NEWER");
	await dashboard.handleInput("\x1b[B");
	await until("DURABLE-OLDER");
	await runtime.root.commit((tx) => tx.appendEntry(older.id, { kind: "pi.user", model: [{ role: "user", content: "DURABLE-WATCH-UPDATE", timestamp: 0 }] }), runtime.context);
	await until("DURABLE-WATCH-UPDATE");
	assert.match(frame(), /to main › durable-main-draft/);
	await dashboard.handleInput("\x1b[Z");
	assert.match(frame(), /DURABLE-MAIN/);
	assert.doesNotMatch(frame(), /DURABLE-WATCH-UPDATE/);
});

// Preview-only tests above cannot protect the ingress default, durable admission or draft retention.
test("messaging the highlighted running job explicitly pins it and defaults to tracked steering without auto-sending the draft", { timeout: 5000 }, async (t) => {
	const app = await fixture(t);
	app.records[1]!.state = { status: "running", checkpoint: { phase: "run" } } as never;
	app.refresh({ "2": { id: 2, kind: JOB_KIND, state: { status: "running" } } });
	await app.until((frame) => frame.includes("running"));
	await app.key("preserved-draft");
	await app.key("\t");
	await app.until((frame) => frame.includes("JOB-TWO-HISTORY"));
	assert.match(app.frame(), /to main › preserved-draft/);
	await app.key("\r");
	assert.match(app.frame(), /focus composer/);
	assert.match(app.frame(), /to job #2 \(steer\) › preserved-draft/);
	assert.deepEqual(app.jobs[1]!.sent, []);
	assert.deepEqual(app.main.sent, []);
	await app.key("\r");
	assert.deepEqual(app.jobs[1]!.sent, ["preserved-draft"]);
	const draft = app.jobs[1]!.drafts[0]!;
	assert.equal(draft.whenBusy, "steer");
	assert.equal(draft.whenIdle, "reject");
	assert.deepEqual(app.links.get(2)?.steering, { requestId: draft.requestId, message: "preserved-draft" });
	assert.match(app.frame(), /steering queued for job #2/);
	assert.doesNotMatch(app.frame(), /preserved-draft/);
	await app.key("\x14"); // Ctrl-T returns to Main without changing its input mode.
	await app.until((frame) => frame.includes("to main ›"));
	assert.deepEqual(app.main.sent, []);
	assert.deepEqual(app.jobs[0]!.sent, []);
});

test("Enter-pinned running jobs support explicit follow-up without a preview changing the send destination", { timeout: 5000 }, async (t) => {
	const app = await fixture(t);
	app.records[1]!.state = { status: "running", checkpoint: { phase: "run" } } as never;
	app.refresh({ "2": { id: 2, kind: JOB_KIND, state: { status: "running" } } });
	await app.until((frame) => frame.includes("running"));
	await app.key("\t");
	await app.until((frame) => frame.includes("JOB-TWO-HISTORY"));
	await app.key("\r");
	assert.match(app.frame(), /focus composer/);
	assert.match(app.frame(), /to job #2 \(steer\) ›/);
	await app.key("\x1bs"); // Alt-S explicitly queues after the run.
	await app.key("follow-up-draft");
	await app.key("\t");
	await app.key("j");
	await app.until((frame) => frame.includes("JOB-ONE-HISTORY"));
	await app.key("\x1b[Z");
	assert.match(app.frame(), /to job #2 › follow-up-draft/);
	await app.key("\r");
	assert.deepEqual(app.jobs[1]!.sent, ["follow-up-draft"]);
	assert.equal(app.jobs[1]!.drafts[0]!.whenBusy, "followUp");
	assert.equal(app.links.get(2)?.steering, undefined);
	assert.match(app.frame(), /follow-up queued for job #2/);
	assert.deepEqual(app.jobs[0]!.sent, []);
	assert.deepEqual(app.main.sent, []);
});

test("failed steering retains the pinned draft and retries without recording or duplicating failed input", { timeout: 5000 }, async (t) => {
	const app = await fixture(t);
	app.records[1]!.state = { status: "running", checkpoint: { phase: "run" } } as never;
	app.refresh({ "2": { id: 2, kind: JOB_KIND, state: { status: "running" } } });
	await app.until((frame) => frame.includes("running"));
	await app.key("\t");
	await app.until((frame) => frame.includes("JOB-TWO-HISTORY"));
	await app.key("s");
	await app.key("retry-this-draft");
	app.jobs[1]!.setSubmitError(new Error("steering admission unavailable"));
	await app.key("\r");
	assert.match(app.frame(), /steering admission unavailable/);
	assert.match(app.frame(), /to job #2 \(steer\) › retry-this-draft/);
	assert.deepEqual(app.jobs[1]!.sent, []);
	assert.equal(app.links.get(2)?.steering, undefined);
	app.jobs[1]!.setSubmitError();
	await app.key("\r");
	assert.deepEqual(app.jobs[1]!.sent, ["retry-this-draft"]);
	assert.deepEqual(app.main.sent, []);
});

test("completed job input defaults to follow-up while explicit steering rejects and retains pinned and addressed drafts", { timeout: 5000 }, async (t) => {
	const app = await fixture(t);
	await app.key("\t");
	await app.until((frame) => frame.includes("JOB-TWO-HISTORY"));
	await app.key("s");
	assert.match(app.frame(), /to job #2 ›/);
	await app.key("continue-completed");
	await app.key("\r");
	assert.deepEqual(app.jobs[1]!.sent, ["continue-completed"]);
	assert.equal(app.jobs[1]!.drafts[0]!.whenBusy, "followUp");
	await app.key("\x1bs");
	await app.key("keep-this-draft");
	await app.key("\r");
	assert.match(app.frame(), /no longer running/);
	assert.match(app.frame(), /to job #2 \(steer\) › keep-this-draft/);
	await app.key("\x01"); // Ctrl-A then Ctrl-K clears without relying on cursor position.
	await app.key("\x0b");
	await app.key("/steer 1 addressed-draft");
	await app.key("\r");
	assert.match(app.frame(), /no longer running/);
	assert.match(app.frame(), /to job #2 \(steer\) › \/steer 1 addressed-draft/);
	assert.deepEqual(app.jobs[1]!.sent, ["continue-completed"]);
	assert.deepEqual(app.jobs[0]!.sent, []);
	assert.deepEqual(app.main.sent, []);
});

test("Enter activates immediately during a pending preview read and its completion preserves later focus and multiline input", { timeout: 5000 }, async (t) => {
	const app = await fixture(t);
	const delayed = Promise.withResolvers<void>();
	app.jobs[1]!.setGate(delayed.promise);
	await app.key("first line");
	await app.key("\x1b[13;2u");
	await app.key("second line");
	await app.key("\t");
	await app.key("\r");
	assert.match(app.frame(), /focus composer/);
	assert.match(app.frame(), /to job #2 ›/);
	await app.key("\x1b[13;2u");
	await app.key("third line");
	await app.key("\t");
	await app.key("\t"); // Read/scroll remains accessible via the focus cycle.
	assert.match(app.frame(), /focus transcript/);
	delayed.resolve();
	await app.until((frame) => frame.includes("JOB-TWO-HISTORY"));
	assert.match(app.frame(), /focus transcript/, "finishing the load must not steal focus back to the composer");
	await app.key("\t");
	await app.key("\r");
	assert.deepEqual(app.jobs[1]!.sent, ["first line\nsecond line\nthird line"]);
	assert.deepEqual(app.main.sent, []);
});

test("transcript arrows and j/k scroll identically through repeated steps and both bounds without retargeting the draft", { timeout: 5000 }, async (t) => {
	const app = await fixture(t);
	for (let index = 0; index < 45; index++) app.jobs[1]!.append(`scroll-evidence-${index}`);
	await app.key("keep-main-draft");
	await app.key("\t");
	await app.until((frame) => frame.includes("scroll-evidence-44"));
	await app.key("\t");
	const bottom = app.frame();
	await app.key("k");
	await app.key("k");
	const twoUp = app.frame();
	assert.notEqual(twoUp, bottom);
	await app.key("g");
	const top = app.frame();
	await app.key("j");
	await app.key("j");
	const twoDown = app.frame();
	for (const [, down, up] of navigationKeys.slice(1)) {
		await app.key("G");
		await app.key(up);
		await app.key(up);
		assert.equal(app.frame(), twoUp);
		for (let repeat = 0; repeat < 80; repeat++) await app.key(up);
		assert.equal(app.frame(), top);
		await app.key(down);
		await app.key(down);
		assert.equal(app.frame(), twoDown);
		for (let repeat = 0; repeat < 80; repeat++) await app.key(down);
		assert.equal(app.frame(), bottom);
	}
	assert.match(app.frame(), /to main › keep-main-draft/);
	assert.deepEqual(app.main.sent, []);
	assert.deepEqual(app.jobs.map((job) => job.sent), [[], []]);
});

test("composer j/k remain literal text and arrow keys edit multiline input rather than navigate jobs", { timeout: 5000 }, async (t) => {
	const app = await fixture(t);
	await app.key("\t");
	await app.key("\r");
	assert.match(app.frame(), /focus composer/);
	await app.key("j");
	await app.key("\x1b[13;2u");
	await app.key("k");
	await app.key("\x1b[A");
	await app.key("!");
	await app.key("\x1b[B");
	await app.key("?");
	await app.key("\r");
	assert.deepEqual(app.jobs[1]!.sent, ["j!\nk?"]);
	assert.deepEqual(app.jobs[0]!.sent, []);
	assert.deepEqual(app.main.sent, []);
});
