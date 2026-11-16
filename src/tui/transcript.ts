import type { Context } from "@earendil-works/chord/context";
import type { Conversation, ConversationView, ConversationWatch, Cursor, EntryRecord, UsageState } from "@earendil-works/pi-durable";
import { formatEntryLines, formatLiveLines, transcriptLine, type TranscriptLine, type LiveView } from "./format.ts";
import { estimateContextTokens } from "../context-usage.ts";

const INITIAL_ENTRIES = 80;
const OLDER_ENTRIES = 60;
const MAX_ENTRIES = 1200;

/**
 * One conversation's display history. The watch delivers the newest window; the
 * class merges it with pages loaded above it, so scrolling up survives the window
 * dropping old entries.
 */
export class Transcript {
	readonly conversation: Conversation;
	entries: EntryRecord[] = [];
	live: LiveView | undefined;
	inbox = 0;
	usage: UsageState | undefined;
	contextTokens: number | undefined;
	contextWindow = 0;
	hasOlder = false;
	loadingOlder = false;
	private context: Context | undefined;
	private meterTimer: NodeJS.Timeout | undefined;
	private cursor: Cursor | undefined;
	private watch: ConversationWatch | undefined;
	private version = 0;
	private cache: { version: number; width: number; tools: boolean; lines: TranscriptLine[] } | undefined;
	onUpdate: () => void = () => undefined;

	constructor(conversation: Conversation) {
		this.conversation = conversation;
	}

	async start(context: Context, contextWindow: number): Promise<void> {
		this.context = context;
		this.contextWindow = contextWindow;
		const page = await this.conversation.entries({ order: "descending" }, INITIAL_ENTRIES, undefined, context);
		this.entries = [...page.items].reverse();
		this.cursor = page.next;
		this.hasOlder = page.next !== undefined;
		this.watch = await this.conversation.watch(context, { min: 40, max: 100 });
		this.watch.start(async (call) => {
			if (call.kind !== "value") return;
			this.merge(call.value);
			this.onUpdate();
		});
		this.merge(this.watch.value);
		await this.refreshMeter();
	}

	private scheduleMeter(): void {
		if (this.context === undefined) return;
		if (this.meterTimer !== undefined) clearTimeout(this.meterTimer);
		this.meterTimer = setTimeout(() => {
			this.meterTimer = undefined;
			void this.refreshMeter();
		}, 200);
		this.meterTimer.unref?.();
	}

	private async refreshMeter(): Promise<void> {
		const context = this.context;
		if (context === undefined) return;
		try {
			const view = await this.conversation.context(context);
			this.contextTokens = estimateContextTokens(view);
			this.onUpdate();
		} catch {
			// A transient read failure leaves the previous estimate in place.
		}
	}

	private merge(view: ConversationView): void {
		const beforeLength = this.entries.length;
		const beforeLast = this.entries.at(-1)?.id;
		const byId = new Map<number, EntryRecord>();
		for (const entry of this.entries) byId.set(Number(entry.id), entry);
		for (const entry of view.entries) byId.set(Number(entry.id), entry);
		this.entries = [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
		if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.slice(-MAX_ENTRIES);
		const docs = view.docs as Record<string, unknown>;
		this.live = docs["pi.live"] as LiveView | undefined;
		const inbox = docs["pi.inbox"] as { items?: unknown[] } | undefined;
		this.inbox = Array.isArray(inbox?.items) ? inbox.items.length : 0;
		this.usage = docs["pi.usage"] as UsageState | undefined;
		if (this.entries.length !== beforeLength || this.entries.at(-1)?.id !== beforeLast) {
			this.touch();
			this.scheduleMeter();
		}
	}

	private touch(): void {
		this.version++;
		this.cache = undefined;
	}

	async older(context: Context): Promise<boolean> {
		if (this.cursor === undefined || this.loadingOlder) return false;
		this.loadingOlder = true;
		try {
			const page = await this.conversation.entries({ order: "descending" }, OLDER_ENTRIES, this.cursor, context);
			const byId = new Map<number, EntryRecord>();
			for (const entry of page.items) byId.set(Number(entry.id), entry);
			for (const entry of this.entries) byId.set(Number(entry.id), entry);
			this.entries = [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
			this.cursor = page.next;
			this.hasOlder = page.next !== undefined;
			this.touch();
			this.onUpdate();
			return page.items.length > 0;
		} finally {
			this.loadingOlder = false;
		}
	}

	/** Committed transcript lines for one width. */
	lines(width: number, toolsExpanded: boolean): TranscriptLine[] {
		const cached = this.cache;
		if (cached !== undefined && cached.version === this.version && cached.width === width && cached.tools === toolsExpanded) {
			return cached.lines;
		}
		const lines: TranscriptLine[] = [];
		for (const entry of this.entries) {
			const formatted = formatEntryLines(entry, { width, toolsExpanded });
			if (formatted.length > 0) {
				lines.push(...formatted, transcriptLine(""));
			}
		}
		this.cache = { version: this.version, width, tools: toolsExpanded, lines };
		return lines;
	}

	liveLines(width: number): TranscriptLine[] {
		return formatLiveLines(this.live, width);
	}

	get modelCount(): number {
		const usage = this.usage;
		if (usage === undefined) return 0;
		return Object.keys(usage.models).length;
	}

	async stop(): Promise<void> {
		if (this.meterTimer !== undefined) clearTimeout(this.meterTimer);
		this.meterTimer = undefined;
		await this.watch?.stop();
		this.watch = undefined;
	}
}
