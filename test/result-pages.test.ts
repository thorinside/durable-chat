import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, defineTask, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { formatResultPage, resultPage } from "../src/result-pages.ts";
import { createJobInCommit, MAIN_INSTRUCTIONS, readJobResultPage } from "../src/jobs.ts";
import { JobHandoffDoc, JobTask } from "../src/tasks.ts";
import { createTaskExtension } from "../src/tool.ts";
import { openCodemode } from "../src/codemode.ts";
import type { AnyTaskRecord } from "../src/format.ts";

function allPages(text: string) {
	const first = resultPage(text, 7);
	return Array.from({ length: first.totalPages }, (_, index) => resultPage(text, 7, index + 1, first.revision));
}

test("result pages preserve empty answers and the exact estimated-token boundary", () => {
	for (const size of [0, 19999, 20000, 20001, 40000, 40001]) {
		const source = "x".repeat(size);
		const pages = allPages(source);
		assert.equal(pages.length, Math.max(1, Math.ceil(size / 20000)));
		assert.equal(pages.map((page) => page.text).join(""), source);
		assert.equal(pages.at(-1)!.remainingBytes, 0);
		assert.equal(pages.at(-1)!.nextCall, undefined);
	}
});

test("result pages reassemble non-ASCII, code, long lines and whitespace without splitting surrogate pairs", () => {
	for (const source of ["x".repeat(19999) + "😀漢e\u0301".repeat(14000), "\n".repeat(5000), '```ts\nconst x = "漢😀";\n```\n'.repeat(5000) + " \t\n"]) {
		const pages = allPages(source);
		assert.equal(pages.map((page) => page.text).join(""), source);
		for (const [index, page] of pages.entries()) {
			assert.ok(page.text.isWellFormed());
			assert.ok(Buffer.byteLength(page.text) <= 20000);
			assert.ok(page.text.split("\n").length <= 1401);
			assert.equal(page.start, index === 0 ? 0 : pages[index - 1]!.end);
			const display = formatResultPage(page);
			assert.ok(Buffer.byteLength(display) < 50 * 1024);
			assert.ok(display.split("\n").length < 2000);
			assert.match(display, /not a tokenizer/);
		}
	}
});

test("result paging rejects invalid pages and mixing revisions rather than silently skipping content", () => {
	const source = "x".repeat(20001);
	const first = resultPage(source, 7);
	for (const page of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => resultPage(source, 7, page), /positive safe integer/);
	assert.throws(() => resultPage(source, 7, 2), /require the revision/);
	assert.throws(() => resultPage(source, 7, 3, first.revision), /out of range/);
	assert.throws(() => resultPage(source + "changed", 7, 2, first.revision), /revision changed/);
	assert.deepEqual(resultPage(source, 7), first);
});

