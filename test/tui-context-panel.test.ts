import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { openRuntime } from "../src/harness.ts";
import { Dashboard } from "../src/tui/app.ts";

const originalConfig = '# keep these settings\nprovider: faux\nautoContinue: false\nmcp:\n  enabled: false # no external services\n';
const toggleKey = "\x1bc"; // Alt-C, unused by the dashboard and composer keymaps.

async function fixture(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "dchat-context-panel-"));
	const configPath = join(dir, "config.yaml");
	writeFileSync(configPath, originalConfig);
	const open = () => openRuntime({ configPath, storePath: join(dir, "store.sqlite"), withMcp: false });
	let runtime = await open();
	let rows = 30;
	const create = () => new Dashboard({ runtime, rows: () => rows, requestRender() {}, onQuit() {} });
	let dashboard = create();
	t.after(async () => {
		await dashboard.stop();
		await runtime.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return {
		configPath,
		get runtime() { return runtime; },
		get dashboard() { return dashboard; },
		frame(width = 160) {
			const frame = dashboard.render(width);
			assert.equal(frame.length, rows);
			assert.ok(frame.every((line) => visibleWidth(line) <= width));
			return frame.map(stripTerminalSequences);
		},
		async key(key: string) { await dashboard.handleInput(key); },
		async command(command: string) {
			await dashboard.handleInput(command);
			await dashboard.handleInput("\r");
		},
		async reload() {
			await dashboard.stop();
			await runtime.close();
			runtime = await open();
			dashboard = create();
		},
		resizeHeight(height: number) { rows = height; },
	};
}

test("Alt-C saves context off in the active config and a fresh dashboard keeps it off across resizing", async (t) => {
	const app = await fixture(t);
	assert.match(app.frame()[2]!, /CONTEXT/);
	await app.key("unsent draft");
	await app.key(toggleKey);
	assert.doesNotMatch(app.frame()[2]!, /CONTEXT/);
	assert.match(app.frame().join("\n"), /to main › unsent draft/);
	assert.equal(readFileSync(app.configPath, "utf8"), `${originalConfig}contextPanel: false\n`);
	await app.reload();
	assert.equal(app.runtime.config.contextPanel, false);
	for (const width of [40, 110, 140, 200]) assert.doesNotMatch(app.frame(width)[2]!, /CONTEXT/);
	// Width reset and manual resizing must not override explicit visibility.
	await app.key("\t");
	for (const key of ["}", "0"]) {
		await app.key(key);
		assert.doesNotMatch(app.frame()[2]!, /CONTEXT/);
	}
	await app.key(toggleKey);
	assert.match(app.frame()[2]!, /CONTEXT/);
	await app.reload();
	assert.match(app.frame()[2]!, /CONTEXT/);
});

test("automatic context hiding reserves usable transcript and context widths without changing preference", async (t) => {
	const app = await fixture(t);
	for (const width of [40, 80, 110, 120, 139]) assert.doesNotMatch(app.frame(width)[2]!, /CONTEXT/);
	for (const width of [140, 160, 200]) {
		const heading = app.frame(width)[2]!;
		const separators = [...heading.matchAll(/│/g)].map((match) => match.index);
		assert.equal(separators.length, 2);
		assert.ok(separators[1]! - separators[0]! - 1 >= 80);
		assert.ok(width - separators[1]! - 1 >= 26);
	}
	app.frame(140);
	await app.key("\t");
	for (let index = 0; index < 20; index++) await app.key("}");
	assert.match(app.frame(140)[2]!, /CONTEXT/, "context width clamps to leave an 80-column transcript");
	for (let index = 0; index < 20; index++) await app.key("]");
	assert.doesNotMatch(app.frame(140)[2]!, /CONTEXT/, "an enlarged jobs pane can leave too little room");
	assert.match(app.frame(200)[2]!, /CONTEXT/);
	assert.doesNotMatch(app.frame(139)[2]!, /CONTEXT/);
	assert.equal(readFileSync(app.configPath, "utf8"), originalConfig);
	assert.equal(app.runtime.config.contextPanel, true);
	await app.reload();
	assert.match(app.frame(140)[2]!, /CONTEXT/);
	// Turning the preference on in a narrow window must not force a cramped panel.
	app.frame(110);
	await app.key(toggleKey);
	await app.key(toggleKey);
	assert.doesNotMatch(app.frame(110)[2]!, /CONTEXT/);
	assert.match(app.frame(160)[2]!, /CONTEXT/);
});

test("context toggle preserves keyboard focus and a growing multiline composer", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1000 });
	const app = await fixture(t);
	await app.key("first draft line");
	await app.key("\n");
	await app.key("second draft line");
	for (let index = 0; index < 3; index++) {
		const before = app.frame();
		const status = before.find((line) => line.startsWith(" target "));
		const first = before.findIndex((line) => line.includes("first draft line"));
		const second = before.findIndex((line) => line.includes("second draft line"));
		assert.ok(second > first);
		await app.key(toggleKey);
		t.mock.timers.tick(5001); // Let the save notice expire before checking the focus status.
		const after = app.frame();
		assert.equal(after.find((line) => line.startsWith(" target ")), status);
		assert.match(after[first]!, /first draft line/);
		assert.match(after[second]!, /second draft line/);
		await app.key("\t");
	}
	await app.key("!");
	assert.match(app.frame().join("\n"), /second draft line!/);
	app.resizeHeight(14);
	assert.match(app.frame().join("\n"), /second draft line!/);
});

test("context slash commands persist on off and toggle locally without conversation input", async (t) => {
	const app = await fixture(t);
	for (const [command, enabled] of [["/context off", false], ["/context on", true], ["/context toggle", false], ["/context", true]] as const) {
		await app.command(command);
		assert.equal(app.runtime.config.contextPanel, enabled);
		assert.equal(app.frame()[2]!.includes("CONTEXT"), enabled);
	}
	const saved = readFileSync(app.configPath, "utf8");
	await app.command("/context invalid");
	assert.match(app.frame().join("\n"), /Usage: \/context/);
	assert.equal(readFileSync(app.configPath, "utf8"), saved);
	const history = await app.runtime.root.entries({ order: "ascending" }, 100, undefined, app.runtime.context);
	assert.equal(history.items.filter((entry) => entry.kind === "pi.user").length, 0);
});

test("a failed context preference save reports the error without changing visibility or the config", async (t) => {
	const app = await fixture(t);
	app.frame();
	// Simulate a config edit that cannot safely be merged, independent of filesystem permissions.
	const invalid = "contextPanel: [\n";
	writeFileSync(app.configPath, invalid);
	await app.key(toggleKey);
	assert.match(app.frame()[2]!, /CONTEXT/);
	assert.match(app.frame().join("\n"), /Could not save context panel preference/);
	assert.equal(app.runtime.config.contextPanel, true);
	assert.equal(readFileSync(app.configPath, "utf8"), invalid);
});
