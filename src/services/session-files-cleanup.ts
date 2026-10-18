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

/**
 * Sweeps orphaned `<id>.tmp` directories under `sessionsDir` whose session ID is
 * not in `activeSessionIds` and whose mtime is older than `minAgeMs` (default 1 minute).
 * Returns the number of swept directories. Never throws.
 */
export async function sweepOrphanedSessionTmpDirs(
  sessionsDir: string,
  activeSessionIds: Set<string>,
  minAgeMs: number = MIN_ORPHAN_TMP_AGE_MS,
): Promise<number> {
  try {
    const entries = await readdirAsync(sessionsDir, { withFileTypes: true });
    let swept = 0;
    const now = Date.now();
    await Promise.allSettled(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.endsWith(".tmp"))
        .map(async (entry) => {
          const id = entry.name.slice(0, -".tmp".length);
          if (activeSessionIds.has(id)) return;
          const fullPath = path.join(sessionsDir, entry.name);
          const st = await statAsync(fullPath).catch(() => null);
          if (!st || now - st.mtimeMs < minAgeMs) return;
          await rmAsync(fullPath, { recursive: true, force: true });
          swept++;
        }),
    );
    return swept;
  } catch {
    return 0;
  }
}
