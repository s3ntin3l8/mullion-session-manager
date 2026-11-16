import path from "node:path";
import fsPromises from "node:fs/promises";
import { stateFilePath } from "./session-state-file.js";
import { hookTokenPath } from "./hook-token.js";
import { ptyHostTokenPath } from "./pty-host-token.js";
import { sessionAgentGuidePath } from "./agent-guide.js";
import { sessionBriefingPath } from "./project-briefing.js";
import { sessionWorkflowConventionsPath } from "./workflow-conventions.js";
import {
  opencodeTier0Path,
  opencodeSeedPath,
  opencodeConfigDir,
} from "./hook-adapters/opencode.js";
import { claudeHooksSettingsPath, claudeMcpConfigPath } from "./hook-adapters/claude-code.js";

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
 *  - the session-scoped temporary directory (#1681) is removed to prevent temp leaks.
 */
export async function cleanupSessionFiles(sessionsDir: string, id: string): Promise<void> {
  await Promise.allSettled([
    fsPromises.unlink(hookTokenPath(sessionsDir, id)),
    fsPromises.unlink(stateFilePath(sessionsDir, id)),
    fsPromises.unlink(sessionAgentGuidePath(sessionsDir, id)),
    fsPromises.unlink(sessionWorkflowConventionsPath(sessionsDir, id)),
    fsPromises.unlink(sessionBriefingPath(sessionsDir, id)),
    fsPromises.unlink(opencodeTier0Path(sessionsDir, id)),
    fsPromises.unlink(opencodeSeedPath(sessionsDir, id)),
    // The Claude Code adapter's per-session settings and MCP config. These were
    // written at spawn time but never removed, so every session leaked two files.
    fsPromises.unlink(claudeHooksSettingsPath(sessionsDir, id)),
    fsPromises.unlink(claudeMcpConfigPath(sessionsDir, id)),
    fsPromises.rm(opencodeConfigDir(sessionsDir, id), { recursive: true, force: true }),
    fsPromises.rm(sessionTmpDirPath(sessionsDir, id), { recursive: true, force: true }),
    // The pty-host session token (Windows, #1728) — the backend's stop()
    // removes it too; this covers a session whose stop never ran.
    fsPromises.unlink(ptyHostTokenPath(sessionsDir, id)),
  ]);
}

/**
 * Suffixes of the per-session artifacts under `sessionsDir` (`<id>.<suffix>`).
 * Mirrors the removals in {@link cleanupSessionFiles}; the sock is deliberately
 * absent — the liveness check, not the file's presence, decides a session is dead.
 */
const SESSION_ARTIFACT_RE =
  /^([^./]+)\.(?:tmp|opencode-config|opencode-tier0\.md|opencode-seed\.md|hooks\.json|mcp\.json|token|pty-token|state\.json|agent-guide\.md|workflow-conventions\.md|briefing\.md)$/;

/** Artifacts that are directories; every other suffix is a plain file. */
const DIRECTORY_ARTIFACT_SUFFIXES = new Set(["tmp", "opencode-config"]);

function sessionIdOfArtifact(entry: { name: string; isDirectory(): boolean }): string | null {
  const m = SESSION_ARTIFACT_RE.exec(entry.name);
  if (!m) return null;
  const suffix = entry.name.slice(m[1].length + 1);
  // A file named `x.tmp` or a directory named `x.token` is not ours.
  return DIRECTORY_ARTIFACT_SUFFIXES.has(suffix) === entry.isDirectory() ? m[1] : null;
}

/** Minimum age before an untracked session temp dir is considered orphaned (1 minute). */
const MIN_ORPHAN_TMP_AGE_MS = 60_000;

export interface SweepLogger {
  warn(obj: unknown, msg: string): void;
  info?(obj: unknown, msg: string): void;
}

export interface SweepOrphanedTmpDirsOptions {
  activeSessionIds?: Set<string>;
  minAgeMs?: number;
  log?: SweepLogger;
}

/**
 * Filter function to confirm which candidate session IDs are safe to sweep.
 * Callers should only return IDs confirmed "dead", skipping "alive" and "unknown"
 * to prevent deleting the TMPDIR of a live dtach session after a restart.
 */
export type DeadSessionFilter = (candidateIds: string[]) => Promise<Set<string>> | Set<string>;

/**
 * Sweeps the orphaned per-session artifacts (`<id>.tmp`, `<id>.opencode-config`,
 * `<id>.hooks.json`, `<id>.mcp.json`, ...) under `sessionsDir` whose session ID is
 * confirmed dead and whose mtime is older than `minAgeMs` (default 1 minute).
 * Returns the number of swept directories. Never throws.
 */
export async function sweepOrphanedSessionTmpDirs(
  sessionsDir: string,
  isDead: DeadSessionFilter,
  activeSessionIdsOrOptions?: Set<string> | SweepOrphanedTmpDirsOptions,
  minAgeMs?: number,
  log?: SweepLogger,
): Promise<number> {
  let activeSessionIds: Set<string>;
  let resolvedMinAgeMs: number;
  let resolvedLog: SweepLogger | undefined;

  if (activeSessionIdsOrOptions instanceof Set) {
    activeSessionIds = activeSessionIdsOrOptions;
    resolvedMinAgeMs = minAgeMs ?? MIN_ORPHAN_TMP_AGE_MS;
    resolvedLog = log;
  } else {
    activeSessionIds = activeSessionIdsOrOptions?.activeSessionIds ?? new Set();
    resolvedMinAgeMs = activeSessionIdsOrOptions?.minAgeMs ?? MIN_ORPHAN_TMP_AGE_MS;
    resolvedLog = activeSessionIdsOrOptions?.log;
  }

  let entries;
  try {
    entries = await fsPromises.readdir(sessionsDir, { withFileTypes: true });
  } catch (err) {
    resolvedLog?.warn({ err, sessionsDir }, "sweepOrphanedSessionTmpDirs: failed to readdir");
    return 0;
  }

  const now = Date.now();
  // Newest mtime per session id across every artifact it left behind, so a
  // session that is still being written to is never treated as old.
  const newestMtimeById = new Map<string, number>();

  for (const entry of entries) {
    const id = sessionIdOfArtifact(entry);
    if (!id || activeSessionIds.has(id)) continue;

    const fullPath = path.join(sessionsDir, entry.name);
    try {
      const st = await fsPromises.stat(fullPath);
      newestMtimeById.set(id, Math.max(newestMtimeById.get(id) ?? 0, st.mtimeMs));
    } catch (err) {
      resolvedLog?.warn(
        { err, path: fullPath },
        "sweepOrphanedSessionTmpDirs: failed to stat candidate artifact",
      );
    }
  }

  const candidateIds = [...newestMtimeById]
    .filter(([, mtimeMs]) => now - mtimeMs >= resolvedMinAgeMs)
    .map(([id]) => id);

  if (candidateIds.length === 0) return 0;

  let confirmedDead: Set<string>;
  try {
    confirmedDead = await isDead(candidateIds);
  } catch (err) {
    resolvedLog?.warn(
      { err, candidateIds },
      "sweepOrphanedSessionTmpDirs: failed to check session liveness",
    );
    return 0;
  }

  let swept = 0;
  await Promise.allSettled(
    [...confirmedDead].map(async (id) => {
      try {
        // cleanupSessionFiles is best-effort per file and never throws, so one
        // unremovable artifact cannot keep the rest of the session's files alive.
        await cleanupSessionFiles(sessionsDir, id);
        swept++;
      } catch (err) {
        resolvedLog?.warn(
          { err, id },
          "sweepOrphanedSessionTmpDirs: failed to clean session files",
        );
      }
    }),
  );

  return swept;
}
