import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWorkspace, planWorkspace } from "../src/workspaces.ts";

function repository(t: TestContext) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "dchat-workspaces-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-C", dir, ...args], { encoding: "utf8", timeout: 15_000 }).trimEnd();
	git("init", "-q");
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.invalid");
	git("config", "commit.gpgSign", "false");
	git("config", "core.hooksPath", "/dev/null");
	mkdirSync(join(dir, "src"));
	writeFileSync(join(dir, "src/base.txt"), "prepared base\n");
	writeFileSync(join(dir, ".gitignore"), "ignored-local/\n");
	git("add", ".");
	git("commit", "-qm", "prepared base");
	return { dir, git };
}

test("worktree planning rejects tracked and untracked dirt without committing or changing the source", async (t) => {
	const { dir, git } = repository(t);
	const base = git("rev-parse", "HEAD");
	writeFileSync(join(dir, "src/base.txt"), "unfinished edit\n");
	await assert.rejects(planWorkspace(dir, "worktree"), /clean source checkout/);
	assert.equal(readFileSync(join(dir, "src/base.txt"), "utf8"), "unfinished edit\n");
	writeFileSync(join(dir, "src/base.txt"), "prepared base\n");
	writeFileSync(join(dir, "untracked.txt"), "retain this file\n");
	await assert.rejects(planWorkspace(dir, "worktree"), /clean source checkout/);
	assert.equal(git("rev-parse", "HEAD"), base);
	assert.equal(readFileSync(join(dir, "untracked.txt"), "utf8"), "retain this file\n");
	assert.deepEqual(await planWorkspace(dir, "shared"), { kind: "shared", cwd: dir });
});

test("worktrees use the recorded base and source subdirectory while excluding ignored local files", async (t) => {
	const { dir, git } = repository(t);
	mkdirSync(join(dir, "ignored-local"));
	writeFileSync(join(dir, "ignored-local/secret.txt"), "local credential\n");
	const workspace = await planWorkspace(join(dir, "src"), "worktree");
	assert.equal(workspace.kind, "worktree");
	if (workspace.kind !== "worktree") return;
	writeFileSync(join(dir, "src/base.txt"), "later source commit\n");
	git("add", "src/base.txt");
	git("commit", "-qm", "source moves ahead");
	await ensureWorkspace(workspace);
	assert.equal(workspace.cwd, join(workspace.path, "src"));
	assert.equal(readFileSync(join(workspace.cwd, "base.txt"), "utf8"), "prepared base\n");
	assert.equal(existsSync(join(workspace.path, "ignored-local/secret.txt")), false);
	writeFileSync(join(workspace.cwd, "variant.txt"), "unfinished variant\n");
	await ensureWorkspace(workspace);
	assert.equal(readFileSync(join(workspace.cwd, "variant.txt"), "utf8"), "unfinished variant\n");
	assert.equal(existsSync(join(dir, "src/variant.txt")), false);
});

test("worktree recovery reuses an interrupted branch creation and preserves later commits", async (t) => {
	const { dir, git } = repository(t);
	const workspace = await planWorkspace(dir, "worktree");
	if (workspace.kind !== "worktree") throw new Error("Expected worktree plan");
	git("branch", workspace.branch, workspace.baseCommit);
	await ensureWorkspace(workspace);
	writeFileSync(join(workspace.cwd, "variant.txt"), "variant commit\n");
	execFileSync("git", ["-C", workspace.cwd, "add", "variant.txt"], { timeout: 15_000 });
	execFileSync("git", ["-C", workspace.cwd, "commit", "-qm", "variant result"], { timeout: 15_000 });
	const tip = git("rev-parse", workspace.branch);
	await ensureWorkspace(workspace);
	assert.equal(git("rev-parse", workspace.branch), tip);
	assert.notEqual(tip, workspace.baseCommit);
	git("worktree", "lock", workspace.path);
	await assert.rejects(ensureWorkspace(workspace), /locked or setup is incomplete/);
	assert.equal(git("rev-parse", workspace.branch), tip);
	git("worktree", "unlock", workspace.path);
	const moved = `${workspace.path}-retained`;
	renameSync(workspace.path, moved);
	await assert.rejects(ensureWorkspace(workspace), /missing or incomplete/);
	assert.equal(readFileSync(join(moved, "variant.txt"), "utf8"), "variant commit\n");
});

test("worktree recovery refuses a changed branch without a registered workspace", async (t) => {
	const { dir, git } = repository(t);
	const workspace = await planWorkspace(dir, "worktree");
	if (workspace.kind !== "worktree") throw new Error("Expected worktree plan");
	writeFileSync(join(dir, "src/base.txt"), "later commit\n");
	git("add", ".");
	git("commit", "-qm", "later commit");
	git("branch", workspace.branch);
	const branchTip = git("rev-parse", workspace.branch);
	await assert.rejects(ensureWorkspace(workspace), /Refusing to reuse a modified branch/);
	assert.equal(git("rev-parse", workspace.branch), branchTip);
	assert.equal(existsSync(workspace.path), false);
});
