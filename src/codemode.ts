import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import type { Extension } from "@earendil-works/pi-durable";

/**
 * One QuickJS sandbox per runtime. It runs scripts on a worker thread, so a spinning script
 * cannot block the TUI's event loop.
 *
 * The VM fingerprint records the memory limit and the interrupt budget, and a script interrupted
 * by a restart only replays when that fingerprint still matches, so these stay constants here
 * rather than config keys. Closing the sandbox is not a script outcome: the script resumes in the
 * next runtime's sandbox from its journal.
 */
const MEMORY_LIMIT_BYTES = 128 * 1024 * 1024;
const SCRIPT_TIMEOUT_MS = 300_000;

/** MCP tools are named `mcp__<server>__<tool>`, so the codemode section groups them by server. */
const NAMESPACES = [{ name: "mcp", prefix: "mcp__" }] as const;

export type CodemodeSetup = {
	extension: Extension;
	close(): Promise<void>;
};

/** The codemode extension: the tool, its prompt section, and the sandbox that runs scripts. */
export function openCodemode(): CodemodeSetup {
	const sandbox = new CodemodeSandbox({ memoryLimitBytes: MEMORY_LIMIT_BYTES, timeoutMs: SCRIPT_TIMEOUT_MS });
	return {
		extension: createCodemodeExtension({ sandbox, namespaces: NAMESPACES }),
		close: () => sandbox.close(),
	};
}
