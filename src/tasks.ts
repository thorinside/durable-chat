import { configure, defineDoc, defineTask } from "@earendil-works/pi-durable";
import type { DocumentReader, EntryDraft, ModelRef } from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import { ensureWorkspace, JobWorkspaceDoc, type JobWorkspace } from "./workspaces.ts";
import { formatResultPage, resultPage } from "./result-pages.ts";
import { answerTextOfEntry, completeAnswer } from "./job-answers.ts";

export const JOB_KIND = "durable-chat.job";
export const MAX_BRIEF_CHARS = 4000;
export const HANDOFF_MAX_DEPTH = 8;

export const JOB_INSTRUCTIONS = [
	"You are a background job agent working for a coordinator.",
	"Complete the brief in the assigned working directory with read, write, edit, and bash.",
	"With `codemode`, a script calls this job's tools as `tools.<name>(args)` and only the script's output comes back; use it for parallel reads and for filtering large output before it reaches you.",
	"A context fork inherits earlier investigation as background; the newest brief defines your assignment. Main alone creates forks.",
	"Keep changes in your assigned workspace. Report its branch and useful commits/diff with your result; main decides integration.",
	"When Substrate MCP is available, you also have substrate_search, substrate_describe, and substrate_call:",
	"search for the noun or verb, describe the exact tool, then call it with a JSON args object. Never print secrets.",
	"Use the handoff tool only when the remaining work belongs to another job or should return to the coordinator:",
	"give a self-contained brief and a short summary of verified progress. A handoff ends this job.",
	"Inspect real files and live state instead of guessing. Make the smallest change that satisfies the brief.",
	"Finish with a concise result: what you changed, what you verified, and anything still open. Never claim a check you did not run.",
].join("\n");

/** Legacy session index, read only so jobs created before JobLink can still resume. */
export const JobsIndex = defineDoc<{ byTask: Record<string, { conversationId: number }> }>({
	kind: "durable-chat.jobs",
	version: 1,
	scope: "session",
	initial: () => ({ byTask: {} }),
	checkpointWhen: () => false,
});

export type JobTemplate = {
	model: ModelRef;
	cwd: string;
	maxTurns: number;
	thinkingLevel: ModelThinkingLevel;
	extensionNames: string[];
	workspace?: JobWorkspace;
};

export type ForkOrigin = { conversationId: number; entryId: number; jobId?: number };

/** Task-scoped native link to the conversation this job owns, plus the config a successor inherits. */
export const JobLink = defineDoc<{
	conversationId: number;
	template?: JobTemplate;
	/** Latest main steering admission; its stable ID lets the job rejoin it after a restart. */
	steering?: { requestId: string; message: string };
}>({
	kind: "durable-chat.job-link",
	version: 1,
	scope: "task",
	initial: () => ({ conversationId: 0 }),
	checkpointWhen: () => false,
});

/** A job's recorded intent to hand its work to a new job or back to main. */
export const JobHandoffDoc = defineDoc<{
	target: "job" | "main";
	brief: string;
	summary: string;
	at: number;
}>({
	kind: "app.job-handoff",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ target: "main", brief: "", summary: "", at: 0 }),
	checkpointWhen: () => false,
});

export const JOB_NOTICE_KIND = "app.job-notice";
export type JobNoticePhase = "started" | "completed" | "failed" | "aborted" | "handed_off";
export type JobNoticeData = {
	taskId: number;
	brief: string;
	phase: JobNoticePhase;
	conversationId?: number;
	summary?: string;
};

/** Native write entry that makes a job visible to the main model. */
export function jobNoticeEntry(text: string, data: JobNoticeData): EntryDraft {
	return {
		kind: JOB_NOTICE_KIND,
		data,
		model: [{ role: "user", content: `[host] ${text}`, timestamp: Date.now() }],
	};
}

/**
 * A job is one background agent conversation plus this durable coordinator task.
 * The task submits the brief, joins the answer, and records the receipt on the task.
 * The conversation outlives the task, so it can be inspected or continued later.
 */
