import childProcess from "node:child_process";

const FOCUS_GHOSTTY = `function run(argv) {
	const ownerPID = Number(argv[0]);
	const ownerTTY = argv[1];
	const app = Application("com.mitchellh.ghostty");
	if (!app.running()) return "not-found";
	const terminals = app.terminals();
	for (const candidate of terminals) {
		let matchesOwner = false;
		try { matchesOwner = candidate.pid() === ownerPID; } catch (_) {}
		if (!matchesOwner && ownerTTY) {
			try { matchesOwner = candidate.tty() === ownerTTY; } catch (_) {}
		}
		if (matchesOwner) {
			candidate.focus();
			return "focused";
		}
	}
	return "not-found";
}`;

function capture(command: string, args: string[], timeout: number): Promise<string> {
	return new Promise((resolve, reject) => {
		childProcess.execFile(command, args, { encoding: "utf8", timeout, maxBuffer: 64 * 1024 }, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout);
		});
	});
}

/** Best-effort handoff of an interactive local launch to the Ghostty terminal owning its store. */
export async function focusExistingSession(pid: number, options: {
	command?: string;
	isTTY?: boolean;
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
} = {}): Promise<boolean> {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const isTTY = options.isTTY ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
	if (!isTTY || platform !== "darwin" || !Number.isSafeInteger(pid) || pid <= 0
		|| (options.command !== undefined && options.command !== "tui" && options.command !== "chat")
		|| env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return false;
	if (env.TERM_PROGRAM?.toLowerCase() !== "ghostty" && !env.TERM?.toLowerCase().includes("ghostty") && !env.GHOSTTY_RESOURCES_DIR) return false;
	try {
		const tty = (await capture("/bin/ps", ["-p", String(pid), "-o", "tty="], 1000)).trim();
		const device = tty === "" || tty === "?" || tty === "??" ? "" : tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
		// Pass metadata as arguments: neither PID nor terminal identity becomes script source.
		return (await capture("/usr/bin/osascript", ["-l", "JavaScript", "-e", FOCUS_GHOSTTY, String(pid), device], 3000)).trim() === "focused";
	} catch {
		// Missing APIs, denied Automation permission and timeouts preserve the original lock error.
		return false;
	}
}
