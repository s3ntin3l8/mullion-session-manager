import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The sessions-dir HISTORY — the trail of dirs this install has resolved.
 *
 * Issue #1771 — the ownership set a Mullion instance derives (see
 * resolveSessionsDirs in src/plugins/pty.ts) can name every dir an earlier
 * RELEASE would have used for the same configured path, but it cannot name
 * a dir this instance used and no longer resolves to:
 *
 *   - the operator moved SESSIONS_DIR (or moved the project it is relative
 *     to) — the old dir is not derivable from the new configured path;
 *   - TMPDIR's VALUE changed between two runs — the old fallback root is not
 *     derivable either, because the compat roots are computed from the
 *     CURRENT os.tmpdir().
 *
 * In both cases the scope's dtach socket sits in a dir the instance cannot
 * name, so the scope is neither owned nor verifiable, and the liveness read
 * lands on "dead" — the one verdict the reconciler is allowed to act on
 * destructively (it terminates the scope and flips the session's row to
 * "exited" while the scope keeps running).
 *
 * So the instance keeps a small trail of the dirs it has resolved, in the
 * install root (MULLION_HOME), and the ownership set grows by that trail.
 *
 * Four rules hold this together:
 *
 *   - **Only what this instance resolved is ever recorded** (issue #1137):
 *     a dir may enter the owned set only if this instance itself created it.
 *     The trail records the RESOLVED dir and nothing else — never a compat
 *     candidate, never anything an operator typed.
 *   - **The trail is per install root**, so it survives a SESSIONS_DIR move
 *     and a TMPDIR change, but not a wiped install root. A scope whose dir
 *     was never recorded by THIS install is still unplaceable. Two projects
 *     that share one install root share the trail: the install root is the
 *     unit of ownership here, not the project.
 *   - **The write is atomic, but it is still a read-modify-write.** Two
 *     PROCESSES sharing one install root can lose each other's newest entry
 *     in the microseconds between the read and the write. The consequence is
 *     bounded: one dir is missing from the trail, so a scope in it reads the
 *     way it read before this file existed — never a wrong ownership claim.
 *   - **Nothing here is ever fatal.** A missing file is the normal case; a
 *     corrupt or unwritable one is reported and ignored, and the boot
 *     continues with the dirs the resolver can derive on its own — the same
 *     posture the fallback-root handling takes (see resolveSessionsDirs).
 */

/** The history file's name inside the install root (MULLION_HOME). */
export const SESSIONS_DIR_HISTORY_FILE = "sessions-dirs.json";

/**
 * How many dirs the trail keeps.
 *
 * A policy value, not a number the code needs: the trail is a record of
 * where this install has lived, not a log, and every entry in it is a dir a
 * scope may still live in. 16 is generous for the moves a host actually
 * sees (a TMPDIR that differs per launch, an operator who relocates
 * SESSIONS_DIR a few times) and small enough that the file stays a handful
 * of lines. The OLDEST entry is dropped when the bound is reached, so a
 * scope older than the trail becomes unplaceable again — the same
 * "recent N" trade-off the release pruning already makes.
 */
export const SESSIONS_DIR_HISTORY_LIMIT = 16;

/** What the trail holds, plus anything that went wrong while reading it. */
export interface SessionsDirHistory {
  /** The dirs this install has resolved, oldest first. Always absolute. */
  dirs: string[];
  /**
   * Why the trail could not be read or written — never fatal. The caller
   * reports it to the operator; the boot continues regardless.
   */
  warning?: string;
}

/**
 * The trail file's path, or "" when there is no install root to keep it in
 * (a dev checkout — MULLION_HOME is empty there, and the resolver's own
 * derivations are all such an install needs).
 */
export function sessionsDirHistoryPath(mullionHome: string): string {
  const home = mullionHome.trim();
  if (home === "") return "";
  return path.join(path.resolve(home), SESSIONS_DIR_HISTORY_FILE);
}

/**
 * Reads the trail. Never throws: a missing file is the normal case (the
 * first boot, and every boot of an install that never moved), and a
 * corrupt or unreadable one is reported through `warning` and ignored.
 */
export function readSessionsDirHistory(mullionHome: string): SessionsDirHistory {
  const file = sessionsDirHistoryPath(mullionHome);
  // No install root — nowhere to keep a trail, and nothing to trail.
  if (file === "") return { dirs: [] };

  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return { dirs: [] };
    return {
      dirs: [],
      warning: `the sessions-dir history at ${file} could not be read and was ignored: ${errorMessage(err)}`,
    };
  }

  try {
    const dirs = extractDirs(JSON.parse(raw));
    if (dirs === null) {
      return {
        dirs: [],
        warning: `the sessions-dir history at ${file} does not have the expected shape and was ignored`,
      };
    }
    return { dirs };
  } catch (err) {
    return {
      dirs: [],
      warning: `the sessions-dir history at ${file} is not readable JSON and was ignored: ${errorMessage(err)}`,
    };
  }
}

