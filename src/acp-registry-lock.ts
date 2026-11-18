import { closeSync, lstatSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * A permanent inode and SQLite's OS-backed exclusive transaction are the mutex.
 * Creating the file does NOT confer ownership: a contender may win while its
 * creator is descheduled. Only BEGIN EXCLUSIVE admits a host. No PID, timestamp,
 * parsing of partial owner metadata, stale-file deletion or release-time unlink
 * participates in the protocol. The kernel releases the lock on process death.
 *
 * Never unlink/replace this file, including on orderly shutdown. Like the session
 * databases, it requires a local filesystem with working SQLite locking. Native
 * store leases deliberately retain their existing format and behavior.
 */
export function acquireRegistryLock(directory: string): () => void {
	// Pre-fix development hosts used the shared JSON/PID helper. Fail closed rather
	// than claiming interoperability with that racy protocol (including empty files).
	let legacy = false;
	try { lstatSync(join(directory, "registry.lock")); legacy = true; }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	if (legacy) throw new Error("Legacy ACP registry.lock present; stop old hosts and remove that marker offline before upgrading.");
	const path = join(directory, "registry-lock.sqlite");
	try { closeSync(openSync(path, "wx", 0o600)); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
	const before = lstatSync(path);
	if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || (process.getuid && before.uid !== process.getuid())) {
		throw new Error("Unsafe ACP registry mutex");
	}
	const db = new DatabaseSync(path);
	try {
		// busy_timeout defaults to zero: contenders fail immediately, without sleeps.
		db.exec("BEGIN EXCLUSIVE");
		const after = lstatSync(path);
		if (before.dev !== after.dev || before.ino !== after.ino) throw new Error("ACP registry mutex replaced during admission");
	} catch (error) {
		db.close();
		throw new Error("ACP registry unavailable or already open by another host", { cause: error });
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		// Close only our connection, never a pathname that could now name another
		// owner's inode. Closing rolls back the (write-free) exclusive transaction.
		db.close();
	};
}
