import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { openRuntime } from "../src/harness.ts";
import type { ImageAttachment, ImagePaster } from "../src/images.ts";
import { Dashboard } from "../src/tui/app.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const paster: ImagePaster = {
	paste: async () => [{ source: "clipboard", data: PNG, mimeType: "image/png" }],
	fromPath: async (source) => ({ source, data: PNG, mimeType: "image/png" }),
};

async function setup(t: TestContext) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "dchat-tui-images-")));
	const configPath = join(dir, "config.yaml");
	writeFileSync(configPath, "provider: faux\nmcp:\n  enabled: false\n");
	const runtime = await openRuntime({ configPath, storePath: join(dir, "store.sqlite"), withMcp: false });
	const dashboard = new Dashboard({ runtime, rows: () => 30, requestRender: () => {}, onQuit: () => {}, paster });
	t.after(async () => {
		await dashboard.stop();
		await runtime.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const render = () => dashboard.render(140).map(stripTerminalSequences).join("\n");
	const type = async (text: string) => {
		for (const character of text) await dashboard.handleInput(character);
	};
	return { runtime, dashboard, render, type };
}

test("ctrl+v attaches a pasted image and the next message to main carries it", async (t) => {
	const { runtime, render, type } = await setup(t);
	await type("\x16");
	assert.match(render(), /attached clipboard/);
	await type("look at this");
	await type("\r");

	const before = await runtime.root.entries({ order: "ascending" }, 100, undefined, runtime.context);
	const user = before.items.filter((entry) => entry.kind === "pi.user").at(-1);
	assert.ok(user !== undefined);
	const content = (user.model as readonly { role?: string; content?: unknown }[]).find((message) => message.role === "user")?.content;
	assert.ok(Array.isArray(content));
	assert.ok(content.some((block) => (block as { type?: string })?.type === "image"));
});

test("paste is refused when the model has no image input", async (t) => {
	const { runtime, render, type } = await setup(t);
	t.mock.method(runtime, "supportsImages", () => false);
	await type("\x16");
	assert.match(render(), /does not take image input/);

	const history = await runtime.root.entries({ order: "ascending" }, 100, undefined, runtime.context);
	assert.equal(history.items.filter((entry) => entry.kind === "pi.user").length, 0);
});

test("paste is refused for a job target, because attachments go to main only", async (t) => {
	const { runtime, render, type } = await setup(t);
	await type("/new job work\r");
	// A new job becomes the target, so a paste must be refused rather than sent to the job.
	assert.match(render(), /to job #\d+/);
	await type("\t"); // focus the composer
	await type("\x16");
	assert.match(render(), /images go to main only/);
});
