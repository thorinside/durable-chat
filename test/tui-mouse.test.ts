import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TuiAltScreen, getCapabilities, getOsc8LinkAtColumn, setCapabilities, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { Terminal, TuiMouseEvent } from "@earendil-works/pi-tui";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { openRuntime } from "../src/harness.ts";
import { createJobInCommit, jobOptionsOf } from "../src/jobs.ts";
import { Dashboard } from "../src/tui/app.ts";
import { createTextCopier, type CopyText } from "../src/tui/clipboard.ts";

async function fixture(t: TestContext, jobs = 0, linkText?: string, copySelection?: CopyText, answer?: string) {
	const dir = mkdtempSync(join(tmpdir(), "dchat-mouse-"));
	const configPath = join(dir, "config.yaml");
	writeFileSync(configPath, "provider: faux\nautoContinue: false\nmcp:\n  enabled: false\n");
	const runtime = await openRuntime({ configPath, storePath: join(dir, "store.sqlite"), withMcp: false });
	let width = 140;
	const height = 20;
	let input: (data: string) => void = () => {};
	const terminal: Terminal = {
		start(onInput) { input = onInput; }, stop() {}, write() {},
		get columns() { return width; }, rows: height, kittyProtocolActive: false,
		moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
		setTitle() {}, setProgress() {}, setProgramStatus() {},
	};
	const opened: string[] = [];
	const copied: string[] = [];
	const ui = new TuiAltScreen(terminal, false, undefined, { openUrl: (url) => { opened.push(url); }, copyOnSelect: false });
	const dashboard = new Dashboard({ runtime, rows: () => height, requestRender: () => ui.requestRender(), onQuit: () => {}, openUrl: (url) => { opened.push(url); }, copySelection: copySelection ?? (async (text) => { copied.push(text); return true; }) });
	t.after(async () => {
		ui.stop();
		await dashboard.stop();
		await runtime.close();
		rmSync(dir, { recursive: true, force: true });
	});
	await runtime.root.commit(async (tx) => {
		for (let index = 1; index <= 20; index++) {
			await tx.appendEntry(runtime.root.id, { kind: "pi.user", model: [{ role: "user", content: `entry-${index}`, timestamp: 0 }] });
		}
		if (linkText !== undefined) await tx.appendEntry(runtime.root.id, { kind: "pi.user", model: [{ role: "user", content: linkText, timestamp: 0 }] });
		if (answer !== undefined) await tx.appendEntry(runtime.root.id, { kind: "pi.assistant", model: [fauxAssistantMessage([fauxText(answer)])] });
	}, runtime.context);
	const started = await runtime.root.commit(async (tx) => {
		const result = [];
		for (let index = 1; index <= jobs; index++) {
			result.push(await createJobInCommit(tx, `mouse-job-${index}`, runtime.model, runtime.jobExtensions, runtime.cwd, jobOptionsOf(runtime.config)));
		}
		return result;
	}, runtime.context);
	await Promise.all(started.map((job) => runtime.harness.waitForTask(job.taskId, runtime.context)));
	await dashboard.start();
	ui.setLayoutRoot(dashboard);
	ui.setFocus(dashboard);
	ui.start();
	const frame = () => {
		ui.renderNow();
		return ui.getScreenLines().map(stripTerminalSequences);
	};
	frame();
	const wheel = (x: number, direction: "up" | "down", count = 1, y = 5) => {
		// Exercise the actual terminal decoder and component dispatch, not just Dashboard.handleMouse.
		for (let index = 0; index < count; index++) input(`\x1b[<${direction === "up" ? 64 : 65};${x + 1};${y + 1}M`);
		return frame();
	};
	return { dashboard, frame, wheel, opened, copied, rawFrame: () => ui.getScreenLines(), input: (data: string) => input(data), resize: (columns: number) => { width = columns; return frame(); }, height, started };
}

