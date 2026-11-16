import { randomUUID } from "node:crypto";
import { configure, ConversationIdle, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type {
	AgentChange,
	Conversation,
	ConversationHandle,
	ConversationId,
	Cursor,
	EntryId,
	Extension,
	Harness,
	ModelRef,
	TaskId,
	Tx,
} from "@earendil-works/pi-durable";
import type { AssistantMessage, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord/context";
import type { AnyTaskRecord } from "./format.ts";
import { JobLink, JobTask, JOB_INSTRUCTIONS, JOB_KIND, MAX_BRIEF_CHARS, jobNoticeEntry, type ForkOrigin, type JobResult, type JobState, type JobTemplate } from "./tasks.ts";
export { JOB_INSTRUCTIONS };
import type { ResolvedConfig } from "./config.ts";
import { JobWorkspaceDoc, type JobWorkspace } from "./workspaces.ts";
import { JobTags, normalizeTags, taggedJob, writeJobTags } from "./tags.ts";

export const MAIN_INSTRUCTIONS = [
	"You coordinate durable background jobs for one user in a terminal.",
	"With `codemode`, a script can call your own tools in one run and only its output reaches you; a script can only call the tools this conversation has, so for main that means task, fork, and reminder.",
	"Start a job with the `task` tool for substantive work, then answer the user and stop. Do not wait for it or check on it.",
	"Prime context once in a scouting job, then use `fork` to create independently briefed variants from that job's completed context or your own. Only you have the fork tool.",
	"Give reusable prepared jobs descriptive tags (for example reviewer), then fork with source tag:reviewer instead of memorizing ids. Tags identify context, not its freshness; tell each variant what changed and what to verify.",
	"Choose shared workspaces for inspection/coordinated work, or managed worktrees for competing edits. Worktrees require a clean committed source; their branches are retained for your integration decision.",
	"All jobs use the user's active session model. Forks inherit conversation context, not running tasks. Each result reports back to you; wait for completion notices before comparing variants.",
	"To redirect a running job, call task with action steer, its id, and a message. This queues steering at the next boundary without waiting for the job; then answer the user and stop.",
	"Jobs notify you automatically: [host] start/completion/failure/abort notices, and [job #N handoff] inputs from jobs that continue their work with you.",
	"For a future check of a long-running external process, use reminder action schedule with an explicit timezone timestamp and a concrete next-step message, then answer and stop. When a host reminder wakes you through your normal inbox, check the stated process and decide the next step; the reminder is not evidence that the process finished. Reminders are one-shot and recover when the session next runs if offline.",
	"Do not poll. Never call task list/show in a loop, and avoid calling them unless the user asks for status or a notice lacks a detail you need. A completion notice already contains the result summary.",
	"When a completion notice arrives, act on it: summarize the result, take the next concrete step, or say the work is complete. Do not start a job merely to keep working. If the user asks for status, one task list call is enough.",
	"Treat [host] notices as status facts, not as the user speaking. A [job #N handoff] is a job handing its work to you; continue it.",
	"Never claim work is done unless the notice or your own verified check says so. Keep replies short.",
].join("\n");



export function normalizeBrief(raw: unknown): string {
	const brief = typeof raw === "string" ? raw.trim() : "";
	if (brief.length === 0) throw new Error("A job needs a brief.");
	if (brief.length > MAX_BRIEF_CHARS) throw new Error(`The brief is longer than ${MAX_BRIEF_CHARS} characters.`);
	return brief;
}

export type JobAgentOptions = { maxTurns: number; thinkingLevel: ModelThinkingLevel };
export type JobCreateOptions = JobAgentOptions & {
	notifyMain?: boolean;
	autoContinue?: boolean;
	handoffDepth?: number;
	handoffFrom?: number;
	fork?: ForkOrigin;
	workspace?: JobWorkspace;
	tags?: readonly string[];
};

export function jobAgentChange(
	model: ModelRef,
	jobExtensions: readonly Extension[],
	cwd: string,
	options: JobAgentOptions,
): AgentChange {
	return {
		model,
		thinkingLevel: options.thinkingLevel,
		cwd,
		maxTurns: options.maxTurns,
		instructions: JOB_INSTRUCTIONS,
		extensions: [...jobExtensions],
		tools: null,
		modelTools: null,
	};
}

export function jobOptionsOf(config: ResolvedConfig): JobAgentOptions {
	return { maxTurns: config.jobMaxTurns, thinkingLevel: config.thinkingLevel };
}

export function jobCreateOptionsOf(config: ResolvedConfig): JobCreateOptions {
	return { ...jobOptionsOf(config), autoContinue: config.autoContinue };
}

/** Create the job coordinator task and its owned conversation atomically. */
export async function createJobInCommit(
	tx: Tx,
	brief: string,
	model: ModelRef,
	jobExtensions: readonly Extension[],
	cwd: string,
	options: JobCreateOptions,
): Promise<{ taskId: TaskId<JobResult>; conversationId: ConversationId }> {
	const tags = normalizeTags(options.tags ?? []);
	const taskId = await tx.createTask(
		JobTask,
		{
			brief,
			...(options.notifyMain === true ? { notifyMain: true } : {}),
			autoContinue: options.autoContinue === true,
			...(options.handoffDepth === undefined ? {} : { handoffDepth: options.handoffDepth }),
			...(options.handoffFrom === undefined ? {} : { handoffFrom: options.handoffFrom }),
			...(options.fork === undefined ? {} : { fork: options.fork }),
			...(options.workspace === undefined ? {} : { workspace: options.workspace }),
		},
		{ ownership: { kind: "conversation" }, background: true, conversationId: ROOT_CONVERSATION_ID },
	);
	const ownership = { kind: "task" as const, taskId };
	const conversation = options.fork === undefined
		? await tx.createConversation({ ownership })
		: await tx.forkConversation(options.fork.conversationId as ConversationId, options.fork.entryId as EntryId, { ownership });
	await configure(tx, conversation.id, jobAgentChange(model, jobExtensions, cwd, options));
	if (options.fork !== undefined) {
		const origin = options.fork;
		const workspace = options.workspace;
		const placement = workspace?.kind === "worktree"
			? `Managed worktree branch: ${workspace.branch}; base commit: ${workspace.baseCommit}. Keep this branch checked out.`
			: "This is a shared workspace; coordinate edits with main.";
		await tx.appendEntry(conversation.id, {
			kind: "app.context-fork",
			data: { fork: origin, ...(workspace === undefined ? {} : { workspace }) },
			model: [{ role: "user", timestamp: Date.now(), content: `[host] Context inherited from ${origin.jobId === undefined ? "main" : `job #${origin.jobId}`} through entry #${origin.entryId}. Earlier messages are background for the next brief. Assigned directory: ${cwd}. ${placement} Main decides integration.` }],
		});
	}
	const template: JobTemplate = {
		model: { provider: model.provider, modelId: model.modelId },
		cwd,
		maxTurns: options.maxTurns,
		thinkingLevel: options.thinkingLevel,
		extensionNames: jobExtensions.map((extension) => extension.name),
		...(options.workspace === undefined ? {} : { workspace: options.workspace }),
	};
	const link = await tx.doc(JobLink, taskId);
	link.conversationId = Number(conversation.id);
	link.template = template;
	if (options.workspace !== undefined) (await tx.doc(JobWorkspaceDoc, conversation.id)).workspace = options.workspace;
	if (tags.length > 0) await writeJobTags(tx, taskId, tags);
	return { taskId, conversationId: conversation.id };
}

/**
 * Write a native model-visible notice into the main conversation. A write never
 * starts a run; it lands at the next boundary if the conversation is busy.
 */
export async function announceJobStart(
	conversation: Conversation,
	started: { taskId: TaskId<JobResult>; conversationId: ConversationId },
	brief: string,
	context: Context,
): Promise<void> {
	await conversation.submit({
		type: "write",
		entry: jobNoticeEntry(
			`The user started background job #${started.taskId}: "${brief}". It runs in its own conversation. ` +
			`No action is needed now; a completion notice will arrive automatically.`,
			{
				taskId: Number(started.taskId),
				conversationId: Number(started.conversationId),
				brief,
				phase: "started",
			},
		),
	}, context);
}

/**
 * Apply the session-wide model before scheduling resumes, including continued and legacy jobs.
 *
 * Reconfiguration leaves prepared requests intact. Resuming a request or deferred poll uses its
 * checkpoint model; a new preparation (including an ordinary retry) uses the current selection.
 * A checkpoint for another model must never block startup or the user's model choice.
 * When supplied, install host repository-context support on existing jobs and successor templates too.
 */
export async function applyStartupJobModel(harness: Harness, model: ModelRef, context: Context, repositoryInstructions?: Extension): Promise<void> {
	let cursor: Cursor | undefined;
	do {
		cursor = await harness.commit(async (tx) => {
			const page = await tx.scanTasks({ kind: JOB_KIND }, 200, cursor);
			// All table reads precede configure/doc writes on the atomic mutation line.
			const owned = [];
			for (const task of page.items) owned.push((await tx.scanConversations({ ownerTaskId: task.id }, 2)).items);
			for (let index = 0; index < page.items.length; index++) {
				for (const conversation of owned[index]!) await configure(tx, conversation.id, {
					model,
					...(repositoryInstructions === undefined ? {} : { extensions: { add: [repositoryInstructions] } }),
				});
				if (page.items[index]!.state.status !== "terminal") {
					const link = await tx.doc(JobLink, page.items[index]!.id);
					if (link.template !== undefined) {
						link.template.model = { ...model };
						if (repositoryInstructions !== undefined && !link.template.extensionNames.includes(repositoryInstructions.name)) {
							link.template.extensionNames.push(repositoryInstructions.name);
						}
					}
				}
			}
			return page.next;
		}, context);
	} while (cursor !== undefined);
}

/** Apply the session thinking level to every job conversation. New jobs read it from the live job options. */
export async function applyThinkingLevel(harness: Harness, level: ModelThinkingLevel, context: Context): Promise<void> {
	let cursor: Cursor | undefined;
	do {
		cursor = await harness.commit(async (tx) => {
			const page = await tx.scanTasks({ kind: JOB_KIND }, 200, cursor);
			const owned = [];
			for (const task of page.items) owned.push((await tx.scanConversations({ ownerTaskId: task.id }, 2)).items);
			for (let index = 0; index < page.items.length; index++) {
				for (const conversation of owned[index]!) await configure(tx, conversation.id, { thinkingLevel: level });
			}
			return page.next;
		}, context);
	} while (cursor !== undefined);
}

export async function scanJobs(harness: Harness, context: Context, limit = 200): Promise<AnyTaskRecord[]> {
	const page = await harness.commit((tx) => tx.scanTasks({ kind: JOB_KIND }, limit, undefined), context);
	const labels = await harness.snapshot(JobTags, context);
	return page.items.map((record) => taggedJob(record, labels));
}

export async function jobRecord(harness: Harness, id: number, context: Context): Promise<AnyTaskRecord | undefined> {
	const record = await harness.getTask(id as unknown as TaskId, context);
	return record === undefined ? undefined : taggedJob(record, await harness.snapshot(JobTags, context));
}

export async function jobConversationId(harness: Pick<Harness, "commit">, id: number, context: Context): Promise<number | undefined> {
	const page = await harness.commit(
		(tx) => tx.scanConversations({ ownerTaskId: id as unknown as TaskId }, 2),
		context,
	);
	const found = page.items[0];
	return found === undefined ? undefined : Number(found.id);
}

export async function findJobConversation(
	harness: Harness,
	id: number,
	context: Context,
): Promise<Conversation | undefined> {
	const conversationId = await jobConversationId(harness, id, context);
	if (conversationId === undefined) return undefined;
	return harness.conversation(conversationId as unknown as ConversationId, context);
}

export function answerTextOfEntry(entry: { model?: readonly unknown[] } | undefined): string | undefined {
	const assistant = (entry?.model ?? []).filter(
		(message): message is AssistantMessage => typeof message === "object" && message !== null && (message as { role?: unknown }).role === "assistant",
	);
	const text = (assistant.at(-1)?.content ?? [])
		.flatMap((part) => part.type === "text" ? [part.text] : [])
		.join("");
	return text.trim().length === 0 ? undefined : text;
}

export async function readAnswer(harness: Harness, entryId: number, context: Context): Promise<string | undefined> {
	const entry = await harness.commit(
		(tx) => tx.entry(entryId as unknown as EntryId),
		context,
	);
	return answerTextOfEntry(entry as { model?: readonly unknown[] } | undefined);
}

export type SendResult = { status: "answered"; answer?: string } | { status: "unanswered"; reason: string };

export type JobInputDraft = {
	type: "input";
	content: string;
	whenBusy: "steer" | "followUp";
};

/** Input to a job conversation: `steer` joins the current run, follow-up queues behind it. */
export function jobInputDraft(message: string, steer: boolean): JobInputDraft {
	return {
		type: "input",
		content: normalizeBrief(message),
		whenBusy: steer ? "steer" : "followUp",
	};
}

/** Admit steering without waiting for the worker; tracking and admission must commit together. */
export async function queueJobSteering(
	harness: Pick<Harness, "getTask" | "commit"> & {
		conversation(id: ConversationId, context: Context): Promise<ConversationHandle | undefined>;
	},
	id: number,
	message: string,
	context: Context,
	requestId = `job:${id}:steer:${randomUUID()}`,
): Promise<void> {
	if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Provide a valid positive job id.");
	const draft = { ...jobInputDraft(message, true), content: message };
	const job = await harness.getTask(id as TaskId, context);
	if (job === undefined || job.kind !== JOB_KIND) throw new Error(`No job #${id}.`);
	if (job.state.status === "terminal") throw new Error(`Job #${id} is no longer running. Start or fork a job for new work.`);
	const conversationId = await jobConversationId(harness, id, context);
	const conversation = conversationId === undefined ? undefined : await harness.conversation(conversationId as ConversationId, context);
	if (conversation === undefined) throw new Error(`Job #${id} has no conversation.`);
	try {
		await harness.commit(async (tx) => {
			const current = await tx.task(id as TaskId);
			if (current === undefined || current.kind !== JOB_KIND || current.state.status === "terminal"
				|| (current.state.checkpoint as JobState).phase !== "run") throw new Error(`Job #${id} is no longer running.`);
			const link = await tx.doc(JobLink, id as TaskId);
			// The job cannot finish between admission and recording the submission it must rejoin.
			await conversation.submit(tx, { ...draft, requestId, whenIdle: "reject" });
			link.steering = { requestId, message: draft.content };
		}, context);
	} catch (error) {
		if (error instanceof ConversationIdle) throw new Error(`Job #${id} has no active run to steer; it may have just finished.`);
		throw error;
	}
}

export async function sendToJob(
	harness: Harness,
	id: number,
	message: string,
	context: Context,
	options: { steer?: boolean } = {},
): Promise<SendResult> {
	const conversation = await findJobConversation(harness, id, context);
	if (conversation === undefined) throw new Error(`Job #${id} has no conversation.`);
	const submission = await conversation.submit(jobInputDraft(message, options.steer === true), context);
	const settled = await submission.wait(context);
	if (settled.status === "done" && settled.type === "input") {
		return { status: "answered", answer: await readAnswer(harness, Number(settled.answer), context) };
	}
	return { status: "unanswered", reason: settled.status === "unanswered" ? String(settled.reason) : "not answered" };
}

export type LogEntry = { id: number; kind: string; text: string };

function messageText(message: { role?: string; content?: unknown; toolName?: string }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((block) => {
		if (typeof block !== "object" || block === null) return [];
		const value = block as Record<string, unknown>;
		if (value.type === "text" && typeof value.text === "string") return [value.text];
		if (value.type === "toolCall" && typeof value.name === "string") return [`[tool ${value.name}]`];
		if (value.type === "image") return ["[image]"];
		return [];
	}).join(" ");
}

/** Newest `limit` transcript entries of a conversation, oldest first. */
export async function readLog(harness: Harness, conversationId: number, context: Context, limit = 30): Promise<LogEntry[]> {
	const page = await harness.commit(
		(tx) => tx.scanEntries({ conversationId: conversationId as unknown as ConversationId, order: "descending" }, limit, undefined),
		context,
	);
	return [...page.items].reverse().map((entry) => {
		const messages = Array.isArray(entry.model) ? entry.model : [];
		const text = messages.map((message) => messageText(message as { role?: string; content?: unknown })).join(" ").trim();
		return { id: Number(entry.id), kind: entry.kind, text };
	});
}

export function formatLog(entries: readonly LogEntry[], width = 240): string {
	if (entries.length === 0) return "(no transcript entries)";
	return entries.map((entry) => {
		const flat = entry.text.replace(/\s+/g, " ").trim();
		const text = flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
		return `#${entry.id} ${entry.kind.padEnd(14)} ${text}`;
	}).join("\n");
}

export type CompactOutcome = { taskId: number; entryId?: number; submissionId?: number; noop: boolean };

/** Manual compaction, joined through the Task and the summary placement (both matter). */
export async function compactConversation(
	harness: Harness,
	conversation: Conversation,
	instructions: string | undefined,
	context: Context,
): Promise<CompactOutcome> {
	const taskId = await conversation.compact(instructions, context);
	const settled = await harness.waitForTask(taskId, context);
	const outcome = settled.state.outcome;
	if (outcome.status !== "completed") {
		throw new Error(`Compaction ended ${outcome.status}: ${outcome.error?.message ?? outcome.reason ?? ""}`.trim());
	}
	const result = outcome.result;
	if (result.submissionId !== undefined) {
		const submission = await harness.submission(result.submissionId, context);
		if (submission === undefined) throw new Error("The summary placement is missing.");
		const placed = await submission.wait(context);
		if (placed.status !== "done") throw new Error(`The summary was not placed: ${JSON.stringify(placed)}`);
	}
	return {
		taskId: Number(taskId),
		noop: result.entryId === undefined && result.submissionId === undefined,
		...(result.entryId === undefined ? {} : { entryId: Number(result.entryId) }),
		...(result.submissionId === undefined ? {} : { submissionId: Number(result.submissionId) }),
	};
}

