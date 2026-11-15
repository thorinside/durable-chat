import { chmodSync, linkSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { localConfigPath, resolveConfig, setConfigValue } from "./config.ts";
import type { ConfigOverrides } from "./config.ts";
import { acquireStoreLock } from "./harness.ts";

export type StateFork = { sourcePath: string; storePath: string; configPath: string };

/** Snapshot the selected state without opening a Harness or resuming any work. */
export function forkLocalState(overrides: ConfigOverrides = {}, env: NodeJS.ProcessEnv = process.env): StateFork {
	const sourcePath = resolveConfig(overrides, env).storePath;
	const storePath = resolve(".durable-chat/store.sqlite");
	const configPath = localConfigPath();
	if (sourcePath === storePath) throw new Error("The selected state is already folder-local; select another source with --store <path>.");
	if (lstatSync(sourcePath, { throwIfNoEntry: false }) === undefined) throw new Error(`Source state does not exist: ${sourcePath}`);
	const release = acquireStoreLock(storePath);
	let staging: string | undefined;
	try {
		for (const path of [storePath, `${storePath}-wal`, `${storePath}-shm`]) {
			if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) throw new Error(`Refusing to overwrite existing local state: ${path}`);
		}
		const originalConfig = lstatSync(configPath, { throwIfNoEntry: false }) === undefined ? undefined : readFileSync(configPath);
		staging = mkdtempSync(join(dirname(storePath), ".state-fork-"));
		const stagedConfig = join(staging, "config.yaml");
		if (originalConfig !== undefined) writeFileSync(stagedConfig, originalConfig);
		setConfigValue(stagedConfig, "store", ".durable-chat/store.sqlite");
		chmodSync(stagedConfig, 0o600);

		const snapshot = join(staging, "store.sqlite");
		const source = new DatabaseSync(sourcePath, { readOnly: true });
		try {
			// VACUUM INTO is a consistent SQLite snapshot, including committed WAL data.
			// A raw file copy can silently omit that data while the source is open.
			source.prepare("VACUUM INTO ?").run(snapshot);
		} finally {
			source.close();
		}
		chmodSync(snapshot, 0o600);
		const currentConfig = lstatSync(configPath, { throwIfNoEntry: false }) === undefined ? undefined : readFileSync(configPath);
		if (originalConfig === undefined ? currentConfig !== undefined : currentConfig === undefined || !originalConfig.equals(currentConfig)) {
			throw new Error(`Local config changed while forking; retry: ${configPath}`);
		}
		// Hard-link publication is exclusive: even a competing creator cannot be overwritten.
		linkSync(snapshot, storePath);
		try {
			renameSync(stagedConfig, configPath);
		} catch (error) {
			unlinkSync(storePath);
			throw error;
		}
		return { sourcePath, storePath, configPath };
	} finally {
		try {
			if (staging !== undefined) rmSync(staging, { recursive: true, force: true });
		} finally {
			release();
		}
	}
}
