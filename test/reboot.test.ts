import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Harness } from "@earendil-works/pi-durable";
import { acquireStoreLock, openRuntime } from "../src/harness.ts";
import type { AppRuntime } from "../src/harness.ts";
import { createJobInCommit, jobOptionsOf, scanJobs } from "../src/jobs.ts";
import { rebootClosedStore } from "../src/reboot.ts";
import { JobTags } from "../src/tags.ts";
import { installRollbackSnapshot, rollbackChoices, rollbackSource } from "../src/rollback.ts";

function temporary(t: TestContext) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "dchat-reboot-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

async function setup(t: TestContext) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "dchat-runtime-reboot-")));
	const configPath = join(dir, "config.yaml");
	writeFileSync(configPath, "provider: faux\nautoContinue: false\nmcp:\n  enabled: false\n");
	const runtimes: AppRuntime[] = [];
	const keep = (runtime: AppRuntime) => { runtimes.push(runtime); return runtime; };
	t.after(async () => {
		for (const runtime of runtimes.reverse()) await runtime.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const runtime = keep(await openRuntime({ configPath, storePath: join(dir, "store.sqlite"), withMcp: false }));
	return { dir, configPath, runtime, keep };
}

function seed(path: string, value: string): void {
	const db = new DatabaseSync(path);
	try {
		db.exec("CREATE TABLE notes (value TEXT)");
		db.prepare("INSERT INTO notes VALUES (?)").run(value);
	} finally { db.close(); }
}

function note(path: string): string {
	const db = new DatabaseSync(path, { readOnly: true });
	try { return db.prepare("SELECT value FROM notes").get()!.value as string; }
	finally { db.close(); }
}

test("reboot archives conversations and pending tagged jobs, starts empty at the same path, and retains files and the exclusive store lease", { timeout: 10_000 }, async (t) => {
	const { dir, configPath, runtime, keep } = await setup(t);
	await runtime.root.commit((tx) => tx.appendEntry(runtime.root.id, {
		kind: "app.saved-note", data: { note: "old conversation" },
		model: [{ role: "user", content: "old conversation", timestamp: 0 }],
	}), runtime.context);
	const job = await runtime.root.commit((tx) => createJobInCommit(tx, "pending review", runtime.model, runtime.jobExtensions, runtime.cwd, {
		...jobOptionsOf(runtime.config), tags: ["reviewer"],
	}), runtime.context);
	const workspace = join(dir, "retained-worktree");
	mkdirSync(workspace);
	writeFileSync(join(workspace, "variant.txt"), "retained edits");
	chmodSync(runtime.storePath, 0o600);
	const fresh = keep(await runtime.reboot());
	assert.equal(fresh.storePath, runtime.storePath);
	assert.equal(fresh.cwd, runtime.cwd);
	assert.deepEqual(fresh.model, runtime.model);
	assert.deepEqual(await scanJobs(fresh.harness, fresh.context), []);
	assert.deepEqual((await fresh.harness.snapshot(JobTags, fresh.context))?.byJob ?? {}, {});
	assert.equal((await fresh.root.entries({ order: "ascending" }, 100, undefined, fresh.context)).items.some((entry) => entry.kind === "app.saved-note"), false);
	assert.equal(readFileSync(join(workspace, "variant.txt"), "utf8"), "retained edits");
	assert.equal(statSync(fresh.storePath).mode & 0o777, 0o600, "reboot must not widen database permissions");
	const archivePath = fresh.previousStateArchive!;
	assert.ok(existsSync(archivePath));
	assert.equal(existsSync(archivePath + "-wal"), false);
	assert.equal(existsSync(archivePath + "-shm"), false);
	// Closing the old object must not drop the lease transferred to the fresh runtime.
	await runtime.close();
	assert.throws(() => acquireStoreLock(fresh.storePath), /already open/);
	const archived = keep(await openRuntime({ configPath, storePath: archivePath, withMcp: false }));
	const archivedJobs = await scanJobs(archived.harness, archived.context);
	assert.equal(archivedJobs.length, 1);
	assert.equal(archivedJobs[0]!.id, job.taskId);
	assert.equal(archivedJobs[0]!.state.status, "pending");
	assert.deepEqual(archivedJobs[0]!.tags, ["reviewer"]);
	assert.ok((await archived.root.entries({ order: "ascending" }, 100, undefined, archived.context)).items.some((entry) => entry.kind === "app.saved-note"));
	await fresh.close();
	const reopened = keep(await openRuntime({ configPath, storePath: fresh.storePath, withMcp: false }));
	assert.equal(reopened.previousStateArchive, archivePath);
	assert.deepEqual(await scanJobs(reopened.harness, reopened.context), []);
});

test("same-millisecond reboots create distinct archives and keep the startup configuration even if the config file changes", { timeout: 10_000 }, async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 0, 2) });
	const { configPath, runtime, keep } = await setup(t);
	writeFileSync(configPath, "provider: local\nmodel: changed-on-disk\n");
	const first = keep(await runtime.reboot());
	const second = keep(await first.reboot());
	assert.notEqual(first.previousStateArchive, second.previousStateArchive);
	assert.ok(existsSync(first.previousStateArchive!));
	assert.ok(existsSync(second.previousStateArchive!));
	assert.equal(second.config, runtime.config);
	assert.deepEqual(second.model, runtime.model);
	assert.equal(second.storePath, runtime.storePath);
	assert.equal(second.mcpAttempted, false);
});

