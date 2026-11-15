import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { backgroundLine, formatEntry, formatLive, shortenHome } from "../src/tui/format.ts";

test("terminal paths use a home-relative directory only for home and its descendants", () => {
	const home = join(dirname(homedir()), "test-user");
	assert.equal(shortenHome(home, home), "~");
	assert.equal(shortenHome(join(home, "projects", "durable chat"), home), join("~", "projects", "durable chat"));
	const sibling = `${home}-other`;
	assert.equal(shortenHome(join(sibling, "project"), home), join(sibling, "project"));
	assert.equal(shortenHome(dirname(home), home), dirname(home));
	assert.equal(shortenHome(join(homedir(), "projects")), join("~", "projects"));
});

function entry(kind: string, model: EntryRecord["model"]): EntryRecord {
	return { id: 1 as EntryRecord["id"], conversationId: ROOT_CONVERSATION_ID, kind, model };
}

function plain(lines: string[]): string {
	return lines.map((line) => stripVTControlCharacters(line).trimEnd()).join("\n");
}

test("row backgrounds survive nested style resets, fill padding, and reset before the neighboring pane", () => {
	const rendered = backgroundLine("a\x1b[0mb\x1b[49mc\x1b[md", 8, 16);
	let background: number | undefined;
	let text = "";
	for (const match of rendered.matchAll(/\x1b\[([0-9;]*)m|([^\x1b]+)/g)) {
		if (match[1] !== undefined) {
			const codes = match[1].length === 0 ? [0] : match[1].split(";").map(Number);
			if (codes[0] === 48 && codes[1] === 5) background = codes[2];
			else if (codes.includes(0) || codes.includes(49)) background = undefined;
		} else {
			assert.equal(background, 16);
			text += match[2];
		}
	}
	assert.equal(text, "abcd    ");
	assert.equal(background, undefined);
});

test("live formatting shows only in-flight tools, not completed duplicates", () => {
	const lines = formatLive({
		tools: [
			{ callId: "a", name: "read", status: "done" },
			{ callId: "b", name: "bash", status: "running" },
			{ callId: "c", name: "edit", status: "pending" },
		],
	}, 80).join("\n");
	assert.match(lines, /bash running/);
	assert.match(lines, /edit pending/);
	assert.doesNotMatch(lines, /read done/);
});

test("committed and streaming assistant messages render Markdown instead of exposing prose delimiters", () => {
	const content = "# Summary\n\n**Ready** and *readable*, with `inline` code.\n\n- First item\n- Second item";
	const committed = formatEntry(entry("pi.assistant", [fauxAssistantMessage([fauxText(content)])]), { width: 60, toolsExpanded: false });
	const live = formatLive({ generation: { message: { content } } }, 60);
	assert.equal(plain(live), plain(committed));
	const text = plain(committed);
	assert.match(text, /Summary/);
	assert.match(text, /Ready and readable, with inline code\./);
	assert.match(text, /First item/);
	assert.match(text, /Second item/);
	assert.doesNotMatch(text, /# Summary|\*\*Ready\*\*|\*readable\*|`inline`/);
});

test("Markdown code stays literal and incomplete streaming fences remain readable", () => {
	const code = '  const value = "**literal**";';
	for (const content of [`\`\`\`ts\n${code}`, `\`\`\`ts\n${code}\n\`\`\``, `    ${code}`]) {
		const live = formatLive({ generation: { message: { content } } }, 80);
		const committed = formatEntry(entry("pi.assistant", [fauxAssistantMessage([fauxText(content)])]), { width: 80, toolsExpanded: false });
		assert.match(plain(live), /  const value = "\*\*literal\*\*";/);
		assert.equal(plain(live), plain(committed));
	}
});

test("Markdown links and long Unicode content fit the transcript width without losing content", () => {
	const content = "[Documentation](https://example.com)\n\n**Hello界界界界界界界界**\n\n```\nabcdefghijklmnopqrstuvwxyz\n```";
	for (const width of [8, 20, 60]) {
		const lines = formatLive({ generation: { message: { content } } }, width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		const joined = plain(lines).replace(/\s/g, "");
		assert.ok(joined.includes("Documentation"));
		assert.ok(joined.includes("Hello界界界界界界界界"));
		assert.ok(joined.includes("abcdefghijklmnopqrstuvwxyz"));
		// The renderer may use a terminal hyperlink or print the URL inline; both must retain the destination.
		assert.ok(lines.join("\n").includes("https://example.com") || joined.includes("https://example.com"));
	}
});

test("user messages and host prose render Markdown while tool results remain verbatim", () => {
	const user = { role: "user" as const, content: "**Important** `path.ts`", timestamp: 0 };
	for (const kind of ["pi.user", "app.job-notice"]) {
		const text = plain(formatEntry(entry(kind, [user]), { width: 80, toolsExpanded: false }));
		assert.match(text, /Important path\.ts/);
		assert.doesNotMatch(text, /\*\*Important\*\*|`path\.ts`/);
	}
	const tool = entry("pi.tool-result", [{
		role: "toolResult", toolCallId: "call-1", toolName: "bash", isError: false, timestamp: 0,
		content: [{ type: "text", text: "**Important** `path.ts`" }],
	}]);
	const output = plain(formatEntry(tool, { width: 80, toolsExpanded: true }));
	assert.match(output, /\*\*Important\*\* `path\.ts`/);
});