function pane(frame: string[], name: "JOBS" | "TRANSCRIPT" | "CONTEXT"): string {
	const heading = frame[2]!;
	const start = heading.indexOf(name);
	assert.ok(start >= 0, `${name} is visible`);
	const end = heading.indexOf("│", start);
	return frame.slice(2, -6).map((line) => line.slice(start, end === -1 ? undefined : end)).join("\n");
}

test("terminal wheel events scroll the hovered transcript while preserving composer focus, draft and geometry", async (t) => {
	const app = await fixture(t);
	app.input("unsent draft");
	const before = app.frame();
	const x = before[2]!.indexOf("TRANSCRIPT") + 1;
	assert.match(pane(before, "TRANSCRIPT"), /entry-20/);
	const older = app.wheel(x, "up", 12);
	assert.doesNotMatch(pane(older, "TRANSCRIPT"), /entry-20/);
	assert.equal(pane(older, "JOBS"), pane(before, "JOBS"));
	assert.equal(pane(older, "CONTEXT"), pane(before, "CONTEXT"));
	assert.match(older.join("\n"), /focus composer/);
	assert.equal(older.findIndex((line) => line.includes("unsent draft")), before.findIndex((line) => line.includes("unsent draft")));
	assert.match(pane(app.wheel(x, "down", 12), "TRANSCRIPT"), /entry-20/);
});

test("wheel scrolling browses jobs and context independently without changing the selected job or keyboard focus", async (t) => {
	const app = await fixture(t, 8);
	const before = app.frame();
	const jobsScrolled = app.wheel(3, "down", 6);
	assert.notEqual(pane(jobsScrolled, "JOBS"), pane(before, "JOBS"));
	assert.equal(pane(jobsScrolled, "TRANSCRIPT"), pane(before, "TRANSCRIPT"));
	assert.equal(pane(jobsScrolled, "CONTEXT"), pane(before, "CONTEXT"));
	assert.match(jobsScrolled.join("\n"), /focus composer/);
	const contextX = before[2]!.indexOf("CONTEXT") + 1;
	const contextScrolled = app.wheel(contextX, "down", 40);
	assert.match(pane(contextScrolled, "CONTEXT"), /store:/);
	assert.equal(pane(contextScrolled, "JOBS"), pane(jobsScrolled, "JOBS"));
	assert.equal(pane(contextScrolled, "TRANSCRIPT"), pane(jobsScrolled, "TRANSCRIPT"));
	app.input("\t");
	app.input("j");
	const selected = app.frame();
	assert.match(pane(selected, "JOBS"), new RegExp(`▸ #${app.started.at(-2)!.taskId}\\b`));
});

test("wheel hit testing follows narrow and resized pane geometry", async (t) => {
	const app = await fixture(t);
	for (const width of [40, 80, 140, 100]) {
		const before = app.resize(width);
		const x = before[2]!.indexOf("TRANSCRIPT") + 1;
		assert.match(pane(before, "TRANSCRIPT"), /entry-20/);
		assert.doesNotMatch(pane(app.wheel(x, "up", 12), "TRANSCRIPT"), /entry-20/);
		assert.match(pane(app.wheel(x, "down", 12), "TRANSCRIPT"), /entry-20/);
	}
	// A manually enabled context pane below the default breakpoint must use the same bounds as rendering.
	app.input("\t");
	app.input("{");
	const resized = app.frame();
	const x = resized[2]!.indexOf("CONTEXT") + 1;
	assert.ok(x > 0);
	const after = app.wheel(x, "down", 40);
	assert.match(pane(after, "CONTEXT"), /store:/);
	assert.equal(pane(after, "TRANSCRIPT"), pane(resized, "TRANSCRIPT"));
});

