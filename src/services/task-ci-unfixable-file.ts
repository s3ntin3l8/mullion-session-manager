import { closeSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { taskCiUnfixablePath } from "./task-prompt.js";

// A worker's reason is a short paragraph; anything past this is a runaway file,
// and it would otherwise travel whole over the host channel before the 500-char
// cap in task-ci-return-hold.ts applies.
const MAX_CI_UNFIXABLE_BYTES = 4096;

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * Reads a worker's "this red check cannot be fixed from this PR" declaration:
 * `null` for an absent file, the trimmed text (at most `MAX_CI_UNFIXABLE_BYTES`
 * read) otherwise, and a placeholder for an empty one — the file's existence is
 * the declaration. Shared by the local backend and the agent route so a remote
 * host answers exactly like the primary does.
 *
 * It takes the parts of the path, not a path, and validates them here, at the one
 * place the file is opened: `taskId` must be an integer and `headSha` a full
 * lowercase SHA, so nothing path-like can reach the filesystem whatever the
 * caller did. It opens the file directly and treats "not found" as `null`, rather
 * than checking existence first, so the file cannot change between check and read.
 * The resolved path must also stay inside `sessionsDir`.
 */
export function readCiUnfixableFile(
  sessionsDir: string,
  taskId: number,
  headSha: string,
): string | null {
  if (!Number.isInteger(taskId) || !FULL_SHA.test(headSha)) {
    throw new Error("taskId must be an integer and headSha a 40-char lowercase hex SHA");
  }
  const root = path.resolve(sessionsDir);
  const target = path.resolve(taskCiUnfixablePath(root, taskId, headSha));
  if (!target.startsWith(root + path.sep)) throw new Error("declaration path escapes sessionsDir");
  let fd: number;
  try {
    fd = openSync(target, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const buf = Buffer.alloc(MAX_CI_UNFIXABLE_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8").trim() || "(no reason given)";
  } finally {
    closeSync(fd);
  }
}
