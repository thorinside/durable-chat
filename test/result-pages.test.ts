import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { formatResultPage, resultPage } from "../src/result-pages.ts";
import { createJobInCommit, MAIN_INSTRUCTIONS, readJobResultPage } from "../src/jobs.ts";
import { JobTask } from "../src/tasks.ts";
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