test("wheel events over chrome, separators and modal screens are consumed without moving the dashboard", async (t) => {
	const app = await fixture(t);
	const before = app.frame();
	const transcriptX = before[2]!.indexOf("TRANSCRIPT");
	for (const [x, y] of [[transcriptX, 0], [transcriptX, 2], [transcriptX, app.height - 3], [transcriptX - 1, 5]]) {
		assert.deepEqual(app.wheel(x!, "up", 5, y), before);
	}
	app.input("\t");
	app.input("?");
	const help = app.frame();
	assert.match(help.join("\n"), /Help/);
	assert.deepEqual(app.wheel(transcriptX, "down", 5), help);
	app.input("\x1b");
	assert.match(pane(app.frame(), "TRANSCRIPT"), /entry-20/);
	const pointer: TuiMouseEvent = { type: "press", button: "left", x: transcriptX, y: 5, screenX: transcriptX, screenY: 5, width: 140, height: app.height, shift: false, alt: false, ctrl: false };
	assert.equal(app.dashboard.handleMouse(pointer)?.handled, true, "dashboard owns selection rather than selecting adjacent panes through toolkit fallback");
});

test("transcript links retain native modifier-click targets through wrapping and routed clicks preserve the draft", async (t) => {
	const previousCapabilities = getCapabilities();
	setCapabilities({ images: null, trueColor: true, hyperlinks: true });
	t.after(() => setCapabilities(previousCapabilities));
	const markdownUrl = "https://example.com/release?version=1&view=notes";
	const bareUrl = `https://example.com/${"long-path/".repeat(5)}details`;
	const app = await fixture(t, 0, `[release notes](${markdownUrl})\n\n${bareUrl}`);
	app.input("keep this draft");
	const targets = (url: string, width: number) => app.rawFrame().flatMap((line, y) =>
		Array.from({ length: width }, (_, x) => ({ x, y })).filter(({ x }) => getOsc8LinkAtColumn(line, x) === url));
	for (const width of [140, 80, 40]) {
		const frame = app.resize(width);
		const transcriptStart = frame[2]!.indexOf("TRANSCRIPT");
		const separator = frame[2]!.indexOf("│", transcriptStart);
		for (const url of [markdownUrl, bareUrl]) {
			const cells = targets(url, width);
			assert.ok(cells.length > 0, "native Command-click must retain the complete destination, even on wrapped links");
			assert.ok(cells.every(({ x }) => x >= transcriptStart && (separator === -1 || x < separator)), "hyperlinks must not leak into adjacent panes");
		}
	}
	const click = (x: number, y: number, drag = false) => {
		app.input(`\x1b[<0;${x + 1};${y + 1}M`);
		if (drag) app.input(`\x1b[<32;${x + 3};${y + 1}M`);
		app.input(`\x1b[<0;${x + (drag ? 3 : 1)};${y + 1}m`);
		return app.frame();
	};
	for (const url of [markdownUrl, bareUrl]) {
		const { x, y } = targets(url, 40)[0]!;
		const frame = click(x, y);
		assert.equal(app.opened.at(-1), url);
		assert.match(frame.join("\n"), /keep this draft/);
		assert.match(frame.join("\n"), /focus composer/);
	}
	const { x, y } = targets(markdownUrl, 40)[0]!;
	click(x, y, true);
	assert.deepEqual(app.opened, [markdownUrl, bareUrl], "dragging across a link selects text instead of opening it");
});

// Wheel/link tests disable toolkit copy-on-select and cannot protect selection text or its lifecycle.
function pointer(app: Awaited<ReturnType<typeof fixture>>, type: "press" | "drag" | "release", x: number, y: number) {
	app.input(`\x1b[<${type === "drag" ? 32 : 0};${x + 1};${y + 1}${type === "release" ? "m" : "M"}`);
	return app.frame();
}

function transcriptBounds(app: Awaited<ReturnType<typeof fixture>>) {
	const heading = app.frame()[2]!;
	const x = heading.indexOf("TRANSCRIPT");
	const separator = heading.indexOf("│", x);
	return { x, width: (separator < 0 ? heading.length : separator) - x, top: 4, bottom: app.height - 7 };
}

