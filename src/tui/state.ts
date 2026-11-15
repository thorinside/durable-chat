import type { TaskGraphNode } from "@earendil-works/pi-durable";
import { jobView, type AnyTaskRecord } from "../format.ts";
import { JOB_KIND, type ForkOrigin } from "../tasks.ts";
import type { JobWorkspace } from "../workspaces.ts";

export type Focus = "composer" | "jobs" | "transcript";

export type Target = { kind: "main" } | { kind: "job"; id: number };

export type UiMode =
	| "chat"
	| "newJob"
	| "compact"
	| "reset"
	| "rollback"
	| "model"
	| "filter"
	| "confirmCancel"
	| "confirmReset"
	| "confirmQuit"
	| "confirmReboot"
	| "confirmRollback"
	| "confirmAbortMain"
	| "help"
	| "inspector";

export type JobRow = {
	id: number;
	brief: string;
	status: string;
	live: boolean;
	blocked?: string;
	conversationId?: number;
	answer?: string;
	startedAt?: number;
	endedAt?: number;
	error?: string;
	fork?: ForkOrigin;
	workspace?: JobWorkspace;
	tags?: readonly string[];
};

/** Merge durable job records with the live task graph, then sort live first and finished newest first. */
export function buildJobRows(
	records: readonly AnyTaskRecord[],
	nodes: readonly TaskGraphNode[],
): JobRow[] {
	const byId = new Map<number, JobRow>();
	for (const record of records) {
		const view = jobView(record);
		byId.set(view.id, {
			id: view.id,
			brief: view.brief,
			status: view.status,
			live: false,
			tags: view.tags,
			...(view.fork === undefined ? {} : { fork: view.fork }),
			...(view.workspace === undefined ? {} : { workspace: view.workspace }),
			...(view.conversationId === undefined ? {} : { conversationId: view.conversationId }),
			...(view.answer === undefined ? {} : { answer: view.answer }),
			...(view.startedAt === undefined ? {} : { startedAt: view.startedAt }),
			...(view.endedAt === undefined ? {} : { endedAt: view.endedAt }),
			...(view.reason === undefined ? {} : { error: view.reason }),
		});
	}
	for (const node of nodes) {
		if (node.kind !== JOB_KIND) continue;
		const id = Number(node.id);
		const existing = byId.get(id);
		byId.set(id, {
			id,
			brief: existing?.brief ?? "(starting)",
			status: node.blocked === undefined ? node.state.status : `blocked: ${node.blocked}`,
			live: true,
			tags: existing?.tags ?? [],
			...(existing?.fork === undefined ? {} : { fork: existing.fork }),
			...(existing?.workspace === undefined ? {} : { workspace: existing.workspace }),
			...(node.blocked === undefined ? {} : { blocked: node.blocked }),
			...(existing?.conversationId === undefined ? {} : { conversationId: existing.conversationId }),
			...(existing?.startedAt === undefined ? {} : { startedAt: existing.startedAt }),
		});
	}
	const rows = [...byId.values()];
	const live = rows.filter((row) => row.live).sort((a, b) => a.id - b.id);
	const finished = rows.filter((row) => !row.live).sort((a, b) => b.id - a.id);
	return [...live, ...finished];
}

export function filterJobs(rows: readonly JobRow[], query: string, showFinished: boolean): JobRow[] {
	const needle = query.trim().toLowerCase();
	return rows.filter((row) => {
		if (!showFinished && !row.live) return false;
		if (needle.length === 0) return true;
		return String(row.id).includes(needle)
			|| row.brief.toLowerCase().includes(needle)
			|| row.status.toLowerCase().includes(needle)
			|| (row.tags?.some((tag) => tag.includes(needle)) ?? false)
			|| (row.fork !== undefined && `fork ${row.fork.jobId === undefined ? "main" : `#${row.fork.jobId}`}`.includes(needle))
			|| (row.workspace?.cwd.toLowerCase().includes(needle) ?? false)
			|| (row.workspace?.kind === "worktree" && row.workspace.branch.toLowerCase().includes(needle));
	});
}

/** Follow new arrivals on main, but preserve manual browsing between arrivals and pinned-job selection. */
export function reconcileJobSelection(
	rows: readonly JobRow[],
	previousRows: readonly JobRow[],
	target: Target,
	selectedId: number | undefined,
): number | undefined {
	const newest = rows.reduce<number | undefined>((id, row) => id === undefined || row.id > id ? row.id : id, undefined);
	const previousNewest = previousRows.reduce<number | undefined>((id, row) => id === undefined || row.id > id ? row.id : id, undefined);
	if (target.kind === "main" && newest !== undefined && (previousNewest === undefined || newest > previousNewest)) return newest;
	if (rows.some((row) => row.id === selectedId)) return selectedId;
	return target.kind === "main" ? newest : rows[0]?.id;
}

export function moveSelection(rows: readonly JobRow[], selectedId: number | undefined, delta: number): number | undefined {
	if (rows.length === 0) return undefined;
	const current = rows.findIndex((row) => row.id === selectedId);
	const next = current === -1 ? 0 : Math.max(0, Math.min(rows.length - 1, current + delta));
	return rows[next]?.id;
}

export function nextFocus(focus: Focus, backwards = false): Focus {
	const order: Focus[] = ["composer", "jobs", "transcript"];
	const index = order.indexOf(focus);
	return order[(index + (backwards ? order.length - 1 : 1)) % order.length]!;
}

/** Toggle main/job target. `preferredJobId` is the highlighted row, used when the target is main. */
export function toggleTarget(target: Target, preferredJobId: number | undefined): Target {
	if (target.kind === "job") return { kind: "main" };
	if (preferredJobId !== undefined) return { kind: "job", id: preferredJobId };
	return { kind: "main" };
}

export function targetLabel(target: Target): string {
	return target.kind === "main" ? "main" : `job #${target.id}`;
}

export function clampScroll(offset: number, totalLines: number, height: number): number {
	const max = Math.max(0, totalLines - height);
	return Math.max(0, Math.min(offset, max));
}
