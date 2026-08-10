import type { FastifyInstance } from "fastify";
import type { SessionInfo } from "./pty-manager.js";
import type { CgroupProcess } from "./cgroup-inventory.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { getRemoteHostClient, type SpawnResult } from "./remote-host-client.js";
import { saveSessionUpload } from "./session-upload.js";
import {
  checkoutBranchWorktree,
  clearOrphanedTaskWorktree,
  createWorktree,
  listTaskWorktreeDirs,
  pruneWorktrees,
  pruneWorktreeMetadata,
  removeListedWorktree,
  removeWorktree,
  removeWorktreeIfClean,
  resumeTaskWorktree,
  syncWorktree,
  type ClearOrphanedTaskWorktreeResult,
  type PruneWorktreesResult,
  type RemoveIfCleanResult,
  type RemoveListedWorktreeResult,
  type WorktreeResult,
} from "./git-worktree.js";
import { deleteBranch, type DeleteBranchResult } from "./git-branch-delete.js";
import type { PromoteDecision } from "../plugins/hooks.js";
import { adapterHasInitialPromptArgs } from "./hook-adapters/index.js";

// The seam that lets every route (sessions.ts, terminal.ts's non-attach
// paths, session-reconciler.ts) spawn/query/terminate a session without
// caring whether it lives on this process's own app.pty or on a remote
// agent over HTTP — see the plan's "same intent-vs-live-state seam, now
// host-aware" framing. WS attach is deliberately NOT part of this
// interface: piping bytes needs the raw upstream socket
// (remote-host-client.ts's openAttach), not a request/response call, so
// routes/terminal.ts branches on local-vs-remote directly instead.
export interface SessionBackend {
  spawn(opts: {
    id: string;
    cwd: string;
    command: string;
    cols: number;
    rows: number;
    skipPermissions?: boolean;
    initialPrompt?: string;
    projectId?: number;
  }): Promise<SpawnResult>;
  liveStatus(
    ids: string[],
    idleThresholdMs: number,
    sessionProjectIds?: Record<string, number>,
  ): Promise<Record<string, SessionInfo | null>>;
  isMasterAlive(ids: string[]): Promise<Record<string, boolean>>;
  terminate(id: string): Promise<void>;
  // Phase 4 (#187) — the scrollback replay buffer for whichever host
  // actually runs this session's PTY. Never rejects for "not currently
  // tracked" (a restart before reattach, same as liveStatus's own
  // null-safe posture) — returns an empty buffer instead, since that's a
  // legitimate "no history yet" state, not a host/session error.
  getScrollback(id: string): Promise<Buffer>;
  // Icebox item filed during Phase 5 (#230) planning — the genuine OS
  // subprocesses running inside a session's cgroup (MCP servers,
  // `Bash run_in_background` jobs, nested CLIs), not to be confused with
  // Claude Code subagents (in-process, no PID — see #191/#193). Local hosts
  // only for now: it reads this process's own systemd/cgroupfs, the same
  // scoping RemoteBackend still applies to resumeTaskWorktree below (#484's
  // scope — checkoutBranchWorktree above got its own remote support in
  // #345). Returns `[]` on a remote host rather than throwing, same "not
  // supported yet" posture as resumeTaskWorktree.
  listSessionProcesses(id: string): Promise<CgroupProcess[]>;
  // Issue #68: writes a pasted/attached image under a session's own cwd —
  // on whichever host actually runs that session's CLI, since a file path
  // is only useful to a process that can open it — and returns that path.
  uploadImage(cwd: string, buffer: Buffer, mime: string): Promise<{ path: string }>;
  // Issue #178 — delivers a human decision to a pending review gate, on
  // whichever host is actually holding the open hook connection (only that
  // process's hooks.ts can write the reply — see that file's
  // resolvePendingGate). Returns false if no gate is currently pending for
  // this session (already resolved, timed out, or its connection died).
  resolveReviewGate(id: string, decision: "approved" | "denied", reason?: string): Promise<boolean>;
  // Issue #271 — creates a worktree on whichever host actually owns `cwd`'s
  // filesystem, for the launcher-toggle and promote flows. Returns `null`
  // when creation fails for a git-level reason (bad baseRef, not a repo);
  // callers must not proceed to spawn a session against a nonexistent path.
  createWorktree(
    cwd: string,
    baseRef: string,
    seed: string,
    branchName?: string,
  ): Promise<WorktreeResult | null>;
  // Checks out an existing branch into a fresh detached-HEAD worktree on
  // whichever host owns `cwd`'s filesystem (dock preview flow, issue #345).
  checkoutBranchWorktree(cwd: string, branch: string): Promise<WorktreeResult | null>;
  // Issue #345 — force-removes a dock-preview worktree (`git worktree
  // remove --force`) on whichever host owns it. Distinct from
  // removeWorktreeIfClean below (never `--force`) — an HMR dev server
  // running inside a preview worktree is almost always dirty. Used by
  // killSession/the reconciler/the spawn-failure rollback, and by the
  // worktreeRefresh sync tick's `pendingRemoval` retry — see
  // git-worktree.ts's PreviewWorktreeInfo.remove doc comment.
  removeWorktree(worktreePath: string, parentCwd?: string): Promise<boolean>;
  // Issue #345 — resets a dock-preview worktree to the current tip of a
  // LOCAL branch ref (`git reset --hard`, no fetch) on whichever host owns
  // it, for the worktreeRefresh live-sync tick. Safe only because the
  // worktree's HEAD is detached (checkoutBranchWorktree above) — see
  // git-worktree.ts's syncWorktree doc comment.
  syncWorktree(worktreePath: string, branch: string): Promise<boolean>;
  // #483 — the retry route's resume-on-preserved-branch checkout (see
  // git-worktree.ts's resumeTaskWorktree doc comment). #484 — proxied to a
  // remote host via /internal/git-worktree/resume, the same way every
  // other worktree-lifecycle op on this interface already is.
  resumeTaskWorktree(cwd: string, branchName: string): Promise<WorktreeResult | null>;
  // #484 — lists this host's own on-disk task-worktree directories, for the
  // primary's boot-time orphan sweep (plugins/task-watcher.ts). See
  // git-worktree.ts's listTaskWorktreeDirs doc comment for what "task
  // worktree" means here and why this can't distinguish orphan from in-use
  // on its own.
  listTaskWorktreeDirs(cwd: string): Promise<string[]>;
  // Issue #271 — stashes a seed prompt for a NEW session's SessionStart hook
  // to pick up, on whichever host that session actually runs on.
  stashSeed(id: string, seed: string): Promise<void>;
  // Issue #271 — delivers a promote decision to whichever host is actually
  // holding the open promote_request connection (only that process's
  // hooks.ts can write the reply). Returns false if no promote request is
  // currently pending for this session.
  resolvePendingPromote(id: string, decision: PromoteDecision): Promise<boolean>;
  // Phase 6's 6.8 (issue #283) — removes a task worktree on whichever host
  // actually owns it, only when clean (never `--force`; see
  // git-worktree.ts's removeWorktreeIfClean doc comment for what "clean"
  // does and doesn't protect against).
  removeWorktreeIfClean(worktreePath: string, parentCwd?: string): Promise<RemoveIfCleanResult>;
  // Phase 6's 6.8 (issue #283) — removes the explicitly-named orphan task
  // worktrees in `orphanPaths` on whichever host owns `cwd`'s filesystem.
  // Deliberately takes a caller-computed delete list, not just `cwd` — see
  // git-worktree.ts's pruneWorktrees doc comment for why.
  pruneWorktrees(cwd: string, orphanPaths: string[]): Promise<PruneWorktreesResult>;
  // Phase 6's 6.8 (issue #283) — task-claim.ts's pre-claim orphan clearing;
  // see git-worktree.ts's clearOrphanedTaskWorktree doc comment for why
  // this (unlike removeWorktreeIfClean) also deletes the branch ref.
  clearOrphanedTaskWorktree(
    cwd: string,
    worktreePath: string,
    branchName: string,
  ): Promise<ClearOrphanedTaskWorktreeResult>;
  // Issue #442 — deletes a local branch on whichever host owns `cwd`'s
  // filesystem, for the GitPanel's manual branch-management UI. The
  // `task-branch` refusal reason isn't produced here — it needs the tasks
  // DB table, which this DB-less seam has no access to; that guard lives
  // one layer up, in routes/projects.ts (see git-branch-delete.ts's own
  // doc comment).
  deleteBranch(cwd: string, name: string, opts?: { force?: boolean }): Promise<DeleteBranchResult>;
  // Issue #442 — removes any worktree `git worktree list` itself reports
  // for `cwd` (not just a task-scoped one) on whichever host owns it. The
  // `sessions-active` refusal reason isn't produced here either, for the
  // same DB-access reason as deleteBranch above; see git-worktree.ts's
  // removeListedWorktree doc comment for what force does and doesn't do.
  removeListedWorktree(
    cwd: string,
    worktreePath: string,
    opts?: { force?: boolean },
  ): Promise<RemoveListedWorktreeResult>;
  // Issue #442 — clears stale worktree administrative metadata (`git
  // worktree prune`) on whichever host owns `cwd`. Never removes a worktree
  // that still exists on disk — see git-worktree.ts's pruneWorktreeMetadata
  // doc comment.
  pruneWorktreeMetadata(cwd: string): Promise<{ pruned: boolean }>;
}

