import type { FastifyInstance } from "fastify";
import { WebSocket as NodeWebSocket } from "ws";
import type { DiscoveredCandidate, Launcher, DockControl } from "./project-config.js";
import type { AgentRuleTarget } from "./agent-rules.js";
import type { SkillInfo, SkillAgent } from "./skills.js";
import type { SessionInfo } from "./pty-manager.js";
import type { DetectedAgent } from "./agent-detect.js";
import type { GitHubRepoRef } from "./git-remote.js";
import type { GitStatus } from "./git-status.js";
import type { GitBranchInfo, GitWorktreeInfo } from "./git-refs.js";
import type { GitDiffStats } from "./git-diff.js";
import { getHostRow, decryptToken } from "./host-registry.js";
import type { PromoteDecision } from "../plugins/hooks.js";
import type {
  ClearOrphanedTaskWorktreeResult,
  PruneWorktreesResult,
  RemoveIfCleanResult,
  RemoveListedWorktreeResult,
} from "./git-worktree.js";
import type { DeleteBranchResult } from "./git-branch-delete.js";

// One HTTP+WS client per remote "agent" host (issue #26), talking to its
// token-gated /internal/* API (src/routes/internal.ts). Every request sets
// `Authorization: Bearer <token>`; a bearer WS header (not a query-string
// token) is only settable via the `ws` package's client, not the global
// WebSocket — see src/routes/internal.test.ts's identical reasoning.