/**
 * Records `dir` as the dir this install has just resolved, and returns the
 * trail as it now stands (the recorded dir last).
 *
 * This is the ONE call a caller needs: it reads the trail, appends the dir,
 * writes the file and reports what went wrong — so the caller never has to
 * read the file itself to learn what was in it.
 *
 * The write is atomic — a temp file plus a rename — because two plugins
 * resolve the same configured path in one process (pty.ts and device.ts)
 * and a half-written file would be read by the other. The rename is atomic
 * within a filesystem, so a concurrent reader sees either the old file or
 * the new one, never a partial one.
 *
 * The dir moves to the END of the trail rather than being appended in
 * place: the bound drops the OLDEST entries, so the dir this install uses
 * now has to be the newest one or it could be dropped while still in use.
 */
export function recordSessionsDir(mullionHome: string, dir: string): SessionsDirHistory {
  const file = sessionsDirHistoryPath(mullionHome);
  if (file === "") return { dirs: [] };

  const resolved = path.resolve(dir);
  const existing = readSessionsDirHistory(mullionHome);
  // Already the newest entry — the file is exactly what we would write.
  if (existing.dirs[existing.dirs.length - 1] === resolved) return existing;

  const dirs = [...existing.dirs.filter((entry) => entry !== resolved), resolved].slice(
    -SESSIONS_DIR_HISTORY_LIMIT,
  );
  try {
    writeHistoryFile(file, dirs);
  } catch (err) {
    // The trail is an aid, not a requirement: an unwritable install root
    // must not stop the boot. The dirs we already had are still returned.
    return {
      dirs: existing.dirs,
      warning: `the sessions-dir history at ${file} could not be written and was not updated: ${errorMessage(err)}`,
    };
  }
  // The write succeeded, but a file that could not be READ is still worth
  // reporting: the trail it held is gone, replaced by this one entry.
  return existing.warning === undefined ? { dirs } : { dirs, warning: existing.warning };
}

/**
 * The dirs a parsed history file holds: absolute paths, in file order, with
 * duplicates dropped. Anything else in the file (a relative path, a
 * non-string) is ignored rather than repaired — the file is this install's
 * own state, and a hand-edited one that does not parse is simply not
 * trusted.
 *
 * `null` means the file does not have the expected shape at all, which the
 * caller reports — a file that is not a history is not a history that
 * happens to be empty.
 */
function extractDirs(parsed: unknown): string[] | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const raw = (parsed as { dirs?: unknown }).dirs;
  if (!Array.isArray(raw)) return null;
  const dirs: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !path.isAbsolute(entry)) continue;
    const resolved = path.resolve(entry);
    if (!dirs.includes(resolved)) dirs.push(resolved);
  }
  return dirs;
}

/**
 * Writes the trail atomically, mode 0600.
 *
 * 0600 because the install root holds this install's private state (the
 * .env lives there too); the trail itself is not a secret, but it is state
 * about the host and it costs nothing to keep it to the owner.
 */
function writeHistoryFile(file: string, dirs: string[]): void {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    throw new Error(`${dir} does not exist`);
  }
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  try {
    fs.writeFileSync(tmp, `${JSON.stringify({ dirs }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    // The temp file is ours and nobody else will read it — remove it, so a
    // failed write does not litter the install root.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Best effort: the write already failed, and the temp file is inert.
    }
    throw err;
  }
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
