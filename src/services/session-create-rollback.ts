// The rollback scope of createSessionRecord (session-lifecycle.ts): what a
// create has made so far, and the idempotent unwind of it on any non-ok result
// or throw. Split out of session-lifecycle.ts unchanged.
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { sessions } from "../db/schema.js";
import { forceRemoveCheckout } from "./checkout-removal.js";
import { resolveBackend } from "./session-backend.js";

// What createSessionRecordInner has created so far and so must unwind.
export interface CreateRollback {
  /** The host the session's SCOPE was created on — the placement host. */
  hostId?: string;
  /**
   * The host the session's WORKTREE was created on — issue #1722: the
   * worktree is cut from the project's repo, so it is created on the
   * PROJECT's host, while the scope runs on the placement host. The two
   * are the same host today; #1724 makes them differ, and a rollback that
   * sent the worktree cleanup to the scope's host would leave a leaked
   * worktree and an undeleted branch with no log line. So they are
   * tracked separately.
   */
  worktreeHostId?: string;
  projectId?: number; // for releasing the worktree's browsers
  /** Worktree created by this call (never a pre-existing one). */
  worktreePath?: string;
  /** Repo the worktree was cut from (parentCwd for removeWorktree/deleteBranch). */
  parentCwd?: string;
  /** Branch created together with the worktree (baseRef path only). */
  branch?: string;
  /** Issue #2245 — prepareWorktree cut a fresh tree for this call (not a resume
   * of an existing one), so the project's setup recipe runs in it. */
  cutWorktree?: boolean;
  /** Inserted `sessions` row id, once the insert committed. */
  sessionId?: number;
  spawned: boolean;
  done: boolean;
}

// Idempotent, best-effort, never throws: terminate any scope/Session this
// call created for `sessionId` (never an id it didn't create), remove the
// worktree and its branch, then delete the row. Each step is its own
// try/catch — a RemoteBackend method can throw synchronously from its
// `client` getter (hosts row deleted mid-request), and one failing step
// must not skip the rest.
export async function rollbackCreate(app: FastifyInstance, rb: CreateRollback): Promise<void> {
  if (rb.done) return;
  rb.done = true;
  // Either host is enough to have something to undo: the scope's host (the
  // terminate) or the worktree's host (the worktree/branch cleanup). They
  // are two INDEPENDENT fields (issue #1722) — so the gate has to name
  // both, or a rollback that only ever made a worktree would be skipped
  // and leave the worktree and its branch behind.
  if (rb.hostId === undefined && rb.worktreeHostId === undefined) return;
  if (rb.sessionId !== undefined && rb.hostId !== undefined) {
    try {
      await resolveBackend(app, rb.hostId).terminate(String(rb.sessionId));
    } catch (err) {
      app.log.warn({ err, sessionId: rb.sessionId }, "create rollback: terminate failed");
    }
  }
  if (rb.worktreePath !== undefined) {
    // The worktree lives on ITS host — the project's, where it was cut
    // from — which is not necessarily the host the scope was created on
    // (issue #1722).
    const wtHost = rb.worktreeHostId ?? rb.hostId!;
    const worktreeBackend = () => resolveBackend(app, wtHost);
    try {
      await forceRemoveCheckout(app, rb.projectId, wtHost, rb.worktreePath, rb.parentCwd);
    } catch {
      // Best-effort: a leaked worktree directory is the cheaper failure —
      // same posture as cleanupPreviewWorktree's pendingRemoval retry.
    }
    if (rb.branch !== undefined && rb.parentCwd !== undefined) {
      try {
        await worktreeBackend().deleteBranch(rb.parentCwd, rb.branch, { force: true });
      } catch {
        // Best-effort, as above.
      }
    }
  }
  if (rb.sessionId !== undefined) {
    app.db.delete(sessions).where(eq(sessions.id, rb.sessionId)).run();
  }
}