class LocalBackend implements SessionBackend {
  constructor(private readonly app: FastifyInstance) {}

  async spawn(opts: {
    id: string;
    cwd: string;
    command: string;
    cols: number;
    rows: number;
    skipPermissions?: boolean;
    initialPrompt?: string;
    projectId?: number;
  }): Promise<SpawnResult> {
    // B6 fix — PtyManager.getOrCreate()/Session.spawn() themselves never
    // throw synchronously (getOrCreate() is sync by design; a spawn failure
    // is caught-and-logged internally, not thrown out of getOrCreate() —
    // see pty-manager.ts's Session.spawn()), but the session it just created
    // now exposes spawnOutcome(): the SAME first-attempt promise spawn()
    // kicked off internally, awaited here instead of discarded. This is what
    // lets a genuine local spawn failure (missing systemd-run/dtach, a
    // vanished cwd, a scope-name collision) actually reject this call and
    // reach routes/sessions.ts's existing rollback `catch` block — before
    // this fix, that block was dead code for the local-spawn path: a real
    // failure returned 201 with a live-looking row, a created worktree never
    // registered for cleanup, and no program actually running (the row only
    // self-healed later via the 30s reconciler).
    const session = this.app.pty.getOrCreate(opts);
    await session.spawnOutcome();
    // No version-skew risk for a local spawn — same process/build as the
    // caller, so this is computed directly rather than echoed back.
    return {
      initialPromptApplied:
        opts.initialPrompt !== undefined && adapterHasInitialPromptArgs(opts.command),
    };
  }

