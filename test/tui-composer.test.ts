import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURSOR_MARKER, StdinBuffer, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { Conversation } from "@earendil-works/pi-durable";
import { openRuntime } from "../src/harness.ts";
import { findJobConversation, scanJobs } from "../src/jobs.ts";
import { jobView } from "../src/format.ts";
import { Dashboard } from "../src/tui/app.ts";
import { Composer } from "../src/tui/composer.ts";

const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;

async function setup(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "dchat-composer-"));
	const configPath = join(dir, "config.yaml");
	writeFileSync(configPath, "provider: faux\nautoContinue: false\nmcp:\n  enabled: false\n");
	const runtime = await openRuntime({ configPath, storePath: join(dir, "store.sqlite"), withMcp: false });
	let height = 30;
	const dashboard = new Dashboard({ runtime, rows: () => height, requestRender: () => {}, onQuit: () => {} });
	t.after(async () => {
		await dashboard.stop();
		await runtime.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const messages = async (conversation: Conversation = runtime.root) => {
		const entries = await conversation.entries({ order: "ascending" }, 100, undefined, runtime.context);
		return entries.items.filter((entry) => entry.kind === "pi.user").flatMap((entry) =>
			(entry.model as { role: string; content: string | { type: string; text?: string }[] }[])
				.filter((message) => message.role === "user")
				.map((message) => typeof message.content === "string" ? message.content : message.content.filter((block) => block.type === "text").map((block) => block.text).join("")));
	};
	return { runtime, dashboard, messages, resize: (rows: number) => { height = rows; } };
}

for (const [name, newline] of [["LF", "\n"], ["CRLF", "\r\n"], ["CR", "\r"]]) {
	test(`bracketed ${name} paste stays a draft until Enter and durable Main input retains normalized line breaks`, async (t) => {
		const { dashboard, messages } = await setup(t);
		const lines = ["", "Description | toolPrefix", "disable)requestTimeoutMs);", "", "最後の行", ""];
		await dashboard.handleInput(paste(lines.join(newline)));
		assert.deepEqual(await messages(), []);
		await dashboard.handleInput("\r");
		assert.deepEqual(await messages(), [lines.join("\n")]);
	});
}

for (const [name, key] of [
	["Kitty Shift+Enter", "\x1b[13;2u"],
	["modifyOtherKeys Shift+Enter", "\x1b[27;2;13~"],
	["legacy Shift+Enter", "\x1b[13;2~"],
	["Ctrl+J fallback", "\n"],
	["Alt+Enter fallback", "\x1b\r"],
]) {
	test(`${name} inserts a visible draft line while plain Enter sends once`, async (t) => {
		const { dashboard, messages } = await setup(t);
		await dashboard.handleInput("first line");
		await dashboard.handleInput(key);
		await dashboard.handleInput("second line");
		const frame = dashboard.render(140).map(stripTerminalSequences);
		assert.ok(frame.findIndex((line) => line.includes("second line")) > frame.findIndex((line) => line.includes("first line")));
		assert.deepEqual(await messages(), []);
		await dashboard.handleInput("\r");
		assert.deepEqual(await messages(), ["first line\nsecond line"]);
	});
}

test("terminal chunk boundaries inside paste markers and CRLF never turn pasted newlines into submissions", async (t) => {
	// ProcessTerminal uses this decoder before rewrapping its paste event for Dashboard.
	// Direct handleInput tests alone would miss transport fragmentation/coalesced Enter.
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const original = "alpha\r\nbeta\rgamma\n\nend";
	const encoded = paste(original);
	for (let split = 1; split < encoded.length; split++) {
		const decoder = new StdinBuffer();
		const composer = new Composer(() => 24, () => {});
		const keys: string[] = [];
		decoder.on("paste", (content) => composer.handleInput(paste(content)));
		decoder.on("data", (data) => keys.push(data));
		try {
			decoder.process(encoded.slice(0, split));
			decoder.process(encoded.slice(split) + "\r");
			assert.equal(composer.getValue(), "alpha\nbeta\ngamma\n\nend", `split ${split}`);
			assert.deepEqual(keys, ["\r"], `only the explicit Enter is a key at split ${split}`);
		} finally { decoder.destroy(); }
	}
});

test("multiline navigation and deletion edit logical lines rather than submitting or flattening the draft", async (t) => {
	const { dashboard, messages } = await setup(t);
	await dashboard.handleInput(paste("alpha\nbeta\ngamma"));
	dashboard.render(100); // Establish the toolkit's visual navigation width.
	await dashboard.handleInput("\x1b[A"); // beta, column 4
	await dashboard.handleInput("!");
	await dashboard.handleInput("\x01"); // Ctrl-A: start of beta!
	await dashboard.handleInput("\x7f"); // Join beta! onto alpha.
	await dashboard.handleInput("\x1b[C");
	await dashboard.handleInput("\x1b[D");
	await dashboard.handleInput("\x1b[3~"); // Forward delete b at the join.
	await dashboard.handleInput("\r");
	assert.deepEqual(await messages(), ["alphaeta!\ngamma"]);
});

test("large folded pastes submit their complete content rather than the visible placeholder", async (t) => {
	const { dashboard, messages } = await setup(t);
	const document = Array.from({ length: 18 }, (_, index) => `row ${index} | ${"description ".repeat(20)}`).join("\r\n");
	await dashboard.handleInput(paste(document));
	dashboard.render(50);
	await dashboard.handleInput("\r");
	assert.deepEqual(await messages(), [document.replaceAll("\r\n", "\n")]);
});

test("visual wrapping never invents newline characters when the pasted source has none", async (t) => {
	const { dashboard, messages } = await setup(t);
	const unbroken = "DescriptiontoolPrefix_disable)requestTimeoutMs);".repeat(5);
	await dashboard.handleInput(paste(unbroken));
	dashboard.render(40);
	await dashboard.handleInput("\r");
	assert.equal((await messages()).at(-1), unbroken);
});

test("growing and scrolling drafts reserve pane space and keep the cursor visible after narrow and short resizes", async (t) => {
	const { dashboard, resize, messages } = await setup(t);
	const empty = dashboard.render(100).map(stripTerminalSequences);
	const emptyTarget = empty.findIndex((line) => line.includes("to main ›"));
	for (let line = 1; line <= 12; line++) {
		if (line > 1) await dashboard.handleInput("\x1b[13;2u");
		await dashboard.handleInput(`draft-${line}`);
	}
	const grown = dashboard.render(100);
	assert.ok(grown.map(stripTerminalSequences).findIndex((line) => line.includes("to main ›")) < emptyTarget);
	for (const [height, width] of [[30, 100], [16, 40], [11, 24]]) {
		resize(height);
		for (const direction of ["\x1b[A", "\x1b[B"]) {
			for (let step = 0; step < 12; step++) {
				await dashboard.handleInput(direction);
				const frame = dashboard.render(width);
				assert.equal(frame.length, height);
				assert.ok(frame.every((line) => visibleWidth(line) <= width));
				const target = frame.map(stripTerminalSequences).findIndex((line) => line.includes("to main ›"));
				const cursor = frame.findIndex((line) => line.includes(CURSOR_MARKER));
				assert.ok(cursor >= target && cursor < height - 2, "cursor remains inside the composer, above its bottom padding and hint");
				assert.match(stripTerminalSequences(frame.at(-1)!), /ENTER/, "input growth must not hide the send hint");
			}
		}
	}
	assert.deepEqual(await messages(), []);
});

test("new job briefs and subsequent job messages retain composed and pasted line breaks", async (t) => {
	const { runtime, dashboard, messages } = await setup(t);
	await dashboard.handleInput("\x0e"); // Ctrl-N
	await dashboard.handleInput("inspect source");
	await dashboard.handleInput("\x1b[13;2u");
	await dashboard.handleInput("report findings");
	await dashboard.handleInput("\r");
	const [job] = await scanJobs(runtime.harness, runtime.context);
	assert.ok(job);
	assert.equal(jobView(job).brief, "inspect source\nreport findings");
	await runtime.harness.waitForTask(job.id, runtime.context);
	await dashboard.handleInput("\t"); // Transcript -> composer, retaining the job target.
	const followUp = "\ncheck one\n\ncheck two\n";
	await dashboard.handleInput(paste(followUp));
	const conversation = await findJobConversation(runtime.harness, Number(job.id), runtime.context);
	assert.ok(conversation);
	const before = await messages(conversation);
	await dashboard.handleInput("\r");
	assert.deepEqual(await messages(conversation), [...before, followUp]);
});