function inverseCells(line: string): number[] {
	let inverse = false;
	let column = 0;
	const cells: number[] = [];
	for (const match of line.matchAll(/\x1b\[[0-9;:]*m|\x1b\][^\x1b\x07]*(?:\x07|\x1b\\)|[^\x1b]+/gu)) {
		const token = match[0];
		if (token.startsWith("\x1b[")) {
			for (const code of token.slice(2, -1).split(";")) {
				if (code === "7") inverse = true;
				else if (code === "0" || code === "" || code === "27") inverse = false;
			}
		} else if (!token.startsWith("\x1b")) {
			const width = visibleWidth(token);
			if (inverse) for (let index = 0; index < width; index++) cells.push(column + index);
			column += width;
		}
	}
	return cells;
}

function highlightedRows(app: Awaited<ReturnType<typeof fixture>>) {
	const { top, bottom } = transcriptBounds(app);
	// The composer fake cursor also uses reverse video; it is not mouse selection.
	return app.rawFrame().flatMap((line, y) => y >= top && y <= bottom && inverseCells(line).length ? [y] : []);
}

test("multiline selection highlights and copies only transcript cells including intermediate rows, then clears after copy", async (t) => {
	const copied = Promise.withResolvers<boolean>();
	const texts: string[] = [];
	const app = await fixture(t, 0, undefined, (text) => { texts.push(text); return copied.promise; });
	app.input("keep selection draft");
	const { x, width, top } = transcriptBounds(app);
	const before = app.frame();
	pointer(app, "press", x + 2, top);
	pointer(app, "drag", x + 7, top + 3);
	for (const [y, line] of app.rawFrame().entries()) {
		if (y >= app.height - 6) continue; // Composer cursor is not a mouse highlight.
		const cells = inverseCells(line);
		assert.ok(cells.every((column) => column >= x && column < x + width && y >= top && y <= top + 3), "highlight must stay in transcript selection, including intermediate rows");
	}
	assert.ok(highlightedRows(app).length > 0);
	pointer(app, "release", x + 7, top + 3);
	const expected = before.slice(top, top + 4).map((line, index) =>
		line.slice(x + (index === 0 ? 2 : 0), x + (index === 3 ? 8 : width)).replace(/^ /, "").trimEnd()).join("\n");
	assert.deepEqual(texts, [expected]);
	assert.ok(highlightedRows(app).length > 0, "pending clipboard copy retains selection");
	copied.resolve(true);
	await copied.promise;
	await Promise.resolve();
	app.frame();
	assert.deepEqual(highlightedRows(app), []);
	assert.match(app.frame().join("\n"), /keep selection draft/);
	app.input("!");
	assert.match(app.frame().join("\n"), /keep selection draft!/);
});

test("selection clamps all transcript edges at narrow, wide and manually resized pane widths", async (t) => {
	const app = await fixture(t);
	for (const columns of [40, 80, 140]) {
		app.resize(columns);
		if (columns === 140) { app.input("\t"); app.input("]"); app.frame(); }
		const { x, width, top, bottom } = transcriptBounds(app);
		const before = app.frame();
		pointer(app, "press", x, top);
		pointer(app, "drag", columns + 20, app.height + 20);
		pointer(app, "release", columns + 20, app.height + 20);
		assert.equal(app.copied.at(-1), before.slice(top, bottom + 1).map((line) => line.slice(x, x + width).replace(/^ /, "").trimEnd()).join("\n"));
		await Promise.resolve();
		pointer(app, "press", x + width - 1, bottom);
		pointer(app, "drag", -5, -5);
		pointer(app, "release", -5, -5);
		assert.equal(app.copied.at(-1), before.slice(top, bottom + 1).map((line) => line.slice(x, x + width).replace(/^ /, "").trimEnd()).join("\n"));
		await Promise.resolve();
	}
});

test("presses outside transcript content and on modal screens never start selection or copy", async (t) => {
	const app = await fixture(t);
	const { x, top } = transcriptBounds(app);
	for (const [startX, startY] of [[0, top], [139, top], [x, 0], [x, 2], [x, 3], [x, app.height - 3]]) {
		pointer(app, "press", startX!, startY!);
		pointer(app, "drag", x + 8, top + 2);
		pointer(app, "release", x + 8, top + 2);
		assert.deepEqual(highlightedRows(app), []);
	}
	app.input("\t"); app.input("?"); app.frame();
	pointer(app, "press", x, top);
	pointer(app, "drag", x + 8, top + 2);
	pointer(app, "release", x + 8, top + 2);
	assert.deepEqual(app.copied, []);
	assert.deepEqual(highlightedRows(app), []);
});

