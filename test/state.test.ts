import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { openRuntime } from "../src/harness.ts";
import { createJobInCommit, jobOptionsOf, jobRecord } from "../src/jobs.ts";

const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function workspace(t: TestContext) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "dchat-state-fork-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const cwd = join(dir, "project");
	const globalDir = join(dir, "xdg/durable-chat");
	mkdirSync(join(cwd, ".durable-chat"), { recursive: true });
	mkdirSync(globalDir, { recursive: true });
	const sourcePath = join(dir, "global.sqlite");
	const globalConfig = join(globalDir, "config.yaml");
	writeFileSync(globalConfig, `provider: faux\nstore: ${JSON.stringify(sourcePath)}\nmcp:\n  enabled: false\n`);
	const storePath = join(cwd, ".durable-chat/store.sqlite");
	const localConfig = join(cwd, ".durable-chat/config.yaml");
	const run = (...args: string[]) => {
		const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
			cwd, env: { XDG_CONFIG_HOME: join(dir, "xdg") }, encoding: "utf8", timeout: 20_000,
		});
		assert.ifError(result.error);
		return result;
	};
	return { cwd, sourcePath, globalConfig, storePath, localConfig, run };
}

function sampleDatabase(path: string): DatabaseSync {
	const db = new DatabaseSync(path);
	db.exec("PRAGMA journal_mode=WAL; CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample VALUES (1, 'original');");
	return db;
}

test("state fork snapshots committed WAL data, preserves local overrides, and separates subsequent writes", (t) => {
	const paths = workspace(t);
	const source = sampleDatabase(paths.sourcePath);
	t.after(() => source.close());
	const globalText = readFileSync(paths.globalConfig, "utf8");
	writeFileSync(paths.localConfig, "# keep project settings\nmaxTurns: 27\nmcp:\n  servers: [nt_helper]\n");
	const result = paths.run("state", "fork");
	assert.equal(result.status, 0, result.stderr);
	assert.equal(paths.run("config", "get", "store").stdout.trim(), paths.storePath);
	assert.equal(paths.run("config", "get", "maxTurns").stdout.trim(), "27");
	assert.equal(paths.run("config", "get", "mcp.servers").stdout.trim(), "nt_helper");
	assert.match(readFileSync(paths.localConfig, "utf8"), /# keep project settings/);
	assert.equal(parseYaml(readFileSync(paths.localConfig, "utf8")).store, ".durable-chat/store.sqlite");
	assert.equal(readFileSync(paths.globalConfig, "utf8"), globalText);
	const fork = new DatabaseSync(paths.storePath);
	try {
		assert.equal(fork.prepare("SELECT value FROM sample WHERE id = 1").get()?.value, "original");
		source.exec("UPDATE sample SET value = 'source-only'");
		assert.equal(fork.prepare("SELECT value FROM sample WHERE id = 1").get()?.value, "original");
		fork.exec("UPDATE sample SET value = 'fork-only'");
		assert.equal(source.prepare("SELECT value FROM sample WHERE id = 1").get()?.value, "source-only");
	} finally {
		fork.close();
	}
	assert.deepEqual(readdirSync(join(paths.cwd, ".durable-chat")).filter((name) => name.startsWith(".state-fork-") || name.endsWith(".lock")), []);
});

test("a fork retains durable conversation identities and pending jobs and can resume without advancing the source", async (t) => {
	const paths = workspace(t);
	const source = await openRuntime({ configPath: paths.globalConfig, withMcp: false });
	try {
		const marker = await source.root.commit((tx) => tx.appendEntry(source.root.id, { kind: "app.fork-marker", data: { origin: "global" } }), source.context);
		const started = await source.root.commit(
			(tx) => createJobInCommit(tx, "continue in the fork", source.model, source.jobExtensions, source.cwd, jobOptionsOf(source.config)), source.context,
		);
		const before = await jobRecord(source.harness, Number(started.taskId), source.context);
		assert.notEqual(before?.state.status, "terminal");
		const result = paths.run("state", "fork");
		assert.equal(result.status, 0, result.stderr);
		const fork = await openRuntime({ configPath: paths.globalConfig, storePath: paths.storePath, withMcp: false });
		try {
			assert.equal(fork.root.id, source.root.id);
			const history = await fork.root.entries({ order: "ascending" }, 100, undefined, fork.context);
			assert.deepEqual(history.items.find((entry) => entry.id === marker.id)?.data, { origin: "global" });
			const settled = await fork.harness.waitForTask(started.taskId, fork.context);
			assert.equal(settled.state.outcome.status, "completed");
			assert.equal((await jobRecord(source.harness, Number(started.taskId), source.context))?.state.status, before?.state.status);
		} finally {
			await fork.close();
		}
	} finally {
		await source.close();
	}
});

test("state fork never overwrites an existing local database or stale SQLite sidecars", (t) => {
	const paths = workspace(t);
	const source = sampleDatabase(paths.sourcePath);
	source.close();
	const localText = "maxTurns: 27\n";
	writeFileSync(paths.localConfig, localText);
	for (const path of [paths.storePath, `${paths.storePath}-wal`, `${paths.storePath}-shm`]) {
		writeFileSync(path, "keep existing state");
		const result = paths.run("state", "fork");
		assert.equal(result.status, 1);
		assert.match(result.stderr, /Refusing to overwrite/);
		assert.equal(readFileSync(path, "utf8"), "keep existing state");
		assert.equal(readFileSync(paths.localConfig, "utf8"), localText);
		rmSync(path);
	}
});

test("a missing or invalid source leaves local state and configuration untouched", (t) => {
	const paths = workspace(t);
	const localText = "maxTurns: 27\n";
	writeFileSync(paths.localConfig, localText);
	const missing = paths.run("state", "fork");
	assert.equal(missing.status, 1);
	assert.match(missing.stderr, /Source state does not exist/);
	assert.equal(existsSync(paths.sourcePath), false);
	writeFileSync(paths.sourcePath, "not a SQLite database");
	assert.equal(paths.run("state", "fork").status, 1);
	assert.equal(existsSync(paths.storePath), false);
	assert.equal(readFileSync(paths.localConfig, "utf8"), localText);
	assert.deepEqual(readdirSync(join(paths.cwd, ".durable-chat")), ["config.yaml"]);
});

test("state fork accepts an explicit source and refuses to copy an already selected local store onto itself", (t) => {
	const paths = workspace(t);
	const source = sampleDatabase(paths.sourcePath);
	source.close();
	writeFileSync(paths.localConfig, "store: ./missing-project.sqlite\n");
	assert.equal(paths.run("state", "fork", "--store", paths.sourcePath).status, 0);
	const before = readFileSync(paths.storePath);
	const config = readFileSync(paths.localConfig);
	const repeated = paths.run("state", "fork");
	assert.equal(repeated.status, 1);
	assert.match(repeated.stderr, /already folder-local/);
	assert.deepEqual(readFileSync(paths.storePath), before);
	assert.deepEqual(readFileSync(paths.localConfig), config);
});