  async liveStatus(
    ids: string[],
    idleThresholdMs: number,
    _sessionProjectIds?: Record<string, number>,
  ): Promise<Record<string, SessionInfo | null>> {
    const result: Record<string, SessionInfo | null> = Object.create(null);
    for (const id of ids) {
      result[id] = this.app.pty.get(id)?.toInfo(idleThresholdMs) ?? null;
    }
    return result;
  }

  // Perf audit finding B8(2) — used to Promise.all(ids.map(id =>
  // app.pty.isMasterAlive(id))): one `systemctl --user is-active` subprocess
  // spawn per active session, every reconcile tick. isMasterAliveBatch
  // (pty-manager.ts) does the equivalent check with a single `systemctl
  // --user list-units` spawn for the whole batch.
  async isMasterAlive(ids: string[]): Promise<Record<string, boolean>> {
    return this.app.pty.isMasterAliveBatch(ids);
  }

  async terminate(id: string): Promise<void> {
    await this.app.pty.terminate(id);
  }

  async getScrollback(id: string): Promise<Buffer> {
    return this.app.pty.get(id)?.getScrollback() ?? Buffer.alloc(0);
  }

  listSessionProcesses(id: string): Promise<CgroupProcess[]> {
    return this.app.pty.listSessionProcesses(id);
  }