export type JobInput = {
	brief: string;
	notifyMain?: boolean;
	autoContinue?: boolean;
	handoffDepth?: number;
	handoffFrom?: number;
	fork?: ForkOrigin;
	workspace?: JobWorkspace;
};

export type JobState =
	| { phase: "run"; steeringRequestId?: string }
	| {
		phase: "handoffMain";
		brief: string;
		summary: string;
	}
	| {
		phase: "handoffJob";
		brief: string;
		summary: string;
	}
	| {
		phase: "handoffJobNotify";
		successorId: number;
		successorConversationId: number;
		brief: string;
		summary: string;
		notify: boolean;
	}
	| {
		phase: "report";
		status: "answered" | "unanswered";
		answerEntry?: number;
		answer?: string;
		/** Absent on legacy tail-only checkpoints. */
		answerComplete?: boolean;
		reason?: string;
	};

export type JobResult = {
	conversationId: number;
	brief: string;
	status: "answered" | "unanswered" | "aborted" | "handed_off";
	answer?: string;
	/** True when the receipt contains the complete final response text. */
	answerComplete?: boolean;
	answerEntry?: number;
	reason?: string;
	handoff?: { target: "job" | "main"; id?: number };
};

async function linkOf(
	read: DocumentReader,
	taskId: number,
	context: Context,
): Promise<{ conversationId: number; template?: JobTemplate } | undefined> {
	const link = await read.snapshot(JobLink, taskId as never, context);
	if (link !== undefined && link.conversationId > 0) return link;
	// Jobs created before JobLink used the session index.
	const index = await read.snapshot(JobsIndex, context);
	const entry = index?.byTask[String(taskId)];
	return entry === undefined ? undefined : { conversationId: Number(entry.conversationId) };
}

async function conversationOf(
	read: DocumentReader,
	taskId: number,
	context: Context,
): Promise<number | undefined> {
	return (await linkOf(read, taskId, context))?.conversationId;
}

async function handoffOf(
	read: DocumentReader,
	conversationId: number,
	context: Context,
): Promise<{ target: "job" | "main"; brief: string; summary: string } | undefined> {
	const handoff = await read.snapshot(JobHandoffDoc, conversationId as never, context);
	return handoff === undefined || handoff.brief.length === 0
		? undefined
		: { target: handoff.target, brief: handoff.brief, summary: handoff.summary };
}

function successorBrief(taskId: number, brief: string, summary: string): string {
	const text = `Handoff from job #${taskId}.\n\nVerified progress:\n${summary}\n\nNext brief:\n${brief}`;
	return text.length <= MAX_BRIEF_CHARS ? text : `${text.slice(0, MAX_BRIEF_CHARS - 1)}…`;
}

