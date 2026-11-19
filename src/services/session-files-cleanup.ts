import path from "node:path";
import fsPromises from "node:fs/promises";
import { isPipePath } from "../cli/ipc-path.mjs";
import { sessionSocketPath } from "./scope/dtach.js";
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
import {
  claudeHooksSettingsPath,
  claudeMcpConfigPath,
  claudeSessionBundleDir,
} from "./hook-adapters/claude-code.js";

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
    // Composed per project skill / reviewer agent; a whole directory.
    fsPromises.rm(claudeSessionBundleDir(sessionsDir, id), { recursive: true, force: true }),
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
  /^([^./]+)\.(?:tmp|opencode-config|mullion-bundle|opencode-tier0\.md|opencode-seed\.md|hooks\.json|mcp\.json|token|pty-token|state\.json|agent-guide\.md|workflow-conventions\.md|briefing\.md)$/;

/** Artifacts that are directories; every other suffix is a plain file. */
const DIRECTORY_ARTIFACT_SUFFIXES = new Set(["tmp", "opencode-config", "mullion-bundle"]);

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
 * Returns how many sessions had every artifact removed (a session with a file
 * that could not be removed is retried next pass, not counted). Never throws.
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

  const removed = [...confirmedDead];
  await Promise.allSettled(
    removed.map(async (id) => {
      // cleanupSessionFiles never throws. The master's own socket is removed
      // here and not there: terminate() reaches cleanupSessionFiles only after
      // the scope backend has stopped the master (which takes its socket with
      // it), so a socket still on disk is one a master died without removing.
      // Keeping the unlink out of cleanupSessionFiles keeps that function to
      // files this module owns.
      await cleanupSessionFiles(sessionsDir, id);
      const socket = sessionSocketPath(sessionsDir, id);
      // On Windows the socket is a named pipe with nothing on disk to remove.
      if (!isPipePath(socket)) await fsPromises.unlink(socket).catch(() => {});
    }),
  );

  // Count what is actually gone: a removal that failed leaves its artifact
  // behind, and the next pass retries it.
  let remaining: Set<string>;
  try {
    remaining = new Set(
      (await fsPromises.readdir(sessionsDir, { withFileTypes: true }))
        .map((entry) => sessionIdOfArtifact(entry))
        .filter((id): id is string => id !== null),
    );
  } catch (err) {
    // Can't tell what is left, so don't claim anything was swept.
    resolvedLog?.warn(
      { err, removed: removed.length },
      "sweepOrphanedSessionTmpDirs: could not re-list the sessions directory to count removals",
    );
    return 0;
  }
  const swept = removed.filter((id) => !remaining.has(id)).length;
  if (swept < removed.length) {
    resolvedLog?.warn(
      { stuck: removed.length - swept },
      "sweepOrphanedSessionTmpDirs: some session files could not be removed",
    );
  }
  return swept;
}