test("clipboard failures retain selection and stale successful copies do not erase a newer drag", async (t) => {
	const first = Promise.withResolvers<boolean>();
	let calls = 0;
	const app = await fixture(t, 0, undefined, () => ++calls === 1 ? first.promise : Promise.resolve(false));
	const { x, top } = transcriptBounds(app);
	pointer(app, "press", x, top);
	pointer(app, "drag", x + 8, top + 2);
	pointer(app, "release", x + 8, top + 2);
	pointer(app, "press", x + 2, top + 1);
	pointer(app, "drag", x + 10, top + 3);
	first.resolve(true);
	await first.promise; await Promise.resolve();
	app.frame();
	assert.ok(highlightedRows(app).includes(top + 3));
	pointer(app, "release", x + 10, top + 3);
	await Promise.resolve(); await Promise.resolve();
	app.frame();
	assert.ok(highlightedRows(app).length > 0);
	assert.match(app.frame().join("\n"), /Copy failed/);
	app.resize(80);
	assert.deepEqual(highlightedRows(app), [], "resizing invalidates selected cell coordinates");
});

test("transcript selection copies whole wide and combining graphemes when endpoints land inside their cells", async (t) => {
	const app = await fixture(t, 0, "A界e\u0301🙂Z");
	const before = app.frame();
	const y = before.findIndex((line) => line.includes("界"));
	assert.ok(y >= 4);
	const prefix = before[y]!.slice(0, before[y]!.indexOf("界"));
	const x = visibleWidth(prefix);
	pointer(app, "press", x + 1, y); // Second cell of 界.
	pointer(app, "drag", x + 4, y); // Second cell of 🙂, after 界 + é.
	pointer(app, "release", x + 4, y);
	assert.deepEqual(app.copied, ["界e\u0301🙂"]);
	await Promise.resolve();
	assert.deepEqual(highlightedRows(app), []);
});

test("double and triple clicks still copy transcript words and lines without selecting neighboring panes", async (t) => {
	const app = await fixture(t, 0, "selectionword, secondword");
	t.mock.timers.enable({ apis: ["Date"], now: 1000 });
	const before = app.frame();
	const y = before.findIndex((line) => line.includes("selectionword"));
	const x = before[y]!.indexOf("selectionword");
	const bounds = transcriptBounds(app);
	for (let count = 1; count <= 3; count++) {
		t.mock.timers.tick(100);
		pointer(app, "press", x, y);
		pointer(app, "release", x, y);
		await Promise.resolve();
	}
	assert.deepEqual(app.copied, ["selectionword", before[y]!.slice(bounds.x, bounds.x + bounds.width).replace(/^ /, "").trimEnd()]);
	assert.deepEqual(highlightedRows(app), []);
});

test("copy excludes speaker gutters and right cell fill while preserving code indentation and blank lines", async (t) => {
	const app = await fixture(t, 0, "```ts\nif (ok) {\n  run(界é🙂);  next();\n\n  done();\n}\n```");
	const frame = app.frame();
	const { x, width } = transcriptBounds(app);
	const first = frame.findIndex((line) => line.includes("if (ok)"));
	const last = frame.findIndex((line) => line.includes("done();"));
	assert.ok(first >= 4 && last > first);
	pointer(app, "press", x, first); // Start in the continuation gutter, not source indentation.
	pointer(app, "drag", x + width - 1, last); // End in padded terminal cells.
	pointer(app, "release", x + width - 1, last);
	assert.deepEqual(app.copied, ["if (ok) {\n  run(界é🙂);  next();\n\n  done();"]);
	await Promise.resolve();
	assert.deepEqual(highlightedRows(app), []);

	const count = app.copied.length;
	pointer(app, "press", x, first);
	pointer(app, "drag", x + 4, first);
	pointer(app, "release", x + 4, first);
	assert.equal(app.copied.length, count, "selecting only decorative gutter cells copies nothing");
});

