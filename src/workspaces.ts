import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { defineDoc } from "@earendil-works/pi-durable";
import type { EnvTarget } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

const exec = promisify(execFile);

export type JobWorkspace = { kind: "shared"; cwd: string } | {
	kind: "worktree";
	repository: string;
	gitDirectory: string;
	baseCommit: string;
	path: string;
	branch: string;
	cwd: string;
};

/** Conversation-scoped so the workspace assignment outlives a completed job task. */
export const JobWorkspaceDoc = defineDoc<{ workspace?: JobWorkspace }>({
	kind: "durable-chat.workspace", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({}), checkpointWhen: () => false,
});

export async function jobEnvironment(target: EnvTarget, context: Context, fallback: string): Promise<NodeExecutionEnv> {
	const assignment = await target.read.snapshot(JobWorkspaceDoc, target.conversationId, context);
	if (assignment?.workspace !== undefined) {
		if (target.cwd !== assignment.workspace.cwd) throw new Error("The job cwd differs from its saved workspace assignment.");
		await ensureWorkspace(assignment.workspace, context.abortSignal);
	}
	return new NodeExecutionEnv({ cwd: target.cwd ?? fallback });
}

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
	const result = await exec("git", ["-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], {
		encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 120_000,
		env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))), GIT_OPTIONAL_LOCKS: "0" },
		...(signal === undefined ? {} : { signal }),
	});
	return result.stdout.replace(/\r?\n$/, "");
}

/** Read-only planning. The durable job stores this plan before any worktree is created. */
export async function planWorkspace(cwd: string, kind: "shared" | "worktree", signal?: AbortSignal): Promise<JobWorkspace> {
	const directory = await realpath(cwd);
	if (!(await stat(directory)).isDirectory()) throw new Error(`Workspace is not a directory: ${cwd}`);
	if (kind === "shared") return { kind, cwd: directory };
	const repository = await realpath(await git(directory, ["rev-parse", "--show-toplevel"], signal));
	const baseCommit = await git(repository, ["rev-parse", "HEAD^{commit}"], signal);
	if ((await git(repository, ["status", "--porcelain=v1", "--untracked-files=normal", "--ignore-submodules=none"], signal)).length > 0) {
		throw new Error("Worktree forks require a clean source checkout, including untracked files. Commit the intended base or select a shared workspace.");
	}
	if (await git(repository, ["rev-parse", "HEAD^{commit}"], signal) !== baseCommit) throw new Error("Source HEAD changed while planning the worktree; retry.");
	const subdirectory = relative(repository, directory);
	if (isAbsolute(subdirectory) || subdirectory === ".." || subdirectory.startsWith("../")) throw new Error("The source directory is outside its Git repository.");
	const common = await realpath(resolve(repository, await git(repository, ["rev-parse", "--git-common-dir"], signal)));
	const token = randomUUID();
	const path = join(common, "dchat-worktrees", token);
	return { kind, repository, gitDirectory: common, baseCommit, path, branch: `dchat/${token}`, cwd: join(path, subdirectory) };
}

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function registered(workspace: Extract<JobWorkspace, { kind: "worktree" }>, signal?: AbortSignal): Promise<boolean> {
	const listing = await git(workspace.gitDirectory, ["worktree", "list", "--porcelain", "-z"], signal);
	for (const block of listing.split("\0\0")) {
		const fields = block.split("\0");
		if (!fields.includes(`worktree ${workspace.path}`)) continue;
		if (fields.some((field) => field === "locked" || field.startsWith("locked "))) throw new Error(`The saved worktree is locked or setup is incomplete: ${workspace.path}. Inspect it before continuing.`);
		if (!fields.includes(`branch refs/heads/${workspace.branch}`)) throw new Error(`Worktree branch differs from its saved job assignment: ${workspace.path}`);
		if (fields.some((field) => field.startsWith("prunable")) || !(await exists(workspace.cwd))) {
			throw new Error(`The saved worktree is missing or incomplete: ${workspace.path}. Restore it before continuing this job.`);
		}
		const root = await realpath(await git(workspace.cwd, ["rev-parse", "--show-toplevel"], signal));
		const common = await realpath(resolve(workspace.cwd, await git(workspace.cwd, ["rev-parse", "--git-common-dir"], signal)));
		if (root !== workspace.path || common !== workspace.gitDirectory) throw new Error(`The saved job directory belongs to another repository: ${workspace.cwd}`);
		return true;
	}
	return false;
}

/** Reconcile an interrupted setup without resetting, deleting, or overwriting any existing work. */
export async function ensureWorkspace(workspace: JobWorkspace, signal?: AbortSignal): Promise<void> {
	if (workspace.kind === "shared") {
		if (!(await stat(workspace.cwd)).isDirectory()) throw new Error(`Shared workspace is not a directory: ${workspace.cwd}`);
		return;
	}
	if (await registered(workspace, signal)) return;
	if (await exists(workspace.path)) throw new Error(`Refusing to overwrite an unregistered worktree directory: ${workspace.path}`);
	const branches = await git(workspace.gitDirectory, ["for-each-ref", "--format=%(refname)", `refs/heads/${workspace.branch}`], signal);
	if (branches.length > 0 && await git(workspace.gitDirectory, ["rev-parse", `refs/heads/${workspace.branch}`], signal) !== workspace.baseCommit) {
		throw new Error(`Refusing to reuse a modified branch without its saved worktree: ${workspace.branch}`);
	}
	await mkdir(resolve(workspace.path, ".."), { recursive: true });
	await git(workspace.gitDirectory, branches.length > 0
		? ["worktree", "add", "--", workspace.path, workspace.branch]
		: ["worktree", "add", "-b", workspace.branch, "--", workspace.path, workspace.baseCommit], signal);
	if (!(await registered(workspace, signal))) throw new Error(`Git did not register the assigned worktree: ${workspace.path}`);
}
