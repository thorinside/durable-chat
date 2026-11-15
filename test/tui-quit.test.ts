import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { openRuntime } from "../src/harness.ts";
import { Dashboard } from "../src/tui/app.ts";

async function setup(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "dchat-double-interrupt-"));
	const configPath = join(dir, "config.yaml");
	writeFileSync(configPath, "provider: faux\nmcp:\n  enabled: false\n");
	const runtime = await openRuntime({ configPath, storePath: join(dir, "store.sqlite"), withMcp: false });
	let quits = 0;
	const dashboard = new Dashboard({ runtime, rows: () => 24, requestRender: () => {}, onQuit: () => { quits++; } });
	t.after(async () => {
		await dashboard.stop();
		await runtime.close();
		rmSync(dir, { recursive: true, force: true });
	});
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	return { dashboard, quits: () => quits, render: () => dashboard.render(120).map(stripTerminalSequences).join("\n") };
}

test("the first Ctrl-C clears the composer and a second consecutive press quits an idle dashboard", async (t) => {
	const { dashboard, quits, render } = await setup(t);
	dashboard.handleInput("\x11");
	assert.equal(quits(), 0);
	dashboard.handleInput("unfinished-draft");
	assert.match(render(), /unfinished-draft/);
	dashboard.handleInput("\x03");
	assert.equal(quits(), 0);
	assert.doesNotMatch(render(), /unfinished-draft/);
	assert.match(render(), /CTRL-C again to quit/);
	t.mock.timers.tick(500);
	dashboard.handleInput("\x03");
	assert.equal(quits(), 1);
	dashboard.handleInput("\x03");
	assert.equal(quits(), 1);
});

test("the Ctrl-C quit window expires so isolated interrupts cannot quit", async (t) => {
	const { dashboard, quits, render } = await setup(t);
	dashboard.handleInput("\x03");
	t.mock.timers.tick(1500);
	assert.doesNotMatch(render(), /again to quit/);
	dashboard.handleInput("\x03");
	assert.equal(quits(), 0);
	t.mock.timers.tick(1000);
	dashboard.handleInput("\x03");
	assert.equal(quits(), 1);
});

test("typing or navigation between Ctrl-C presses disarms quitting", async (t) => {
	for (const [name, intervening] of [["typing", "new-draft"], ["focus navigation", "\t"], ["Escape", "\x1b"]]) {
		await t.test(name!, async (t) => {
			const { dashboard, quits, render } = await setup(t);
			dashboard.handleInput("\x03");
			t.mock.timers.tick(100);
			dashboard.handleInput(intervening!);
			assert.doesNotMatch(render(), /again to quit/);
			t.mock.timers.tick(100);
			dashboard.handleInput("\x03");
			assert.equal(quits(), 0);
			dashboard.handleInput("\x03");
			assert.equal(quits(), 1);
		});
	}
});

test("one Ctrl-C closes an auxiliary prompt before a second press can quit", async (t) => {
	const { dashboard, quits, render } = await setup(t);
	dashboard.handleInput("\x0e");
	dashboard.handleInput("new-job-draft");
	assert.match(render(), /new job ›/);
	dashboard.handleInput("\x03");
	assert.equal(quits(), 0);
	assert.match(render(), /to main ›/);
	assert.doesNotMatch(render(), /new-job-draft/);
	dashboard.handleInput("\x03");
	assert.equal(quits(), 1);
});
