import path from "node:path";
import {
  rm as rmAsync,
  unlink as unlinkAsync,
  readdir as readdirAsync,
  stat as statAsync,
} from "node:fs/promises";
import { stateFilePath } from "./session-state-file.js";
import { hookTokenPath } from "./hook-token.js";
import { sessionAgentGuidePath } from "./agent-guide.js";
import { sessionBriefingPath } from "./project-briefing.js";
import { sessionWorkflowConventionsPath } from "./workflow-conventions.js";
import {
  opencodeTier0Path,
  opencodeSeedPath,
  opencodeConfigDir,
} from "./hook-adapters/opencode.js";

/**
 * Path to this session's isolated temporary directory (`<sessionsDir>/<id>.tmp`).
 */
export function sessionTmpDirPath(sessionsDir: string, id: string): string {
  return path.join(sessionsDir, `${id}.tmp`);
}

/**
 * Removes every per-session file a Session writes under `sessionsDir` — the
 * terminal step of PtyManager.terminate(). Extracted from pty-manager.ts
 * (issue #1522), behaviour unchanged (issue #1523's concurrent form).
 *
 * Every removal is best-effort: ENOENT is the expected common case (the file
 * was never written — hooks never fired, the session predates the feature,
 * this isn't an opencode session, the project opted out of a briefing or
 * conventions text, ...). They are independent, so they run concurrently and
 * one failure never skips the others. Never throws.
 *  - agent-guide/briefing (#405) and workflow-conventions (#937) are written
 *    unconditionally at spawn time but nothing else removed them;
 *  - the opencode tier-0/seed files and config dir (#949) share the lifecycle;
 *  - the session-scoped temporary directory (#1677) is removed to prevent temp leaks.
 */
export async function cleanupSessionFiles(sessionsDir: string, id: string): Promise<void> {
  await Promise.allSettled([
    unlinkAsync(hookTokenPath(sessionsDir, id)),
    unlinkAsync(stateFilePath(sessionsDir, id)),
    unlinkAsync(sessionAgentGuidePath(sessionsDir, id)),
    unlinkAsync(sessionWorkflowConventionsPath(sessionsDir, id)),
    unlinkAsync(sessionBriefingPath(sessionsDir, id)),
    unlinkAsync(opencodeTier0Path(sessionsDir, id)),
    unlinkAsync(opencodeSeedPath(sessionsDir, id)),
    rmAsync(opencodeConfigDir(sessionsDir, id), { recursive: true, force: true }),
    rmAsync(sessionTmpDirPath(sessionsDir, id), { recursive: true, force: true }),
  ]);
}

/** Minimum age before an untracked session temp dir is considered orphaned (1 minute). */
export const MIN_ORPHAN_TMP_AGE_MS = 60_000;

export interface SweepLogger {
  warn(obj: unknown, msg: string): void;
  info?(obj: unknown, msg: string): void;
}

/**
 * Filter function to confirm which candidate session IDs are safe to sweep.
 * Callers should only return IDs confirmed "dead", skipping "alive" and "unknown"
 * to prevent deleting the TMPDIR of a live dtach session after a restart.
 */
export type DeadSessionFilter = (candidateIds: string[]) => Promise<Set<string>> | Set<string>;

/**
 * Sweeps orphaned `<id>.tmp` directories under `sessionsDir` whose session ID is
 * confirmed dead and whose mtime is older than `minAgeMs` (default 1 minute).
 * Returns the number of swept directories. Never throws.
 */
export async function sweepOrphanedSessionTmpDirs(
  sessionsDir: string,
  isDead: DeadSessionFilter,
  activeSessionIds: Set<string> = new Set(),
  minAgeMs: number = MIN_ORPHAN_TMP_AGE_MS,
  log?: SweepLogger,
): Promise<number> {
  let entries;
  try {
    entries = await readdirAsync(sessionsDir, { withFileTypes: true });
  } catch (err) {
    log?.warn({ err, sessionsDir }, "sweepOrphanedSessionTmpDirs: failed to readdir");
    return 0;
  }

  const now = Date.now();
  const candidateIds: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".tmp")) continue;
    const id = entry.name.slice(0, -".tmp".length);
    if (!id || activeSessionIds.has(id)) continue;

    const fullPath = path.join(sessionsDir, entry.name);
    try {
      const st = await statAsync(fullPath);
      if (now - st.mtimeMs >= minAgeMs) {
        candidateIds.push(id);
      }
    } catch (err) {
      log?.warn(
        { err, path: fullPath },
        "sweepOrphanedSessionTmpDirs: failed to stat candidate tmp dir",
      );
    }
  }

  if (candidateIds.length === 0) return 0;

  let confirmedDead: Set<string>;
  try {
    confirmedDead = await isDead(candidateIds);
  } catch (err) {
    log?.warn(
      { err, candidateIds },
      "sweepOrphanedSessionTmpDirs: failed to check session liveness",
    );
    return 0;
  }

  let swept = 0;
  await Promise.allSettled(
    [...confirmedDead].map(async (id) => {
      const fullPath = sessionTmpDirPath(sessionsDir, id);
      try {
        await rmAsync(fullPath, { recursive: true, force: true });
        swept++;
      } catch (err) {
        log?.warn(
          { err, id, fullPath },
          "sweepOrphanedSessionTmpDirs: failed to rm candidate tmp dir",
        );
      }
    }),
  );

  return swept;
}
