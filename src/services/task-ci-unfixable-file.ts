import { closeSync, existsSync, openSync, readSync } from "node:fs";

// A worker's reason is a short paragraph; anything past this is a runaway file,
// and it would otherwise travel whole over the host channel before the 500-char
// cap in task-ci-return-hold.ts applies.
const MAX_CI_UNFIXABLE_BYTES = 4096;

/**
 * Reads a worker's "this red check cannot be fixed from this PR" declaration:
 * `null` for an absent file, the trimmed text (at most `MAX_CI_UNFIXABLE_BYTES`
 * read) otherwise, and a placeholder for an empty one — the file's existence is
 * the declaration. Shared by the local backend and the agent route so a remote
 * host answers exactly like the primary does.
 */
export function readCiUnfixableFile(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(MAX_CI_UNFIXABLE_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8").trim() || "(no reason given)";
  } finally {
    closeSync(fd);
  }
}
