import { chmodSync, lstatSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

/** Discovery is best-effort; explicit paths remain usable when archives cannot be listed. */
export function rollbackChoices(storePath: string, previousArchive?: string): string[] {
	let discovered: string[] = [];
	try {
		discovered = readdirSync(dirname(storePath), { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && entry.name.startsWith(`${basename(storePath)}.reboot-`))
			.map((entry) => join(dirname(storePath), entry.name, basename(storePath))).sort().reverse();
	} catch { /* The user can still enter an explicit path. */ }
	return [...new Set([...(previousArchive === undefined ? [] : [previousArchive]), ...discovered])]
		.filter((path) => {
			try { const stat = lstatSync(path); return stat.isFile() && stat.nlink === 1 && realpathSync(path) !== realpathSync(storePath); }
			catch { return false; }
		}).slice(0, 5);
}

export function rollbackSource(input: string, choices: readonly string[], storePath: string): string {
	let path = input.trim();
	if (path.length === 0) throw new Error("Choose an archive number or enter a database file path.");
	if (/^[1-9][0-9]*$/.test(path)) {
		const selected = choices[Number(path) - 1];
		if (selected === undefined) throw new Error("No archive with that number; choose a listed archive or enter a file path.");
		path = selected;
	} else if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) {
		path = path.slice(1, -1);
	}
	if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
	path = resolve(path);
	const source = lstatSync(path);
	if (!source.isFile() || source.nlink !== 1) throw new Error("Choose a regular database file without symlinks or additional hard links.");
	const current = lstatSync(storePath);
	if (source.dev === current.dev && source.ino === current.ino) throw new Error("That file is already the current state; choose another database.");
	return realpathSync(path);
}

/** The target is the exclusively held, empty replacement file created by state rotation. */
export function installRollbackSnapshot(sourcePath: string, storePath: string): void {
	const target = lstatSync(storePath);
	if (!target.isFile() || target.nlink !== 1 || target.size !== 0) throw new Error("Refusing to replace a nonempty or aliased state file.");
	const staging = mkdtempSync(join(dirname(storePath), ".state-rollback-"));
	try {
		const snapshot = join(staging, "snapshot.sqlite");
		const source = new DatabaseSync(sourcePath, { readOnly: true });
		try {
			// A raw copy can miss committed WAL data. VACUUM INTO leaves the source database unchanged.
			source.prepare("VACUUM INTO ?").run(snapshot);
		} finally { source.close(); }
		chmodSync(snapshot, target.mode & 0o777);
		renameSync(snapshot, storePath);
	} finally {
		// Only our unpublished staging files; selected and archived state are always retained.
		rmSync(staging, { recursive: true, force: true });
	}
}
