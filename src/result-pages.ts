import { createHash } from "node:crypto";
import { int, obj, opt, oneOf, str } from "@earendil-works/pi-schema";

export const resultPageSchema = obj({
	text: str({ description: "Exact response slice, with whitespace preserved; concatenate in page order." }),
	display: str({ description: "Model-facing page text and paging suffix. Print this in codemode, one page per run." }),
	page: int({ minimum: 1 }), totalPages: int({ minimum: 1 }), remainingPages: int({ minimum: 0 }),
	revision: str(), start: int(), end: int(), totalBytes: int(), remainingBytes: int(), remainingEstimatedTokens: int(),
	nextCall: opt(obj({ action: oneOf(["result"]), id: str(), page: int(), revision: str() })),
});

/** Not a model tokenizer or an upper bound: a UTF-8-byte / 4 estimate, fixed across restarts. */
export const RESULT_PAGE_ESTIMATED_TOKENS = 5000;
const PAGE_BYTES = RESULT_PAGE_ESTIMATED_TOKENS * 4;
// Leave headroom under the native tool's 2,000-line / 50-KiB output caps.
const PAGE_NEWLINES = 1400;

export type ResultPage = {
	text: string;
	page: number;
	totalPages: number;
	remainingPages: number;
	revision: string;
	start: number;
	end: number;
	totalBytes: number;
	remainingBytes: number;
	remainingEstimatedTokens: number;
	nextCall?: { action: "result"; id: string; page: number; revision: string };
};

/** Code-point boundaries, no normalization, trimming, indentation, or lost delimiters. */
export function resultPage(text: string, id: number, page = 1, expectedRevision?: string): ResultPage {
	if (!Number.isSafeInteger(page) || page < 1) throw new Error("Page must be a positive safe integer (first page is 1).");
	const revision = `v1:${createHash("sha256").update(text).digest("hex")}`;
	if (expectedRevision !== undefined && expectedRevision !== revision) throw new Error("Result revision changed. Restart at page 1; do not combine revisions.");
	if (page > 1 && expectedRevision === undefined) throw new Error("Pages after 1 require the revision from page 1 or its exact next call.");
	const ranges: { start: number; end: number; bytes: number }[] = [];
	let start = 0;
	let end = 0;
	let bytes = 0;
	let newlines = 0;
	let totalBytes = 0;
	for (const point of text) {
		const size = Buffer.byteLength(point, "utf8");
		if (bytes + size > PAGE_BYTES || (point === "\n" && newlines === PAGE_NEWLINES)) {
			ranges.push({ start, end, bytes });
			start = end;
			bytes = 0;
			newlines = 0;
		}
		end += point.length;
		bytes += size;
		totalBytes += size;
		if (point === "\n") newlines++;
	}
	ranges.push({ start, end, bytes });
	if (page > ranges.length) throw new Error(`Page ${page} is out of range; this result has ${ranges.length} page(s).`);
	const range = ranges[page - 1]!;
	const consumed = ranges.slice(0, page).reduce((sum, item) => sum + item.bytes, 0);
	const remainingBytes = totalBytes - consumed;
	return {
		text: text.slice(range.start, range.end), page, totalPages: ranges.length,
		remainingPages: ranges.length - page, revision, start: range.start, end: range.end,
		totalBytes, remainingBytes, remainingEstimatedTokens: Math.ceil(remainingBytes / 4),
		...(page === ranges.length ? {} : { nextCall: { action: "result" as const, id: String(id), page: page + 1, revision } }),
	};
}

/** The suffix is outside the response text; scripts use the structured text field to reassemble. */
export function formatResultPage(page: ResultPage): string {
	return `--- response text ---\n${page.text}\n--- end response text ---\n` +
		`[${page.totalPages > 1 ? "PAGED" : "COMPLETE"} result: page ${page.page}/${page.totalPages}; ` +
		`${page.remainingPages} page(s) remaining; ${page.remainingBytes} UTF-8 bytes remaining ` +
		`(~${page.remainingEstimatedTokens} estimated tokens, UTF-8 bytes / 4; not a tokenizer). ` +
		`Text offsets ${page.start}..${page.end} (UTF-16); revision ${page.revision}.]\n` +
		(page.nextCall === undefined ? "End of stored response." :
			`Next tool call: task(${JSON.stringify(page.nextCall)})\n` +
			`Codemode: text((await tools.task(${JSON.stringify(page.nextCall)})).display);`);
}