test("reboot checkpoints committed WAL left by a crashed writer into a self-contained rollback archive", { timeout: 10_000 }, async (t) => {
	const dir = temporary(t);
	const path = join(dir, "store.sqlite");
	// A normal last-connection close checkpoints automatically; it cannot protect the crash-WAL gap.
	const crash = spawnSync(process.execPath, ["--input-type=module", "-e", `
		import { DatabaseSync } from "node:sqlite";
		const db = new DatabaseSync(process.argv[1]);
		db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE notes(value TEXT); INSERT INTO notes VALUES ('committed in WAL');");
		process.kill(process.pid, "SIGKILL");
	`, path], { timeout: 5000, encoding: "utf8" });
	assert.equal(crash.signal, "SIGKILL", crash.stderr);
	assert.ok(statSync(path + "-wal").size > 0);
	const release = acquireStoreLock(path);
	t.after(release);
	const archive = await rebootClosedStore(path, async (saved) => { seed(path, "fresh"); return saved; });
	assert.equal(note(archive), "committed in WAL");
	assert.equal(note(path), "fresh");
	assert.equal(existsSync(archive + "-wal"), false);
	assert.equal(existsSync(archive + "-shm"), false);
});

test("failed fresh startup restores the original database and preserves the partial replacement for recovery", async (t) => {
	const dir = temporary(t);
	const path = join(dir, "store.sqlite");
	seed(path, "original");
	const release = acquireStoreLock(path);
	t.after(release);
	let saved = "";
	await assert.rejects(rebootClosedStore(path, async (archive) => {
		saved = archive;
		assert.equal(note(archive), "original");
		seed(path, "partial replacement");
		throw new Error("startup failed");
	}), /original state restored/);
	assert.equal(note(path), "original");
	const directory = join(dir, readdirSync(dir).find((name) => name.startsWith("store.sqlite.reboot-"))!);
	assert.equal(note(join(directory, "failed-fresh", basename(path))), "partial replacement");
	assert.equal(existsSync(saved), false, "the original was restored, not copied over the replacement");
	assert.throws(() => acquireStoreLock(path), /already open/, "recovery leaves lease ownership with its caller");
});

test("failed native startup during reboot restores the original state and releases the lease for a normal restart", { timeout: 10_000 }, async (t) => {
	const { configPath, runtime, keep } = await setup(t);
	await runtime.root.commit((tx) => createJobInCommit(tx, "survive failed reboot", runtime.model, runtime.jobExtensions, runtime.cwd, {
		...jobOptionsOf(runtime.config), tags: ["resumable"],
	}), runtime.context);
	// The filesystem-only recovery test cannot catch storage left open before Harness.open returns.
	const failure = t.mock.method(Harness, "open", async () => { throw new Error("injected startup failure"); });
	await assert.rejects(runtime.reboot(), /original state restored/);
	failure.mock.restore();
	const restored = keep(await openRuntime({ configPath, storePath: runtime.storePath, withMcp: false }));
	const jobs = await scanJobs(restored.harness, restored.context);
	assert.equal(jobs.length, 1);
	assert.deepEqual(jobs[0]!.tags, ["resumable"]);
	assert.equal(jobs[0]!.state.status, "pending");
});