export const JobTask = defineTask<JobInput, JobState, JobResult>({
	name: JOB_KIND,
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (task, runtime, context) => {
			const conversationId = await conversationOf(runtime, Number(task.id), context);
			if (conversationId === undefined) {
				await runtime.commit(() => ({
					status: "terminal",
					outcome: {
						status: "failed" as const,
						error: { message: "The job has no recorded conversation." },
						result: { conversationId: 0, brief: task.input.brief, status: "unanswered" as const },
					},
				}), context);
				return;
			}
			const handle = await runtime.conversation(conversationId as never, context);
			if (handle === undefined) {
				await runtime.commit(() => ({
					status: "terminal",
					outcome: {
						status: "failed" as const,
						error: { message: "The job conversation is not available." },
						result: { conversationId, brief: task.input.brief, status: "unanswered" as const },
					},
				}), context);
				return;
			}

			if (task.input.workspace !== undefined) {
				try {
					await ensureWorkspace(task.input.workspace, runtime.signal);
				} catch (error) {
					if (runtime.signal.aborted) return;
					await runtime.commit(() => ({
						status: "running",
						checkpoint: { phase: "report" as const, status: "unanswered" as const, reason: `Workspace setup failed: ${error instanceof Error ? error.message : String(error)}` },
					}), context);
					return;
				}
			}

			const steering = (await runtime.snapshot(JobLink, task.id, context))?.steering;
			let settled;
			try {
				const submission = await handle.submit({
					type: "input",
					content: steering?.message ?? task.input.brief,
					// Reacquire the latest admitted input rather than duplicating it after a restart.
					requestId: steering?.requestId ?? `job:${task.id}:run`,
					...(steering === undefined ? {} : { whenBusy: "steer", whenIdle: "reject" }),
				}, context);
				settled = await submission.wait(context);
			} catch (error) {
				if (runtime.signal.aborted) return; // The abort handler commits the terminal state.
				throw error;
			}

			if (runtime.signal.aborted) return;
			const handoff = await handoffOf(runtime, conversationId, context);
			let checkpoint: JobState;
			if (handoff !== undefined) {
				checkpoint = handoff.target === "main"
					? { phase: "handoffMain", brief: handoff.brief, summary: handoff.summary }
					: { phase: "handoffJob", brief: handoff.brief, summary: handoff.summary };
			} else if (settled.status === "done" && settled.type === "input") {
				// A reset/compaction can remove the answer from active context after settlement.
				// Read its immutable child entry, not runtime.entry() (scoped to main).
				let answer: string | undefined;
				await runtime.commit(async (tx) => {
					answer = answerTextOfEntry(await tx.entry(settled.answer), conversationId);
				}, context);
				checkpoint = {
					phase: "report",
					status: "answered",
					answerEntry: Number(settled.answer),
					...(answer === undefined ? {} : { answer }),
					answerComplete: answer !== undefined,
				};
			} else {
				const reason = settled.status === "unanswered" ? String(settled.reason) : "not_answered";
				checkpoint = { phase: "report", status: "unanswered", reason };
			}
			if (runtime.signal.aborted) return;
			await runtime.commit(async (tx) => {
				const latest = await tx.doc(JobLink, task.id);
				// A steer can arrive during the final model request and start a subsequent native run.
				// Keep this job live until the latest steering submission has also settled.
				return {
					status: "running",
					checkpoint: latest.steering?.requestId === steering?.requestId ? checkpoint : {
						phase: "run",
						...(latest.steering === undefined ? {} : { steeringRequestId: latest.steering.requestId }),
					},
				};
			}, context);
		},
		handoffMain: async (task, runtime, context) => {
			const { brief, summary } = task.state.checkpoint;
			const conversationId = await conversationOf(runtime, Number(task.id), context) ?? 0;
			const main = await runtime.conversation(runtime.conversationId, context);
			if (main === undefined) {
				await runtime.commit(() => ({
					status: "terminal",
					outcome: {
						status: "failed" as const,
						error: { message: "The main conversation is not available for the handoff." },
						result: { conversationId, brief: task.input.brief, status: "unanswered" as const },
					},
				}), context);
				return;
			}
			const content = `[job #${task.id} handoff] ${summary}\n\nContinue with: ${brief}`;
			let delivered = false;
			await runtime.commit(async (tx) => {
				try {
					await main.submit(tx, {
						type: "input",
						content,
						whenBusy: "followUp",
						requestId: `job-handoff:${task.id}`,
						entry: { kind: "app.job-handoff", data: { fromJob: Number(task.id), brief, summary } },
					});
					delivered = true;
				} catch (error) {
					runtime.report(error);
				}
				if (!delivered) {
					return {
						status: "terminal" as const,
						outcome: {
							status: "failed" as const,
							error: { message: "The handoff to main could not be admitted." },
							result: { conversationId, brief: task.input.brief, status: "unanswered" as const },
						},
					};
				}
				return {
					status: "terminal" as const,
					outcome: {
						status: "completed" as const,
						result: {
							conversationId,
							brief: task.input.brief,
							status: "handed_off" as const,
							answer: summary,
							answerComplete: true,
							handoff: { target: "main" as const },
						},
					},
				};
			}, context);
		},
		handoffJob: async (task, runtime, context) => {
			const { brief, summary } = task.state.checkpoint;
			const link = await linkOf(runtime, Number(task.id), context);
			const template = link?.template;
			const depth = task.input.handoffDepth ?? 0;
			const fail = (message: string) => runtime.commit(() => ({
				status: "running",
				checkpoint: { phase: "report" as const, status: "unanswered" as const, reason: message },
			}), context);
			if (template === undefined) {
				await fail("This job has no agent template for a successor; it cannot hand off to another job.");
				return;
			}
			if (depth >= HANDOFF_MAX_DEPTH) {
				await fail(`Handoff chain limit (${HANDOFF_MAX_DEPTH}) reached.`);
				return;
			}
			const extensions = runtime.registry.installed().filter((extension) => template.extensionNames.includes(extension.name));
			if (extensions.length === 0) {
				await fail("No registered extension matches this job's agent template.");
				return;
			}
			let successorId = 0;
			let successorConversationId = 0;
			const notify = task.input.notifyMain === true;
			await runtime.commit(async (tx) => {
				const newTaskId = await tx.createTask(
					JobTask,
					{
						brief: successorBrief(Number(task.id), brief, summary),
						...(notify ? { notifyMain: true } : {}),
						autoContinue: task.input.autoContinue === true,
						handoffDepth: depth + 1,
						handoffFrom: Number(task.id),
						...(template.workspace === undefined ? {} : { workspace: template.workspace }),
					},
					{ ownership: { kind: "conversation" }, background: true, conversationId: runtime.conversationId },
				);
				const conversation = await tx.createConversation({ ownership: { kind: "task", taskId: newTaskId } });
				await configure(tx, conversation.id, {
					model: template.model,
					thinkingLevel: template.thinkingLevel,
					cwd: template.cwd,
					maxTurns: template.maxTurns,
					instructions: JOB_INSTRUCTIONS,
					extensions,
					tools: null,
					modelTools: null,
				});
				const successor = await tx.doc(JobLink, newTaskId);
				successor.conversationId = Number(conversation.id);
				successor.template = template;
				if (template.workspace !== undefined) (await tx.doc(JobWorkspaceDoc, conversation.id)).workspace = template.workspace;
				successorId = Number(newTaskId);
				successorConversationId = Number(conversation.id);
				return {
					status: "running" as const,
					checkpoint: {
						phase: "handoffJobNotify" as const,
						successorId,
						successorConversationId,
						brief,
						summary,
						notify,
					},
				};
			}, context);
		},
		handoffJobNotify: async (task, runtime, context) => {
			const { successorId, successorConversationId, brief, summary, notify } = task.state.checkpoint;
			const conversationId = await conversationOf(runtime, Number(task.id), context) ?? 0;
			const main = notify ? await runtime.conversation(runtime.conversationId, context) : undefined;
			const entry = jobNoticeEntry(
				`Job #${task.id} handed off to job #${successorId}: "${brief}". The successor continues in its own conversation.`,
				{
					taskId: Number(task.id),
					conversationId: successorConversationId,
					brief,
					phase: "handed_off",
					summary,
				},
			);
			await runtime.commit(async (tx) => {
				if (main !== undefined) {
					try {
						await main.submit(tx, { type: "write", entry });
					} catch (error) {
						runtime.report(error);
					}
				}
				return {
					status: "terminal" as const,
					outcome: {
						status: "completed" as const,
						result: {
							conversationId,
							brief: task.input.brief,
							status: "handed_off" as const,
							answer: summary,
							answerComplete: true,
							handoff: { target: "job" as const, id: successorId },
						},
					},
				};
			}, context);
		},
		report: async (task, runtime, context) => {
			const checkpoint = task.state.checkpoint;
			const conversationId = await conversationOf(runtime, Number(task.id), context) ?? 0;
			const base = { conversationId, brief: task.input.brief };
			const main = task.input.notifyMain === true
				? await runtime.conversation(runtime.conversationId, context)
				: undefined;
			const answered = checkpoint.status === "answered";
			let answer = checkpoint.answer;
			let answerComplete = completeAnswer(answer, checkpoint.answerComplete);
			// Recover legacy tails (and old false-empty checkpoints) from immutable history.
			if (checkpoint.answerEntry !== undefined) {
				let source: string | undefined;
				await runtime.commit(async (tx) => {
					source = answerTextOfEntry(await tx.entry(checkpoint.answerEntry as never), conversationId);
				}, context);
				if (source !== undefined) {
					answer = source;
					answerComplete = true;
				}
			}
			const incomplete = answered && !answerComplete;
			const summary = incomplete
				? `Result may be incomplete or unavailable. Retrieve the original entry with task(${JSON.stringify({ action: "result", id: String(task.id) })}); do not treat this notice as a full response.`
				: formatResultPage(resultPage(answer ?? checkpoint.reason ?? "", Number(task.id)));
			const continueMain = task.input.autoContinue === true;
			const continuation = continueMain
				? " Continue the work: review the result, decide the next step, and tell the user what changed."
				: "";
			const origin = task.input.fork;
			const provenance = origin === undefined ? "" : ` Forked from ${origin.jobId === undefined ? "main" : `job #${origin.jobId}`} at entry #${origin.entryId}.`;
			const workspace = task.input.workspace;
			const placement = workspace === undefined ? "" : ` Workspace: ${workspace.cwd}${workspace.kind === "worktree" ? `; branch ${workspace.branch}; base ${workspace.baseCommit}` : " (shared)"}.`;
			const text = (answered
				? `Background job #${task.id} completed. `
				: `Background job #${task.id} failed.`) + provenance + placement + continuation + `\n\n${summary}`;
			const data = {
				taskId: Number(task.id),
				conversationId,
				brief: task.input.brief,
				phase: answered ? "completed" as const : "failed" as const,
				summary,
			};
			await runtime.commit(async (tx) => {
				if (main !== undefined) {
					try {
						await main.submit(tx, continueMain
							? {
								type: "input",
								content: `[host] ${text}`,
								whenBusy: "followUp",
								entry: { kind: JOB_NOTICE_KIND, data },
							}
							: { type: "write", entry: jobNoticeEntry(text, data) });
					} catch (error) {
						runtime.report(error);
					}
				}
				if (checkpoint.status === "answered") {
					return {
						status: "terminal" as const,
						outcome: {
							status: "completed" as const,
							result: {
								...base,
								status: "answered" as const,
								...(answer === undefined ? {} : { answer }),
								answerComplete,
								...(checkpoint.answerEntry === undefined ? {} : { answerEntry: checkpoint.answerEntry }),
							},
						},
					};
				}
				return {
					status: "terminal" as const,
					outcome: {
						status: "failed" as const,
						error: { message: `Job did not answer: ${checkpoint.reason ?? "unknown"}` },
						result: {
							...base,
							status: "unanswered" as const,
							...(checkpoint.reason === undefined ? {} : { reason: checkpoint.reason }),
						},
					},
				};
			}, context);
		},
	},
	abort: async (task, runtime, context) => {
		const conversationId = await conversationOf(runtime, Number(task.id), context) ?? 0;
		if (conversationId > 0) {
			const handle = await runtime.conversation(conversationId as never, context);
			if (handle !== undefined) {
				// Bound cleanup: a job whose model call ignores cancellation must still settle.
				try {
					await handle.abort(withAbortSignal(AbortSignal.timeout(15_000), context), { background: true });
				} catch {
					// The terminal receipt below remains the authority.
				}
			}
		}
		const main = task.input.notifyMain === true
			? await runtime.conversation(runtime.conversationId, context)
			: undefined;
		const continueMain = task.input.autoContinue === true;
		const text = `Background job #${task.id} was aborted. Its transcript is retained.` +
			(continueMain ? " Decide whether to retry, replan, or tell the user." : "");
		const data = {
			taskId: Number(task.id),
			conversationId,
			brief: task.input.brief,
			phase: "aborted" as const,
		};
		await runtime.commit(async (tx) => {
			if (main !== undefined) {
				try {
					await main.submit(tx, continueMain
						? {
							type: "input",
							content: `[host] ${text}`,
							whenBusy: "followUp",
							entry: { kind: JOB_NOTICE_KIND, data },
						}
						: { type: "write", entry: jobNoticeEntry(text, data) });
				} catch (error) {
					runtime.report(error);
				}
			}
			return {
				status: "terminal" as const,
				outcome: {
					status: "aborted" as const,
					reason: "Aborted by the host.",
					result: { conversationId, brief: task.input.brief, status: "aborted" as const },
				},
			};
		}, context);
	},
});
