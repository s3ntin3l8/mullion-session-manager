// Issue #1964 — reclaiming the git worktree of an isolated session once it ends.
//
// A session that runs in a worktree Mullion cut for it — the launcher's
// "isolate" toggle (#271), a child spawned with `--isolate` (#1951),
// `promote_to_worktree` — leaves a directory and a `git worktree` entry behind
// when it ends. Nothing owned them: `rollbackCreate` only unwinds a FAILED
// create, `cleanupPreviewWorktree` is keyed to dock-preview tracking, and the
// prune sweeps cover `mullion-task-` worktrees only. A coordinator dispatching
// many `--isolate` children to another host accumulates them there.
//
// The session row now records what it owns (`sessions.worktree_branch` /
// `worktree_repo_cwd`), and this module reclaims it — but only when doing so
// cannot lose anything:
//
//   - the worktree is not in use by another active session;
//   - its branch is PUSHED (an upstream it is not ahead of, or an upstream that
//     is gone) or already MERGED into the default branch;
//   - the working tree is clean (`removeWorktreeIfClean`, which never uses
//     `--force` and refuses on uncommitted changes or merge conflicts).
//
// The BRANCH is never deleted — only the directory — so even a worktree removed
// by mistake loses no commit. Anything that fails a gate is LEFT in place with
// the reason on the row (`worktree_kept_reason`), where `GET /api/sessions`
// shows it: "surface the leftover instead".
//
// Everything goes through `resolveBackend` / `resolveHostBranches`, so a session
// on another host is reclaimed the same way as a local one. Triggered when the
// session ends (killSession, the reconciler) and by a primary-side sweep
// (plugins/session-worktree-sweep.ts) for the ones that were not yet pushed or
// merged at that moment — an agent has no database and no timers of its own.