test("reboot refuses a database still held by another SQLite connection before moving or creating replacement state", async (t) => {
	const dir = temporary(t);
	const path = join(dir, "store.sqlite");
	const db = new DatabaseSync(path);
	db.exec("PRAGMA journal_mode=WAL; CREATE TABLE notes(value TEXT); INSERT INTO notes VALUES ('original')");
	let opened = false;
	try {
		await assert.rejects(rebootClosedStore(path, async () => { opened = true; }), /locked|connection/);
		assert.equal(opened, false);
		assert.equal(note(path), "original");
		assert.equal(readdirSync(dir).some((name) => name.includes(".reboot-")), false);
	} finally { db.close(); }
});

test("reboot keeps the original archive safe if a failed replacement still has SQLite connections", async (t) => {
	const dir = temporary(t);
	const path = join(dir, "store.sqlite");
	seed(path, "original");
	let leaked: DatabaseSync | undefined;
	let saved = "";
	try {
		await assert.rejects(rebootClosedStore(path, async (archive) => {
			saved = archive;
			leaked = new DatabaseSync(path);
			leaked.exec("PRAGMA journal_mode=WAL; CREATE TABLE partial(value TEXT)");
			throw new Error("startup failed before closing");
		}), /Reboot and recovery failed/);
		assert.equal(note(saved), "original");
		assert.ok(existsSync(path), "do not rename a replacement with an uncertain connection lifetime");
	} finally { leaked?.close(); }
});

test("rollback restores archived conversations and tagged jobs at the active path while preserving both source and current state", { timeout: 10_000 }, async (t) => {
	const { configPath, runtime, keep } = await setup(t);
	await runtime.root.commit((tx) => tx.appendEntry(runtime.root.id, {
		kind: "app.before-reboot", data: { note: "old context" },
	}), runtime.context);
	await runtime.root.commit((tx) => createJobInCommit(tx, "old review", runtime.model, runtime.jobExtensions, runtime.cwd, {
		...jobOptionsOf(runtime.config), tags: ["old"],
	}), runtime.context);
	const current = keep(await runtime.reboot());
	const source = current.previousStateArchive!;
	const untouched = readFileSync(source);
	assert.equal(rollbackChoices(current.storePath, source)[0], source);
	assert.equal(rollbackSource("1", [source], current.storePath), source);
	await current.root.commit((tx) => tx.appendEntry(current.root.id, {
		kind: "app.after-reboot", data: { note: "new context" },
	}), current.context);
	await current.root.commit((tx) => createJobInCommit(tx, "new review", current.model, current.jobExtensions, current.cwd, {
		...jobOptionsOf(current.config), tags: ["new"],
	}), current.context);
	const restored = keep(await current.rollback(source));
	assert.equal(restored.storePath, current.storePath);
	assert.equal(restored.restoredFrom, source);
	assert.notEqual(restored.previousStateArchive, source);
	assert.ok(readFileSync(source).equals(untouched), "selected archive must remain unchanged");
	const jobs = await scanJobs(restored.harness, restored.context);
	assert.equal(jobs.length, 1);
	assert.deepEqual(jobs[0]!.tags, ["old"]);
	const entries = (await restored.root.entries({ order: "ascending" }, 100, undefined, restored.context)).items;
	assert.ok(entries.some((entry) => entry.kind === "app.before-reboot"));
	assert.equal(entries.some((entry) => entry.kind === "app.after-reboot"), false);
	const savedCurrent = keep(await openRuntime({ configPath, storePath: restored.previousStateArchive!, withMcp: false }));
	assert.deepEqual((await scanJobs(savedCurrent.harness, savedCurrent.context))[0]!.tags, ["new"]);
	assert.ok((await savedCurrent.root.entries({ order: "ascending" }, 100, undefined, savedCurrent.context)).items.some((entry) => entry.kind === "app.after-reboot"));
	await current.close();
	assert.throws(() => acquireStoreLock(restored.storePath), /already open/);
	await restored.close();
	const reopened = keep(await openRuntime({ configPath, storePath: restored.storePath, withMcp: false }));
	assert.equal(reopened.restoredFrom, source);
	assert.equal(reopened.previousStateArchive, restored.previousStateArchive);
});