// Existing job tests only use short faux responses: they cannot detect truncation before paging,
// lost first-page discovery, or native/codemode output caps dropping the retrieval suffix.
test("full job results and first-page notices survive restart and remain retrievable through native tools and codemode", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "dchat-result-pages-"));
	const source = "\n".repeat(1500) + "START\n```ts\n" + 'const 漢字 = "😀"; '.repeat(8000) + "\n```\nEND \t\n";
	const codemode = openCodemode();
	const closes: (() => Promise<void>)[] = [];
	t.after(async () => {
		for (const close of closes.reverse()) await close();
		await codemode.close();
		rmSync(dir, { recursive: true, force: true });
	});
	let nextArgs: Record<string, unknown> = {};
	let mode = "task";
	let toolText = "";
	async function open() {
		const faux = fauxProvider(); // Immediate scripted responses, no pacing or real-time sleeps.
		const respond: FauxResponseFactory = ({ messages }) => {
			faux.appendResponses([respond]);
			const latest = messages.at(-1);
			if (latest?.role === "toolResult") {
				toolText = latest.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
				return fauxAssistantMessage("Page received.");
			}
			const user = messages.findLast((message) => message.role === "user");
			if (user?.content === "worker") return fauxAssistantMessage(source);
			if (user?.content === "retrieve") return fauxAssistantMessage(fauxToolCall(mode, mode === "task" ? nextArgs : {
				code: `text((await tools.task(${JSON.stringify(nextArgs)})).display);`,
			}), { stopReason: "toolUse" });
			return fauxAssistantMessage("Acknowledged.");
		};
		faux.setResponses(Array.from({ length: 16 }, () => respond));
		const models = createModels(); models.setProvider(faux.provider);
		const model = { provider: faux.getModel().provider, modelId: faux.getModel().id };
		const tasks = createTaskExtension({ model, jobExtensions: [], cwd: dir, jobOptions: { maxTurns: 20, thinkingLevel: "off" } });
		const registry = createRegistry();
		for (const extension of [tasks, codemode.extension, defineExtension({ name: "jobs", tasks: [JobTask] })]) registry.install(extension);
		const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "store.sqlite")), { models, registry, now: () => 1000 }, context);
		const root = await harness.root(context);
		await root.configure({ model, cwd: dir, instructions: MAIN_INSTRUCTIONS, extensions: [tasks, codemode.extension] }, context);
		let closed = false;
		const close = async () => { if (!closed) { closed = true; await harness.close(context); } };
		closes.push(close);
		return { harness, root, model, tasks, close };
	}
	let session = await open();
	const started = await session.root.commit((tx) => createJobInCommit(tx, "worker", session.model, [], dir, {
		maxTurns: 20, thinkingLevel: "off", notifyMain: true, autoContinue: false,
	}), context);
	const receipt = await session.harness.waitForTask(started.taskId, context);
	assert.equal(receipt.state.outcome.result.answer, source);
	const first = resultPage(source, Number(started.taskId));
	const notices = await session.root.entries({ order: "ascending" }, 100, undefined, context);
	const notice = notices.items.find((entry) => entry.kind === "app.job-notice" && (entry.data as { phase: string }).phase === "completed");
	assert.ok(notice);
	const noticeText = JSON.stringify(notice.model);
	assert.ok(noticeText.includes(JSON.stringify(formatResultPage(first)).slice(1, -1)));
	assert.ok(first.nextCall);
	await session.close();
	session = await open();
	const record = (await session.harness.getTask(started.taskId, context))!;
	assert.deepEqual(await readJobResultPage(session.harness, record, context), first);
	let assembled = first.text;
	let page = first;
	while (page.nextCall !== undefined) {
		nextArgs = page.nextCall;
		const tool = session.tasks.tools!.find((tool) => tool.name === "task")!;
		const reply = await tool.execute(nextArgs as never, session.harness as never, context);
		assert.notEqual(reply.isError, true);
		const structured = reply.structuredOutput as unknown as typeof first;
		assert.equal(structured.start, page.end);
		assembled += structured.text;
		page = structured;
	}
	assert.equal(assembled, source);
	// Native output must preserve content and the exact next call below the harness caps.
	for (const requestedPage of [1, 2]) {
		nextArgs = { action: "result", id: String(started.taskId), page: requestedPage, revision: first.revision };
		mode = "task";
		await (await session.root.submit({ type: "input", content: "retrieve" }, context)).wait(context);
		assert.ok(toolText.includes(formatResultPage(resultPage(source, Number(started.taskId), requestedPage, first.revision))));
		mode = "codemode";
		await (await session.root.submit({ type: "input", content: "retrieve" }, context)).wait(context);
		assert.ok(toolText.includes(formatResultPage(resultPage(source, Number(started.taskId), requestedPage, first.revision))), toolText.slice(-2000));
		assert.doesNotMatch(toolText, /Warning: truncated output/);
	}
	// A legacy receipt must recover from the complete original entry, not its saved tail.
	const legacy = { ...record, state: { ...record.state, outcome: { ...receipt.state.outcome, result: { ...receipt.state.outcome.result, answerComplete: undefined, answer: "[...answer truncated...]\n" + source.slice(-6000) } } } } as AnyTaskRecord;
	assert.deepEqual(await readJobResultPage(session.harness, legacy, context), first);
	const missing = { ...legacy, state: { ...legacy.state, outcome: { ...receipt.state.outcome, result: { answer: "[...answer truncated...]\nlost", answerEntry: 999999 } } } } as AnyTaskRecord;
	await assert.rejects(readJobResultPage(session.harness, missing, context), /full answer entry is unavailable/);
	const worker = (await session.harness.conversation(started.conversationId, context))!;
	const workerEntries = await worker.entries({ order: "ascending" }, 100, undefined, context);
	const userEntry = workerEntries.items.find((entry) => entry.model?.some((message) => message.role === "user"))!;
	const mainEntries = await session.root.entries({ order: "descending" }, 100, undefined, context);
	const foreignAnswer = mainEntries.items.find((entry) => entry.model?.some((message) => message.role === "assistant"))!;
	assert.ok(userEntry && foreignAnswer);
	// Neither a non-assistant source nor another conversation's answer may certify a legacy tail.
	for (const answerEntry of [userEntry.id, foreignAnswer.id]) {
		const invalidSource = { ...legacy, state: { ...legacy.state, outcome: { ...receipt.state.outcome, result: { ...legacy.state.outcome.result, answerEntry } } } } as AnyTaskRecord;
		await assert.rejects(readJobResultPage(session.harness, invalidSource, context), /full answer entry is unavailable/);
	}
	const live = { ...record, state: { status: "running", checkpoint: { phase: "run" } } } as AnyTaskRecord;
	await assert.rejects(readJobResultPage(session.harness, live, context), /still live/);
	const tool = session.tasks.tools!.find((tool) => tool.name === "task")!;
	const shown = await tool.execute({ action: "show", id: String(started.taskId) } as never, session.harness as never, context);
	assert.equal((shown.structuredOutput as unknown as typeof first).text, first.text);
	assert.deepEqual((shown.structuredOutput as unknown as typeof first).nextCall, first.nextCall);
	const listed = await tool.execute({ action: "list" } as never, session.harness as never, context);
	assert.equal(typeof listed.structuredOutput, "string");
	assert.ok(!String(listed.structuredOutput).includes("const 漢字"));
	assert.ok(String(listed.structuredOutput).length < 1000);
	const failed = { ...record, state: { status: "terminal", outcome: { status: "failed", result: { reason: source } } } } as AnyTaskRecord;
	assert.deepEqual(await readJobResultPage(session.harness, failed, context), first);
	const completeFallback = { ...record, state: { status: "terminal", outcome: { status: "completed", result: { answer: "[...answer truncated...] is literal response text", answerComplete: true } } } } as AnyTaskRecord;
	assert.equal((await readJobResultPage(session.harness, completeFallback, context)).text, "[...answer truncated...] is literal response text");
	for (const args of [{ action: "result", id: "0" }, { action: "result", id: "999999" }, { action: "result", id: String(started.taskId), page: 0 }, { action: "show", id: String(started.taskId), page: 2 }]) {
		assert.equal((await tool.execute(args as never, session.harness as never, context)).isError, true);
	}
});

