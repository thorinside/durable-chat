import { defineDoc } from "@earendil-works/pi-durable";
import type { TaskId, Tx } from "@earendil-works/pi-durable";
import type { AnyTaskRecord } from "./format.ts";
import { JOB_KIND } from "./tasks.ts";

export type JobTagIndex = { byJob: Record<string, string[]> };

/** Labels outlive job tasks; the session index is their single mutable source of truth. */
export const JobTags = defineDoc<JobTagIndex>({
	kind: "durable-chat.job-tags", version: 1, scope: "session",
	initial: () => ({ byJob: {} }), checkpointWhen: () => false,
});

export function normalizeTags(tags: readonly string[]): string[] {
	const normalized = [...new Set(tags.map((tag) => tag.trim().toLowerCase()))];
	if (normalized.length > 8 || normalized.some((tag) => !/^[a-z0-9][a-z0-9._-]{0,47}$/.test(tag))) {
		throw new Error("Use at most 8 tags, each 1–48 letters/digits with optional dots, hyphens, or underscores.");
	}
	return normalized;
}

/** For a just-created or already validated job; performs only document writes. */
export async function writeJobTags(tx: Tx, id: TaskId, tags: readonly string[]): Promise<void> {
	const labels = await tx.doc(JobTags);
	if (tags.length === 0) delete labels.byJob[String(id)];
	else labels.byJob[String(id)] = [...tags];
}

export async function setJobTags(tx: Tx, id: TaskId, tags: readonly string[]): Promise<string[]> {
	const normalized = normalizeTags(tags);
	if ((await tx.task(id))?.kind !== JOB_KIND) throw new Error(`No job #${id}.`);
	await writeJobTags(tx, id, normalized);
	return normalized;
}

export function taggedJob(record: AnyTaskRecord, index: Readonly<JobTagIndex> | undefined): AnyTaskRecord {
	return { ...record, tags: [...(index?.byJob[String(record.id)] ?? [])] };
}

/** Resolve at call time. Ambiguity is explicit rather than silently choosing a different prepared context. */
export function resolveTaggedSource(source: string, index: Readonly<JobTagIndex> | undefined): string {
	if (!source.startsWith("tag:")) return source;
	const tag = normalizeTags([source.slice(4)])[0]!;
	const matches = Object.entries(index?.byJob ?? {}).filter(([, tags]) => tags.includes(tag)).map(([id]) => id);
	if (matches.length === 0) throw new Error(`No job has tag ${tag}.`);
	if (matches.length > 1) throw new Error(`Tag ${tag} matches jobs ${matches.map((id) => `#${id}`).join(", ")}. Choose an id or make the tag unique.`);
	return matches[0]!;
}
