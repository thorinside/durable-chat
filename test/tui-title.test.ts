import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { Dashboard } from "../src/tui/app.ts";
import { runTui } from "../src/tui/main.ts";

function fixture(t: TestContext, failure?: "dashboard" | "title", failCleanup = false) {
	for (const stream of [process.stdin, process.stdout]) {
		const descriptor = Object.getOwnPropertyDescriptor(stream, "isTTY");
		Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
		t.after(() => {
			if (descriptor === undefined) Reflect.deleteProperty(stream, "isTTY");
			else Object.defineProperty(stream, "isTTY", descriptor);
		});
	}
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const startupError = new Error("startup failed");
	const cleanupError = new Error("cleanup failed");
	const priorTitle = "the shell's existing title";
	let title = priorTitle;
	const stack: string[] = [];
	const writes: string[] = [];
	let observerStops = 0;
	t.mock.method(ProcessTerminal.prototype, "write", (text: string) => {
		writes.push(text);
		if (text === "\x1b[22;0t") stack.push(title);
		else if (text === "\x1b[23;0t") {
			assert.ok(stack.length > 0, "title restoration must balance a previous save");
			title = stack.pop()!;
		}
	});
	t.mock.method(ProcessTerminal.prototype, "setTitle", (text: string) => {
		title = text;
		if (failure === "title") throw startupError; // Fail after the title was changed.
	});
	t.mock.method(TuiAltScreen.prototype, "start", () => {});
	t.mock.method(TuiAltScreen.prototype, "setLayoutRoot", () => {});
	t.mock.method(TuiAltScreen.prototype, "setFocus", () => {});
	t.mock.method(TuiAltScreen.prototype, "stop", () => { if (failCleanup) throw cleanupError; });
	t.mock.method(Dashboard.prototype, "start", async function (this: Dashboard) {
		if (failure === "dashboard") throw startupError;
		this.handleInput("\x03");
		this.handleInput("\x03");
	});
	t.mock.method(Dashboard.prototype, "stop", async () => { observerStops++; });
	return {
		// Only construction uses this runtime: all UI startup and terminal I/O are test-controlled.
		run: () => runTui({ cwd: process.cwd(), root: {} } as never),
		startupError, cleanupError, priorTitle, stack, writes,
		title: () => title, observerStops: () => observerStops,
	};
}

test("a dashboard startup failure leaves the terminal's previous title saved and restored exactly once", async (t) => {
	const ui = fixture(t, "dashboard");
	await assert.rejects(ui.run(), (error) => error === ui.startupError);
	assert.equal(ui.title(), ui.priorTitle);
	assert.deepEqual(ui.writes, ["\x1b[22;0t", "\x1b[23;0t"]);
	assert.equal(ui.stack.length, 0);
});

test("a failure after changing the title restores it even when terminal cleanup also fails", async (t) => {
	const ui = fixture(t, "title", true);
	await assert.rejects(ui.run(), (error) => error === ui.cleanupError);
	assert.equal(ui.title(), ui.priorTitle);
	assert.equal(ui.writes.at(-1), "\x1b[23;0t");
	assert.equal(ui.stack.length, 0);
	assert.equal(ui.observerStops(), 1, "terminal cleanup failure must still stop dashboard observers");
});

test("each completed TUI lifecycle restores the previous title without leaking title-stack entries", async (t) => {
	const ui = fixture(t);
	for (let run = 0; run < 2; run++) {
		assert.equal(await ui.run(), "quit");
		assert.equal(ui.title(), ui.priorTitle);
		assert.equal(ui.stack.length, 0);
	}
	assert.deepEqual(ui.writes, ["\x1b[22;0t", "\x1b[23;0t", "\x1b[22;0t", "\x1b[23;0t"]);
});
