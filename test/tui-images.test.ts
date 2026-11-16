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
import { createJobInCommit, findJobConversation, jobOptionsOf } from "../src/jobs.ts";

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

test("Enter job activation preserves Main-only attachments through refused Enter and one-shot queue sends and return to Main", async (t) => {
	const { runtime, dashboard, render, type } = await setup(t);
	const started = await runtime.root.commit((tx) => createJobInCommit(tx, "attachment-target", runtime.model, runtime.jobExtensions, runtime.cwd, jobOptionsOf(runtime.config)), runtime.context);
	await runtime.harness.abortTask(started.taskId, runtime.context);
	await runtime.harness.waitForTask(started.taskId, runtime.context);
	await dashboard.start();
	await type("\x16");
	await type("keep this image draft");
	await type("\t");
	await type("\r");
	await type("!"); // Immediate typing after activation must remain composer input.
	assert.match(render(), /to job #\d+ › keep this image draft!/);
	await type("\r");
	assert.match(render(), /images go to main only/);
	await dashboard.handleInput("\x1b[13;10u");
	assert.match(render(), /images go to main only/);
	assert.match(render(), /1 attached/);
	assert.match(render(), /keep this image draft/);
	const worker = (await findJobConversation(runtime.harness, Number(started.taskId), runtime.context))!;
	assert.equal((await worker.entries({ order: "ascending" }, 100, undefined, runtime.context)).items.filter((entry) => entry.kind === "pi.user").length, 0);
	await type("\x14");
	await type("\r");
	const entries = await runtime.root.entries({ order: "ascending" }, 100, undefined, runtime.context);
	const input = entries.items.findLast((entry) => entry.kind === "pi.user")!;
	assert.match(JSON.stringify(input.model), /keep this image draft/);
	assert.match(JSON.stringify(input.model), /"type":"image"/);
});
