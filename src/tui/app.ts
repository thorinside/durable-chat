import { isKeyRelease, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { getNativeClipboard } from "@earendil-works/pi-tui";
import { withCancel } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import type { TaskGraph, TaskGraphNode, TaskGraphWatch, TaskId, UserInput } from "@earendil-works/pi-durable";
import type { AppRuntime } from "../harness.ts";
import { selectModel, type ModelChoice, type RuntimeNotice } from "../models.ts";
import { rollbackChoices, rollbackSource } from "../rollback.ts";
import { describeConfig, setConfigValue } from "../config.ts";
import { parseId } from "../commands.ts";
import { jobView } from "../format.ts";
import {
	announceJobStart,
	compactConversation,
	createJobInCommit,
	findJobConversation,
	jobConversationId,
	jobCreateOptionsOf,
	jobRecord,
	jobInputDraft,
	queueJobSteering,
	normalizeBrief,
	scanJobs,
} from "../jobs.ts";
import type { AnyTaskRecord } from "../format.ts";
import { buildJobRows, clampScroll, filterJobs, moveSelection, reconcileJobSelection, targetLabel, type Focus, type JobRow, type Target, type UiMode } from "./state.ts";
import { transcriptLine, type TranscriptLine, backgroundLine, bold, dim, fg, padLines, shortenHome, statusText, usageTotals, ACCENT, BORDER, COMPOSER_BG, GREEN, MUTED, RED, TEXT, TRANSCRIPT_BG, YELLOW } from "./format.ts";
import { attachmentLabel, createImagePaster, MAX_ATTACHMENTS, type ImageAttachment, type ImagePaster } from "../images.ts";
import { compactionLimit, contextPercent, formatTokenCount } from "../context-usage.ts";
import { Transcript } from "./transcript.ts";
import { overlayDialog } from "./dialog.ts";
import { JOB_KIND } from "../tasks.ts";
import { TranscriptSelection } from "./selection.ts";
import { createTextCopier, copyNotice, type CopyText } from "./clipboard.ts";
import { openBrowser } from "./browser.ts";
import { Composer, isComposerNewline, isComposerQueue } from "./composer.ts";

const FLASH_MS = 5000;
const QUIT_REPEAT_MS = 1500;
const CHROME_ROWS = 8; // Header + spacer, status spacer + status, three composer rows, and hint.
const PANE_HEADING_ROWS = 2; // Title + spacer.
const MIN_ROWS = CHROME_ROWS + PANE_HEADING_ROWS + 1;
const JOB_ROW_HEIGHT = 3; // Status, brief, and a spacer between jobs.
const CONTEXT_BREAKPOINT = 140;
const MIN_CONTEXT_WIDTH = 26;
const MIN_TRANSCRIPT_WITH_CONTEXT = 80;

function shortcut(keys: string, description: string): string {
	return `${bold(keys.toUpperCase())} ${fg(description, MUTED)}`;
}

type ToastKind = "info" | "error";
type PendingConfirm = "cancel" | "reset" | "quit" | "reboot" | "rollback" | "abortMain";

export type DashboardOptions = {
	runtime: AppRuntime;
	rows: () => number;
	requestRender: () => void;
	onQuit: () => void;
	onReboot?: () => void;
	onRollback?: (source: string) => void;
	onModel?: (id: string) => void;
	onProvider?: (name: string) => void;
	notice?: RuntimeNotice;
	onEditConfig?: () => Promise<string>;
	/** Injected so a test can stand in for the native clipboard. */
	paster?: ImagePaster;
	/** Shared selection/answer clipboard path; only true confirms a local write. */
	copySelection?: CopyText;
	openUrl?: (url: string) => void;
};

type AppState = {
	focus: Focus;
	target: Target;
	selectedJobId?: number;
	mode: UiMode;
	filter: string;
	showFinished: boolean;
	toolsExpanded: boolean;
	jobsPane?: number;
	contextPane?: number;
};

/** Full-screen dashboard over one AppRuntime. All durable semantics stay in the runtime. */
export class Dashboard implements Component {
	readonly capturesViewportInput = true;
	private readonly selection: TranscriptSelection;
	private readonly copyText: CopyText;
	private readonly runtime: AppRuntime;
	private readonly rowsOf: () => number;
	private readonly requestRender: () => void;
	private readonly onQuit: () => void;
	private readonly onReboot: (() => void) | undefined;
	private readonly onRollback: ((source: string) => void) | undefined;
	private readonly onModel: ((id: string) => void) | undefined;
	private readonly onProvider: ((name: string) => void) | undefined;
	private readonly initialNotice: RuntimeNotice | undefined;
	private readonly onEditConfig: (() => Promise<string>) | undefined;
	private readonly paster: ImagePaster;
	private attachments: ImageAttachment[] = [];
	private readonly input: Composer;
	private composerHeight = 3;
	private readonly state: AppState = {
		focus: "composer",
		target: { kind: "main" },
		mode: "chat",
		filter: "",
		showFinished: true,
		toolsExpanded: false,
	};
	private readonly main: Transcript;
	private current: Transcript | undefined;
	private graph: TaskGraphWatch | undefined;
	private nodes = new Map<number, TaskGraphNode>();
	private records = new Map<number, AnyTaskRecord>();
	private rowsAll: JobRow[] = [];
	private visible: JobRow[] = [];
	private scroll = 0;
	private jobsScroll: number | undefined;
	private contextScroll = 0;
	/** Display state is independent of the composer/action target while browsing jobs. */
	private displayTarget: Target = { kind: "main" };
	private displayConversationId: number | undefined;
	private previewJobId: number | undefined;
	private displayLoad: Promise<boolean> | undefined;
	private displayCancel: (() => void) | undefined;
	private lastWidth = 120;
	private toast: { text: string; kind: ToastKind; at: number } | undefined;
	private actionLabel: string | undefined;
	private actionCancel: (() => void) | undefined;
	private pending: PendingConfirm | undefined;
	private pendingResetHandoff: string | undefined;
	private pendingRollbackSource: string | undefined;
	private rollbackFiles: string[] = [];
	private modelItems: ModelChoice[] = [];
	private modelIndex = 0;
	private modelLoading = false;
	private modelVersion = 0;
	private modelController: AbortController | undefined;
	private modelWarning: string | undefined;
	private lastStatuses = new Map<number, string>();
	private scanTimer: NodeJS.Timeout | undefined;
	private clock: NodeJS.Timeout | undefined;
	private scanning = false;
	private scanAgain = false;
	private started = false;
	private stopping = false;
	private displayVersion = 0;
	private quitRequested = false;
	private quitArmedAt: number | undefined;
	private quitArmTimer: NodeJS.Timeout | undefined;

	constructor(options: DashboardOptions) {
		this.copyText = options.copySelection ?? createTextCopier();
		this.selection = new TranscriptSelection(
			this.copyText,
			(result) => { const notice = copyNotice(result); this.flash(notice.text, notice.kind); },
			options.requestRender,
			options.openUrl ?? ((url) => { void openBrowser(url).catch((error) => this.flash(`Could not open link: ${message(error)}`, "error")); }),
		);
		this.runtime = options.runtime;
		this.rowsOf = options.rows;
		this.input = new Composer(options.rows, options.requestRender);
		this.requestRender = options.requestRender;
		this.onQuit = options.onQuit;
		this.onReboot = options.onReboot;
		this.onRollback = options.onRollback;
		this.onModel = options.onModel;
		this.onProvider = options.onProvider;
		this.initialNotice = options.notice;
		this.onEditConfig = options.onEditConfig;
		this.paster = options.paster ?? createImagePaster(getNativeClipboard());
		this.main = new Transcript(options.runtime.root);
		this.main.onUpdate = () => this.renderSoon();
	}

	async start(): Promise<void> {
		this.stopping = false;
		await this.main.start(this.runtime.context, this.runtime.config.contextWindow);
		this.current = this.main;
		await this.refreshJobs(true);
		this.graph = await this.runtime.harness.watchTaskGraph(this.runtime.context);
		this.graph.start(async (call) => {
			if (call.kind !== "value") return;
			this.onGraph(call.value);
		});
		this.clock = setInterval(() => {
			if (this.nodes.size > 0 || this.actionLabel !== undefined || this.toast !== undefined) this.requestRender();
		}, 1000);
		this.clock.unref?.();
		// Resume pending work and continue interrupted phases from the previous process.
		this.runtime.harness.resume();
		this.started = true;
		if (this.runtime.previousStateArchive !== undefined) this.flash(`Previous state archive: ${this.runtime.previousStateArchive}`);
		if (this.initialNotice !== undefined) this.flash(this.initialNotice.text, this.initialNotice.error === true ? "error" : "info");
		this.requestRender();
	}

	async stop(): Promise<void> {
		this.selection.reset();
		this.started = false;
		this.stopping = true;
		this.displayVersion++;
		this.displayCancel?.();
		this.modelController?.abort();
		this.modelVersion++;
		this.disarmQuit();
		this.actionCancel?.();
		if (this.clock !== undefined) clearInterval(this.clock);
		if (this.scanTimer !== undefined) clearTimeout(this.scanTimer);
		await this.graph?.stop();
		this.graph = undefined;
		await this.current?.stop();
		if (this.current !== this.main) await this.main.stop();
	}

	invalidate(): void {
		// Each pane rebuilds its own cache; this only asks the TUI for a frame.
		this.requestRender();
	}

	private renderSoon(): void {
		if (this.started) this.requestRender();
	}

	private now(): number {
		return Date.now();
	}

	private onGraph(graph: TaskGraph): void {
		const next = new Map<number, TaskGraphNode>();
		for (const node of Object.values(graph.tasks)) next.set(Number(node.id), node);
		this.nodes = next;
		if (this.scanTimer !== undefined) clearTimeout(this.scanTimer);
		this.scanTimer = setTimeout(() => {
			this.scanTimer = undefined;
			void this.refreshJobs();
		}, 120);
		this.renderSoon();
	}

	private async refreshJobs(initial = false): Promise<void> {
		if (this.scanning) {
			this.scanAgain = true;
			return;
		}
		this.scanning = true;
		try {
			const records = await scanJobs(this.runtime.harness, this.runtime.context, 200);
			this.records = new Map(records.map((record) => [Number(record.id), record]));
			this.rowsAll = buildJobRows(records, [...this.nodes.values()]);
			const previousStatuses = this.lastStatuses;
			this.lastStatuses = new Map(this.rowsAll.map((row) => [row.id, row.status]));
			if (!initial) {
				for (const row of this.rowsAll) {
					const before = previousStatuses.get(row.id);
					if (before !== undefined && before !== row.status && !row.live) {
						const ok = row.status.includes("completed") || row.status.includes("handed off");
						this.flash(`job #${row.id} ${row.status}`, ok ? "info" : "error");
					}
				}
			}
			this.applyView();
			this.renderSoon();
		} catch (error) {
			this.flash(`job list failed: ${message(error)}`, "error");
		} finally {
			this.scanning = false;
			if (this.scanAgain) {
				this.scanAgain = false;
				void this.refreshJobs();
			}
		}
	}

	private applyView(): void {
		const previous = this.visible;
		this.visible = filterJobs(this.rowsAll, this.state.filter, this.state.showFinished);
		// New arrivals must not move a row the user is currently reading.
		const selectionTarget = this.previewJobId === undefined ? this.state.target : { kind: "job" as const, id: this.previewJobId };
		const selected = reconcileJobSelection(this.visible, previous, selectionTarget, this.state.selectedJobId);
		if (selected !== this.state.selectedJobId) this.jobsScroll = undefined;
		this.state.selectedJobId = selected;
		if (this.state.focus === "jobs" || this.previewJobId !== undefined) this.previewSelected();
		else if (this.current === undefined) void this.showTarget(this.state.target);
	}

	private previewSelected(): void {
		this.previewJobId = this.state.selectedJobId;
		void this.showTarget(this.previewJobId === undefined ? this.state.target : { kind: "job", id: this.previewJobId });
	}

	private setFocus(focus: Focus): void {
		this.state.focus = focus;
		this.input.focused = focus === "composer";
		if (focus === "jobs") this.previewSelected();
		else if (focus === "composer") {
			this.previewJobId = undefined;
			void this.showTarget(this.state.target);
		}
	}

	private async pinMain(): Promise<void> {
		this.previewJobId = undefined;
		this.state.target = { kind: "main" };
		this.state.selectedJobId = reconcileJobSelection(this.visible, [], this.state.target, this.state.selectedJobId);
		this.scroll = 0;
		this.contextScroll = 0;
		this.jobsScroll = undefined;
		await this.showTarget(this.state.target);
	}

	private async pinJob(id: number): Promise<boolean> {
		this.previewJobId = undefined;
		this.state.target = { kind: "job", id };
		this.state.selectedJobId = id;
		this.scroll = 0;
		this.contextScroll = 0;
		this.jobsScroll = undefined;
		return this.showTarget(this.state.target);
	}

	/** Only the displayed transcript changes here; never the send/action destination. */
	private showTarget(target: Target): Promise<boolean> {
		if (this.stopping) return Promise.resolve(false);
		const same = target.kind === this.displayTarget.kind
			&& (target.kind === "main" || (this.displayTarget.kind === "job" && target.id === this.displayTarget.id));
		if (same && this.displayLoad !== undefined) return this.displayLoad;
		if (same && this.current !== undefined) return Promise.resolve(true);
		const version = ++this.displayVersion;
		this.displayCancel?.();
		const cancellable = target.kind === "job" ? withCancel(this.runtime.context) : undefined;
		this.displayCancel = cancellable?.cancel;
		const context = cancellable?.context ?? this.runtime.context;
		this.displayTarget = target;
		this.displayConversationId = undefined;
		const old = this.current;
		this.current = target.kind === "main" ? this.main : undefined;
		if (old !== undefined && old !== this.main) void old.stop();
		this.selection.reset();
		this.scroll = 0;
		this.contextScroll = 0;
		this.renderSoon();
		const load = async (): Promise<boolean> => {
			if (target.kind === "main") return true;
			let transcript: Transcript | undefined;
			try {
				const row = this.rowsAll.find((item) => item.id === target.id);
				const conversationId = row?.conversationId ?? await jobConversationId(this.runtime.harness, target.id, context);
				if (version !== this.displayVersion) return false;
				this.displayConversationId = conversationId;
				if (conversationId === undefined) return false; // Retried on job refresh once startup creates it.
				const conversation = await this.runtime.harness.conversation(conversationId as never, context);
				if (version !== this.displayVersion) return false;
				if (conversation === undefined) throw new Error(`conversation #${conversationId} is unavailable`);
				transcript = new Transcript(conversation);
				transcript.onUpdate = () => { if (version === this.displayVersion) this.renderSoon(); };
				await transcript.start(context, this.runtime.config.contextWindow);
				if (version !== this.displayVersion) {
					await transcript.stop();
					return false;
				}
				this.current = transcript;
				return true;
			} catch (error) {
				await transcript?.stop();
				if (version === this.displayVersion) this.flash(`could not read the job transcript: ${message(error)}`, "error");
				return false;
			}
		};
		this.displayLoad = load().finally(() => {
			if (version === this.displayVersion) {
				this.displayLoad = undefined;
				this.renderSoon();
			}
		});
		return this.displayLoad;
	}

	private steerInput(target = this.state.target): boolean {
		return target.kind === "job" && (this.nodes.has(target.id) || this.records.get(target.id)?.state.status === "running");
	}

	private async openSelected(): Promise<void> {
		const id = this.state.selectedJobId;
		if (id === undefined) return;
		try {
			const loaded = this.pinJob(id);
			// Activation is immediate, even during a slow preview read. Its completion must not steal focus.
			this.setFocus("composer");
			this.renderSoon();
			await loaded;
		} catch (error) {
			this.flash(message(error), "error");
		}
	}

	private async toggleTarget(): Promise<void> {
		try {
			const selected = this.state.selectedJobId;
			if (this.state.target.kind === "main") {
				if (selected === undefined) {
					this.flash("no job selected; start one with Ctrl-N", "info");
					return;
				}
				if (await this.pinJob(selected)) this.flash(`target job #${selected}`, "info");
			} else {
				await this.pinMain();
				this.flash("target main", "info");
			}
		} catch (error) {
			this.flash(message(error), "error");
		}
	}

	private resizeJobs(delta: number): void {
		const max = Math.max(22, Math.min(52, Math.floor(this.lastWidth * 0.45)));
		const current = this.state.jobsPane ?? this.jobsWidth(this.lastWidth);
		this.state.jobsPane = Math.max(22, Math.min(max, current + delta));
		this.renderSoon();
	}

	private resizeContext(delta: number): void {
		const current = this.state.contextPane ?? (this.contextWidth(this.lastWidth) || 30);
		this.state.contextPane = Math.max(MIN_CONTEXT_WIDTH, Math.min(48, current + delta));
		this.renderSoon();
	}

	private setContextPanel(visible = this.runtime.config.contextPanel === false): void {
		try {
			// Edit the resolved highest-precedence file, not a lower global layer or conversation.
			setConfigValue(this.runtime.config.configPath, "contextPanel", String(visible));
			this.runtime.config.contextPanel = visible;
			this.runtime.config.configFound = true;
			if (!this.runtime.config.configPaths.includes(this.runtime.config.configPath)) this.runtime.config.configPaths.push(this.runtime.config.configPath);
			this.flash(visible
				? `Context panel enabled${this.contextWidth(this.lastWidth) === 0 ? " (hidden until there is room)" : ""}; saved`
				: "Context panel off; saved");
		} catch (error) {
			this.flash(`Could not save context panel preference: ${message(error)}`, "error");
		}
	}

	private beginPrompt(mode: Exclude<UiMode, "help" | "inspector" | `confirm${string}`>): void {
		this.state.mode = mode;
		this.input.setValue("");
		this.setFocus("composer");
		this.renderSoon();
	}

	private cancelPrompt(): void {
		this.modelController?.abort();
		this.modelVersion++;
		this.state.mode = "chat";
		this.input.setValue("");
		this.pending = undefined;
		this.pendingResetHandoff = undefined;
		this.pendingRollbackSource = undefined;
		this.rollbackFiles = [];
		this.renderSoon();
	}

	private flash(text: string, kind: ToastKind = "info"): void {
		const at = this.now();
		this.toast = { text, kind, at };
		this.renderSoon();
		const timer = setTimeout(() => {
			if (this.toast?.at === at) {
				this.toast = undefined;
				this.renderSoon();
			}
		}, FLASH_MS);
		timer.unref?.();
	}

	private async runAction(label: string, run: (context: Context) => Promise<void>): Promise<void> {
		if (this.actionCancel !== undefined) {
			this.flash("an action is already running", "error");
			return;
		}
		const cancellable = withCancel(this.runtime.context);
		this.actionLabel = label;
		this.actionCancel = cancellable.cancel;
		this.renderSoon();
		try {
			await run(cancellable.context);
		} catch (error) {
			this.flash(message(error), "error");
		} finally {
			this.actionLabel = undefined;
			this.actionCancel = undefined;
			this.renderSoon();
		}
	}

	private async pasteAttachments(): Promise<void> {
		try {
			await this.addAttachments(await this.paster.paste());
		} catch (error) {
			this.flash(message(error), "error");
		}
	}

	private async addAttachments(next: readonly ImageAttachment[]): Promise<void> {
		if (this.state.target.kind !== "main") {
			this.flash("images go to main only", "error");
			return;
		}
		if (!this.runtime.supportsImages()) {
			this.flash(`${this.runtime.modelLabel} does not take image input`, "error");
			return;
		}
		if (next.length === 0) {
			this.flash("nothing to attach", "error");
			return;
		}
		if (this.attachments.length + next.length > MAX_ATTACHMENTS) {
			this.flash(`at most ${MAX_ATTACHMENTS} images per message`, "error");
			return;
		}
		this.attachments.push(...next);
		this.flash(`attached ${attachmentLabel(this.attachments)}`);
		this.renderSoon();
	}

	private async submit(followUp = false): Promise<void> {
		const value = this.input.getValue();
		const text = value.trim();
		if (this.state.mode === "newJob") {
			if (text.length === 0) {
				this.flash("a job needs a brief", "error");
				return;
			}
			let brief: string;
			try {
				brief = normalizeBrief(text);
			} catch (error) {
				this.flash(message(error), "error");
				return;
			}
			this.state.mode = "chat";
			this.input.setValue("");
			await this.runAction("starting job", async (context) => {
				const started = await this.runtime.root.commit(
					(tx) => createJobInCommit(tx, brief, this.runtime.model, this.runtime.jobExtensions, this.runtime.cwd, {
						...jobCreateOptionsOf(this.runtime.config),
						notifyMain: true,
					}),
					context,
				);
				let notifyError: string | undefined;
				try {
					await announceJobStart(this.runtime.root, started, brief, context);
				} catch (error) {
					notifyError = message(error);
				}
				this.runtime.harness.resume();
				await this.refreshJobs();
				await this.pinJob(Number(started.taskId));
				this.setFocus("transcript");
				this.flash(
					notifyError === undefined
						? `job #${started.taskId} started`
						: `job #${started.taskId} started; main was not notified: ${notifyError}`,
					notifyError === undefined ? "info" : "error",
				);
			});
			return;
		}
		if (this.state.mode === "compact") {
			const instructions = text.length === 0 ? undefined : text;
			const target = this.state.target;
			this.state.mode = "chat";
			this.input.setValue("");
			await this.runAction(`compacting ${targetLabel(target)}`, async (context) => {
				const conversation = target.kind === "main"
					? this.runtime.root
					: await findJobConversation(this.runtime.harness, target.id, context);
				if (conversation === undefined) throw new Error(`job #${target.kind === "job" ? target.id : "?"} has no conversation`);
				const result = await compactConversation(this.runtime.harness, conversation, instructions, context);
				this.flash(result.noop ? "compaction no-op" : `compacted ${targetLabel(target)}`, "info");
			});
			return;
		}
		if (this.state.mode === "model") {
			if (this.modelLoading) return;
			const selected = this.matchingModels()[this.modelIndex];
			if (selected === undefined) { this.flash("No matching model.", "error"); return; }
			this.chooseModel(selected.lookup);
			return;
		}
		if (this.state.mode === "rollback") {
			try { this.pendingRollbackSource = rollbackSource(text, this.rollbackFiles, this.runtime.storePath); }
			catch (error) { this.flash(message(error), "error"); return; }
			this.pending = "rollback";
			this.state.mode = "confirmRollback";
			this.input.setValue("");
			this.renderSoon();
			return;
		}
		if (this.state.mode === "reset") {
			this.pending = "reset";
			this.pendingResetHandoff = text.length === 0 ? undefined : text;
			this.state.mode = "confirmReset";
			this.input.setValue("");
			this.renderSoon();
			return;
		}
		if (this.state.mode === "filter") {
			this.state.filter = text;
			this.state.mode = "chat";
			this.input.setValue("");
			this.applyView();
			this.renderSoon();
			return;
		}
		if (text.length === 0 && this.attachments.length === 0) return;
		if (text.startsWith("/")) {
			// Addressed job input retains its draft until admission succeeds.
			if (!/^\/(?:send|steer)(?:\s|$)/i.test(text)) this.input.setValue("");
			try {
				await this.submitSlash(text);
			} catch (error) {
				this.flash(message(error), "error");
			}
			this.renderSoon();
			return;
		}
		const target = this.state.target;
		if (this.attachments.length > 0 && target.kind !== "main") {
			this.flash("images go to main only", "error");
			return;
		}
		const attachments = [...this.attachments];
		let steer = !followUp && this.steerInput(target);
		const admitted = () => {
			// Admission may finish after the user has begun editing the next draft.
			if (this.input.getValue() === value) this.input.setValue("");
			this.attachments = this.attachments.filter((image) => !attachments.includes(image));
			this.scroll = 0;
		};
		await this.runAction(`${steer ? "steering" : "queuing to"} ${targetLabel(target)}`, async (context) => {
			if (target.kind === "main") {
				const content: UserInput = attachments.length === 0
					? value
					: [...(text.length > 0 ? [{ type: "text" as const, text: value }] : []), ...attachments.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }))];
				await this.runtime.root.submit({
					type: "input",
					content,
					whenBusy: steer ? "steer" : "followUp",
				}, context);
				admitted();
				this.flash(steer ? "steered main" : "sent to main");
				return;
			}
			if (!followUp) {
				// Graph/list refresh is debounced; use the durable status for the automatic ingress default.
				const job = await this.runtime.harness.getTask(target.id as TaskId, context);
				if (job === undefined || job.kind !== JOB_KIND) throw new Error(`No job #${target.id}.`);
				steer = job.state.status !== "terminal";
			}
			if (steer) {
				await queueJobSteering(this.runtime.harness, target.id, value, context);
			} else {
				const conversation = await findJobConversation(this.runtime.harness, target.id, context);
				if (conversation === undefined) throw new Error(`job #${target.id} has no conversation`);
				// One-shot follow-up also continues completed conversations; it does not steer a live run.
				await conversation.submit({ ...jobInputDraft(value, false), content: value }, context);
			}
			admitted();
			this.flash(steer ? `steering queued for job #${target.id}; delivery at next boundary` : `follow-up queued for job #${target.id}`);
		});
	}

	private async submitSlash(text: string): Promise<void> {
		const source = text.slice(1).trim();
		const command = source.split(/\s+/, 1)[0]!.toLowerCase();
		const tail = source.slice(command.length).trim();
		const rawId = tail.split(/\s+/, 1)[0];
		switch (command) {
			case "":
			case "help":
				this.state.mode = "help";
				return;
			case "info":
				this.state.mode = "inspector";
				return;
			case "context":
				if (tail === "" || tail === "toggle") this.setContextPanel();
				else if (tail === "on" || tail === "off") this.setContextPanel(tail === "on");
				else throw new Error("Usage: /context [on|off|toggle]");
				return;
			case "model": {
				if (this.onModel === undefined) throw new Error("Model switching is unavailable here.");
				this.modelController?.abort();
				const controller = new AbortController();
				this.modelController = controller;
				const version = ++this.modelVersion;
				this.modelItems = [];
				this.modelIndex = 0;
				this.modelLoading = true;
				this.modelWarning = undefined;
				this.beginPrompt("model");
				try {
					const choices = await this.runtime.listModels(controller.signal);
					if (version !== this.modelVersion || controller.signal.aborted) return;
					this.modelItems = choices.items;
					this.modelWarning = choices.warning;
					if (tail.length > 0) {
						this.input.setValue(tail);
						this.chooseModel(selectModel(tail, choices.items).lookup);
					}
				} catch (error) {
					if (!controller.signal.aborted) this.flash(message(error), "error");
				} finally {
					if (version === this.modelVersion) { this.modelLoading = false; this.renderSoon(); }
				}
				return;
			}
			case "provider": {
				if (this.onProvider === undefined) throw new Error("Provider switching is unavailable here.");
				const entries = this.runtime.config.providers;
				if (tail.length === 0) {
					this.flash(`providers: ${entries.map((entry) => `${entry.name}${entry.name === this.runtime.config.provider ? " (current)" : ""}`).join(", ")}`);
					return;
				}
				const entry = entries.find((candidate) => candidate.name === tail);
				if (entry === undefined) {
					this.flash(`No configured provider "${tail}". Known: ${entries.map((candidate) => candidate.name).join(", ")}`, "error");
					return;
				}
				this.chooseProvider(tail);
				return;
			}
			case "image": {
				if (tail.length === 0) throw new Error("Usage: /image <path>");
				await this.addAttachments([await this.paster.fromPath(tail)]);
				return;
			}
			case "thinking": {
				if (tail.length === 0) {
					this.flash(`thinking: ${this.runtime.thinkingLevel}`);
					return;
				}
				await this.runAction(`thinking ${tail}`, async () => {
					this.flash(`thinking level: ${await this.runtime.setThinkingLevel(tail)}`);
				});
				return;
			}
			case "rollback":
				if (this.onRollback === undefined) throw new Error("Rollback is unavailable here.");
				this.rollbackFiles = rollbackChoices(this.runtime.storePath, this.runtime.previousStateArchive);
				this.beginPrompt("rollback");
				if (tail.length > 0) {
					this.input.setValue(tail);
					await this.submit();
				}
				return;
			case "reboot":
				if (tail.length > 0) throw new Error("Usage: /reboot");
				if (this.onReboot === undefined) throw new Error("Reboot is unavailable here.");
				this.pending = "reboot";
				this.state.mode = "confirmReboot";
				return;
			case "quit":
			case "exit":
				this.requestQuit();
				return;
			case "tasks":
				await this.refreshJobs();
				this.setFocus(this.lastWidth >= 64 ? "jobs" : "transcript");
				if (this.lastWidth < 64) this.flash(`${this.visible.length} jobs: ${this.visible.map((row) => `#${row.id}`).join(", ") || "none"}`);
				return;
			case "task":
			case "show":
			case "log":
			case "cancel": {
				const id = parseId(rawId);
				if ((await jobRecord(this.runtime.harness, id, this.runtime.context))?.kind !== JOB_KIND) throw new Error(`No job #${id}.`);
				if (!(await this.pinJob(id))) return;
				this.setFocus("transcript");
				if (command === "cancel") this.requestCancel();
				return;
			}
			case "new":
			case "compact":
			case "reset":
			case "filter":
				this.beginPrompt(command === "new" ? "newJob" : command);
				this.input.setValue(tail);
				if (tail.length > 0 || command === "compact" || command === "reset") await this.submit();
				return;
			case "send":
			case "steer": {
				const id = parseId(rawId);
				const content = tail.slice(rawId!.length).trim();
				if (content.length === 0) throw new Error(`Usage: /${command} <id> <message>`);
				await this.runAction(`${command} job #${id}`, async (context) => {
					if (command === "steer") {
						await queueJobSteering(this.runtime.harness, id, content, context);
					} else {
						const conversation = await findJobConversation(this.runtime.harness, id, context);
						if (conversation === undefined) throw new Error(`No conversation for job #${id}.`);
						await conversation.submit(jobInputDraft(content, false), context);
					}
					if (this.input.getValue().trim() === text) this.input.setValue("");
					this.flash(command === "steer" ? `steering queued for job #${id}; delivery at next boundary` : `follow-up queued for job #${id}`);
				});
				return;
			}
			case "wait":
				await this.runAction("waiting for jobs", async (context) => {
					const pending = (await this.runtime.harness.inspect(context)).tasks.filter((task) => task.record.kind === JOB_KIND);
					await Promise.all(pending.map((task) => this.runtime.harness.waitForTask(task.record.id, context)));
					await this.refreshJobs();
					this.flash(pending.length === 0 ? "no live jobs" : "jobs settled");
				});
				return;
			default:
				this.flash(`Unknown command /${command}. Use /help.`, "error");
		}
	}

	private disarmQuit(): void {
		const armed = this.quitArmedAt !== undefined;
		this.quitArmedAt = undefined;
		if (this.quitArmTimer !== undefined) clearTimeout(this.quitArmTimer);
		this.quitArmTimer = undefined;
		if (armed) this.renderSoon();
	}

	private interrupt(): void {
		if (this.quitRequested) return;
		const now = this.now();
		const elapsed = this.quitArmedAt === undefined ? undefined : now - this.quitArmedAt;
		this.disarmQuit();
		if (elapsed !== undefined && elapsed >= 0 && elapsed < QUIT_REPEAT_MS) {
			this.requestQuit();
			return;
		}
		if (this.state.mode !== "chat") {
			this.cancelPrompt();
		} else if (this.actionCancel !== undefined) {
			this.actionCancel();
			this.flash("stopped waiting; durable work continues");
		} else {
			this.input.setValue("");
			this.flash("cleared");
		}
		this.quitArmedAt = now;
		this.quitArmTimer = setTimeout(() => this.disarmQuit(), QUIT_REPEAT_MS);
		this.quitArmTimer.unref?.();
		this.renderSoon();
	}

	private matchingModels(): ModelChoice[] {
		const query = this.input.getValue().trim().toLowerCase();
		return this.modelItems.filter((item) => `${item.lookup} ${item.name}`.toLowerCase().includes(query));
	}

	private chooseModel(id: string): void {
		this.state.mode = "chat";
		this.input.setValue("");
		this.quitRequested = true;
		this.onModel?.(id);
	}

	private chooseProvider(name: string): void {
		this.state.mode = "chat";
		this.input.setValue("");
		this.quitRequested = true;
		this.onProvider?.(name);
	}

	private requestQuit(): void {
		if (this.quitRequested) return;
		if (this.actionLabel !== undefined || this.nodes.size > 0) {
			this.pending = "quit";
			this.state.mode = "confirmQuit";
			this.renderSoon();
			return;
		}
		this.quitRequested = true;
		this.onQuit();
	}

	private confirm(): void {
		const pending = this.pending;
		this.pending = undefined;
		this.state.mode = "chat";
		if (pending === "cancel") {
			const id = this.state.target.kind === "job" ? this.state.target.id : undefined;
			if (id === undefined) return;
			void this.runAction(`cancelling job #${id}`, async (context) => {
				await this.runtime.harness.abortTask(id as unknown as TaskId, context);
				this.flash(`cancel requested for job #${id}`, "info");
				await this.refreshJobs();
			});
			return;
		}
		if (pending === "reset") {
			const target = this.state.target;
			const handoff = this.pendingResetHandoff;
			this.pendingResetHandoff = undefined;
			void this.runAction(`resetting ${targetLabel(target)}`, async (context) => {
				const conversation = target.kind === "main"
					? this.runtime.root
					: await findJobConversation(this.runtime.harness, target.id, context);
				if (conversation === undefined) throw new Error(`job #${target.kind === "job" ? target.id : "?"} has no conversation`);
				await conversation.reset(handoff, context);
				this.flash(`reset ${targetLabel(target)}`, "info");
			});
			return;
		}
		if (pending === "abortMain") {
			void this.runAction("aborting main run", async (context) => {
				await this.runtime.root.abort(context);
				this.flash("main run aborted (jobs survive)", "info");
			});
			return;
		}
		if (pending === "rollback") {
			const source = this.pendingRollbackSource;
			this.pendingRollbackSource = undefined;
			if (source === undefined) return;
			this.quitRequested = true;
			this.onRollback?.(source);
			return;
		}
		if (pending === "reboot") {
			this.quitRequested = true;
			this.onReboot?.();
			return;
		}
		if (pending === "quit") {
			this.quitRequested = true;
			this.onQuit();
		}
	}

	private async editConfig(): Promise<void> {
		if (this.onEditConfig === undefined) {
			this.flash("config editing is unavailable here", "error");
			return;
		}
		this.state.mode = "chat";
		this.renderSoon();
		try {
			const result = await this.onEditConfig();
			this.flash(result);
		} catch (error) {
			this.flash(message(error), "error");
		} finally {
			this.renderSoon();
		}
	}

	private requestCancel(): void {
		if (this.state.target.kind !== "job") {
			this.flash("select a job first (Tab, then j/k and Enter)", "error");
			return;
		}
		this.pending = "cancel";
		this.state.mode = "confirmCancel";
		this.renderSoon();
	}

	private requestReset(): void {
		this.pendingResetHandoff = undefined;
		this.state.mode = "reset";
		this.input.setValue("");
		this.setFocus("composer");
		this.renderSoon();
	}

	private requestAbortMain(): void {
		this.pending = "abortMain";
		this.state.mode = "confirmAbortMain";
		this.renderSoon();
	}

	private transcriptLines(width: number): TranscriptLine[] {
		if (this.current === undefined) return [];
		const lines = [...this.current.lines(width, this.state.toolsExpanded), ...this.current.liveLines(width)];
		// A trailing entry spacer must not occupy the only content row in a short terminal.
		while (lines.length > 0 && stripTerminalSequences(lines.at(-1)!.text).trim().length === 0) lines.pop();
		return lines;
	}

	private scrollBy(delta: number): void {
		const transcript = this.current;
		if (transcript === undefined) return;
		const width = this.paneWidths(this.lastWidth).transcriptWidth;
		const total = this.transcriptLines(width).length;
		const height = this.contentHeight();
		this.scroll = clampScroll(this.scroll + delta, total, height);
		if (delta > 0 && this.scroll > 0 && transcript.hasOlder) {
			void transcript.older(this.runtime.context).then((more) => {
				if (more) this.renderSoon();
			});
		}
		this.renderSoon();
	}

	private contentHeight(): number {
		return Math.max(1, this.bodyHeight() - PANE_HEADING_ROWS);
	}

	private bodyHeight(): number {
		return Math.max(3, Math.max(MIN_ROWS, Math.round(this.rowsOf())) - CHROME_ROWS - (this.composerHeight - 3));
	}

	/** Shared by rendering, transcript wrapping and pointer hit testing after pane resizes. */
	private paneWidths(width: number): { jobsWidth: number; transcriptWidth: number; contextWidth: number } {
		const jobsWidth = width >= 64 ? this.jobsWidth(width) : 0;
		let contextWidth = this.contextWidth(width);
		const separators = (jobsWidth > 0 ? 1 : 0) + (contextWidth > 0 ? 1 : 0);
		let transcriptWidth = width - jobsWidth - contextWidth - separators;
		if (transcriptWidth < 30) {
			contextWidth = 0;
			transcriptWidth = width - jobsWidth - (jobsWidth > 0 ? 1 : 0);
		}
		return { jobsWidth, transcriptWidth, contextWidth };
	}

	private jobsOffset(height: number): number {
		const capacity = Math.max(1, Math.floor((height - PANE_HEADING_ROWS + 1) / JOB_ROW_HEIGHT));
		const selectedIndex = Math.max(0, this.visible.findIndex((row) => row.id === this.state.selectedJobId));
		const centered = Math.max(0, Math.min(selectedIndex - Math.floor(capacity / 2), this.visible.length - capacity));
		return clampScroll(this.jobsScroll ?? centered * JOB_ROW_HEIGHT, Math.max(0, this.visible.length * JOB_ROW_HEIGHT - 1), Math.max(1, height - PANE_HEADING_ROWS));
	}

	private jobsWidth(width: number): number {
		if (this.state.jobsPane !== undefined) {
			return Math.max(22, Math.min(this.state.jobsPane, Math.max(22, width - 42)));
		}
		return Math.max(24, Math.min(30, Math.round(width * 0.22)));
	}

	private contextWidth(width: number): number {
		if (this.runtime.config.contextPanel === false || width < CONTEXT_BREAKPOINT) return 0;
		const available = width - this.jobsWidth(width) - 2 - MIN_TRANSCRIPT_WITH_CONTEXT;
		if (available < MIN_CONTEXT_WIDTH) return 0;
		const preferred = this.state.contextPane ?? Math.max(MIN_CONTEXT_WIDTH, Math.min(36, Math.round(width * 0.2)));
		return Math.min(preferred, available);
	}

	private async copy(): Promise<void> {
		const target = this.displayTarget;
		let text = "";
		if (target.kind === "job") {
			const record = this.records.get(target.id);
			text = record === undefined ? "" : (jobView(record).answer ?? "");
		}
		if (text.length === 0 && this.current !== undefined) {
			for (const entry of [...this.current.entries].reverse()) {
				if (entry.kind !== "pi.assistant") continue;
				const messages = (entry.model ?? []) as readonly { role?: string; content?: unknown }[];
				const last = messages.at(-1);
				if (last === undefined) continue;
				text = contentText(last.content);
				if (text.length > 0) break;
			}
		}
		if (text.length === 0) {
			this.flash("nothing to copy", "error");
			return;
		}
		try {
			const notice = copyNotice(await this.copyText(text));
			this.flash(notice.text, notice.kind);
		} catch { this.flash("Copy failed", "error"); }
	}

	render(width: number): string[] {
		this.lastWidth = width;
		const height = Math.max(MIN_ROWS, Math.round(this.rowsOf()));
		const composer = this.renderComposer(width);
		this.composerHeight = composer.length;
		const bodyHeight = this.bodyHeight();
		if (this.state.mode !== "chat") this.selection.update();
		let body: string[];
		if (this.state.mode === "help") body = this.renderHelp(width, bodyHeight);
		else if (this.state.mode === "inspector") body = this.renderInspector(width, bodyHeight);
		else if (this.state.mode === "model") body = this.renderModels(width, bodyHeight);
		else if (this.state.mode === "rollback") body = this.panel("Rollback state", [
			"Choose an archive number or enter a database file path.",
			"Esc cancels. A separate confirmation follows selection.", "",
			...(this.rollbackFiles.length === 0 ? ["No recent archives; enter a file path."] : this.rollbackFiles.map((path, index) => `${index + 1}. ${path}`)),
		], width, bodyHeight);
		else if (this.state.mode === "confirmCancel" || this.state.mode === "confirmReset" || this.state.mode === "confirmAbortMain") {
			body = this.renderConfirm(width, bodyHeight);
		} else {
			body = this.renderBody(width, bodyHeight);
		}
		const frame = [
			this.renderHeader(width),
			" ".repeat(width),
			...padLines(body, bodyHeight, width),
			" ".repeat(width),
			this.renderStatus(width),
			...composer,
			this.renderHint(width),
		].slice(0, height);
		if (this.state.mode === "confirmRollback") return overlayDialog(frame, width, "Rollback all state?",
			`Restore from ${this.pendingRollbackSource}. Current state will be archived first; the selected file stays unchanged. Restored jobs resume. Project files and worktrees stay in place.`,
			"Y restore · Enter / N / Esc cancel");
		if (this.state.mode === "confirmReboot") return overlayDialog(frame, width, "Reboot all state?",
			`Archive this store’s conversations, jobs and tags, then start fresh at ${this.runtime.storePath}. Durable work stays paused in the archive. Project files and worktrees stay in place.`,
			"Y reboot · Enter / N / Esc cancel");
		if (this.state.mode !== "confirmQuit") return frame;
		const live = this.rowsAll.filter((row) => row.live).length;
		const tasks = this.nodes.size;
		const detail = tasks === 0 ? "No live work." : `${live} live job${live === 1 ? "" : "s"} and ${tasks} live task${tasks === 1 ? "" : "s"} pause and resume on the next run.`;
		return overlayDialog(frame, width, "Quit durable-chat?", detail, "Enter / y quit · n / Esc cancel");
	}

	private renderHeader(width: number): string {
		const live = this.rowsAll.filter((row) => row.live).length;
		const mcp = !this.runtime.mcpAttempted ? "mcp off" : this.runtime.mcpConnected ? "substrate" : "substrate down";
		const left = `${bold("durable-chat")}${dim(`  ${this.runtime.modelLabel}`)}${live > 0 ? fg(`  ${live} live`, ACCENT) : ""}${dim(`  ${mcp}`)}`;
		return truncateToWidth(left, width, "", true);
	}

	private renderBody(width: number, height: number): string[] {
		const { jobsWidth, transcriptWidth, contextWidth } = this.paneWidths(width);
		const jobs = jobsWidth > 0 ? padLines(this.renderJobs(jobsWidth, height), height, jobsWidth) : [];
		const rows = this.renderTranscript(transcriptWidth, height);
		const transcript = padLines(rows.map((line) => line.text), height, transcriptWidth)
			.map((line) => backgroundLine(line, transcriptWidth, TRANSCRIPT_BG));
		if (this.state.mode === "chat") {
			this.selection.update({ x: jobsWidth > 0 ? jobsWidth + 1 : 0, y: 2 + PANE_HEADING_ROWS, width: transcriptWidth, lines: transcript.slice(PANE_HEADING_ROWS), copyBounds: rows.slice(PANE_HEADING_ROWS), source: this.current });
			transcript.splice(PANE_HEADING_ROWS, height - PANE_HEADING_ROWS, ...this.selection.lines());
		}
		const context = contextWidth > 0 ? padLines(this.renderContext(contextWidth, height), height, contextWidth) : [];
		const lines: string[] = [];
		for (let index = 0; index < height; index++) {
			let line = jobsWidth > 0 ? `${jobs[index]}${dim("│")}${transcript[index]}` : transcript[index]!;
			if (contextWidth > 0) line += `${dim("│")}${context[index]}`;
			lines.push(truncateToWidth(line, width, "", true));
		}
		return lines;
	}

	private renderJobs(width: number, height: number): string[] {
		const live = this.rowsAll.filter((row) => row.live).length;
		const title = `${bold("JOBS")} ${dim(`${live} live`)}${this.state.filter.length > 0 ? ` ${dim(`/${this.state.filter}`)}` : ""}`;
		const lines = [truncateToWidth(title, width, "", true), ""];
		if (this.visible.length === 0) {
			lines.push(dim(this.state.filter.length > 0 ? `  No jobs match /${this.state.filter}.` : "  No jobs. Ctrl-N starts one."));
			return lines;
		}
		const content: string[] = [];
		for (const [index, row] of this.visible.entries()) {
			if (index > 0) content.push("");
			const selected = row.id === this.state.selectedJobId;
			const marker = selected ? fg("▸", ACCENT) : " ";
			const id = `#${String(row.id).padEnd(7)}`;
			const state = truncateToWidth(compactJobStatus(row.status), 9).padEnd(9);
			const age = row.startedAt === undefined ? "—" : compactDuration(Math.max(0, (row.endedAt ?? this.now()) - row.startedAt));
			const head = `${marker} ${selected ? bold(id) : id} ${statusText(state)} ${dim(age.padStart(3))}`;
			content.push(truncateToWidth(head, width, "", true));
			const briefWidth = Math.max(4, width - 3);
			const origin = row.fork === undefined ? "" : `↳ ${row.fork.jobId === undefined ? "main" : `#${row.fork.jobId}`} · `;
			const labels = row.tags?.length ? `[${row.tags.join(", ")}] ` : "";
			const brief = truncateToWidth(`${labels}${origin}${row.brief.replace(/\s+/g, " ")}`, briefWidth, "…");
			content.push(selected ? `   ${fg(brief, TEXT)}` : dim(`   ${brief}`));
		}
		const start = this.jobsOffset(height);
		if (this.jobsScroll !== undefined) this.jobsScroll = start;
		return [...lines, ...content.slice(start, start + Math.max(1, height - PANE_HEADING_ROWS))];
	}

	private renderTranscript(width: number, height: number): TranscriptLine[] {
		const target = `${targetLabel(this.displayTarget)}${this.previewJobId === undefined ? "" : " (preview)"}`;
		const live = this.current?.live;
		const active = live?.generation !== undefined || live?.tools?.some((slot) => slot.status === "running") === true;
		const title = `${bold("TRANSCRIPT")} ${dim(target)}${active ? fg("  ● live", GREEN) : ""}${this.scroll > 0 ? dim(`  ↑${this.scroll}`) : ""}`;
		const lines = [transcriptLine(truncateToWidth(title, width, "", true)), transcriptLine("")];
		const transcript = this.current;
		if (transcript === undefined) {
			lines.push(transcriptLine(dim(this.displayLoad === undefined ? "  No conversation is available for this job yet." : "  Loading job transcript…"), 2));
			return lines;
		}
		const contentHeight = Math.max(1, height - PANE_HEADING_ROWS);
		const all = this.transcriptLines(width);
		if (all.length === 0) {
			lines.push(transcriptLine(dim("  No messages yet. Type below and press Enter."), 2));
			return lines;
		}
		const offset = clampScroll(this.scroll, all.length, contentHeight);
		this.scroll = offset;
		const end = Math.max(contentHeight, all.length - offset);
		const start = Math.max(0, end - contentHeight);
		lines.push(...all.slice(start, end));
		return lines;
	}

	private renderContext(width: number, height: number): string[] {
		const content = this.contextLines(width);
		const viewport = Math.max(1, height - PANE_HEADING_ROWS);
		this.contextScroll = clampScroll(this.contextScroll, content.length, viewport);
		return [truncateToWidth(bold("CONTEXT"), width, "", true), "", ...content.slice(this.contextScroll, this.contextScroll + viewport)];
	}

	private contextLines(width: number): string[] {
		const target = this.displayTarget;
		const transcript = this.current;
		const usage = usageTotals(transcript?.usage);
		const live = transcript?.live as { run?: { turns?: number } } | undefined;
		const rows: [string, string][] = [];
		rows.push(["target", targetLabel(this.state.target)]);
		if (this.previewJobId !== undefined) rows.push(["preview", targetLabel(target)]);
		if (target.kind === "job") {
			const row = this.rowsAll.find((item) => item.id === target.id);
			rows.push(["status", row?.status ?? "unknown"]);
			const conversation = this.displayConversationId ?? row?.conversationId;
			rows.push(["conversation", conversation === undefined ? "…" : `#${conversation}`]);
			rows.push(["brief", row?.brief ?? "(unknown)"]);
			if (row?.tags?.length) rows.push(["tags", row.tags.join(", ")]);
			if (row?.fork !== undefined) rows.push(["fork from", `${row.fork.jobId === undefined ? "main" : `job #${row.fork.jobId}`} · entry #${row.fork.entryId}`]);
			if (row?.workspace !== undefined) {
				rows.push(["workspace", row.workspace.kind]);
				if (row.workspace.kind === "worktree") rows.push(["branch", truncateToWidth(row.workspace.branch, Math.max(1, width - 13), "…")], ["base commit", row.workspace.baseCommit.slice(0, 10)]);
			}
			if (row?.error !== undefined) rows.push(["error", row.error]);
		} else {
			rows.push(["status", live?.run === undefined ? "idle" : "busy"]);
		}
		rows.push(["turns", live?.run?.turns === undefined ? "—" : String(live.run.turns)]);
		const contextTokens = transcript?.contextTokens;
		const window = this.runtime.config.contextWindow;
		rows.push(["context", contextTokens === undefined
			? "…"
			: `~${formatTokenCount(contextTokens)} / ${formatTokenCount(window)} (${contextPercent(contextTokens, window).toFixed(0)}%)`]);
		rows.push(["compact", `~${formatTokenCount(compactionLimit(window))}`]);
		rows.push(["spent", usage.tokens === 0 ? "—" : formatTokenCount(usage.tokens)]);
		if (usage.cost > 0) rows.push(["cost", `$${usage.cost.toFixed(3)}`]);
		rows.push(["queued", String(transcript?.inbox ?? 0)]);
		rows.push(["model", this.runtime.config.model ?? this.runtime.modelLabel]);
		rows.push(["thinking", this.runtime.config.thinkingLevel]);
		rows.push(["jobs", `${this.rowsAll.filter((row) => row.live).length} live`]);
		rows.push(["mcp", !this.runtime.mcpAttempted ? "off" : this.runtime.mcpConnected ? "connected" : "unavailable"]);
		rows.push(["config", shortenHome(this.runtime.config.configPath)]);
		rows.push(["store", shortenHome(this.runtime.storePath)]);
		const lines: string[] = [];
		for (const [label, value] of rows) {
			const prefix = `${label}:`.padEnd(13);
			const wrapped = wrapTextWithAnsi(value, Math.max(1, width - 13));
			wrapped.forEach((part, index) => {
				lines.push(index === 0 ? `${dim(prefix)}${part}` : `${" ".repeat(13)}${part}`);
			});
		}
		return lines;
	}

	private renderStatus(width: number): string {
		const target = targetLabel(this.state.target);
		const toast = this.toast;
		if (toast !== undefined && this.now() - toast.at < FLASH_MS) {
			return truncateToWidth(fg(` ${toast.kind === "error" ? "✗" : "·"} ${toast.text}`, toast.kind === "error" ? RED : YELLOW), width, "", true);
		}
		const activity = this.actionLabel === undefined ? "" : fg(`  ⏳ ${this.actionLabel}`, YELLOW);
		const focus = dim(`focus ${this.state.focus}`);
		const contextTokens = this.current?.contextTokens;
		const window = this.runtime.config.contextWindow;
		const meter = contextTokens === undefined ? "ctx …" : `ctx ~${formatTokenCount(contextTokens)}/${formatTokenCount(window)}`;
		const context = this.previewJobId === undefined ? meter : `preview ${meter}`;
		const line = ` ${dim("target")} ${bold(target)}  ${focus}  ${dim(context)}${activity}`;
		return truncateToWidth(line, width, "", true);
	}

	private composerPrefix(): string {
		switch (this.state.mode) {
			case "newJob": return "new job › ";
			case "compact": return `compact ${targetLabel(this.state.target)} focus › `;
			case "reset": return `reset ${targetLabel(this.state.target)} handoff › `;
			case "model": return "model filter › ";
			case "rollback": return "rollback file or number › ";
			case "filter": return "filter › ";
			case "help":
			case "inspector":
			case "confirmCancel":
			case "confirmReset":
			case "confirmQuit":
			case "confirmReboot":
			case "confirmRollback":
			case "confirmAbortMain":
				return "— › ";
			default: {
				const steer = this.steerInput() ? " (steer)" : "";
				return `to ${targetLabel(this.state.target)}${steer} › `;
			}
		}
	}

	private renderComposer(width: number): string[] {
		const prefix = truncateToWidth(` ${this.composerPrefix()}`, Math.max(0, width - 3), "");
		const active = this.state.focus === "composer"
			&& this.state.mode !== "help"
			&& this.state.mode !== "inspector"
			&& !this.state.mode.startsWith("confirm");
		this.input.focused = active;
		const inner = Math.max(1, width - visibleWidth(prefix) - 1);
		const maxContentRows = Math.max(1, Math.max(MIN_ROWS, Math.round(this.rowsOf())) - CHROME_ROWS - PANE_HEADING_ROWS);
		const rendered = this.input.render(inner, maxContentRows);
		return rendered.map((line, index) => {
			const label = index === 1 ? fg(prefix, active ? ACCENT : MUTED) : " ".repeat(visibleWidth(prefix));
			return backgroundLine(`${label}${line}`, width, COMPOSER_BG);
		});
	}

	private renderHint(width: number): string {
		let hint: string;
		const separator = dim(" · ");
		if (this.quitArmedAt !== undefined && this.now() - this.quitArmedAt < QUIT_REPEAT_MS) hint = shortcut("CTRL-C", "again to quit");
		else if (this.state.mode === "help") hint = shortcut("ANY KEY", "closes help");
		else if (this.state.mode === "inspector") hint = [shortcut("E", "edit config"), shortcut("ESC", "closes"), fg("edits apply after restart", MUTED)].join(separator);
		else if (this.state.mode === "model") hint = [shortcut("↑ / ↓", "select"), shortcut("ENTER", "apply to all agents"), shortcut("ESC", "cancel")].join(separator);
		else if (this.state.mode === "rollback") hint = [shortcut("ENTER", "choose state file"), shortcut("ESC", "cancel")].join(separator);
		else if (this.state.mode === "confirmRollback") hint = [shortcut("Y", "restore"), shortcut("ENTER / N / ESC", "cancel")].join(separator);
		else if (this.state.mode === "confirmReboot") hint = [shortcut("Y", "reboot"), shortcut("ENTER / N / ESC", "cancel")].join(separator);
		else if (this.state.mode === "confirmCancel" || this.state.mode === "confirmReset" || this.state.mode === "confirmQuit" || this.state.mode === "confirmAbortMain") hint = [shortcut("Y / ENTER", "confirm"), shortcut("N / ESC", "cancel")].join(separator);
		else if (this.actionLabel !== undefined) hint = shortcut("CTRL-C", "stop waiting (work stays durable)");
		else if (this.state.focus === "composer") hint = [shortcut("ENTER", this.state.target.kind === "main" ? "send" : this.steerInput() ? "steer" : "queue"), ...(this.state.target.kind === "job" && this.steerInput() ? [shortcut("CMD-SHIFT-ENTER", "queue")] : []), shortcut(this.input.getValue().length === 0 ? "?" : "TAB ?", "help"), shortcut("TAB", "focus"), shortcut("SHIFT-ENTER", "newline"), ...(this.attachments.length === 0 ? [] : [fg(`${this.attachments.length} attached`, YELLOW)])].join(separator);
		else if (this.state.focus === "jobs") hint = [shortcut("ENTER", "message"), shortcut("↑/↓ J/K", "preview"), shortcut("?", "help"), shortcut("TAB", "focus")].join(separator);
		else hint = [shortcut("↑/↓ J/K", "scroll"), shortcut("?", "help"), shortcut("S", "compose"), shortcut("TAB", "focus")].join(separator);
		if (this.scroll > 0 && this.state.focus === "transcript") hint += dim(` · ↑${this.scroll}`);
		return truncateToWidth(` ${hint}`, width, "", true);
	}

	private renderHelp(width: number, height: number): string[] {
		const bindings: [string, string][] = [
			["TAB / SHIFT-TAB", "cycle composer, jobs, transcript"],
			["CTRL-X", "toggle context pane (saved in active config)"],
			["CTRL-T", "target main ↔ selected job"],
			["CTRL-N", "new job brief"],
			["SHIFT-ENTER", "insert a newline (Ctrl-J or Alt-Enter fallback); Enter sends"],
			["CMD-SHIFT-ENTER", "queue once from composer (if reported); /send <id> <text> fallback"],
			["CTRL-V", "paste an image into the composer (main only)"],
			["ENTER", "send input, or pin job and focus composer; confirm prompt"],
			["S (JOBS)", "pin highlighted job and compose; running jobs default to steer"],
			["[ / ]", "resize the jobs pane"],
			["{ / }", "resize the context pane"],
			["0", "reset pane widths"],
			["↑ / ↓ or J / K", "move job selection or scroll (not while typing)"],
			["WHEEL", "scroll the pane under the pointer"],
			["G / SHIFT-G", "jump to oldest / newest"],
			["N / C / M / SHIFT-R", "new · cancel · compact · reset"],
			["S / T / I / F / Y", "compose · tools · inspector · finished · copy"],
			["/", "filter jobs outside composer; commands inside"],
			["CTRL-C", "stop waiting / clear prompt / close overlay"],
			["CTRL-C ×2", "quit within 1.5s (confirms with live work)"],
		];
		return this.panel("Help", [
			bold("Slash commands (composer)"),
			"/context off · /context on · /context toggle",
			"/help · /info · /tasks · /task <id> · /log <id>",
			"/new [brief] · /send <id> <text> · /steer <id> <text>",
			"/cancel <id> · /compact [focus] · /reset [handoff]",
			"/model [id] · /provider [name] · /thinking [level] · /image <path> · /wait · /filter [query] · /rollback [path] · /reboot · /quit",
			"",
			...bindings.map(([keys, description]) => shortcut(keys.padEnd(20), description)),
			"",
			"Jobs are background tasks; this TUI is the only store writer.",
			"Closing pauses jobs; the next run resumes them.",
		], width, height);
	}

	private renderModels(width: number, height: number): string[] {
		const matches = this.matchingModels();
		const capacity = Math.max(1, height - 10);
		const start = Math.max(0, Math.min(this.modelIndex - Math.floor(capacity / 2), matches.length - capacity));
		const selected = matches[this.modelIndex];
		return this.panel(`Models — ${this.runtime.model.provider}`, [
			"Type to filter; Up/Down selects; Enter applies; Esc cancels.",
			"One model for main and all jobs. Session only; history is kept.", "",
			...(this.modelLoading ? ["Loading models…"] : matches.length === 0 ? ["No matching models."] : matches.slice(start, start + capacity).map((model, index) =>
				`${start + index === this.modelIndex ? "▸" : " "} ${this.runtime.config.providers.length > 1 ? model.lookup : model.id}${model.lookup === `${this.runtime.model.provider}/${this.runtime.model.modelId}` ? " (current)" : ""}`)),
			"",
			...(selected === undefined ? [] : [`${selected.name} · context ${formatTokenCount(selected.contextWindow)} · output ${formatTokenCount(selected.maxTokens)}`]),
			...(this.modelWarning === undefined ? [] : [this.modelWarning]),
		], width, height);
	}

	private renderInspector(width: number, height: number): string[] {
		const usage = usageTotals(this.current?.usage);
		const lines = [
			...(this.runtime.previousStateArchive === undefined ? [] : [`Previous state archive: ${this.runtime.previousStateArchive}`, ""]),
			...(this.runtime.restoredFrom === undefined ? [] : [`Restored from: ${this.runtime.restoredFrom}`, ""]),
			...describeConfig(this.runtime.config),
			"",
			`live jobs: ${this.rowsAll.filter((row) => row.live).length}`,
			`context: ~${formatTokenCount(this.current?.contextTokens ?? 0)} / ${formatTokenCount(this.runtime.config.contextWindow)} ` +
				`(compact at ~${formatTokenCount(compactionLimit(this.runtime.config.contextWindow))})`,
			`${this.previewJobId === undefined ? "target" : "preview"} spend: ${formatTokenCount(usage.tokens)} tokens${usage.cost > 0 ? `, $${usage.cost.toFixed(4)}` : ""}`,
			`job tools: ${this.runtime.jobExtensions.flatMap((extension) => extension.tools?.map((tool) => tool.name) ?? []).join(", ") || "(none)"}`,
			...this.runtime.mcpNotes.slice(0, 8).map((note) => `mcp: ${note}`),
			...(this.runtime.acpError === undefined ? [] : [`acp: unavailable (${this.runtime.acpError})`]),
			"",
			"Edit the file with `durable-chat config edit`; restart to apply.",
		];
		return this.panel("Inspector", lines, width, height);
	}

	private renderConfirm(width: number, height: number): string[] {
		const target = targetLabel(this.state.target);
		const lines: string[] = [];
		if (this.state.mode === "confirmCancel") {
			lines.push(`Cancel ${target}?`, "", "The job conversation and its transcript are retained.");
		} else if (this.state.mode === "confirmReset") {
			lines.push(`Reset ${target}?`, "", this.pendingResetHandoff === undefined ? "The next context starts empty." : `Handoff: ${this.pendingResetHandoff}`, "Raw history is retained.");
		} else if (this.state.mode === "confirmAbortMain") {
			lines.push("Abort the main run?", "", "Jobs are background tasks and are not cancelled by this.");
		}
		return this.panel("Confirm", lines, width, height);
	}

	private panel(title: string, content: readonly string[], width: number, height: number): string[] {
		const box = Math.max(30, Math.min(width - 2, 86));
		const inner = box - 4;
		const left = Math.max(0, Math.floor((width - box) / 2));
		const rows: string[] = [];
		rows.push(`${" ".repeat(left)}${dim("┌")} ${bold(title)} ${dim("─".repeat(Math.max(0, box - visibleWidth(title) - 3)))}${dim("┐")}`);
		for (const line of content.slice(0, Math.max(1, height - 2))) {
			const wrapped = wrapTextWithAnsi(line, inner);
			for (const part of wrapped) {
				rows.push(`${" ".repeat(left)}${dim("│")} ${truncateToWidth(part, inner, "", true)} ${dim("│")}`);
			}
			if (rows.length >= height - 1) break;
		}
		while (rows.length < height - 1) {
			rows.push(`${" ".repeat(left)}${dim("│")} ${" ".repeat(inner)} ${dim("│")}`);
		}
		rows.push(`${" ".repeat(left)}${dim("└")}${dim("─".repeat(Math.max(0, box - 2)))}${dim("┘")}`);
		return rows;
	}

	private cycleFocus(backwards: boolean): void {
		const order: Focus[] = this.lastWidth < 64 ? ["composer", "transcript"] : ["composer", "jobs", "transcript"];
		const index = Math.max(0, order.indexOf(this.state.focus));
		this.setFocus(order[(index + (backwards ? order.length - 1 : 1)) % order.length]!);
		this.renderSoon();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel") {
			if (this.state.mode === "chat") this.selection.handle(event);
			// Never fall back to toolkit selection of the full, composited dashboard.
			return { handled: true, render: event.type !== "move" };
		}
		this.selection.reset();
		this.renderSoon();
		// Consume unused wheel events too, so the toolkit never scrolls the whole dashboard.
		const handled = { handled: true, render: false };
		const delta = Math.trunc(event.wheelDelta ?? 0);
		if (this.state.mode !== "chat" || !Number.isFinite(delta) || delta === 0
			|| event.y < 2 + PANE_HEADING_ROWS || event.y >= 2 + this.bodyHeight()
			|| event.x < 0 || event.x >= this.lastWidth) return handled;
		const { jobsWidth, transcriptWidth, contextWidth } = this.paneWidths(this.lastWidth);
		const transcriptStart = jobsWidth > 0 ? jobsWidth + 1 : 0;
		const contextStart = transcriptStart + transcriptWidth + 1;
		if (event.x < jobsWidth) {
			this.jobsScroll = clampScroll(this.jobsOffset(this.bodyHeight()) + delta, Math.max(0, this.visible.length * JOB_ROW_HEIGHT - 1), this.contentHeight());
			this.renderSoon();
		} else if (event.x >= transcriptStart && event.x < transcriptStart + transcriptWidth) {
			this.scrollBy(-delta);
		} else if (contextWidth > 0 && event.x >= contextStart) {
			this.contextScroll = clampScroll(this.contextScroll + delta, this.contextLines(contextWidth).length, this.contentHeight());
			this.renderSoon();
		}
		return handled;
	}

	handleInput(data: string): void | Promise<void> {
		// TUI normally filters releases; keep direct dashboard delivery safe too.
		if (isKeyRelease(data)) return;
		this.selection.reset();
		this.renderSoon();
		if (matchesKey(data, "ctrl+c")) {
			this.interrupt();
			return;
		}
		this.disarmQuit();
		if (this.state.mode === "help") {
			this.state.mode = "chat";
			this.renderSoon();
			return;
		}
		if (this.state.mode === "inspector") {
			if (data === "e") {
				void this.editConfig();
				return;
			}
			if (matchesKey(data, "escape") || matchesKey(data, "enter") || data === "i") {
				this.state.mode = "chat";
				this.renderSoon();
			}
			return;
		}
		if (this.state.mode === "confirmReboot" || this.state.mode === "confirmRollback") {
			if (data === "y" || data === "Y") this.confirm();
			else if (data === "n" || data === "N" || matchesKey(data, "escape") || matchesKey(data, "enter")) this.cancelPrompt();
			return;
		}
		if (this.state.mode === "confirmCancel" || this.state.mode === "confirmReset" || this.state.mode === "confirmQuit" || this.state.mode === "confirmAbortMain") {
			if (data === "y" || data === "Y" || matchesKey(data, "enter")) this.confirm();
			else if (data === "n" || data === "N" || matchesKey(data, "escape")) this.cancelPrompt();
			return;
		}
		if ((this.state.focus === "composer" || this.state.mode !== "chat") && isComposerNewline(data)) {
			this.input.handleInput("\n");
			this.renderSoon();
			return;
		}
		if (this.state.mode === "model") {
			if (matchesKey(data, "escape")) this.cancelPrompt();
			else if (matchesKey(data, "enter")) return this.submit();
			else if (matchesKey(data, "up")) this.modelIndex = Math.max(0, this.modelIndex - 1);
			else if (matchesKey(data, "down")) this.modelIndex = Math.min(Math.max(0, this.matchingModels().length - 1), this.modelIndex + 1);
			else { this.input.handleInput(data); this.modelIndex = 0; }
			this.renderSoon();
			return;
		}
		if (this.state.mode !== "chat") {
			if (matchesKey(data, "escape")) {
				this.cancelPrompt();
				return;
			}
			if (matchesKey(data, "enter")) return this.submit();
			this.input.handleInput(data);
			this.renderSoon();
			return;
		}
		// Ctrl-X is unused by the editor and has an unambiguous legacy control byte.
		// Keep only literal Meta-C as an alias: extended Alt-C matching can also
		// match printable non-Latin keys via Kitty's base-layout key fallback.
		if (matchesKey(data, "ctrl+x") || data === "\x1bc") {
			this.setContextPanel();
			return;
		}
		if (matchesKey(data, "ctrl+t")) {
			void this.toggleTarget();
			return;
		}
		if (matchesKey(data, "ctrl+n")) {
			this.beginPrompt("newJob");
			return;
		}
		if (this.state.focus === "composer") {
			if (isComposerQueue(data)) return this.submit(true);
			if (this.input.getValue().length === 0 && data === "?") {
				this.state.mode = "help";
				this.renderSoon();
				return;
			}
			if (matchesKey(data, "ctrl+v")) {
				return this.pasteAttachments();
				return;
			}
			if (matchesKey(data, "enter")) return this.submit();
			if (matchesKey(data, "tab")) {
				this.cycleFocus(false);
				return;
			}
			if (matchesKey(data, "shift+tab")) {
				this.cycleFocus(true);
				return;
			}
			if (matchesKey(data, "escape")) {
				if (this.input.getValue().length > 0) this.input.setValue("");
				else if (this.attachments.length > 0) this.attachments = [];
				else this.cycleFocus(false);
				this.renderSoon();
				return;
			}
			this.input.handleInput(data);
			this.renderSoon();
			return;
		}
		if (matchesKey(data, "tab")) {
			this.cycleFocus(false);
			return;
		}
		if (matchesKey(data, "shift+tab")) {
			this.cycleFocus(true);
			return;
		}
		if (matchesKey(data, "escape")) {
			if (this.state.target.kind === "job") void this.pinMain();
			this.setFocus("composer");
			this.renderSoon();
			return;
		}
		if (this.state.focus === "jobs") {
			this.jobsScroll = undefined;
			if (data === "s") { void this.openSelected(); return; }
			if (matchesKey(data, "down") || data === "j") {
				this.state.selectedJobId = moveSelection(this.visible, this.state.selectedJobId, 1);
				this.previewSelected();
				this.renderSoon();
				return;
			}
			if (matchesKey(data, "up") || data === "k") {
				this.state.selectedJobId = moveSelection(this.visible, this.state.selectedJobId, -1);
				this.previewSelected();
				this.renderSoon();
				return;
			}
			if (data === "g") {
				this.state.selectedJobId = this.visible[0]?.id;
				this.previewSelected();
				this.renderSoon();
				return;
			}
			if (data === "G") {
				this.state.selectedJobId = this.visible.at(-1)?.id;
				this.previewSelected();
				this.renderSoon();
				return;
			}
			if (matchesKey(data, "enter")) {
				void this.openSelected();
				return;
			}
		} else {
			if (matchesKey(data, "down") || data === "j") {
				this.scrollBy(-1);
				return;
			}
			if (matchesKey(data, "up") || data === "k") {
				this.scrollBy(1);
				return;
			}
			if (matchesKey(data, "pageDown")) {
				this.scrollBy(-this.contentHeight());
				return;
			}
			if (matchesKey(data, "pageUp")) {
				this.scrollBy(this.contentHeight());
				return;
			}
			if (data === "g") {
				this.scrollBy(Number.MAX_SAFE_INTEGER);
				return;
			}
			if (data === "G") {
				this.scroll = 0;
				this.renderSoon();
				return;
			}
		}
		if (data === "[") {
			this.resizeJobs(-2);
			return;
		}
		if (data === "]") {
			this.resizeJobs(2);
			return;
		}
		if (data === "{") {
			this.resizeContext(-2);
			return;
		}
		if (data === "}") {
			this.resizeContext(2);
			return;
		}
		if (data === "0") {
			this.state.jobsPane = undefined;
			this.state.contextPane = undefined;
			this.renderSoon();
			return;
		}
		if (data === "n") {
			this.beginPrompt("newJob");
			return;
		}
		if (data === "c") {
			this.requestCancel();
			return;
		}
		if (data === "m") {
			this.beginPrompt("compact");
			return;
		}
		if (data === "R") {
			this.requestReset();
			return;
		}
		if (data === "a") {
			this.requestAbortMain();
			return;
		}
		if (data === "s") {
			this.setFocus("composer");
			this.renderSoon();
			return;
		}
		if (data === "t") {
			this.state.toolsExpanded = !this.state.toolsExpanded;
			this.flash(this.state.toolsExpanded ? "tool output expanded" : "tool output collapsed");
			return;
		}
		if (data === "f") {
			this.state.showFinished = !this.state.showFinished;
			this.applyView();
			this.renderSoon();
			return;
		}
		if (data === "/") {
			this.beginPrompt("filter");
			this.input.setValue(this.state.filter);
			return;
		}
		if (data === "i") {
			this.state.mode = "inspector";
			this.renderSoon();
			return;
		}
		if (data === "?") {
			this.state.mode = "help";
			this.renderSoon();
			return;
		}
		if (data === "y") {
			void this.copy();
			return;
		}
		if (data === "q") {
			this.requestQuit();
		}
	}
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((block) => {
		if (typeof block !== "object" || block === null) return [];
		const value = block as Record<string, unknown>;
		return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
	}).join("\n");
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function compactDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "?";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

function compactJobStatus(status: string): string {
	if (status.startsWith("handed off") || status.includes("handing off")) return "handoff";
	if (status.includes("completed")) return "done";
	if (status.includes("aborted")) return "aborted";
	if (status.includes("failed")) return "failed";
	if (status.includes("faulted")) return "faulted";
	if (status.includes("running")) return "running";
	if (status.includes("pending")) return "pending";
	if (status.includes("waiting")) return "wait";
	if (status.includes("sleeping")) return "sleep";
	if (status.includes("completing")) return "finish";
	if (status.includes("reporting")) return "report";
	if (status.includes("blocked")) return "blocked";
	return status;
}
