import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import childProcess from "node:child_process";
import { createTextCopier, copyNotice } from "../src/tui/clipboard.ts";

const local = { platform: "darwin" as const, isTTY: true, env: { TERM_PROGRAM: "Apple_Terminal" } };
const forbidden = () => assert.fail("must not read the clipboard or use an unintended transport");

// Mouse tests inject a successful copier; they cannot protect the real transport choice.
function mockPbcopy(t: TestContext) {
	const calls: { command: string; args: string[]; options: { shell: boolean; timeout: number; env: NodeJS.ProcessEnv; stdio: string[] }; text?: string; encoding?: string }[] = [];
	const children: (EventEmitter & { stdin: EventEmitter & { end: (text: string, encoding: string) => void } })[] = [];
	t.mock.method(childProcess, "spawn", (command: string, args: string[], options: typeof calls[number]["options"]) => {
		const call: typeof calls[number] = { command, args, options };
		calls.push(call);
		const child = Object.assign(new EventEmitter(), { stdin: Object.assign(new EventEmitter(), {
			end: (text: string, encoding: string) => { call.text = text; call.encoding = encoding; },
		}) });
		children.push(child);
		return child as never;
	});
	return { calls, children };
}

test("local macOS Terminal, Ghostty and tmux copy through the toolkit native writer without reading the clipboard", async (t) => {
	t.mock.method(childProcess, "spawn", forbidden);
	const texts: string[] = [];
	const clipboard = { getText: forbidden, getImage: forbidden, getFilePaths: forbidden, setText: async (text: string) => { texts.push(text); } };
	for (const env of [{ TERM_PROGRAM: "Apple_Terminal" }, { TERM_PROGRAM: "ghostty" }, { TERM_PROGRAM: "tmux", TMUX: "/tmp/tmux" }]) {
		assert.equal(await createTextCopier({ ...local, env, nativeClipboard: () => clipboard, write: forbidden })("  code(界é🙂);\n\nnext"), true);
	}
	assert.deepEqual(texts, Array(3).fill("  code(界é🙂);\n\nnext"));
});

test("missing or failing native writers fall back to bounded pbcopy with literal UTF-8 stdin and await successful exit", async (t) => {
	const { calls, children } = mockPbcopy(t);
	const text = "  $(touch /tmp/not-executed); 'quotes'\n界é🙂  inside\n";
	for (const nativeClipboard of [() => undefined, () => { throw new Error("load failed"); }, () => ({ getText: forbidden, getImage: forbidden, setText: async () => { throw new Error("unavailable"); } })]) {
		let finished = false;
		const pending = createTextCopier({ ...local, env: { ...local.env, LC_ALL: "C" }, nativeClipboard, write: forbidden })(text).then((result) => { finished = true; return result; });
		await Promise.resolve(); await Promise.resolve();
		assert.equal(finished, false, "writing stdin alone is not a confirmed copy");
		const call = calls.at(-1)!;
		assert.equal(call.command, "/usr/bin/pbcopy");
		assert.deepEqual(call.args, []);
		assert.equal(call.options.shell, false);
		assert.equal(call.options.timeout, 3000);
		assert.deepEqual(call.options.stdio, ["pipe", "ignore", "ignore"]);
		assert.equal(call.options.env.LC_ALL, "en_US.UTF-8");
		assert.equal(call.text, text);
		assert.equal(call.encoding, "utf8");
		children.at(-1)!.emit("close", 0, null);
		assert.equal(await pending, true);
	}
});

test("pbcopy launch, stdin, exit and timeout failures never fall back to misleading OSC 52 success", async (t) => {
	const { children } = mockPbcopy(t);
	for (const failure of ["launch", "stdin", "exit", "timeout"]) {
		const pending = createTextCopier({ ...local, nativeClipboard: () => undefined, write: forbidden })("text");
		const child = children.at(-1)!;
		if (failure === "launch") child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }));
		if (failure === "stdin") child.stdin.emit("error", Object.assign(new Error("closed"), { code: "EPIPE" }));
		child.emit("close", failure === "stdin" ? 0 : 1, failure === "timeout" ? "SIGTERM" : null);
		assert.match(String(await pending), /Copy failed/);
	}
});

test("SSH never writes the remote macOS clipboard and OSC 52 sends exact text without claiming confirmed delivery", async (t) => {
	t.mock.method(childProcess, "spawn", forbidden);
	const text = "  exact 界é🙂\n\nend  ";
	for (const marker of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]) {
		for (const tmux of [false, true]) {
			const writes: string[] = [];
			const result = await createTextCopier({ ...local, env: { [marker]: "remote", ...(tmux ? { TMUX: "/tmp/tmux" } : {}) }, nativeClipboard: forbidden,
				write: async (sequence) => { writes.push(sequence); } })(text);
			let expected = `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`;
			if (tmux) expected = `\x1bPtmux;${expected.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
			assert.deepEqual(writes, [expected]);
			assert.deepEqual(result, { status: "sent" });
			assert.match(copyNotice(result).text, /unconfirmed/);
			assert.equal(copyNotice(result).kind, "info");
		}
	}
});

test("non-macOS uses OSC 52 while known unsupported remote Terminal and non-TTY copies fail without writing", async (t) => {
	t.mock.method(childProcess, "spawn", forbidden);
	let writes = 0;
	assert.deepEqual(await createTextCopier({ platform: "linux", env: {}, isTTY: true, nativeClipboard: forbidden, write: async () => { writes++; } })("text"), { status: "sent" });
	assert.equal(writes, 1);
	for (const options of [{ ...local, env: { ...local.env, SSH_TTY: "/dev/tty" } }, { ...local, isTTY: false }, { platform: "linux" as const, env: {}, isTTY: false }]) {
		assert.match(String(await createTextCopier({ ...options, nativeClipboard: forbidden, write: forbidden })("text")), /Copy unavailable/);
	}
	assert.match(String(await createTextCopier({ platform: "linux", env: {}, isTTY: true, write: async () => { throw new Error("broken pipe"); } })("text")), /Copy failed/);
});
