import type { FastifyInstance } from "fastify";
import type { SessionInfo } from "./pty-manager.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { getRemoteHostClient } from "./remote-host-client.js";
import { saveSessionUpload } from "./session-upload.js";
import { createWorktree, type WorktreeResult } from "./git-worktree.js";
import type { PromoteDecision } from "../plugins/hooks.js";

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
  }): Promise<void>;
  liveStatus(ids: string[], idleThresholdMs: number): Promise<Record<string, SessionInfo | null>>;
  isMasterAlive(ids: string[]): Promise<Record<string, boolean>>;
  terminate(id: string): Promise<void>;
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
  // Issue #271 — stashes a seed prompt for a NEW session's SessionStart hook
  // to pick up, on whichever host that session actually runs on.
  stashSeed(id: string, seed: string): Promise<void>;
  // Issue #271 — delivers a promote decision to whichever host is actually
  // holding the open promote_request connection (only that process's
  // hooks.ts can write the reply). Returns false if no promote request is
  // currently pending for this session.
  resolvePendingPromote(id: string, decision: PromoteDecision): Promise<boolean>;
}

class LocalBackend implements SessionBackend {
  constructor(private readonly app: FastifyInstance) {}

  async spawn(opts: {
    id: string;
    cwd: string;
    command: string;
    cols: number;
    rows: number;
  }): Promise<void> {
    // PtyManager.getOrCreate/Session.spawn never throw synchronously — a
    // failed spawn is caught internally and logged (see pty-manager.ts) —
    // so, unlike RemoteBackend.spawn below, this can't trigger the
    // remote-spawn-rollback path in sessions.ts.
    this.app.pty.getOrCreate(opts);
  }

  async liveStatus(
    ids: string[],
    idleThresholdMs: number,
  ): Promise<Record<string, SessionInfo | null>> {
    const result: Record<string, SessionInfo | null> = Object.create(null);
    for (const id of ids) {
      result[id] = this.app.pty.get(id)?.toInfo(idleThresholdMs) ?? null;
    }
    return result;
  }

  async isMasterAlive(ids: string[]): Promise<Record<string, boolean>> {
    const entries = await Promise.all(
      ids.map(async (id) => [id, await this.app.pty.isMasterAlive(id)] as const),
    );
    const result: Record<string, boolean> = Object.create(null);
    for (const [id, alive] of entries) result[id] = alive;
    return result;
  }

  async terminate(id: string): Promise<void> {
    await this.app.pty.terminate(id);
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

  async stashSeed(id: string, seed: string): Promise<void> {
    this.app.pty.stashSeed(id, seed);
  }

  async resolvePendingPromote(id: string, decision: PromoteDecision): Promise<boolean> {
    return this.app.resolvePendingPromote(id, decision);
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
  }): Promise<void> {
    return this.client.spawn(opts);
  }

  liveStatus(ids: string[], idleThresholdMs: number): Promise<Record<string, SessionInfo | null>> {
    return this.client.bulkLiveStatus(ids, idleThresholdMs);
  }

  isMasterAlive(ids: string[]): Promise<Record<string, boolean>> {
    return this.client.bulkIsMasterAlive(ids);
  }

  terminate(id: string): Promise<void> {
    return this.client.terminate(id);
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

  stashSeed(id: string, seed: string): Promise<void> {
    return this.client.resolveStashSeed(id, seed);
  }

  resolvePendingPromote(id: string, decision: PromoteDecision): Promise<boolean> {
    return this.client.resolvePendingPromote(id, decision);
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