export class HostUnreachableError extends Error {
  constructor(hostId: string, cause: unknown) {
    super(
      `Host ${hostId} is unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "HostUnreachableError";
    this.cause = cause;
  }
}

/** The agent responded — it IS reachable — but rejected the request (4xx):
 * a real client-side error (a malformed body, an unknown session id), not
 * a connectivity problem. Distinct from HostUnreachableError so a caller
 * that cares can tell "the agent said no" apart from "couldn't reach it"
 * (e.g. never treat a 4xx as grounds to skip reconciling a host — the host
 * is fine). Existing callers that just want "did this succeed" keep
 * working unchanged since this is still a thrown Error either way. */
export class HostRequestError extends Error {
  constructor(
    hostId: string,
    public readonly statusCode: number,
    // Issue #431, Hermes review on PR #458 — retained (not just folded into
    // the message string) so a caller that wants to forward the agent's
    // actual rejection reason (e.g. a JSON {message} body) to its own
    // response doesn't have to re-parse it back out of `.message`.
    public readonly body: string,
  ) {
    super(`Host ${hostId} rejected the request: HTTP ${statusCode}${body ? ` — ${body}` : ""}`);
    this.name = "HostRequestError";
  }
}

// A network blip must never read as "the agent said no sessions are alive"
// (landmine #1 — an unreachable host's sessions must be skipped, not
// flipped to exited) — every call below throws HostUnreachableError rather
// than returning a default/empty payload on network failure or timeout.
const REQUEST_TIMEOUT_MS = 5_000;

// Bulk live-status responses are reused for this long — see the plan's
// "list performance" note: multiple browser tabs/poll cycles hitting
// GET /api/sessions within the same short window shouldn't each cost this
// host its own HTTP round trip.
const LIVE_STATUS_CACHE_TTL_MS = 1_500;

// A preview asset request (issue #28 phase 6) can legitimately take longer
// than REQUEST_TIMEOUT_MS's 5s — a dev server compiling a route on first
// request (Vite/webpack's on-demand compilation) is a real, non-error delay
// this proxy must not preempt.
const PREVIEW_REQUEST_TIMEOUT_MS = 30_000;

// Same reasoning as PREVIEW_REQUEST_TIMEOUT_MS above, for the same reason:
// an image upload (issue #68) can be up to MAX_UPLOAD_BYTES (10 MiB,
// session-upload.ts) — a real, non-error transfer time over a WAN/VPN link
// to a remote agent that REQUEST_TIMEOUT_MS's 5s is nowhere near generous
// enough for.
const UPLOAD_REQUEST_TIMEOUT_MS = 30_000;

// spawn() and openAttach() both target the same session — same id/cwd/
// command/size — just over HTTP vs. WS; kept as one shared shape rather
// than two field-for-field-identical interfaces.
export interface SessionTarget {
  id: string;
  cwd: string;
  command: string;
  cols: number;
  rows: number;
  skipPermissions?: boolean;
  projectId?: number;
}

export type SpawnSessionOptions = SessionTarget;
export type OpenAttachOptions = SessionTarget;

// Issue #247 / roadmap 7.4 — mirrors GET /internal/config's response shape
// (routes/internal.ts). No idle timeout: that's a DB-backed Settings value
// on the primary, with no env-var equivalent an agent could read.
export interface AgentConfig {
  role: "primary" | "agent";
  version: string;
  projectsRoots: string[];
  sessionsDir: string;
  crsConfigDir: string;
  browserEnabled: boolean;
}

export class RemoteHostClient {
  private readonly baseUrl: string;
  private readonly wsBaseUrl: string;
  // No longer readonly (issue #245 / roadmap 7.1) — a registered host's
  // session credential can rotate out from under an already-cached client
  // (getRemoteHostClient's own cache is keyed on the DB row's current
  // credential fields, so a rotation normally rebuilds a fresh client
  // instead — see remote-host-client.ts's own clientCache comment — but
  // the retry-on-401 below covers the narrow race where the agent's own
  // renewal has already landed and the primary hasn't re-read the row yet).
  private token: string;
  private readonly hostId: string;
  // Issue #245 — set only for a session-credentialed (registered) host;
  // absent (undefined) for a manually-registered static-token one, which
  // never retries on 401 (a wrong static token isn't going to become right
  // by asking the DB again).
  private readonly refreshToken?: () => string | null;

  private liveStatusCache: {
    key: string;
    ts: number;
    result: Record<string, SessionInfo | null>;
  } | null = null;
  // Concurrent misses on the same key (e.g. two browser tabs' list
  // requests landing in the same tick, before either has populated
  // liveStatusCache) share one HTTP call instead of each firing their own.
  private liveStatusInFlight = new Map<string, Promise<Record<string, SessionInfo | null>>>();

  constructor(opts: {
    hostId: string;
    baseUrl: string;
    token: string;
    refreshToken?: () => string | null;
  }) {
    this.hostId = opts.hostId;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.wsBaseUrl = this.baseUrl.replace(/^http/, "ws");
    this.token = opts.token;
    this.refreshToken = opts.refreshToken;
  }

  private async rawFetch(
    path: string,
    init: RequestInit | undefined,
    timeoutMs: number,
  ): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...init?.headers, Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(timeoutMs),
        // hosts.ts's SSRF guard only validates the *configured* baseUrl —
        // fetch following a redirect by default would still send the
        // bearer token to wherever a 3xx response points, bypassing that
        // guard entirely (e.g. an agent, or a MITM between primary and
        // agent, redirecting to a cloud IMDS endpoint). "manual" surfaces
        // the 3xx as a non-ok response (handled as HostUnreachableError
        // below) instead of ever issuing the follow-up request.
        redirect: "manual",
      });
    } catch (err) {
      throw new HostUnreachableError(this.hostId, err);
    }
  }

  private async request<T>(
    path: string,
    init?: RequestInit,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    let res = await this.rawFetch(path, init, timeoutMs);
    // Retry-once-on-401 (issue #245 / roadmap 7.1): a session credential
    // this client was built with can go stale if the agent renewed it
    // (agent-enrollment.ts) between when getRemoteHostClient last read the
    // DB row and now. refreshToken() re-reads the row live; if it's
    // genuinely different, one retry with the fresh token — never more
    // than one, and never for a manually-registered host (no
    // refreshToken at all, see the constructor).
    if (res.status === 401 && this.refreshToken) {
      const fresh = this.refreshToken();
      if (fresh && fresh !== this.token) {
        this.token = fresh;
        res = await this.rawFetch(path, init, timeoutMs);
      }
    }
    if (!res.ok) {
      if (res.status >= 400 && res.status < 500) {
        const body = await res.text().catch(() => "");
        throw new HostRequestError(this.hostId, res.status, body);
      }
      throw new HostUnreachableError(this.hostId, new Error(`HTTP ${res.status}`));
    }
    // 204 (terminate) has no body — res.json() throws on an empty stream.
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  discover(): Promise<DiscoveredCandidate[]> {
    return this.request("/internal/discover");
  }

  // Issue #247 / roadmap 7.4 — see internal.ts's GET /internal/config for
  // what's (and isn't — no idle timeout, no DB-backed anything) included.
  resolveConfig(): Promise<AgentConfig> {
    return this.request("/internal/config");
  }

  resolveActions(cwd: string): Promise<Launcher[]> {
    return this.request(`/internal/actions?cwd=${encodeURIComponent(cwd)}`);
  }

  resolveDock(cwd: string): Promise<DockControl[]> {
    return this.request(`/internal/dock?cwd=${encodeURIComponent(cwd)}`);
  }

  // Issue #431 — the client half of the agent-rules triple; see
  // routes/internal.ts's /internal/agent-rules for the agent-side
  // containment (resolveWithinRoots) these three all rely on.
  resolveAgentRules(cwd: string): Promise<AgentRuleTarget[]> {
    return this.request(`/internal/agent-rules?cwd=${encodeURIComponent(cwd)}`);
  }

  // Issue #431, Hermes review on PR #458 — a names-only counterpart for the
  // sidebar's per-project indicator, so GET /api/projects's ruleFiles field
  // doesn't pull full file content (up to 512KB x 12 targets) for a remote
  // project on every poll — see /internal/agent-rules/exists's own comment.
  resolveExistingRuleFileNames(cwd: string): Promise<string[]> {
    return this.request(`/internal/agent-rules/exists?cwd=${encodeURIComponent(cwd)}`);
  }

  writeAgentRule(cwd: string, target: string, content: string): Promise<AgentRuleTarget> {
    return this.request(
      `/internal/agent-rules/${encodeURIComponent(target)}?cwd=${encodeURIComponent(cwd)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      },
    );
  }

