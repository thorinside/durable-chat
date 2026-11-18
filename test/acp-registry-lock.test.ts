import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRegistryLock } from "../src/acp-registry-lock.ts";

function fixture(t: import("node:test").TestContext): string {
	const directory = mkdtempSync(join(tmpdir(), "dchat-registry-mutex-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

test("registry release closes only its connection and never deletes a replacement owner's inode", (t) => {
	const directory = fixture(t);
	const path = join(directory, "registry-lock.sqlite");
	const releaseA = acquireRegistryLock(directory);
	t.after(releaseA);
	const original = lstatSync(path);
	// External replacement is not a supported admission protocol. Even if it
	// happens, a delayed old release must not unlink or unlock the new owner.
	renameSync(path, join(directory, "retired.sqlite"));
	const releaseB = acquireRegistryLock(directory);
	t.after(releaseB);
	const replacement = lstatSync(path);
	assert.notEqual(original.ino, replacement.ino);
	releaseA();
	releaseA();
	assert.equal(lstatSync(path).ino, replacement.ino);
	assert.throws(() => acquireRegistryLock(directory), /already open/);
	releaseB();
	const releaseC = acquireRegistryLock(directory);
	releaseB();
	assert.throws(() => acquireRegistryLock(directory), /already open/, "a repeated old release cannot unlock C");
	releaseC();
	assert.equal(lstatSync(path).ino, replacement.ino, "the mutex inode is permanent across owners");
});

test("legacy partial, malformed, live or dead PID registry markers fail closed rather than guessing staleness", (t) => {
	const directory = fixture(t);
	const path = join(directory, "registry.lock");
	for (const marker of ["", "{", JSON.stringify({ pid: process.pid }), JSON.stringify({ pid: 2147483647 }), JSON.stringify({ pid: -1 })]) {
		writeFileSync(path, marker);
		assert.throws(() => acquireRegistryLock(directory), /Legacy ACP registry.lock/);
		assert.equal(readFileSync(path, "utf8"), marker);
	}
});

test("registry mutex rejects malformed database state and symlinks without reclaiming them", (t) => {
	const directory = fixture(t);
	const path = join(directory, "registry-lock.sqlite");
	writeFileSync(path, "{partial or invalid owner state", { mode: 0o600 });
	assert.throws(() => acquireRegistryLock(directory));
	assert.equal(readFileSync(path, "utf8"), "{partial or invalid owner state");
	rmSync(path);
	const target = join(directory, "target");
	writeFileSync(target, "", { mode: 0o600 });
	symlinkSync(target, path);
	assert.throws(() => acquireRegistryLock(directory), /Unsafe ACP registry mutex/);
	assert.equal(readFileSync(target, "utf8"), "");
});
