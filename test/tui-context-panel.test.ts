import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isKittyProtocolActive, matchesKey, setKittyProtocolActive, stripTerminalSequences, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { openRuntime } from "../src/harness.ts";
import { Dashboard } from "../src/tui/app.ts";

const originalConfig = '# keep these settings\nprovider: faux\nautoContinue: false\nmcp:\n  enabled: false # no external services\n';
const toggleKey = "\x18"; // Ctrl-X has no composer, copy, or terminal-process binding.
const toggleEncodings = [
	["legacy control byte", toggleKey, false],
	["CSI-u", "\x1b[120;5u", false],
	["Kitty press with alternate keys", "\x1b[120:88:120;5:1u", true],
	["modifyOtherKeys", "\x1b[27;5;120~", false],
] as const;

async function fixture(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "dchat-context-panel-"));
	const configPath = join(dir, "config.yaml");
	writeFileSync(configPath, originalConfig);
	const open = () => openRuntime({ configPath, storePath: join(dir, "store.sqlite"), withMcp: false });
	let runtime = await open();
	let rows = 30;
	let quits = 0;
	const create = () => new Dashboard({ runtime, rows: () => rows, requestRender() {}, onQuit() { quits++; } });
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
		get quits() { return quits; },
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

test("Ctrl-X saves context off in the active config and a fresh dashboard keeps it off across resizing", async (t) => {
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

// The original visibility tests used only Meta-C, missing default macOS text input
// and the different control-key encodings negotiated by ProcessTerminal.
for (const [name, key, kitty] of toggleEncodings) {
	test(`Ctrl-X ${name} toggles from every focus without editing or submitting the draft and persists on reload`, async (t) => {
		const previousKitty = isKittyProtocolActive();
		setKittyProtocolActive(kitty);
		t.after(() => setKittyProtocolActive(previousKitty));
		const app = await fixture(t);
		await app.key("draft");
		for (let focus = 0; focus < 3; focus++) {
			await app.key(key);
			assert.equal(app.runtime.config.contextPanel, false);
			assert.doesNotMatch(app.frame()[2]!, /CONTEXT/);
			assert.match(readFileSync(app.configPath, "utf8"), /contextPanel: false/);
			await app.key(key);
			assert.equal(app.runtime.config.contextPanel, true);
			assert.match(app.frame().join("\n"), /to main › draft/);
			await app.key("\t");
		}
		// Editor navigation still works after toggling, and Ctrl-C still clears.
		await app.key("\x01");
		await app.key("!");
		assert.match(app.frame().join("\n"), /to main › !draft/);
		await app.key("\x03");
		assert.doesNotMatch(app.frame().join("\n"), /!draft/);
		assert.equal(app.runtime.config.contextPanel, true);
		assert.equal(app.quits, 0);
		await app.key(key);
		await app.reload();
		assert.equal(app.runtime.config.contextPanel, false);
		const history = await app.runtime.root.entries({ order: "ascending" }, 100, undefined, app.runtime.context);
		assert.equal(history.items.filter((entry) => entry.kind === "pi.user").length, 0);
	});
}

for (const [name, text] of [["default Option-C", "ç"], ["CSI-u printable ç", "\x1b[231u"]]) {
	test(`${name} remains ordinary composer text and never changes the context preference`, async (t) => {
		const app = await fixture(t);
		await app.key("fa");
		await app.key(text!);
		await app.key("ade");
		assert.match(app.frame().join("\n"), /to main › façade/);
		assert.equal(app.runtime.config.contextPanel, true);
		assert.equal(readFileSync(app.configPath, "utf8"), originalConfig);
	});
}

test("the literal Meta-C alias still toggles without treating a Kitty printable base-layout c as a shortcut", async (t) => {
	const app = await fixture(t);
	await app.key("\x1bc");
	assert.equal(app.runtime.config.contextPanel, false);
	await app.key("\x1b[231::99;3u");
	assert.equal(app.runtime.config.contextPanel, false);
});

test("Ctrl-X encodings do not overlap toolkit editing or copy defaults or terminal process controls", () => {
	const reserved = ["ctrl+c", "ctrl+d", "ctrl+j", "ctrl+q", "ctrl+s", "ctrl+t", "ctrl+v", "ctrl+z", "ctrl+shift+x", "super+x", "super+c"] as const;
	for (const [name, key] of toggleEncodings) {
		for (const definition of Object.values(TUI_KEYBINDINGS)) {
			const bindings = typeof definition.defaultKeys === "string" ? [definition.defaultKeys] : definition.defaultKeys;
			for (const binding of bindings) assert.equal(matchesKey(key, binding), false, `${name} must not shadow ${binding}`);
		}
		for (const binding of reserved) assert.equal(matchesKey(key, binding), false, `${name} must not shadow ${binding}`);
	}
});

test("full help stays reachable from every available focus without consuming question marks in a draft", async (t) => {
	for (const width of [40, 160]) {
		await t.test(`help access preserves a draft at ${width} columns`, async (t) => {
			const app = await fixture(t);
			const frame = () => app.frame(width).join("\n");
			assert.match(app.frame(width).at(-1)!, /help/);
			await app.key("?");
			assert.match(frame(), /Help/);
			assert.match(frame(), /CTRL-X/);
			assert.match(frame(), /\/context off/);
			await app.key("\x1b");
			await app.key("draft");
			await app.key("?");
			assert.match(frame(), /to main › draft\?/);
			assert.match(app.frame(width).at(-1)!, /help/);
			// Narrow dashboards omit jobs from the focus cycle.
			for (let focus = 0; focus < (width < 64 ? 1 : 2); focus++) {
				await app.key("\t");
				assert.match(app.frame(width).at(-1)!, /help/);
				await app.key("?");
				assert.match(frame(), /Help/);
				await app.key("\x1b");
				assert.match(frame(), /to main › draft\?/);
			}
			await app.key("\t");
			await app.key("\x03"); // Clear only the draft before entering a command.
			await app.command("/help");
			assert.match(frame(), /Help/);
			assert.match(frame(), /\/context off/);
		});
	}
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