  deleteAgentRule(cwd: string, target: string): Promise<void> {
    return this.request(
      `/internal/agent-rules/${encodeURIComponent(target)}?cwd=${encodeURIComponent(cwd)}`,
      { method: "DELETE" },
    );
  }

  detectAgents(): Promise<DetectedAgent[]> {
    return this.request("/internal/agents");
  }

  // Issue #432 — the client half of the skills-discovery triple; see
  // routes/internal.ts's /internal/skills for the agent-side resolveWithinRoots
  // containment this relies on, same as resolveAgentRules above.
  resolveSkills(cwd: string): Promise<SkillInfo[]> {
    return this.request(`/internal/skills?cwd=${encodeURIComponent(cwd)}`);
  }

  // Issue #463 — the client half of the skills enable/disable triple; see
  // routes/internal.ts's PUT /internal/skills. Same body-only
  // {agent, name, enabled} contract as writeAgentRule above.
  writeSkillEnabled(
    cwd: string,
    agent: SkillAgent,
    name: string,
    enabled: boolean,
  ): Promise<SkillInfo> {
    return this.request(`/internal/skills?cwd=${encodeURIComponent(cwd)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent, name, enabled }),
    });
  }

  resolveGitHubRepo(cwd: string): Promise<GitHubRepoRef | null> {
    return this.request(`/internal/github-repo?cwd=${encodeURIComponent(cwd)}`);
  }

  resolveGitBranch(cwd: string): Promise<string | null> {
    return this.request(`/internal/git-branch?cwd=${encodeURIComponent(cwd)}`);
  }

  /** Mirrors `/internal/git-status`'s `{ isRepo, status }` shape exactly (see
   * that route's own comment) — `isRepo: false` is durable "not a repo",
   * `isRepo: true, status: null` is a transient `git status` failure on the
   * agent side. Callers must not collapse these back into a single
   * `GitStatus | null` — that's the exact ambiguity this shape exists to
   * avoid. */
  resolveGitStatus(cwd: string): Promise<{ isRepo: boolean; status: GitStatus | null }> {
    return this.request(`/internal/git-status?cwd=${encodeURIComponent(cwd)}`);
  }

  /** Local branches + worktrees (issue #162), plus remote-tracking branches
   * (issue #271's base-ref picker) for a remote-hosted project's GitPanel —
   * same reasoning as resolveGitStatus above. `detail` (issue #442) mirrors
   * the public route's `?detail=1` — omitted (not `&detail=0`) when falsy,
   * matching every other optional query param in this file. */
  resolveGitBranches(
    cwd: string,
    detail?: boolean,
  ): Promise<{
    branches: GitBranchInfo[];
    worktrees: GitWorktreeInfo[];
    remoteBranches: string[];
  } | null> {
    return this.request(
      `/internal/git-branches?cwd=${encodeURIComponent(cwd)}${detail ? "&detail=1" : ""}`,
    );
  }

  /** Creates a worktree on this agent's own filesystem (issue #271's
   * launcher-toggle/promote flows) — mirrors /internal/git-worktree's
   * `{cwd, baseRef, seed, branchName?}` -> `{path, branch} | null` shape.
   * Unlike the read-only git methods above, a `null` result here isn't
   * folded into an empty/absent value by the caller — it means creation
   * genuinely failed and the caller (routes/sessions.ts) must not proceed
   * to spawn a session against a worktree that doesn't exist. */
  resolveCreateWorktree(
    cwd: string,
    baseRef: string,
    seed: string,
    branchName?: string,
  ): Promise<{ path: string; branch: string } | null> {
    return this.request("/internal/git-worktree", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, baseRef, seed, branchName }),
    });
  }

  /** Removes a task worktree on this agent's own filesystem — only when
   * clean (issue #283). Mirrors /internal/git-worktree/remove's
   * `{worktreePath, parentCwd?}` -> `RemoveIfCleanResult` shape. */
  resolveRemoveWorktreeIfClean(
    worktreePath: string,
    parentCwd?: string,
  ): Promise<RemoveIfCleanResult> {
    return this.request("/internal/git-worktree/remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worktreePath, parentCwd }),
    });
  }

  /** Removes the explicitly-named orphan task worktrees in `orphanPaths` on
   * this agent's own filesystem (issue #283) — mirrors
   * /internal/git-worktree/prune's `{cwd, orphanPaths}` ->
   * `PruneWorktreesResult` shape. See git-worktree.ts's pruneWorktrees doc
   * comment for why this takes an explicit delete list rather than
   * figuring out orphans on the agent side. */
  resolvePruneWorktrees(cwd: string, orphanPaths: string[]): Promise<PruneWorktreesResult> {
    return this.request("/internal/git-worktree/prune", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, orphanPaths }),
    });
  }

  /** task-claim.ts's pre-claim orphan clearing on this agent's own
   * filesystem (issue #283) — mirrors
   * /internal/git-worktree/clear-orphan's `{cwd, worktreePath, branchName}`
   * -> `ClearOrphanedTaskWorktreeResult` shape. */
  resolveClearOrphanedTaskWorktree(
    cwd: string,
    worktreePath: string,
    branchName: string,
  ): Promise<ClearOrphanedTaskWorktreeResult> {
    return this.request("/internal/git-worktree/clear-orphan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, worktreePath, branchName }),
    });
  }

  /** Deletes a local branch on this agent's own filesystem (issue #442) —
   * mirrors /internal/git-branch-delete's `{cwd, name, force?}` ->
   * `DeleteBranchResult` shape. Always 200 with a reason envelope, never a
   * 5xx for a git-level refusal (see that route's own comment). */
  resolveDeleteBranch(cwd: string, name: string, force?: boolean): Promise<DeleteBranchResult> {
    return this.request("/internal/git-branch-delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, name, force }),
    });
  }

  /** Removes any worktree `git worktree list` itself reports on this
   * agent's own filesystem (issue #442) — mirrors
   * /internal/git-worktree/remove-listed's `{cwd, worktreePath, force?}` ->
   * `RemoveListedWorktreeResult` shape. Unlike resolveRemoveWorktreeIfClean
   * above, not scoped to task worktrees — see git-worktree.ts's
   * removeListedWorktree doc comment. */
  resolveRemoveListedWorktree(
    cwd: string,
    worktreePath: string,
    force?: boolean,
  ): Promise<RemoveListedWorktreeResult> {
    return this.request("/internal/git-worktree/remove-listed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, worktreePath, force }),
    });
  }

  /** Clears stale worktree administrative metadata (`git worktree prune`)
   * on this agent's own filesystem (issue #442) — mirrors
   * /internal/git-worktree/prune-metadata's `{cwd}` -> `{pruned: boolean}`
   * shape. Never removes a worktree that still exists on disk. */
  resolvePruneWorktreeMetadata(cwd: string): Promise<{ pruned: boolean }> {
    return this.request("/internal/git-worktree/prune-metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
  }

  /** Diff stats (issue #202) for a session's effective cwd on a remote host
   * — mirrors resolveGitStatus's `{ isRepo, stats }` shape for the same
   * "durable not-a-repo vs. transient git failure" reason. Passes an
   * optional `baseRef` (e.g. `origin/main`) so the diff is computed against
   * the merge-base of that ref instead of just HEAD (issue #262 follow-up). */
  resolveGitDiffStats(
    cwd: string,
    baseRef?: string,
  ): Promise<{ isRepo: boolean; stats: GitDiffStats | null }> {
    let url = `/internal/git-diff?cwd=${encodeURIComponent(cwd)}`;
    if (baseRef) url += `&base=${encodeURIComponent(baseRef)}`;
    return this.request(url);
  }

  /** Per-file unified diff (issue #262) for a remote-hosted session's cwd —
   * runs `git diff [base]...HEAD -- <path>` on this agent's filesystem.
   * Returns `{ patch }` where `patch` is the raw unified diff text or null. */
  resolveGitFileDiff(
    cwd: string,
    filePath: string,
    baseRef?: string,
  ): Promise<{ patch: string | null }> {
    let url = `/internal/git-file-diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(filePath)}`;
    if (baseRef) url += `&base=${encodeURIComponent(baseRef)}`;
    return this.request(url);
  }

  /** Runs `git fetch origin` on this agent's filesystem (issue #369 —
   * background auto-fetch and manual fetch button). Returns
   * `{ success, error? }` so the caller can distinguish a git-level failure
   * from a host-reachability 5xx. */
  resolveGitFetch(cwd: string): Promise<{ success: boolean; error?: string }> {
    return this.request(`/internal/git-fetch?cwd=${encodeURIComponent(cwd)}`);
  }

  async spawn(opts: SpawnSessionOptions): Promise<void> {
    await this.request("/internal/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts),
    });
  }

  async bulkLiveStatus(
    ids: string[],
    idleThresholdMs: number,
    sessionProjectIds?: Record<string, number>,
  ): Promise<Record<string, SessionInfo | null>> {
    if (ids.length === 0) return Object.create(null);
    const key =
      [...ids].sort().join(",") + `|${idleThresholdMs}|${JSON.stringify(sessionProjectIds || {})}`;
    if (
      this.liveStatusCache &&
      this.liveStatusCache.key === key &&
      Date.now() - this.liveStatusCache.ts < LIVE_STATUS_CACHE_TTL_MS
    ) {
      return this.liveStatusCache.result;
    }
    const inFlight = this.liveStatusInFlight.get(key);
    if (inFlight) return inFlight;

    const promise = this.request<Record<string, SessionInfo | null>>("/internal/sessions/live", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids, idleThresholdMs, sessionProjectIds }),
    })
      .then((result) => {
        this.liveStatusCache = { key, ts: Date.now(), result };
        return result;
      })
      .finally(() => {
        this.liveStatusInFlight.delete(key);
      });
    this.liveStatusInFlight.set(key, promise);
    return promise;
  }

  bulkIsMasterAlive(ids: string[]): Promise<Record<string, boolean>> {
    if (ids.length === 0) return Promise.resolve(Object.create(null));
    return this.request("/internal/sessions/liveness", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
  }

  async terminate(id: string): Promise<void> {
    await this.request(`/internal/sessions/${encodeURIComponent(id)}/terminate`, {
      method: "POST",
    });
  }

  /**
   * Delivers a review-gate decision (issue #178) to whichever host actually
   * holds the pending hook connection — the agent's own
   * /internal/sessions/:id/review-gate, mirroring
   * /internal/sessions/:id/terminate's shape but with a real JSON response
   * body (`{ok}`) rather than a bare 204, since the caller needs to know
   * whether a gate was actually pending to resolve.
   */
  async resolveReviewGate(
    id: string,
    decision: "approved" | "denied",
    reason?: string,
  ): Promise<boolean> {
    const result = await this.request<{ ok: boolean }>(
      `/internal/sessions/${encodeURIComponent(id)}/review-gate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, reason }),
      },
    );
    return result.ok;
  }

  /**
   * Uploads a pasted/attached image (issue #68) to this agent's own
   * `/internal/uploads`, which writes it under the given session cwd — on
   * *this* host's filesystem, not the primary's, since that's where the
   * CLI reading it back by path actually runs. Reuses request()'s ordinary
   * JSON-response handling; only the request body here is raw bytes rather
   * than JSON, which request()'s header/body passthrough already supports
   * unchanged.
   */
  uploadImage(cwd: string, buffer: Buffer, mime: string): Promise<{ path: string }> {
    const query = new URLSearchParams({ cwd, mime });
    return this.request(
      `/internal/uploads?${query.toString()}`,
      {
        method: "POST",
        headers: { "content-type": mime },
        body: buffer,
      },
      UPLOAD_REQUEST_TIMEOUT_MS,
    );
  }

  /** Fetches the scrollback replay buffer (Phase 4, #187) from whichever
   * agent actually runs this session's PTY, base64-decoded back into a
   * Buffer here so callers (session-backend.ts's RemoteBackend) never see
   * the wire encoding. Mirrors resolveGitStatus/resolveGitBranch's plain-GET
   * shape — no request body, cwd-free (the agent resolves scrollback by
   * session id alone via its own app.pty). */
  async resolveScrollback(id: string): Promise<Buffer> {
    const result = await this.request<{ b64: string }>(
      `/internal/sessions/${encodeURIComponent(id)}/scrollback`,
    );
    return Buffer.from(result.b64, "base64");
  }

  /** Stashes a seed prompt (issue #271) on this agent's own PtyManager, for
   * a NEW session's SessionStart hook to pick up once it fires. */
  async resolveStashSeed(id: string, seed: string): Promise<void> {
    await this.request(`/internal/sessions/${encodeURIComponent(id)}/stash-seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seed }),
    });
  }

  /** Delivers a promote decision (issue #271) to whichever host actually
   * holds the pending promote_request connection — mirrors
   * resolveReviewGate's shape exactly. */
  async resolvePendingPromote(id: string, decision: PromoteDecision): Promise<boolean> {
    const result = await this.request<{ ok: boolean }>(
      `/internal/sessions/${encodeURIComponent(id)}/promote`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(decision),
      },
    );
    return result.ok;
  }

  /**
   * Opens (but does not wait for) a WS connection to this agent's
   * `/internal/ws/attach`, bearer-authed via a request header (the `ws`
   * package is required for this — the browser/global WebSocket API can't
   * set one). Callers (routes/terminal.ts) own the open/error/close
   * lifecycle and the actual byte piping; this just constructs the socket.
   */
  openAttach(opts: OpenAttachOptions): NodeWebSocket {
    const query = new URLSearchParams({
      id: opts.id,
      cwd: opts.cwd,
      command: opts.command,
      cols: String(opts.cols),
      rows: String(opts.rows),
    });
    if (opts.projectId !== undefined) {
      query.set("projectId", String(opts.projectId));
    }
    return new NodeWebSocket(`${this.wsBaseUrl}/internal/ws/attach?${query.toString()}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
  }

  browserAutomationAction(sessionId: number, projectId: number, body: unknown): Promise<unknown> {
    return this.request(`/internal/sessions/${sessionId}/browser?projectId=${projectId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  browserAutomationFind(sessionId: number, projectId: number, body: unknown): Promise<unknown> {
    return this.request(`/internal/sessions/${sessionId}/browser/find?projectId=${projectId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  openBrowserWs(sessionId: number, projectId: number): NodeWebSocket {
    return new NodeWebSocket(
      `${this.wsBaseUrl}/internal/ws/browser/${sessionId}?projectId=${projectId}`,
      {
        headers: { authorization: `Bearer ${this.token}` },
      },
    );
  }

  /**
   * Opens (but does not wait for) a WS connection to this agent's
   * `/internal/ws/events` (issue #166) — the events-channel counterpart to
   * openAttach() above, bearer-authed the same header-only way (the `ws`
   * package, not the browser/global WebSocket API, is what makes a custom
   * Authorization header possible on the upgrade request). Unlike
   * openAttach(), this takes no per-session target — it's one aggregated
   * stream covering every session this agent tracks, so there are no query
   * params to build. Callers (routes/events.ts) own the open/error/close
   * lifecycle and the actual frame relaying.
   */
  openEventsStream(): NodeWebSocket {
    return new NodeWebSocket(`${this.wsBaseUrl}/internal/ws/events`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
  }

  /**
   * Forwards an HTTP preview request to this agent's own
   * `/internal/preview/:port/*` (issue #28 phase 6) — the agent, not this
   * process, dials the actual dev server, always on its own loopback (see
   * internal.ts's own loopback assertion; `port` is never a caller-supplied
   * host, only a number this method interpolates into the path). Returns
   * the raw Response regardless of status (a 404/500 from the dev server is
   * not this method's failure to report — only a network-level failure to
   * reach the agent itself is, same distinction request()'s callers rely
   * on but this method can't reuse it for: unlike request(), a non-2xx
   * upstream status must pass through to the caller unchanged, not throw).
   *
   * `body`/`duplex`, when present, stream a non-GET/HEAD request body
   * through to the agent unbuffered — see http-proxy.ts's
   * buildUpstreamRequestBody. Note PREVIEW_REQUEST_TIMEOUT_MS now also
   * bounds upload time for those requests, not just the response: a large
   * POST to a remote-hosted preview can abort mid-upload once it elapses.
   */
  async openPreviewHttp(
    port: number,
    pathAndQuery: string,
    init: {
      method: string;
      headers: Headers;
      body?: ReadableStream<Uint8Array>;
      duplex?: "half";
    },
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    try {
      return await fetch(`${this.baseUrl}/internal/preview/${port}${pathAndQuery}`, {
        method: init.method,
        headers,
        ...(init.body !== undefined ? { body: init.body, duplex: init.duplex } : {}),
        // "manual" here for the same reason request()'s own comment gives:
        // a followed redirect would resend this bearer token whichever way
        // the redirect's target points, cross-origin-redirect stripping
        // rules notwithstanding — never rely on that instead of just not
        // following. The dev server's own 3xx (relayed by the agent's
        // /internal/preview handler as an ordinary response status, not an
        // HTTP-level redirect of *this* fetch) reaches this method as an
        // ordinary non-ok Response either way, which the caller forwards
        // to the browser unchanged.
        redirect: "manual",
        signal: AbortSignal.timeout(PREVIEW_REQUEST_TIMEOUT_MS),
      } as RequestInit & { duplex?: "half" });
    } catch (err) {
      throw new HostUnreachableError(this.hostId, err);
    }
  }

  /**
   * Opens (but does not wait for) a WS connection to this agent's
   * `/internal/ws/preview` (issue #28 phase 6) — the WS analog of
   * openPreviewHttp above, and constructed the same bearer-header way as
   * openAttach (the `ws` package is required for a request header the
   * browser/global WebSocket API can't set). Callers (preview-proxy.ts) own
   * the open/error/close lifecycle and the actual frame piping.
   *
   * No connect timeout, deliberately matching openAttach's own gap rather
   * than a bespoke one just for this method (Hermes review, PR #48): if the
   * agent accepts the TCP/WS handshake but its own loopback dev server
   * never answers, this connection can sit open with nothing flowing. A
   * hung *preview* pane is a lower-stakes failure mode than the equivalent
   * for a terminal attach — worth fixing for both together in a follow-up,
   * not diverging on here in isolation.
   */
  openPreviewWs(port: number, pathAndQuery: string): NodeWebSocket {
    const query = new URLSearchParams({ port: String(port), path: pathAndQuery });
    return new NodeWebSocket(`${this.wsBaseUrl}/internal/ws/preview?${query.toString()}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
  }

  /** Best-effort reachability probe for the Settings hosts panel's "test
   * connection" action — deliberately doesn't use `request()`'s bearer
   * header/timeout semantics that throw on any non-2xx, since a healthy
   * agent's /health is intentionally unauthenticated. */
  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        // Same redirect-bypass reasoning as request() above — no bearer
        // token to leak here, but a followed redirect would still report
        // "online" based on an unvalidated target's response instead of
        // the configured baseUrl's own.
        redirect: "manual",
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  listBrowserCookies(projectId: number): Promise<unknown> {
    return this.request(`/internal/projects/${projectId}/browser-cookies`, {
      method: "GET",
    });
  }

  importBrowserCookies(projectId: number, body: unknown): Promise<unknown> {
    return this.request(`/internal/projects/${projectId}/browser-cookies/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  uploadBrowserCookies(projectId: number, body: unknown): Promise<unknown> {
    return this.request(`/internal/projects/${projectId}/browser-cookies/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  deleteBrowserCookie(projectId: number, id: number): Promise<unknown> {
    return this.request(`/internal/projects/${projectId}/browser-cookies/${id}`, {
      method: "DELETE",
    });
  }

  getDevServerStatus(projectId: number): Promise<{ online: boolean }> {
    return this.request<{ online: boolean }>(`/internal/projects/${projectId}/dev-server-status`, {
      method: "GET",
    });
  }
}

// Cached per (app instance, hostId), self-invalidating on
// token/baseUrl/session change (compared against the current DB row on
// every lookup) rather than requiring host-registry.ts to explicitly
// notify this module — keeps the two services free of a circular import.
// sessionIdEnc is included (issue #245 / roadmap 7.1) so a rotated session
// rebuilds the cached client with the fresh credential, same as an edited
// baseUrl/authTokenEnc already does.
const clientCache = new WeakMap<
  FastifyInstance,
  Map<
    string,
    {
      client: RemoteHostClient;
      baseUrl: string | null;
      authTokenEnc: string | null;
      sessionIdEnc: string | null;
    }
  >
>();

// Issue #245 / roadmap 7.1 — a host that has successfully registered
// (claimed or enrolled) has BOTH a session and, possibly, a leftover
// manual authTokenEnc; the session is always preferred once it exists and
// hasn't expired; a null/expired session falls back to the manual token
// (empty string if there's none either — a still-pending enrolled row with
// no session yet, which correctly fails auth loudly rather than silently).
function resolveCurrentToken(
  app: FastifyInstance,
  row: NonNullable<ReturnType<typeof getHostRow>>,
): string {
  if (row.sessionIdEnc && row.sessionExpiresAt && row.sessionExpiresAt.getTime() > Date.now()) {
    return app.encryption.decryptString(row.sessionIdEnc);
  }
  return decryptToken(app, row);
}

export function getRemoteHostClient(app: FastifyInstance, hostId: string): RemoteHostClient {
  const row = getHostRow(app, hostId);
  if (!row || row.baseUrl === null) {
    throw new Error(`Host ${hostId} has no baseUrl — not a remote host`);
  }

  let hostMap = clientCache.get(app);
  if (!hostMap) {
    hostMap = new Map();
    clientCache.set(app, hostMap);
  }

  const cached = hostMap.get(hostId);
  if (
    cached &&
    cached.baseUrl === row.baseUrl &&
    cached.authTokenEnc === row.authTokenEnc &&
    cached.sessionIdEnc === row.sessionIdEnc
  ) {
    return cached.client;
  }

  const client = new RemoteHostClient({
    hostId,
    baseUrl: row.baseUrl,
    token: resolveCurrentToken(app, row),
    // Only a registered (has-or-had-a-session) host gets a refresh
    // callback — retrying a wrong static token on 401 would just fail
    // again identically, so there's nothing to gain and it'd mask the
    // real "check its agent token" error with an extra round trip.
    refreshToken: row.sessionIdEnc
      ? () => {
          const fresh = getHostRow(app, hostId);
          return fresh ? resolveCurrentToken(app, fresh) : null;
        }
      : undefined,
  });
  hostMap.set(hostId, {
    client,
    baseUrl: row.baseUrl,
    authTokenEnc: row.authTokenEnc,
    sessionIdEnc: row.sessionIdEnc,
  });
  return client;
}
