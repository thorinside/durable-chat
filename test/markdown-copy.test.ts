import { test } from "node:test";
import assert from "node:assert/strict";
import { Markdown, getCapabilities, getOsc8LinkAtColumn, setCapabilities, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { renderCopyableMarkdown, type MarkdownCopyLine } from "../src/tui/markdown-copy.ts";
import { TranscriptSelection } from "../src/tui/selection.ts";

const identity = (text: string) => text;
const theme: MarkdownTheme = {
	codeBlockIndent: "", heading: identity, link: identity, linkUrl: identity,
	code: identity, codeBlock: identity, codeBlockBorder: identity, quote: identity,
	quoteBorder: identity, hr: identity, listBullet: identity, bold: identity,
	italic: identity, strikethrough: identity, underline: identity,
};
const style = { color: identity };
const open = (url: string) => `\x1b]8;;${url}\x1b\\`;
const close = "\x1b]8;;\x1b\\";

function copy(rows: MarkdownCopyLine[], first = 0, last = rows.length - 1): string[] {
	const copied: string[] = [];
	const selection = new TranscriptSelection(async (text) => { copied.push(text); return true; }, () => {}, () => {}, () => {});
	selection.update({ x: 0, y: 0, width: 200, lines: rows.map((row) => row.text), copyBounds: rows.map((row) => ({
		...row, copyStart: row.copyStart ?? 0, copyEnd: row.copyEnd ?? visibleWidth(stripTerminalSequences(row.text).trimEnd()),
	})) });
	const event = { button: "left" as const, shift: false, alt: false, ctrl: false };
	selection.handle({ ...event, type: "press", x: 0, y: first });
	selection.handle({ ...event, type: "drag", x: 199, y: last });
	selection.handle({ ...event, type: "release", x: 199, y: last });
	return copied;
}

// The existing rail/wrap tests contain no OSC 8 controls, so they cannot detect
// real hyperlink closes being consumed as semantic annotation closes.
test("OSC 8 links inside code preserve full copy and do not link the following code or prose", () => {
	const source = `before ${open("https://example.test")}link${close} after`;
	const rows = renderCopyableMarkdown(`\`\`\`\n${source}\n\`\`\`\n\nfollowing prose`, 80, theme, style);
	const row = rows.find((row) => stripTerminalSequences(row.text).trimEnd() === "before link after")!;
	assert.ok(row);
	assert.equal(row.copyEnd, visibleWidth("before link after"));
	assert.deepEqual(copy(rows, 0, rows.findLastIndex((row) => row.copySkip)), ["before link after"]);
	for (let column = 0; column < visibleWidth(row.text); column++) {
		assert.equal(getOsc8LinkAtColumn(row.text, column), column >= 7 && column < 11 ? "https://example.test" : undefined);
	}
	const following = rows.findIndex((row) => row.text.includes("following prose"));
	assert.deepEqual(copy(rows, following, following), ["following prose"]);
	assert.equal(getOsc8LinkAtColumn(rows[following]!.text, 0), undefined);
});

test("user links matching old annotation IDs remain ordinary links even when followed by a code fence", (t) => {
	const capabilities = getCapabilities();
	setCapabilities({ ...capabilities, hyperlinks: true });
	t.after(() => setCapabilities(capabilities));
	const text = "[ordinary link](dchat-internal-code:0)\n\n```\nactual code\n```";
	const rows = renderCopyableMarkdown(text, 80, theme, style);
	const row = rows.findIndex((row) => row.text.includes("ordinary link"));
	assert.ok(row >= 0);
	assert.equal(rows[row]!.copySkip, false);
	assert.equal(rows[row]!.code, undefined);
	assert.equal(getOsc8LinkAtColumn(rows[row]!.text, 0), "dchat-internal-code:0");
	assert.deepEqual(copy(rows, row, row), ["ordinary link"]);
	assert.deepEqual(copy(rows, rows.findIndex((row) => row.copySkip)), ["actual code"]);
});

test("mixed OSC 8 events retain terminal replacement semantics and balanced links across nested code wraps", (t) => {
	const capabilities = getCapabilities();
	setCapabilities({ ...capabilities, hyperlinks: true });
	t.after(() => setCapabilities(capabilities));
	// OSC 8 is replacement state, not a stack: closing the inner URL must not
	// resurrect the outer URL. Exercise params and both legal terminators too.
	const source = `start ${open("https://outer.test")}outer \x1b]8;id=inner;https://inner.test\x07inner\x1b]8;;\x07 unlinked${close} middle ${open("https://last.test")}longlinkedword longlinkedword longlinkedword${close} end`;
	const text = ["```", source, "second code line", "```"].map((line) => `> > ${line}`).join("\n")
		+ "\n\n[following link](https://following.test) tail";
	for (const width of [22, 35, 200]) {
		const rows = renderCopyableMarkdown(text, width, theme, style);
		const plain = new Markdown(text, 0, 0, theme, style, { renderLatex: false }).render(width);
		assert.deepEqual(rows.map((row) => stripTerminalSequences(row.text)), plain.map(stripTerminalSequences));
		assert.ok(rows.every((row) => !row.text.includes("dchat-internal-code:")), "no private transport reaches the screen");
		const codeRows = rows.filter((row) => row.code);
		assert.deepEqual(copy(rows, 0, rows.findLastIndex((row) => row.copySkip)), [stripTerminalSequences(source) + "\nsecond code line"]);
		for (const row of codeRows) {
			const fragment = stripTerminalSequences(row.text).slice(row.copyStart, row.copyEnd);
			const span = row.code!;
			// Compute expected terminal state from the unwrapped source prefix, not
			// from the annotation parser or its physical-row close/reopen logic.
			for (let col = 0; col < fragment.length; col++) {
				const expected = getOsc8LinkAtColumn(source, span.start + col);
				assert.equal(getOsc8LinkAtColumn(row.text, row.copyStart! + col), span.source === stripTerminalSequences(source) ? expected : undefined);
			}
			assert.equal(getOsc8LinkAtColumn(row.text, 0), undefined, "quote rails stay outside links");
			assert.equal(getOsc8LinkAtColumn(row.text + " padding", visibleWidth(row.text)), undefined, "links close before row padding");
		}
		const following = rows.findIndex((row) => stripTerminalSequences(row.text).includes("following link"));
		assert.ok(following >= 0);
		assert.equal(getOsc8LinkAtColumn(rows[following]!.text, 0), "https://following.test");
		assert.deepEqual(copy(rows, following, following), ["following link tail"]);
	}
});
