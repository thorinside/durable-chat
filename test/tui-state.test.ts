import { test } from "node:test";
import assert from "node:assert/strict";
import type { TaskGraphNode } from "@earendil-works/pi-durable";
import type { AnyTaskRecord } from "../src/format.ts";
import { JOB_KIND } from "../src/tasks.ts";
import { buildJobRows, clampScroll, filterJobs, moveSelection, nextFocus, reconcileJobSelection, toggleTarget } from "../src/tui/state.ts";

function record(id: number, brief: string, terminal: "completed" | "failed" | undefined): AnyTaskRecord {
	return {
		id,
		kind: JOB_KIND,
		input: { brief },
		state: terminal === undefined
			? { status: "running", checkpoint: { phase: "run" } }
			: {
				status: "terminal",
				outcome: terminal === "completed"
					? { status: "completed", result: { conversationId: 10 + id, brief, status: "answered" } }
					: { status: "failed", error: { message: "boom" }, result: { conversationId: 10 + id, brief, status: "unanswered" } },
			},
	} as unknown as AnyTaskRecord;
}

function node(id: number, kind: string, status: "running" | "waiting"): TaskGraphNode {
	return {
		id,
		kind,
		conversationId: 1,
		background: true,
		abortRequested: false,
		conversations: [],
		state: status === "running" ? { status, phase: "run" } : { status, phase: "run", on: [], policy: "allSettled" },
	} as unknown as TaskGraphNode;
}

test("job rows put live jobs first and ignore internal graph tasks", () => {
	const rows = buildJobRows(
		[record(3, "finished old", "completed"), record(2, "finished new", "failed")],
		[node(2, JOB_KIND, "running"), node(9, "pi.generation", "running"), node(4, JOB_KIND, "waiting")],
	);
	assert.deepEqual(rows.map((row) => row.id), [2, 4, 3]);
	assert.equal(rows[0]?.status, "running");
	assert.equal(rows[1]?.status, "waiting");
	assert.equal(rows[2]?.status, "completed");
});

test("job filtering matches id, brief, and status and can hide finished jobs", () => {
	const rows = buildJobRows(
		[record(3, "alpha docs", "completed"), record(4, "beta tests", "completed")],
		[node(7, JOB_KIND, "running")],
	);
	assert.deepEqual(filterJobs(rows, "alpha", true).map((row) => row.id), [3]);
	assert.deepEqual(filterJobs(rows, "7", true).map((row) => row.id), [7]);
	assert.deepEqual(filterJobs(rows, "running", true).map((row) => row.id), [7]);
	assert.deepEqual(filterJobs(rows, "", false).map((row) => row.id), [7]);
});

test("focus cycles through composer, jobs, and transcript in both directions", () => {
	assert.equal(nextFocus("composer"), "jobs");
	assert.equal(nextFocus("jobs"), "transcript");
	assert.equal(nextFocus("transcript"), "composer");
	assert.equal(nextFocus("composer", true), "transcript");
	assert.equal(toggleTarget({ kind: "main" }, 13).kind, "job");
	assert.deepEqual(toggleTarget({ kind: "job", id: 13 }, 14), { kind: "main" });
});

test("the main target follows the newest visible job without changing pinned-job selection", () => {
	const previous = buildJobRows([], [node(3, JOB_KIND, "running")]);
	const current = buildJobRows([record(8, "latest completed", "completed")], [node(3, JOB_KIND, "running"), node(7, JOB_KIND, "running")]);
	assert.equal(reconcileJobSelection(previous, [], { kind: "main" }, undefined), 3);
	assert.equal(reconcileJobSelection(current, previous, { kind: "main" }, 3), 8);
	assert.equal(reconcileJobSelection(current, previous, { kind: "job", id: 3 }, 3), 3);
	assert.equal(reconcileJobSelection(current, [], { kind: "main" }, 3), 8);
});

test("manual job browsing survives status refreshes and newest-job following respects the visible filter", () => {
	const rows = buildJobRows([record(8, "latest completed", "completed")], [node(3, JOB_KIND, "running"), node(7, JOB_KIND, "running")]);
	assert.equal(reconcileJobSelection(rows, rows, { kind: "main" }, 3), 3);
	const visible = filterJobs(rows, "", false);
	assert.equal(reconcileJobSelection(visible, rows, { kind: "main" }, 8), 7);
	assert.equal(reconcileJobSelection([], rows, { kind: "main" }, 8), undefined);
});

test("fork lineage and workspace assignment survive live task overlays and can be filtered", () => {
	const original = record(11, "variant A", undefined);
	const fork = { conversationId: 4, entryId: 8, jobId: 3 };
	const workspace = { kind: "worktree" as const, cwd: "/tmp/variant-a", path: "/tmp/variant-a", repository: "/tmp/source", gitDirectory: "/tmp/source/.git", branch: "dchat/variant-a", baseCommit: "abc123" };
	const rows = buildJobRows([{ ...original, tags: ["reviewer"], input: { brief: "variant A", fork, workspace } }], [node(11, JOB_KIND, "running")]);
	assert.deepEqual(rows[0]?.fork, fork);
	assert.deepEqual(rows[0]?.workspace, workspace);
	assert.deepEqual(rows[0]?.tags, ["reviewer"]);
	assert.equal(filterJobs(rows, "reviewer", true).length, 1);
	assert.equal(filterJobs(rows, "fork #3", true).length, 1);
	assert.equal(filterJobs(rows, "dchat/variant-a", true).length, 1);
});

test("selection movement clamps at both ends", () => {
	const rows = buildJobRows([record(1, "one", "completed"), record(2, "two", "completed")], [node(3, JOB_KIND, "running")]);
	assert.equal(moveSelection(rows, undefined, 1), 3);
	assert.equal(moveSelection(rows, 3, -1), 3);
	assert.equal(moveSelection(rows, 3, 1), 2);
	assert.equal(moveSelection(rows, 1, 1), 1);
	assert.equal(clampScroll(999, 100, 20), 80);
	assert.equal(clampScroll(-5, 100, 20), 0);
});
