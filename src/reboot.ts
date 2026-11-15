import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, renameSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defineDoc } from "@earendil-works/pi-durable";

export type InteractiveExit = "quit" | "reboot" | { rollbackFrom: string } | { modelId: string } | { provider: string };

export const RebootArchive = defineDoc<{ path: string | null; restoredFrom?: string }>({
	kind: "durable-chat.reboot-archive", version: 1, scope: "session",
	initial: () => ({ path: null }), checkpointWhen: () => false,
});

const SIDECARS = ["-wal", "-shm", "-journal"];
const exists = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

function closeJournals(storePath: string): void {
	const db = new DatabaseSync(storePath);
	try {
		db.exec("PRAGMA busy_timeout = 0");
		const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
		if (checkpoint?.busy !== 0) throw new Error("Cannot replace state while another SQLite connection holds the database; close it first.");
		// DELETE mode also requires other WAL connections to release their locks, even idle readers.
		const journal = db.prepare("PRAGMA journal_mode = DELETE").get();
		if (journal?.journal_mode !== "delete") throw new Error("Cannot safely close the database journals for state replacement.");
	} finally {
		db.close();
	}
	for (const suffix of SIDECARS) {
		if (exists(`${storePath}${suffix}`)) throw new Error(`Cannot replace state with a remaining SQLite sidecar: ${storePath}${suffix}`);
	}
}

/** Caller holds the store lock and has closed its runtime. A failed opener must close its connections. */
export async function rebootClosedStore<T>(path: string, openFresh: (archivePath: string) => Promise<T>, operation = "Reboot"): Promise<T> {
	const storePath = resolve(path);
	const stat = lstatSync(storePath);
	if (!stat.isFile() || stat.nlink !== 1) throw new Error("State replacement requires a regular database file without symlinks or additional hard links.");
	closeJournals(storePath);
	const createdAt = new Date().toISOString();
	// Exclusive directory creation avoids overwriting an archive, including same-millisecond reboots.
	const directory = mkdtempSync(`${storePath}.reboot-${createdAt.replaceAll(":", "-")}-`);
	const archivePath = join(directory, basename(storePath));
	renameSync(storePath, archivePath);
	try {
		closeSync(openSync(storePath, "wx", stat.mode & 0o777));
		return await openFresh(archivePath);
	} catch (error) {
		const failed = join(directory, "failed-fresh");
		try {
			// Refuse to move a replacement that still has an open SQLite connection.
			if (exists(storePath)) closeJournals(storePath);
			else if (SIDECARS.some((suffix) => exists(`${storePath}${suffix}`))) throw new Error("Replacement has orphaned SQLite sidecars.");
			// Preserve even a partially initialized replacement; never delete state during recovery.
			for (const suffix of ["", ...SIDECARS]) {
				const file = `${storePath}${suffix}`;
				if (!exists(file)) continue;
				mkdirSync(failed, { recursive: true, mode: 0o700 });
				renameSync(file, join(failed, basename(file)));
			}
			renameSync(archivePath, storePath);
		} catch (recoveryError) {
			throw new AggregateError([error, recoveryError], `${operation} and recovery failed. Preserved state is at ${archivePath}; replacement files may be at ${storePath} or ${failed}.`);
		}
		throw new Error(`${operation} failed; original state restored at ${storePath}. Replacement files, if any, were retained at ${failed}.`, { cause: error });
	}
}