  async uploadImage(cwd: string, buffer: Buffer, mime: string): Promise<{ path: string }> {
    return { path: saveSessionUpload(cwd, buffer, mime) };
  }

  async resolveReviewGate(
    id: string,
    decision: "approved" | "denied",
    reason?: string,
  ): Promise<boolean> {
    return this.app.resolveHookGate(id, decision, reason);
  }

  createWorktree(
    cwd: string,
    baseRef: string,
    seed: string,
    branchName?: string,
  ): Promise<WorktreeResult | null> {
    return createWorktree({ cwd, baseRef, seed, branchName });
  }

  checkoutBranchWorktree(cwd: string, branch: string): Promise<WorktreeResult | null> {
    return checkoutBranchWorktree(cwd, branch);
  }

  removeWorktree(worktreePath: string, parentCwd?: string): Promise<boolean> {
    return removeWorktree(worktreePath, parentCwd);
  }

  syncWorktree(worktreePath: string, branch: string): Promise<boolean> {
    return syncWorktree(worktreePath, branch);
  }

  resumeTaskWorktree(cwd: string, branchName: string): Promise<WorktreeResult | null> {
    return resumeTaskWorktree(cwd, branchName);
  }

  listTaskWorktreeDirs(cwd: string): Promise<string[]> {
    return Promise.resolve(listTaskWorktreeDirs(cwd));
  }

  async stashSeed(id: string, seed: string): Promise<void> {
    this.app.pty.stashSeed(id, seed);
  }

  async resolvePendingPromote(id: string, decision: PromoteDecision): Promise<boolean> {
    return this.app.resolvePendingPromote(id, decision);
  }

  removeWorktreeIfClean(worktreePath: string, parentCwd?: string): Promise<RemoveIfCleanResult> {
    return removeWorktreeIfClean(worktreePath, parentCwd);
  }

  pruneWorktrees(cwd: string, orphanPaths: string[]): Promise<PruneWorktreesResult> {
    return pruneWorktrees(cwd, orphanPaths);
  }

  clearOrphanedTaskWorktree(
    cwd: string,
    worktreePath: string,
    branchName: string,
  ): Promise<ClearOrphanedTaskWorktreeResult> {
    return clearOrphanedTaskWorktree(cwd, worktreePath, branchName);
  }

  deleteBranch(cwd: string, name: string, opts?: { force?: boolean }): Promise<DeleteBranchResult> {
    return deleteBranch(cwd, name, opts);
  }

  removeListedWorktree(
    cwd: string,
    worktreePath: string,
    opts?: { force?: boolean },
  ): Promise<RemoveListedWorktreeResult> {
    return removeListedWorktree(cwd, worktreePath, opts);
  }

  pruneWorktreeMetadata(cwd: string): Promise<{ pruned: boolean }> {
    return pruneWorktreeMetadata(cwd);
  }
}

class RemoteBackend implements SessionBackend {
  constructor(
    private readonly app: FastifyInstance,
    private readonly hostId: string,
  ) {}

  private get client() {
    return getRemoteHostClient(this.app, this.hostId);
  }

  spawn(opts: {
    id: string;
    cwd: string;
    command: string;
    cols: number;
    rows: number;
    skipPermissions?: boolean;
    initialPrompt?: string;
    projectId?: number;
  }): Promise<SpawnResult> {
    return this.client.spawn(opts);
  }

  liveStatus(
    ids: string[],
    idleThresholdMs: number,
    sessionProjectIds?: Record<string, number>,
  ): Promise<Record<string, SessionInfo | null>> {
    return this.client.bulkLiveStatus(ids, idleThresholdMs, sessionProjectIds);
  }

  isMasterAlive(ids: string[]): Promise<Record<string, boolean>> {
    return this.client.bulkIsMasterAlive(ids);
  }

  terminate(id: string): Promise<void> {
    return this.client.terminate(id);
  }

