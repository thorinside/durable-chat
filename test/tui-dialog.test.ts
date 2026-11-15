import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRuntime } from "../src/harness.ts";
import { createJobInCommit, jobOptionsOf } from "../src/jobs.ts";
import { Dashboard } from "../src/tui/app.ts";
import { overlayDialog } from "../src/tui/dialog.ts";

test("double Ctrl-C opens the floating quit confirmation and retains cancel and accept controls", { timeout: 20_000 }, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "dchat-quit-dialog-"));
	const configPath = join(dir, "config.yaml");
	writeFileSync(configPath, "provider: faux\nmcp:\n  enabled: false\n");
	const runtime = await openRuntime({ configPath, storePath: join(dir, "store.sqlite"), withMcp: false });
	let quitCalls = 0;
	const dashboard = new Dashboard({ runtime, rows: () => 30, requestRender: () => {}, onQuit: () => { quitCalls++; } });
	try {
		await runtime.root.commit(
			(tx) => createJobInCommit(tx, "pending work", runtime.model, runtime.jobExtensions, runtime.cwd, jobOptionsOf(runtime.config)), runtime.context,
		);
		await dashboard.start();
		const graph = await runtime.harness.watchTaskGraph(runtime.context);
		const active = Promise.withResolvers<void>();
		graph.start(async (call) => {
			if (call.kind === "value" && Object.keys(call.value.tasks).length > 0) active.resolve();
		});
		try {
			await active.promise;
		} finally {
			await graph.stop();
		}
		t.mock.timers.enable({ apis: ["Date"], now: 1000 });
		dashboard.handleInput("\x03");
		dashboard.handleInput("\x03");
		const confirming = dashboard.render(120).map(stripVTControlCharacters).join("\n");
		assert.match(confirming, /Quit durable-chat\?/);
		assert.match(confirming, /JOBS/);
		assert.match(confirming, /TRANSCRIPT/);
		assert.equal(quitCalls, 0);
		dashboard.handleInput("n");
		assert.doesNotMatch(dashboard.render(120).map(stripVTControlCharacters).join("\n"), /Quit durable-chat\?/);
		assert.equal(quitCalls, 0);
		dashboard.handleInput("\x03");
		assert.doesNotMatch(dashboard.render(120).map(stripVTControlCharacters).join("\n"), /Quit durable-chat\?/);
		dashboard.handleInput("\x03");
		dashboard.handleInput("y");
		assert.equal(quitCalls, 1);
	} finally {
		await dashboard.stop();
		await runtime.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

// State-only TUI tests cannot detect a confirmation replacing the underlying dashboard.
test("a floating quit dialog preserves the dashboard outside its centered rectangle", () => {
	const frame = Array.from({ length: 30 }, (_, index) => `row ${index} ${"·".repeat(100)}`.slice(0, 100));
	const output = overlayDialog(frame, 100, "Quit durable-chat?", "Live work pauses and resumes on the next run.", "Enter / y quit · n / Esc cancel");
	assert.equal(output.length, frame.length);
	assert.equal(output[0], frame[0]);
	assert.equal(output.at(-1), frame.at(-1));
	const changed = output.flatMap((line, index) => line === frame[index] ? [] : [index]);
	assert.ok(changed.length > 0 && changed.length < frame.length / 2);
	assert.ok(Math.abs(changed[0]! - (frame.length - 1 - changed.at(-1)!)) <= 1);
	for (const index of changed) {
		const plain = stripVTControlCharacters(output[index]!);
		assert.equal(plain.slice(0, 20), frame[index]!.slice(0, 20));
		assert.equal(plain.slice(80), frame[index]!.slice(80));
	}
	assert.match(output.join("\n"), /Quit durable-chat\?/);
});

test("a floating confirmation fits narrow and short viewports without losing its keyboard choices", () => {
	for (const width of [16, 24, 40, 120]) {
		for (const height of [10, 24]) {
			const frame = Array.from({ length: height }, () => " ".repeat(width));
			const output = overlayDialog(frame, width, "Quit durable-chat?", "1 live job and 3 live tasks pause and resume on the next run.", "Enter / y quit · n / Esc cancel");
			assert.equal(output.length, height);
			assert.ok(output.every((line) => visibleWidth(line) <= width));
			const content = output.map(stripVTControlCharacters).join("").replace(/[\s│┌┐└┘─]/g, "");
			assert.ok(content.includes("Enter/yquit·n/Esccancel"));
		}
	}
});
