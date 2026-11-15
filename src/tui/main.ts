import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import type { RuntimeNotice } from "../models.ts";
import type { InteractiveExit } from "../reboot.ts";
import type { AppRuntime } from "../harness.ts";
import { resolveConfig } from "../config.ts";
import { runConfigCommand } from "../config-commands.ts";
import { Dashboard } from "./app.ts";
import { shortenHome } from "./format.ts";
import { openBrowser } from "./browser.ts";

/** Stop all UI observers before returning a lifecycle request. The caller owns the runtime. */
export async function runTui(runtime: AppRuntime, notice?: RuntimeNotice): Promise<InteractiveExit> {
	if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
		throw new Error("The TUI needs an interactive terminal; use `durable-chat chat` or `ask`.");
	}
	const terminal = new ProcessTerminal();
	const title = `durable-chat — ${shortenHome(runtime.cwd)}`;
	const ui: TuiAltScreen = new TuiAltScreen(terminal, false, undefined, {
		openUrl: (url) => {
			void openBrowser(url).catch((error) => ui.flash(`Could not open link: ${error instanceof Error ? error.message : String(error)}`));
		},
	});
	const quit = Promise.withResolvers<InteractiveExit>();
	const app = new Dashboard({
		runtime,
		openUrl: (url) => {
			void openBrowser(url).catch((error) => ui.flash(`Could not open link: ${error instanceof Error ? error.message : String(error)}`));
		},
		rows: () => terminal.rows || process.stdout.rows || 24,
		requestRender: () => ui.requestRender(),
		onQuit: () => quit.resolve("quit"),
		onReboot: () => quit.resolve("reboot"),
		onRollback: (source) => quit.resolve({ rollbackFrom: source }),
		onModel: (id) => quit.resolve({ modelId: id }),
		onProvider: (name) => quit.resolve({ provider: name }),
		...(notice === undefined ? {} : { notice }),
		onEditConfig: async () => {
			ui.stop();
			const previousExit = process.exitCode;
			try {
				const overrides = runtime.config.explicitConfigPath === undefined ? {} : { configPath: runtime.config.explicitConfigPath };
				runConfigCommand(["edit"], overrides);
				try {
					resolveConfig(overrides);
					return "config edited; restart durable-chat to apply it";
				} catch (error) {
					return `config invalid: ${error instanceof Error ? error.message : String(error)}`;
				}
			} catch (error) {
				return `config edit failed: ${error instanceof Error ? error.message : String(error)}`;
			} finally {
				process.exitCode = previousExit;
				ui.start();
				terminal.setTitle(title);
				ui.setLayoutRoot(app);
				ui.setFocus(app);
				ui.requestRender();
			}
		},
	});
	// Let the terminal retain both titles; querying the previous title is unnecessary.
	terminal.write("\x1b[22;0t");
	try {
		await app.start();
		ui.setLayoutRoot(app);
		ui.setFocus(app);
		ui.start();
		terminal.setTitle(title);
		return await quit.promise;
	} finally {
		try {
			try { ui.stop(); }
			finally { await app.stop(); }
		} finally {
			terminal.write("\x1b[23;0t");
		}
	}
}