import type { FastifyInstance } from "fastify";
import { and, asc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { sessions } from "../db/schema.js";
import type { GitBranchInfo } from "../shared/types.js";
import { resolveHostBranches, resolveHostGitStatus } from "./host-git.js";
import { resolveBackend } from "./session-backend.js";
import { resolveSessionHostId } from "./session-live-info.js";
import { sessionsUsingWorktree, WorktreeComparisonTimeout } from "./worktree-usage.js";
import type { DeadHistoryHint } from "./worktree-usage.js";

export type KeptReason =
  | "in-use"
  | "still-running"
  | "unpushed"
  | "branch-missing"
  | "dirty"
  | "conflicts"
  | "remove-failed";

export type ReclaimOutcome =
  | { status: "reclaimed" }
  | { status: "kept"; reason: KeptReason }
  /** The host could not be asked (unreachable, an agent too old for the
   * route): nothing is recorded, the sweep tries again. */
  | { status: "deferred" }
  | {
      status: "skipped";
      reason: "not-found" | "no-worktree" | "already-reclaimed" | "active" | "in-flight";
    };

/** Sessions being reclaimed right now, so a kill and a sweep tick racing on the
 * same session do not both run git against it. */
const inFlight = new Set<number>();
// Shorter than the agent client's individual five-second request timeout, so
// a slow agent is skipped for this whole pass instead of retried per worktree.
const SWEEP_COMPARISON_TIMEOUT_MS = 4_000;
type SweepContext = {
  timedOutHosts: Set<string>;
  deadHistory: DeadHistoryHint;
};

/**
 * Holds the same in-flight slot for a manual removal (Settings → Storage), so
 * a sweep tick and the user's Remove never run git against one session at
 * once. False when a reclaim already holds it; release with
 * `releaseReclaimSlot` once done.
 */
export function claimReclaimSlot(sessionId: number): boolean {
  if (inFlight.has(sessionId)) return false;
  inFlight.add(sessionId);
  return true;
}

export function releaseReclaimSlot(sessionId: number): void {
  inFlight.delete(sessionId);
}

/** Whether `branch` has nothing to lose by its worktree going away: pushed to an
 * upstream it is not ahead of, whose upstream was deleted (the usual sign of a
 * merged-and-cleaned-up PR), or merged into the default branch. A worktree
 * branch is created with `--no-track`, so one pushed WITHOUT `-u` has no upstream
 * and reads as unpushed — the conservative answer; push with `-u`. */
function branchIsSafe(branch: GitBranchInfo): boolean {
  if (branch.isMerged === true) return true;
  if (branch.upstreamGone === true) return true;
  return branch.upstream !== undefined && (branch.ahead ?? 0) === 0;
}

/** Stamps the attempt, whatever happens next — it is what the sweep orders by. */
function recordAttempt(app: FastifyInstance, row: typeof sessions.$inferSelect) {
  app.db
    .update(sessions)
    .set({ worktreeLastAttemptAt: new Date() })
    .where(eq(sessions.id, row.id))
    .run();
}

function recordKept(app: FastifyInstance, row: typeof sessions.$inferSelect, reason: KeptReason) {
  if (row.worktreeKeptReason === reason) return;
  app.db.update(sessions).set({ worktreeKeptReason: reason }).where(eq(sessions.id, row.id)).run();
  app.log.info(
    { sessionId: row.id, worktree: row.cwd, branch: row.worktreeBranch, reason },
    "session worktree left in place",
  );
}

/** Marks the session's worktree as gone. Also called by the manual removal in
 * Settings → Storage (`POST /api/projects/:id/git-worktree-remove` with a
 * `sessionId`), so a worktree the user removed drops off that list. */
export function recordReclaimed(app: FastifyInstance, row: typeof sessions.$inferSelect) {
  app.db
    .update(sessions)
    .set({ worktreeReclaimedAt: new Date(), worktreeKeptReason: null })
    .where(eq(sessions.id, row.id))
    .run();
  app.log.info(
    { sessionId: row.id, worktree: row.cwd, branch: row.worktreeBranch },
    "session worktree reclaimed (branch kept)",
  );
}

/**
 * Tries to reclaim the worktree session `sessionId` owns. Safe to call at any
 * time and any number of times: it re-reads the row, does nothing for a session
 * that is still active or owns no worktree, and records why it left a worktree
 * in place. Never throws.
 */
export async function reclaimSessionWorktree(
  app: FastifyInstance,
  sessionId: number,
  sweep?: SweepContext,
): Promise<ReclaimOutcome> {
  if (inFlight.has(sessionId)) return { status: "skipped", reason: "in-flight" };
  inFlight.add(sessionId);
  try {
    return await reclaim(app, sessionId, sweep);
  } catch (err) {
    app.log.warn({ err, sessionId }, "session worktree reclaim failed");
    return { status: "deferred" };
  } finally {
    inFlight.delete(sessionId);
  }
}

async function reclaim(
  app: FastifyInstance,
  sessionId: number,
  sweep?: SweepContext,
): Promise<ReclaimOutcome> {
  const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
  if (!row) return { status: "skipped", reason: "not-found" };
  if (!row.worktreeBranch || !row.worktreeRepoCwd || !row.cwd) {
    return { status: "skipped", reason: "no-worktree" };
  }
  if (row.worktreeReclaimedAt) return { status: "skipped", reason: "already-reclaimed" };
  if (row.status === "active") return { status: "skipped", reason: "active" };

  const hostId = resolveSessionHostId(app, row);
  recordAttempt(app, row);
  if (sweep?.timedOutHosts.has(hostId)) return { status: "deferred" };
  const keep = (reason: KeptReason): ReclaimOutcome => {
    recordKept(app, row, reason);
    return { status: "kept", reason };
  };

  let sibling: Awaited<ReturnType<typeof sessionsUsingWorktree>>;
  try {
    sibling = await sessionsUsingWorktree(
      app,
      row.cwd,
      hostId,
      row.id,
      true,
      sweep
        ? { remoteTimeoutMs: SWEEP_COMPARISON_TIMEOUT_MS, deadHistory: sweep.deadHistory }
        : undefined,
    );
  } catch (error) {
    if (!(error instanceof WorktreeComparisonTimeout) || !sweep) throw error;
    sweep.timedOutHosts.add(hostId);
    return { status: "deferred" };
  }
  if (sibling.active.length > 0 || sibling.alive.length > 0) return keep("in-use");
  if (sibling.unknown.length > 0) return { status: "deferred" };

  // The session's own process, too. A kill whose `terminate` failed still
  // marks the row ended, and its agent may be running in this directory yet;
  // removing the directory out from under it would be the one reclaim that
  // hurts. Only a confirmed-dead process lets it proceed.
  const liveness = (await resolveBackend(app, hostId).liveness([String(sessionId)]))[
    String(sessionId)
  ];
  if (liveness === "alive") return keep("still-running");
  if (liveness !== "dead") return { status: "deferred" };

  // The repo is asked about first (it still answers when the worktree
  // directory is already gone). A repo path that is a SUBDIRECTORY of the
  // repository (a monorepo project; a session whose cwd was a package) has no
  // `.git` of its own and reads as "not a repository" — then the worktree
  // itself, which always has one, is asked instead: it lists the same branches.
  let branches = await resolveHostBranches(app, hostId, row.worktreeRepoCwd);
  if (branches.ok && branches.value.length === 0) {
    branches = await resolveHostBranches(app, hostId, row.cwd);
  }
  if (!branches.ok) {
    app.log.debug(
      { sessionId, hostId, reason: branches.reason },
      "session worktree reclaim deferred",
    );
    return { status: "deferred" };
  }
  const branch = branches.value.find((candidate) => candidate.name === row.worktreeBranch);
  if (!branch) {
    // No branches from EITHER path means neither is a repository: the worktree
    // was removed by hand, or the project moved or was deleted. There is nothing
    // left to reclaim — say so, instead of parking a misleading
    // `branch-missing` on it forever. A worktree that still exists but has lost
    // its branch is a repository, and stays kept.
    if (branches.value.length === 0) {
      const status = await resolveHostGitStatus(app, hostId, row.cwd);
      if (!status.ok) return { status: "deferred" };
      if (!status.value.isRepo) {
        recordReclaimed(app, row);
        return { status: "reclaimed" };
      }
    }
    return keep("branch-missing");
  }
  if (!branchIsSafe(branch)) return keep("unpushed");

  const removal = await resolveBackend(app, hostId).removeWorktreeIfClean(
    row.cwd,
    row.worktreeRepoCwd,
  );
  if (removal.removed) {
    recordReclaimed(app, row);
    return { status: "reclaimed" };
  }
  // "not-a-repo" is "nothing exists at this path" (or something that is not a
  // worktree): there is nothing of ours left to reclaim.
  if (removal.reason === "not-a-repo") {
    recordReclaimed(app, row);
    return { status: "reclaimed" };
  }
  return keep(removal.reason ?? "remove-failed");
}

/** Sessions that ended still owning a worktree nobody has reclaimed yet. */
export function sessionsAwaitingReclaim(app: FastifyInstance, limit: number): number[] {
  return (
    app.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          ne(sessions.status, "active"),
          isNotNull(sessions.worktreeBranch),
          isNull(sessions.worktreeReclaimedAt),
        ),
      )
      // Never attempted first, then the least recently tried: sessions parked on
      // "dirty" or "unpushed", or on a host that does not answer, rotate to the
      // back instead of crowding out everything behind them.
      .orderBy(
        sql`${sessions.worktreeLastAttemptAt} IS NOT NULL`,
        asc(sessions.worktreeLastAttemptAt),
        asc(sessions.id),
      )
      .limit(limit)
      .all()
      .map((row) => row.id)
  );
}

/** One pass of the periodic sweep: tries every ended session that still owns a
 * worktree, oldest first, one at a time (each is a git round trip, possibly to
 * another host). Returns what happened, for the log. */
export async function sweepSessionWorktrees(
  app: FastifyInstance,
  limit = 100,
): Promise<{ reclaimed: number; kept: number; deferred: number }> {
  const counts = { reclaimed: 0, kept: 0, deferred: 0 };
  // A comparison is read-only: abandoning it cannot start a later removal.
  // Skip the rest of that host for this pass, but continue with other hosts.
  const sweep: SweepContext = {
    timedOutHosts: new Set(),
    deadHistory: { ids: new Set(), initialized: false },
  };
  for (const id of sessionsAwaitingReclaim(app, limit)) {
    const outcome = await reclaimSessionWorktree(app, id, sweep);
    if (outcome.status === "reclaimed") counts.reclaimed += 1;
    else if (outcome.status === "kept") counts.kept += 1;
    else if (outcome.status === "deferred") counts.deferred += 1;
  }
  return counts;
}
