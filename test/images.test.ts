import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createImagePaster, supportsImages } from "../src/images.ts";

// A 1x1 PNG that decodes, so the paster passes it through unchanged.
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);

function pngPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "durable-chat-images-"));
	const path = join(dir, "shot.png");
	writeFileSync(path, PNG);
	return path;
}

test("a pasted file becomes an attachment the model can take", async () => {
	const path = pngPath();
	const attachment = await createImagePaster(undefined).fromPath(path);
	assert.equal(attachment.mimeType, "image/png");
	assert.equal(Buffer.from(attachment.data, "base64").equals(PNG), true);
	assert.equal(attachment.source, path);
});

test("a file that is not an image format providers take inline is refused", async () => {
	const dir = mkdtempSync(join(tmpdir(), "durable-chat-images-"));
	const path = join(dir, "notes.txt");
	writeFileSync(path, "not an image\n");
	await assert.rejects(() => createImagePaster(undefined).fromPath(path), /not an image format/);
});

test("the clipboard is reported as unavailable instead of failing silently", async () => {
	await assert.rejects(() => createImagePaster(undefined).paste(), /clipboard is unavailable/);
});

test("image input follows the model's declared modality", () => {
	const faux = fauxProvider({ tokensPerSecond: 60 });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = models.getModel("faux", "faux-1");
	assert.ok(model !== undefined);
	assert.equal(supportsImages(model), true);
	assert.equal(supportsImages({ ...model, input: ["text"] }), false);
});
