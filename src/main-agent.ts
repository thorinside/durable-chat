import { createHmac, timingSafeEqual } from "node:crypto";
import type { Cursor, EntryRecord, LiveState } from "@earendil-works/pi-durable";

/** The local IPC peer is trusted as the Unix owner. Substrate must construct this from authenticated context, never model input. */
export type AgentOrigin = {
	system: "substrate";
	workspaceId: string;
	projectId: string;
	runnerId: string;
	grantId: string;
	principalKind: "apiKey" | "chat" | "service" | "job";
	principalId: string;
	jobAttempt?: number;
};
export const AGENT_MESSAGE_KIND = "app.agent-message";
export const AGENT_MESSAGING_VERSION = 1;
export const MAX_AGENT_REQUESTS = 1024;
export const MAX_READ_ENTRIES = 20;
export const MAX_READ_TEXT = 2000;

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
	return value as Record<string, unknown>;
}

export function parseAgentOrigin(value: unknown): AgentOrigin {
	const input = record(value);
	const fields = ["workspaceId", "projectId", "runnerId", "grantId", "principalKind", "principalId"] as const;
	if (Object.keys(input).some((key) => !["system", ...fields, "jobAttempt"].includes(key)))
		throw new Error("Unsupported agent origin field");
	if (input.system !== "substrate" || !["apiKey", "chat", "service", "job"].includes(String(input.principalKind)))
		throw new Error("Unsupported agent origin");
	for (const field of fields)
		if (typeof input[field] !== "string" || !input[field] || input[field].length > 200 || /[\x00-\x1f\x7f]/.test(input[field]))
			throw new Error(`Invalid agent origin ${field}`);
	if (input.principalKind === "job") {
		if (!Number.isSafeInteger(input.jobAttempt) || (input.jobAttempt as number) < 1)
			throw new Error("Job origin requires its current attempt");
	} else if (input.jobAttempt !== undefined) throw new Error("Only job origin has a jobAttempt");
	// Canonical key ordering also makes the deduplication fingerprint independent of JSON object order.
	return {
		system: "substrate", workspaceId: input.workspaceId as string, projectId: input.projectId as string,
		runnerId: input.runnerId as string, grantId: input.grantId as string,
		principalKind: input.principalKind as AgentOrigin["principalKind"], principalId: input.principalId as string,
		...(input.jobAttempt === undefined ? {} : { jobAttempt: input.jobAttempt as number }),
	};
}

/** Snapshot of producer-known run control only. Missing live state is not idle. No entries, prompts, tools or generation are accessed. */
export function mainStatus(live: Pick<LiveState, "run"> | undefined, observedAt: number) {
	return { availability: "online" as const, activity: live === undefined ? "unknown" : live.run ? "running" : "idle", observedAt };
}

/** Stable caller/target namespace: rotating or revoking a grant must not defeat admission deduplication. */
export function agentRequestScope(origin: AgentOrigin) {
	const { grantId: _grantId, ...principal } = origin;
	return principal;
}

export function parseAgentAttachment(value: unknown) {
	const input = record(value);
	if (Object.keys(input).some((key) => !["origin", "read", "send"].includes(key)) ||
		typeof input.read !== "boolean" || typeof input.send !== "boolean" || (!input.read && !input.send))
		throw new Error("Agent attachment requires explicit read and send capabilities");
	return { origin: parseAgentOrigin(input.origin), read: input.read, send: input.send };
}

export function parseMainRead(params: Record<string, unknown>): { limit: number; cursor?: string } {
	const limit = params.limit ?? 10;
	if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_READ_ENTRIES)
		throw new Error(`limit must be between 1 and ${MAX_READ_ENTRIES}`);
	if (params.cursor === undefined) return { limit: limit as number };
	if (typeof params.cursor !== "string" || params.cursor.length > 4096) throw new Error("Invalid Main read cursor");
	return { limit: limit as number, cursor: params.cursor };
}

/** Runtime- and principal-scoped opaque cursor: a peer cannot forge native storage query state. */
export function encodeMainCursor(cursor: Cursor, secret: string, scope: string): string {
	const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
	const mac = createHmac("sha256", secret).update(`${scope}:${payload}`).digest("base64url");
	return `${payload}.${mac}`;
}
export function decodeMainCursor(value: string, secret: string, scope: string): Cursor {
	const [payload, supplied, extra] = value.split(".");
	const expected = createHmac("sha256", secret).update(`${scope}:${payload}`).digest("base64url");
	if (!supplied || extra !== undefined || !/^[A-Za-z0-9_-]{43}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)))
		throw new Error("Invalid or expired Main cursor; start a new read");
	return record(JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"))) as Cursor;
}

/** Text-only committed native messages. Deliberately excludes system, reasoning, tool arguments and tool output. */
export function mainReadEntry(entry: EntryRecord) {
	if (!["pi.user", "pi.assistant", AGENT_MESSAGE_KIND].includes(entry.kind)) return [];
	const content = (entry.model ?? []).flatMap((message) => {
		if (message.role !== "user" && message.role !== "assistant") return [];
		return typeof message.content === "string" ? [message.content] : message.content.flatMap((block) => block.type === "text" ? [block.text] : []);
	}).join("\n");
	if (!content) return [];
	const origin = entry.kind === AGENT_MESSAGE_KIND ? parseAgentOrigin((entry.data as { origin?: unknown })?.origin) : undefined;
	return [{
		id: String(entry.id), role: origin ? "agent" : entry.kind === "pi.user" ? "human" : "assistant",
		text: content.slice(0, MAX_READ_TEXT), truncated: content.length > MAX_READ_TEXT,
		...(origin ? { origin, requestId: (entry.data as { requestId: string }).requestId } : {}),
	}];
}