test("rollback rejects the current database or a source owned by another runtime before closing current state", { timeout: 10_000 }, async (t) => {
	const { configPath, dir, runtime, keep } = await setup(t);
	await assert.rejects(runtime.rollback(runtime.storePath), /already the current/);
	const other = keep(await openRuntime({ configPath, storePath: join(dir, "other.sqlite"), withMcp: false }));
	await assert.rejects(runtime.rollback(other.storePath), /already open/);
	assert.deepEqual(rollbackChoices(runtime.storePath), []);
	await runtime.root.commit((tx) => tx.appendEntry(runtime.root.id, { kind: "app.still-open", data: {} }), runtime.context);
	assert.ok((await runtime.root.entries({ order: "ascending" }, 100, undefined, runtime.context)).items.some((entry) => entry.kind === "app.still-open"));
});

test("an unreadable rollback database restores current state and releases both source and active leases", { timeout: 10_000 }, async (t) => {
	const { configPath, dir, runtime, keep } = await setup(t);
	await runtime.root.commit((tx) => createJobInCommit(tx, "keep current job", runtime.model, runtime.jobExtensions, runtime.cwd, {
		...jobOptionsOf(runtime.config), tags: ["current"],
	}), runtime.context);
	const bad = join(dir, "invalid.sqlite");
	writeFileSync(bad, "not a SQLite database");
	await assert.rejects(runtime.rollback(bad), /Rollback failed; original state restored/);
	assert.equal(readFileSync(bad, "utf8"), "not a SQLite database");
	assert.equal(existsSync(bad + ".lock"), false);
	const restored = keep(await openRuntime({ configPath, storePath: runtime.storePath, withMcp: false }));
	assert.deepEqual((await scanJobs(restored.harness, restored.context))[0]!.tags, ["current"]);
});

test("rollback copies committed source WAL without changing the selected file and preserves active database permissions", { timeout: 10_000 }, async (t) => {
	const dir = temporary(t);
	const source = join(dir, "source.sqlite");
	const target = join(dir, "active.sqlite");
	// Reboot checkpoints its input in place; rollback must instead read the source WAL without altering it.
	const crash = spawnSync(process.execPath, ["--input-type=module", "-e", `
		import { DatabaseSync } from "node:sqlite";
		const db = new DatabaseSync(process.argv[1]);
		db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE notes(value TEXT); INSERT INTO notes VALUES ('rollback WAL');");
		process.kill(process.pid, "SIGKILL");
	`, source], { timeout: 5000, encoding: "utf8" });
	assert.equal(crash.signal, "SIGKILL", crash.stderr);
	const before = readFileSync(source);
	const wal = readFileSync(source + "-wal");
	seed(target, "current");
	chmodSync(target, 0o600);
	const release = acquireStoreLock(target);
	t.after(release);
	const archive = await rebootClosedStore(target, async (saved) => {
		installRollbackSnapshot(source, target);
		return saved;
	}, "Rollback");
	assert.equal(note(target), "rollback WAL");
	assert.equal(note(archive), "current");
	assert.ok(readFileSync(source).equals(before));
	assert.ok(readFileSync(source + "-wal").equals(wal));
	assert.equal(statSync(target).mode & 0o777, 0o600);
});

test("reboot refuses symlink and hard-link database aliases without altering their data", async (t) => {
	const dir = temporary(t);
	const original = join(dir, "original.sqlite");
	seed(original, "retained");
	const symbolic = join(dir, "symbolic.sqlite");
	const hard = join(dir, "hard.sqlite");
	symlinkSync(original, symbolic);
	linkSync(original, hard);
	for (const path of [symbolic, hard]) {
		await assert.rejects(rebootClosedStore(path, async () => assert.fail("must not open fresh state")), /regular database file/);
	}
	assert.equal(note(original), "retained");
	assert.equal(note(symbolic), "retained");
	assert.equal(note(hard), "retained");
});
