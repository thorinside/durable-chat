import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { modelChoices, type ModelChoices } from "../src/models.ts";
import { openRuntime } from "../src/harness.ts";
import { jobView } from "../src/format.ts";
import { createJobInCommit, jobOptionsOf, scanJobs } from "../src/jobs.ts";
import { Dashboard } from "../src/tui/app.ts";

async function setup(t: TestContext, extraConfig = "") {
	const dir = mkdtempSync(join(tmpdir(), "dchat-tui-slash-"));
	const configPath = join(dir, "config.yaml");
	writeFileSync(configPath, `provider: faux\nautoContinue: false\nmcp:\n  enabled: false\n${extraConfig}`);
	const runtime = await openRuntime({ configPath, storePath: join(dir, "store.sqlite"), withMcp: false });
	let quits = 0;
	let reboots = 0;
	const rollbacks: string[] = [];
	const selectedModels: string[] = [];
	const selectedProviders: string[] = [];
	const dashboard = new Dashboard({ runtime, rows: () => 30, requestRender: () => {}, onQuit: () => { quits++; }, onReboot: () => { reboots++; }, onRollback: (source) => { rollbacks.push(source); }, onModel: (id) => { selectedModels.push(id); }, onProvider: (name) => { selectedProviders.push(name); } });
	t.after(async () => {
		await dashboard.stop();
		await runtime.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const render = () => dashboard.render(140).map(stripTerminalSequences).join("\n");
	const command = async (text: string) => {
		for (const character of text) await dashboard.handleInput(character);
		await dashboard.handleInput("\r");
	};
	return { dir, runtime, dashboard, render, command, quits: () => quits, reboots: () => reboots, rollbacks, selectedModels, selectedProviders };
}

test("a slash typed into the composer stays in the message and help or info commands never reach the model", async (t) => {
	const { runtime, dashboard, render, command } = await setup(t);
	const before = await runtime.root.entries({ order: "ascending" }, 100, undefined, runtime.context);
	dashboard.handleInput("/");
	assert.match(render(), /to main › \//);
	assert.doesNotMatch(render(), /filter ›/);
	await command("help");
	assert.match(render(), /Slash commands \(composer\)/);
	dashboard.handleInput("\x1b");
	await command("/info");
	assert.match(render(), /Inspector/);
	assert.match(render(), /Config:/);
	const after = await runtime.root.entries({ order: "ascending" }, 100, undefined, runtime.context);
	assert.deepEqual(after.items.map((entry) => entry.id), before.items.map((entry) => entry.id));
});

test("slash still filters jobs outside the composer and filter submission does not become a model message", async (t) => {
	const { runtime, dashboard, render, command } = await setup(t);
	for (const brief of ["alpha work", "beta work"]) {
		await runtime.root.commit((tx) => createJobInCommit(tx, brief, runtime.model, runtime.jobExtensions, runtime.cwd, jobOptionsOf(runtime.config)), runtime.context);
	}
	await command("/tasks");
	assert.match(render(), /focus jobs/);
	dashboard.handleInput("/");
	assert.match(render(), /filter ›/);
	await command("alpha");
	assert.match(render(), /alpha work/);
	assert.doesNotMatch(render(), /beta work/);
	await command("/help");
	assert.match(render(), /Slash commands \(composer\)/);
	const history = await runtime.root.entries({ order: "ascending" }, 100, undefined, runtime.context);
	assert.equal(history.items.filter((entry) => entry.kind === "pi.user").length, 0);
});

test("slash new creates a native background job instead of submitting command text to main", async (t) => {
	const { runtime, render, command } = await setup(t);
	await command("/new inspect the local project");
	const jobs = await scanJobs(runtime.harness, runtime.context);
	assert.equal(jobs.length, 1);
	assert.equal(jobView(jobs[0]!).brief, "inspect the local project");
	assert.match(render(), new RegExp(`TRANSCRIPT job #${jobs[0]!.id}`));
	const history = await runtime.root.entries({ order: "ascending" }, 100, undefined, runtime.context);
	assert.equal(history.items.filter((entry) => entry.kind === "pi.user").length, 0);
});

test("slash reset preserves confirmation and invalid commands fail locally without model input", async (t) => {
	const { runtime, dashboard, render, command } = await setup(t);
	await command("/reset retain the verified findings");
	assert.match(render(), /Reset main\?/);
	assert.match(render(), /retain the verified findings/);
	dashboard.handleInput("n");
	const invalid: [string, RegExp][] = [
		["/not-a-command", /Unknown command/],
		["/send 123", /Usage: \/send/],
		["/task 999999", /No job #999999/],
	];
	for (const [input, error] of invalid) {
		await command(input);
		assert.match(render(), error);
	}
	const history = await runtime.root.entries({ order: "ascending" }, 100, undefined, runtime.context);
	assert.equal(history.items.filter((entry) => entry.kind === "pi.user" || entry.kind === "pi.reset").length, 0);
});

test("slash reboot requires an explicit Y, defaults to cancellation, and never submits model input", async (t) => {
	const { runtime, dashboard, render, command, reboots, quits } = await setup(t);
	const before = await runtime.root.entries({ order: "ascending" }, 100, undefined, runtime.context);
	await command("/reboot unexpected");
	assert.match(render(), /Usage: \/reboot/);
	for (const cancel of ["\r", "n", "\x1b"]) {
		await command("/reboot");
		assert.match(render(), /Reboot all state\?/);
		await dashboard.handleInput(cancel);
		assert.equal(reboots(), 0);
	}
	await command("/reboot");
	await dashboard.handleInput("Y");
	assert.equal(reboots(), 1);
	assert.equal(quits(), 0);
	const after = await runtime.root.entries({ order: "ascending" }, 100, undefined, runtime.context);
	assert.deepEqual(after.items.map((entry) => entry.id), before.items.map((entry) => entry.id));
});

test("slash rollback selects a recent state file, requires explicit confirmation, and keeps invalid choices out of model input", async (t) => {
	const { runtime, dashboard, render, command, rollbacks } = await setup(t);
	const archive = runtime.storePath + ".reboot-test";
	mkdirSync(archive);
	const source = join(archive, basename(runtime.storePath));
	const db = new DatabaseSync(source);
	db.exec("CREATE TABLE notes(value TEXT)");
	db.close();
	const before = await runtime.root.entries({ order: "ascending" }, 100, undefined, runtime.context);
	await command("/rollback");
	assert.match(render(), /Rollback state/);
	await command("9");
	assert.match(render(), /No archive with that number/);
	await dashboard.handleInput("\x7f");
	await command("1");
	assert.match(render(), /Rollback all state\?/);
	await dashboard.handleInput("\r");
	assert.deepEqual(rollbacks, []);
	await command("/rollback " + runtime.storePath);
	assert.match(render(), /already the current state/);
	await dashboard.handleInput("\x1b");
	await command('/rollback "' + source + '"');
	await dashboard.handleInput("y");
	assert.deepEqual(rollbacks, [realpathSync(source)]);
	const after = await runtime.root.entries({ order: "ascending" }, 100, undefined, runtime.context);
	assert.deepEqual(after.items.map((entry) => entry.id), before.items.map((entry) => entry.id));
});

test("the model picker filters and navigates provider models and only applies an explicit selection without model input", async (t) => {
	const { runtime, dashboard, render, command, selectedModels } = await setup(t);
	const catalog = createModels();
	catalog.setProvider(fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-review", name: "Review model" }] }).provider);
	const choices = await modelChoices(runtime.config, catalog, runtime.model);
	// Provider discovery/restart is covered in model-picker.test; this controls the UI's catalog boundary.
	t.mock.method(runtime, "listModels", async () => choices);
	const before = await runtime.root.entries({ order: "ascending" }, 100, undefined, runtime.context);
	await command("/model unknown-model");
	assert.match(render(), /Choose a listed model/);
	await dashboard.handleInput("\x1b");
	assert.deepEqual(selectedModels, []);
	await command("/model");
	await dashboard.handleInput("\x1b[B");
	assert.match(render(), /▸ faux-review/);
	await dashboard.handleInput("\x1b[A");
	assert.match(render(), /▸ faux-1/);
	await dashboard.handleInput("unmatched");
	await dashboard.handleInput("\r");
	assert.deepEqual(selectedModels, []);
	await dashboard.handleInput("\x1b");
	await command("/model");
	await command("REVIEW");
	// The switch needs the provider as well as the ID, so the picker hands over the lookup.
	assert.deepEqual(selectedModels, ["faux/faux-review"]);
	const after = await runtime.root.entries({ order: "ascending" }, 100, undefined, runtime.context);
	assert.deepEqual(after.items.map((entry) => entry.id), before.items.map((entry) => entry.id));
	assert.equal(runtime.model.modelId, "faux-1", "UI selection delegates the global switch to the lifecycle owner");
});

test("cancelling a loading model picker aborts discovery and a late catalog cannot reopen or apply it", async (t) => {
	const { runtime, dashboard, render, command, selectedModels } = await setup(t);
	const started = Promise.withResolvers<AbortSignal | undefined>();
	const pending = Promise.withResolvers<ModelChoices>();
	t.mock.method(runtime, "listModels", async (signal?: AbortSignal) => { started.resolve(signal); return pending.promise; });
	const opening = command("/model");
	const signal = await started.promise;
	await dashboard.handleInput("\x1b");
	assert.equal(signal?.aborted, true);
	pending.resolve({ items: [{ id: "faux-1", name: "Faux", contextWindow: 128000, maxTokens: 8192 }] });
	await opening;
	assert.doesNotMatch(render(), /Loading models|Models —/);
	assert.deepEqual(selectedModels, []);
});

test("slash wait with no jobs and slash quit use TUI actions rather than model turns", async (t) => {
	const { runtime, command, render, quits } = await setup(t);
	await command("/wait");
	assert.match(render(), /no live jobs/);
	await command("/quit");
	assert.equal(quits(), 1);
	const history = await runtime.root.entries({ order: "ascending" }, 100, undefined, runtime.context);
	assert.equal(history.items.filter((entry) => entry.kind === "pi.user").length, 0);
});

test("slash thinking changes the session level without submitting a model turn", async (t) => {
	const { runtime, render, command } = await setup(t);
	await command("/thinking high");
	assert.equal(runtime.thinkingLevel, "high");
	assert.match(render(), /thinking level: high/);
	await command("/thinking");
	assert.match(render(), /thinking: high/);
	await command("/thinking huge");
	assert.match(render(), /must be one of/);
	assert.equal(runtime.thinkingLevel, "high");
	const history = await runtime.root.entries({ order: "ascending" }, 100, undefined, runtime.context);
	assert.equal(history.items.filter((entry) => entry.kind === "pi.user").length, 0);
});

test("the model picker lists models across configured providers and labels an ID shared by two entries", async (t) => {
	const { runtime, dashboard, render, command, selectedModels } = await setup(t, "providers:\n  faux: { kind: faux, model: shared }\n  second: { kind: faux, model: shared }\n");
	const choices = { items: [
		{ provider: "faux", id: "shared", name: "Shared", contextWindow: 200000, maxTokens: 8000, lookup: "faux/shared" },
		{ provider: "second", id: "shared", name: "Shared", contextWindow: 8192, maxTokens: 512, lookup: "second/shared" },
	] };
	t.mock.method(runtime, "listModels", async () => choices);
	const before = await runtime.root.entries({ order: "ascending" }, 100, undefined, runtime.context);
	await command("/model");
	assert.match(render(), /faux\/shared \(current\)/);
	// Without the provider name the two rows are indistinguishable, and a selection by number could
	// apply the other entry's limits.
	await dashboard.handleInput("\x1b[B");
	assert.match(render(), /second\/shared/);
	await dashboard.handleInput("\r");
	assert.deepEqual(selectedModels, ["second/shared"]);
	const after = await runtime.root.entries({ order: "ascending" }, 100, undefined, runtime.context);
	assert.equal(after.items.length, before.items.length);
});

test("slash provider lists the configured entries and selects one without a model turn", async (t) => {
	const { runtime, render, command, selectedProviders } = await setup(t, "providers:\n  faux: { kind: faux }\n  offline: { kind: faux, model: offline-model }\n");
	await command("/provider");
	assert.match(render(), /providers: faux \(current\), offline/);
	await command("/provider offline");
	assert.deepEqual(selectedProviders, ["offline"]);
	await command("/provider nope");
	assert.match(render(), /No configured provider "nope"\. Known: faux, offline/);
	const history = await runtime.root.entries({ order: "ascending" }, 100, undefined, runtime.context);
	assert.equal(history.items.filter((entry) => entry.kind === "pi.user").length, 0);
});
