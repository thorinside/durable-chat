import { Buffer } from "node:buffer";
import childProcess from "node:child_process";
import { getNativeClipboard } from "@earendil-works/pi-tui";
import type { NativeClipboard } from "@earendil-works/pi-tui";

/** OSC 52 has no delivery acknowledgement: sent is not the same as copied. */
export type CopyResult = boolean | string | { status: "sent" };
export type CopyText = (text: string) => Promise<CopyResult>;

type ClipboardOptions = {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	isTTY?: boolean;
	nativeClipboard?: () => NativeClipboard | undefined;
	write?: (sequence: string) => Promise<void>;
};

function pbcopy(text: string, env: NodeJS.ProcessEnv): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = childProcess.spawn("/usr/bin/pbcopy", [], {
			shell: false,
			stdio: ["pipe", "ignore", "ignore"],
			timeout: 3000,
			// pbcopy decodes stdin using the locale, not necessarily UTF-8 by default.
			env: { ...env, LC_ALL: "en_US.UTF-8" },
		});
		let inputError: Error | undefined;
		child.on("error", reject);
		child.stdin.on("error", (error) => { inputError = error; });
		child.on("close", (code, signal) => {
			if (code === 0 && !signal && !inputError) resolve();
			else reject(inputError ?? new Error("pbcopy failed"));
		});
		// Transcript content is only stdin data: never shell source or process arguments.
		child.stdin.end(text, "utf8");
	});
}

/** Shared by transcript selection and keyboard answer copy. Never reads the clipboard. */
export function createTextCopier(options: ClipboardOptions = {}): CopyText {
	return async (text) => {
		const env = options.env ?? process.env;
		const platform = options.platform ?? process.platform;
		const remote = Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);
		try {
			if (!(options.isTTY ?? process.stdout.isTTY)) return "Copy unavailable: no terminal clipboard transport.";
			// Local tmux still shares the Mac pasteboard. Over SSH, native helpers would
			// write to the remote host instead of the terminal user's clipboard.
			if (platform === "darwin" && !remote) {
				try {
					const clipboard = (options.nativeClipboard ?? getNativeClipboard)();
					if (clipboard?.setText) { await clipboard.setText(text); return true; }
				} catch { /* Fall back when the optional native helper cannot load or write. */ }
				await pbcopy(text, env);
				return true;
			}
			if (env.TERM_PROGRAM === "Apple_Terminal") return "Copy unavailable: Apple Terminal does not support OSC 52. Use native terminal selection.";
			let sequence = `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`;
			if (env.TMUX) sequence = `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
			await (options.write ?? ((data) => new Promise<void>((resolve, reject) => {
				process.stdout.write(data, (error) => error ? reject(error) : resolve());
			})))(sequence);
			return { status: "sent" };
		} catch {
			return "Copy failed: clipboard transport unavailable.";
		}
	};
}

export function copyNotice(result: CopyResult): { text: string; kind: "info" | "error" } {
	if (result === true) return { text: "copied to clipboard", kind: "info" };
	if (typeof result === "object") return { text: "Copy sent via OSC 52 (unconfirmed)", kind: "info" };
	return { text: typeof result === "string" ? result : "Copy failed", kind: "error" };
}
