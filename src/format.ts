import type { TaskRecord } from "@earendil-works/pi-durable";
import type { ForkOrigin } from "./tasks.ts";
import type { JobWorkspace } from "./workspaces.ts";

export type AnyTaskRecord = TaskRecord<unknown, unknown, unknown> & { readonly tags?: readonly string[] };

export type JobView = {
	id: number;
	brief: string;
	status: string;
	conversationId?: number;
	answer?: string;
	reason?: string;
	handoff?: { target: "job" | "main"; id?: number };
	abortRequested: boolean;
	startedAt?: number;
	endedAt?: number;
	fork?: ForkOrigin;
	workspace?: JobWorkspace;
	tags: readonly string[];
};

function asObject(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

export function jobInput(record: AnyTaskRecord): { brief: string } {
	const input = asObject(record.input);
	return { brief: typeof input?.brief === "string" ? input.brief : "(no brief)" };
}

export function jobView(record: AnyTaskRecord): JobView {
	const state = asObject(record.state);
	const checkpoint = asObject(state?.checkpoint);
	const outcome = asObject(state?.outcome);
	const result = asObject(outcome?.result);
	const status = typeof state?.status === "string" ? state.status : "unknown";
	let display = status;
	let answer: string | undefined;
	let reason: string | undefined;
	let conversationId: number | undefined;
	let handoff: { target: "job" | "main"; id?: number } | undefined;

	if (status === "running" && checkpoint?.phase === "report") display = "reporting";
	if (status === "running" && typeof checkpoint?.phase === "string" && checkpoint.phase.startsWith("handoff")) display = "handing off";
	if (status === "terminal" && outcome !== undefined) {
		display = String(outcome.status);
		const failure = asObject(outcome.error);
		reason = typeof failure?.message === "string"
			? failure.message
			: typeof outcome.reason === "string" ? outcome.reason : undefined;
	}
	if (typeof result?.answer === "string") answer = result.answer;
	if (typeof result?.reason === "string") reason = reason ?? result.reason;
	const rawHandoff = asObject(result?.handoff);
	if (result?.status === "handed_off" && (rawHandoff?.target === "job" || rawHandoff?.target === "main")) {
		const id = typeof rawHandoff.id === "number" ? rawHandoff.id : undefined;
		handoff = { target: rawHandoff.target, ...(id === undefined ? {} : { id }) };
		display = handoff.target === "main" ? "handed off → main" : `handed off → #${id ?? "?"}`;
	}
	const input = asObject(record.input);
	const origin = asObject(input?.fork);
	const fork = origin !== undefined && typeof origin.conversationId === "number" && typeof origin.entryId === "number"
		? { conversationId: origin.conversationId, entryId: origin.entryId, ...(typeof origin.jobId === "number" ? { jobId: origin.jobId } : {}) }
		: undefined;
	const rawWorkspace = asObject(input?.workspace);
	const workspace = rawWorkspace !== undefined && typeof rawWorkspace.cwd === "string" &&
		(rawWorkspace.kind === "shared" || (rawWorkspace.kind === "worktree" &&
			["repository", "gitDirectory", "baseCommit", "path", "branch"].every((key) => typeof rawWorkspace[key] === "string")))
		? rawWorkspace as JobWorkspace : undefined;
	const rawConversation = result?.conversationId;
	if (typeof rawConversation === "number" && rawConversation > 0) conversationId = rawConversation;
	if (record.abortRequested && status !== "terminal") display = `${display} (abort requested)`;
	return {
		id: Number(record.id),
		brief: jobInput(record).brief,
		tags: record.tags ?? [],
		status: display,
		...(conversationId === undefined ? {} : { conversationId }),
		...(answer === undefined ? {} : { answer }),
		...(reason === undefined ? {} : { reason }),
		...(handoff === undefined ? {} : { handoff }),
		abortRequested: record.abortRequested,
		...(fork === undefined ? {} : { fork }),
		...(workspace === undefined ? {} : { workspace }),
		...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
		...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
	};
}

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "?";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function age(view: JobView, now: number): string {
	return formatDuration(Math.max(0, (view.endedAt ?? now) - (view.startedAt ?? now)));
}

export function truncate(text: string, width: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= width ? flat : `${flat.slice(0, Math.max(0, width - 1))}…`;
}

export function formatJobRow(record: AnyTaskRecord, now: number): string {
	const view = jobView(record);
	const id = `#${view.id}`.padEnd(5);
	const status = truncate(view.status, 18).padEnd(18);
	const label = view.fork === undefined ? view.brief : `fork ${view.fork.jobId === undefined ? "main" : `#${view.fork.jobId}`} · ${view.brief}`;
	const brief = truncate(`${view.tags.length === 0 ? "" : `[${view.tags.join(", ")}] `}${label}`, 52).padEnd(54);
	return `${id}${status}${brief}${age(view, now)}`;
}

export function formatJobList(records: readonly AnyTaskRecord[], now: number): string {
	if (records.length === 0) {
		return "No jobs yet. Start one with `durable-chat task add \"<brief>\"` or ask the agent.";
	}
	const sorted = [...records].sort((a, b) => Number(a.id) - Number(b.id));
	const header = `${"ID".padEnd(5)}${"STATUS".padEnd(18)}${"BRIEF".padEnd(54)}AGE`;
	return [header, ...sorted.map((record) => formatJobRow(record, now))].join("\n");
}

export function formatJobDetail(record: AnyTaskRecord, now: number): string {
	const view = jobView(record);
	const lines: string[] = [];
	lines.push(`Job #${view.id}  ${view.status}  (${age(view, now)})`);
	lines.push(`Brief: ${view.brief}`);
	if (view.tags.length > 0) lines.push(`Tags: ${view.tags.join(", ")}`);
	if (view.conversationId !== undefined) lines.push(`Conversation: #${view.conversationId}`);
	if (view.fork !== undefined) lines.push(`Context fork: ${view.fork.jobId === undefined ? "main" : `job #${view.fork.jobId}`} (conversation #${view.fork.conversationId}), through entry #${view.fork.entryId}`);
	if (view.workspace !== undefined) {
		lines.push(`Workspace: ${view.workspace.cwd} (${view.workspace.kind})`);
		if (view.workspace.kind === "worktree") lines.push(`Branch: ${view.workspace.branch}`, `Base commit: ${view.workspace.baseCommit}`);
	}
	if (view.answer !== undefined && view.answer.trim().length > 0) {
		lines.push("");
		lines.push("Answer:");
		for (const line of view.answer.trimEnd().split("\n")) lines.push(`  ${line}`);
	}
	if (view.handoff !== undefined) {
		lines.push("");
		lines.push(`Handoff: ${view.handoff.target === "main" ? "main" : `job #${view.handoff.id ?? "?"}`}`);
	}
	if (view.reason !== undefined) {
		lines.push("");
		lines.push(`Reason: ${view.reason}`);
	}
	if (record.restarts !== undefined && record.restarts > 0) lines.push(`Restarts: ${record.restarts}`);
	return lines.join("\n");
}

export function formatLiveJobLine(record: AnyTaskRecord, now: number): string {
	const view = jobView(record);
	return `#${view.id} ${view.status} — ${truncate(view.brief, 70)} (${age(view, now)})`;
}
