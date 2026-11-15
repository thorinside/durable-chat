import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { NativeClipboard } from "@earendil-works/pi-tui";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { DEFAULT_IMAGE_LIMITS, type ImageLimits, type ImageProcessor } from "@earendil-works/pi-durable/tools";

/** One image ready to go into a user message. `source` is what the transcript and the toast show. */
export type ImageAttachment = { source: string; data: string; mimeType: string };

/** Providers only send image blocks when the model declares image input; otherwise they drop them. */
export function supportsImages(model: Model<Api>): boolean {
	return model.input.includes("image");
}

export const MAX_ATTACHMENTS = 4;

/** Formats providers take inline; the image processor converts the others, such as BMP, to PNG. */
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MIME_BY_EXTENSION: Record<string, string> = {
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};

/** The extension decides when there is one; a clipboard image is bytes with no name, so read its signature. */
function mimeOf(source: string, bytes: Uint8Array): string {
	const known = MIME_BY_EXTENSION[extname(source).toLowerCase()];
	if (known !== undefined) return known;
	if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
	if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
	if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
		&& bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
	return "application/octet-stream";
}

export type ImagePaster = {
	/** Clipboard file URLs, or the clipboard image when the clipboard holds no files. */
	paste(): Promise<ImageAttachment[]>;
	/** A file path, for hosts where the native clipboard helper is unavailable. */
	fromPath(path: string): Promise<ImageAttachment>;
};

/** Photon prepares images on a worker thread, so a large photo does not stall the TUI's event loop. */
export function createImagePaster(clipboard: NativeClipboard | undefined, limits: ImageLimits = DEFAULT_IMAGE_LIMITS): ImagePaster {
	let processor: ImageProcessor | undefined;
	const prepare = async (bytes: Uint8Array, source: string): Promise<ImageAttachment> => {
		const mimeType = mimeOf(source, bytes);
		if (!INLINE_TYPES.has(mimeType)) throw new Error(`${source} is not an image format providers take inline.`);
		processor ??= await createNodePhotonImages();
		// A Buffer's pool buffer cannot be transferred to the Photon worker, so pass a plain Uint8Array.
		const prepared = await processor.prepare(new Uint8Array(bytes), mimeType, limits);
		if (prepared === undefined) throw new Error(`${source} cannot be decoded or made to fit the image limits.`);
		return { source, data: prepared.data, mimeType: prepared.mimeType };
	};
	return {
		async paste() {
			if (clipboard === undefined) throw new Error("The clipboard is unavailable in this environment.");
			const paths = await clipboard.getFilePaths?.();
			if (paths !== undefined && paths !== null) return Promise.all(paths.map((path) => prepare(readFileSync(path), path)));
			const image = await clipboard.getImage();
			if (image === undefined) throw new Error("This terminal cannot read a clipboard image.");
			if (image === null) return [];
			return [await prepare(image, "clipboard")];
		},
		fromPath: (path) => prepare(readFileSync(path), path),
	};
}

export function attachmentLabel(attachments: readonly ImageAttachment[]): string {
	return attachments.map((attachment) => basename(attachment.source)).join(", ");
}