// The restart test above resets neither context nor a live report checkpoint. Gate the actual
// settled -> extraction boundary (or legacy report boundary) so reset deterministically wins.
test("reset between settlement and extraction preserves full receipts, completion pages and legacy recovery", { timeout: 20_000 }, async (t) => {
	const long = "START\n" + "x".repeat(25000) + "\nEND \t\n";
	for (const scenario of [
		{ name: "settled immutable answer after reset", source: long, legacy: false },
		{ name: "legacy report recovers immutable answer after reset and restart", source: long, legacy: true },
		{ name: "old false-empty report is repaired from its immutable answer", source: long, legacy: true, falseEmpty: true },
		{ name: "missing answer source cannot produce an empty complete receipt or notice", source: long, legacy: true, missing: "absent" },
		{ name: "missing legacy source preserves the saved tail without certifying it complete", source: long, legacy: true, missing: "tail" },
		{ name: "valid empty answer after reset", source: "", legacy: false },
		{ name: "valid whitespace answer after reset", source: " \t\n", legacy: false },
	]) await t.test(scenario.name, async (t) => {
		const dir = mkdtempSync(join(tmpdir(), "dchat-result-reset-"));
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let armed = true;
		const closes: (() => Promise<void>)[] = [];
		t.after(async () => {
			release.resolve();
			for (const close of closes.reverse()) await close();
			rmSync(dir, { recursive: true, force: true });
		});
		async function gate(signal: AbortSignal) {
			armed = false;
			entered.resolve();
			const aborted = Promise.withResolvers<void>();
			const onAbort = () => aborted.resolve();
			signal.addEventListener("abort", onAbort, { once: true });
			try { await Promise.race([release.promise, aborted.promise]); }
			finally { signal.removeEventListener("abort", onAbort); }
		}
		const real = JobTask.definition;
		const controlled = defineTask({
			...real,
			phases: {
				...real.phases,
				run: async (task, runtime, callContext) => {
					const wrapped = new Proxy(runtime, {
						get(target, key) {
							if (key === "snapshot") return async (...args: Parameters<typeof runtime.snapshot>) => {
								// JobTask reads this doc immediately after submission.wait() returns.
								if (!scenario.legacy && armed && args[0] === JobHandoffDoc) await gate(runtime.signal);
								return Reflect.apply(target.snapshot, target, args);
							};
							if (key === "commit" && scenario.legacy) return (change, ctx) => target.commit(async (tx, current) => {
								const next = await change(tx, current);
								if (next?.checkpoint?.phase === "report" && next.checkpoint.status === "answered") {
									return { ...next, checkpoint: {
										...next.checkpoint,
										answerComplete: scenario.falseEmpty ? true : undefined,
										answer: scenario.missing === "absent" ? undefined : scenario.falseEmpty ? "" : "[...answer truncated...]\n" + scenario.source.slice(-6000),
										...(scenario.missing ? { answerEntry: 999999 } : {}),
									} };
								}
								return next;
							}, ctx);
							return Reflect.get(target, key);
						},
					});
					await real.phases.run(task, wrapped, callContext);
				},
				report: async (task, runtime, callContext) => {
					if (scenario.legacy && armed) await gate(runtime.signal);
					if (!runtime.signal.aborted) await real.phases.report(task, runtime, callContext);
				},
			},
		});
		async function open() {
			const faux = fauxProvider(); // Offline, immediate response; gates control ordering, not time.
			faux.setResponses([fauxAssistantMessage(scenario.source)]);
			const models = createModels(); models.setProvider(faux.provider);
			const model = { provider: faux.getModel().provider, modelId: faux.getModel().id };
			const registry = createRegistry();
			registry.install(defineExtension({ name: "jobs", tasks: [controlled] }));
			const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "store.sqlite")), { models, registry, now: () => 1000 }, context);
			const root = await harness.root(context);
			let closed = false;
			const close = async () => { if (!closed) { closed = true; await harness.close(context); } };
			closes.push(close);
			return { harness, root, model, close };
		}
		let session = await open();
		const started = await session.root.commit((tx) => createJobInCommit(tx, "worker", session.model, [], dir, {
			maxTurns: 20, thinkingLevel: "off", notifyMain: true, autoContinue: false,
		}), context);
		await Promise.race([entered.promise, session.harness.waitForTask(started.taskId, context).then((task) => { throw new Error(`Job ended before gate: ${JSON.stringify(task.state)}`); })]);
		const worker = (await session.harness.conversation(started.conversationId, context))!;
		const before = await worker.context(context);
		const answerEntry = before.entries.findLast((entry) => entry.model?.some((message) => message.role === "assistant"))!;
		assert.ok(answerEntry);
		await worker.reset(undefined, context);
		assert.ok(!(await worker.context(context)).entries.some((entry) => entry.id === answerEntry.id));
		if (scenario.legacy) {
			const pending = (await session.harness.getTask(started.taskId, context))!;
			assert.equal(pending.state.checkpoint.phase, "report");
			if (!scenario.falseEmpty && !scenario.missing) assert.match(pending.state.checkpoint.answer, /^\[\.\.\.answer truncated\.\.\.\]/);
			// Close aborts only this invocation; the persisted report must recover on reopen.
			await session.close();
			session = await open();
		} else release.resolve();
		const receipt = await session.harness.waitForTask(started.taskId, context);
		assert.equal(receipt.state.outcome.status, "completed");
		assert.equal(receipt.state.outcome.result.answer, scenario.missing === "absent" ? undefined : scenario.missing === "tail" ? "[...answer truncated...]\n" + scenario.source.slice(-6000) : scenario.source);
		assert.equal(receipt.state.outcome.result.answerComplete, !scenario.missing);
		assert.equal(receipt.state.outcome.result.answerEntry, scenario.missing ? 999999 : Number(answerEntry.id));
		const first = resultPage(scenario.source, Number(started.taskId));
		const entries = await session.root.entries({ order: "ascending" }, 100, undefined, context);
		const notice = entries.items.find((entry) => entry.kind === "app.job-notice" && (entry.data as { phase: string }).phase === "completed");
		assert.ok(notice);
		if (scenario.missing) {
			assert.match((notice.data as { summary: string }).summary, /incomplete or unavailable/);
			assert.doesNotMatch((notice.data as { summary: string }).summary, /COMPLETE result|End of stored response/);
			await assert.rejects(readJobResultPage(session.harness, receipt, context), /Cannot return a complete result/);
			return;
		}
		assert.equal((notice.data as { summary: string }).summary, formatResultPage(first));
		if (scenario.source === long) {
			assert.ok(first.nextCall);
			assert.match((notice.data as { summary: string }).summary, /PAGED result: page 1\/2/);
			assert.doesNotMatch((notice.data as { summary: string }).summary, /COMPLETE result/);
		}
		await session.close();
		session = await open();
		const record = (await session.harness.getTask(started.taskId, context))!;
		let page = await readJobResultPage(session.harness, record, context);
		assert.deepEqual(page, first);
		let assembled = page.text;
		while (page.nextCall !== undefined) {
			page = await readJobResultPage(session.harness, record, context, page.nextCall.page, page.nextCall.revision);
			assembled += page.text;
		}
		assert.equal(assembled, scenario.source);
	});
});