test("partial-line copy preserves deliberately selected internal spaces at the selection edge", async (t) => {
	const app = await fixture(t, 0, "```\n  run(界é🙂);  next();\n```");
	const frame = app.frame();
	const y = frame.findIndex((line) => line.includes("run("));
	const x = visibleWidth(frame[y]!.slice(0, frame[y]!.indexOf("run(")));
	const selected = "run(界é🙂);  ";
	pointer(app, "press", x, y);
	pointer(app, "drag", x + visibleWidth(selected) - 1, y);
	pointer(app, "release", x + visibleWidth(selected) - 1, y);
	assert.deepEqual(app.copied, [selected], "selection serialization must not trimEnd a partial substring");
	await Promise.resolve();
	const spaces = x + visibleWidth(selected) - 2;
	pointer(app, "press", spaces, y);
	pointer(app, "drag", spaces + 1, y);
	pointer(app, "release", spaces + 1, y);
	assert.deepEqual(app.copied, [selected, "  "], "deliberately selected internal whitespace alone is content");
});

test("native copy clears the highlight only after the clipboard writer completes", async (t) => {
	const completed = Promise.withResolvers<void>();
	const texts: string[] = [];
	const copy = createTextCopier({ platform: "darwin", env: { TERM_PROGRAM: "Apple_Terminal" }, isTTY: true,
		nativeClipboard: () => ({ getText: () => assert.fail("no reads"), getImage: () => assert.fail("no reads"),
			setText: (text) => { texts.push(text); return completed.promise; } }),
		write: () => assert.fail("no OSC 52 for local Terminal"),
	});
	const app = await fixture(t, 0, "copy-native", copy);
	const before = app.frame();
	const y = before.findIndex((line) => line.includes("copy-native"));
	const x = before[y]!.indexOf("copy-native");
	pointer(app, "press", x, y); pointer(app, "drag", x + 10, y); pointer(app, "release", x + 10, y);
	assert.deepEqual(texts, ["copy-native"]);
	assert.ok(highlightedRows(app).length > 0);
	completed.resolve();
	for (let index = 0; index < 4; index++) await Promise.resolve();
	app.frame();
	assert.deepEqual(highlightedRows(app), []);
	assert.match(app.frame().join("\n"), /copied to clipboard/);
});

test("OSC 52 submission retains selection and reports unconfirmed delivery rather than clipboard success", async (t) => {
	const writes: string[] = [];
	const copy = createTextCopier({ platform: "linux", env: {}, isTTY: true, write: async (text) => { writes.push(text); } });
	const app = await fixture(t, 0, "copy-remote", copy);
	const before = app.frame();
	const y = before.findIndex((line) => line.includes("copy-remote"));
	const x = before[y]!.indexOf("copy-remote");
	pointer(app, "press", x, y); pointer(app, "drag", x + 10, y); pointer(app, "release", x + 10, y);
	for (let index = 0; index < 4; index++) await Promise.resolve();
	assert.deepEqual(writes, [`\x1b]52;c;${Buffer.from("copy-remote").toString("base64")}\x07`]);
	assert.ok(highlightedRows(app).length > 0);
	assert.match(app.frame().join("\n"), /unconfirmed/);
	assert.doesNotMatch(app.frame().join("\n"), /copied to clipboard/);
});

test("keyboard answer copy uses the same clipboard facility and keeps the full unrendered answer", async (t) => {
	const texts: string[] = [];
	const answer = "```ts\nif (ok) {\n  run(界);\n}\n```\n\n**Done**";
	const app = await fixture(t, 0, undefined, async (text) => { texts.push(text); return true; }, answer);
	app.input("\t");
	app.input("y");
	for (let index = 0; index < 4; index++) await Promise.resolve();
	assert.deepEqual(texts, [answer]);
	assert.match(app.frame().join("\n"), /copied to clipboard/);
});