  getScrollback(id: string): Promise<Buffer> {
    return this.client.resolveScrollback(id);
  }

  listSessionProcesses(_id: string): Promise<CgroupProcess[]> {
    // Not supported on remote hosts yet — no remote-host-client wiring for
    // this exists. See the interface doc comment above.
    return Promise.resolve([]);
  }

  uploadImage(cwd: string, buffer: Buffer, mime: string): Promise<{ path: string }> {
    return this.client.uploadImage(cwd, buffer, mime);
  }

  resolveReviewGate(
    id: string,
    decision: "approved" | "denied",
    reason?: string,
  ): Promise<boolean> {
    return this.client.resolveReviewGate(id, decision, reason);
  }

  createWorktree(
    cwd: string,
    baseRef: string,
    seed: string,
    branchName?: string,
  ): Promise<WorktreeResult | null> {
    return this.client.resolveCreateWorktree(cwd, baseRef, seed, branchName);
  }

  checkoutBranchWorktree(cwd: string, branch: string): Promise<WorktreeResult | null> {
    return this.client.resolveCheckoutBranchWorktree(cwd, branch);
  }

  removeWorktree(worktreePath: string, parentCwd?: string): Promise<boolean> {
    return this.client.resolveRemoveWorktree(worktreePath, parentCwd);
  }

  syncWorktree(worktreePath: string, branch: string): Promise<boolean> {
    return this.client.resolveSyncWorktree(worktreePath, branch);
  }

  resumeTaskWorktree(cwd: string, branchName: string): Promise<WorktreeResult | null> {
    return this.client.resolveResumeTaskWorktree(cwd, branchName);
  }

  listTaskWorktreeDirs(cwd: string): Promise<string[]> {
    return this.client.resolveTaskWorktreeDirs(cwd);
  }

  stashSeed(id: string, seed: string): Promise<void> {
    return this.client.resolveStashSeed(id, seed);
  }

  resolvePendingPromote(id: string, decision: PromoteDecision): Promise<boolean> {
    return this.client.resolvePendingPromote(id, decision);
  }

  removeWorktreeIfClean(worktreePath: string, parentCwd?: string): Promise<RemoveIfCleanResult> {
    return this.client.resolveRemoveWorktreeIfClean(worktreePath, parentCwd);
  }

  pruneWorktrees(cwd: string, orphanPaths: string[]): Promise<PruneWorktreesResult> {
    return this.client.resolvePruneWorktrees(cwd, orphanPaths);
  }

  clearOrphanedTaskWorktree(
    cwd: string,
    worktreePath: string,
    branchName: string,
  ): Promise<ClearOrphanedTaskWorktreeResult> {
    return this.client.resolveClearOrphanedTaskWorktree(cwd, worktreePath, branchName);
  }

  deleteBranch(cwd: string, name: string, opts?: { force?: boolean }): Promise<DeleteBranchResult> {
    return this.client.resolveDeleteBranch(cwd, name, opts?.force);
  }

  removeListedWorktree(
    cwd: string,
    worktreePath: string,
    opts?: { force?: boolean },
  ): Promise<RemoveListedWorktreeResult> {
    return this.client.resolveRemoveListedWorktree(cwd, worktreePath, opts?.force);
  }

  pruneWorktreeMetadata(cwd: string): Promise<{ pruned: boolean }> {
    return this.client.resolvePruneWorktreeMetadata(cwd);
  }
}

/** Resolve the backend that owns sessions for `hostId` — `"local"` (and,
 * defensively, any falsy/undefined hostId from a pre-#26 row) is served
 * in-process via `app.pty`; everything else is a RemoteHostClient reached
 * over HTTP. Never throws for an unknown remote hostId itself — the first
 * call against the returned backend will (via getRemoteHostClient), which
 * is where callers already handle failure (skip-on-unreachable, spawn
 * rollback, etc). */
export function resolveBackend(app: FastifyInstance, hostId: string): SessionBackend {
  if (!hostId || hostId === LOCAL_HOST_ID) return new LocalBackend(app);
  return new RemoteBackend(app, hostId);
}
