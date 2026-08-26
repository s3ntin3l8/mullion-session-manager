import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { WebSocket as NodeWebSocket } from "ws";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  NONCE_HEADER,
  buildCanonicalString,
  hashBody,
  isUnsignedBodyPath,
  sign,
} from "./request-signature.js";
import type { DiscoveredCandidate, Launcher, DockControl } from "./project-config.js";
import type { AgentRuleTarget } from "./agent-rules.js";
import type { DockConfigReadResult } from "./dock-config.js";
import type { SkillInfo, SkillAgent } from "./skills.js";
import type { SessionInfo } from "./pty-manager.js";
import type { DetectedAgent } from "./agent-detect.js";
import type { GitHubRepoRef } from "./git-remote.js";
import type { GitStatus } from "./git-status.js";
import type { GitBranchInfo, GitWorktreeInfo } from "./git-refs.js";
import type { GitDiffStats } from "./git-diff.js";
import type { UpdateStatus, ApplyUpdateBody } from "./update-apply.js";
import { getHostRow, decryptToken } from "./host-registry.js";
import {
  assertAllowedUrl,
  findSsrfBlock,
  getPinnedDispatcher,
  getPinnedWsAgent,
  type SsrfBlockedError,
} from "./pinned-connect.js";
import type { UrlGuardPolicy } from "./url-guard.js";
import type { PromoteDecision } from "../plugins/hooks.js";
import type {
  ClearOrphanedTaskWorktreeResult,
  CreateWorktreeResult,
  PruneWorktreesResult,
  RemoveIfCleanResult,
  RemoveListedWorktreeResult,
  WorktreeResult,
} from "./git-worktree.js";
import type { DeleteBranchResult } from "./git-branch-delete.js";
import type { GitPullResult } from "./git-pull.js";
import type { PushResult } from "./git-push.js";

// One HTTP+WS client per remote "agent" host (issue #26), talking to its
// token-gated /internal/* API (src/routes/internal.ts). Every request sets
// `Authorization: Bearer <token>`; a bearer WS header (not a query-string
// token) is only settable via the `ws` package's client, not the global
// WebSocket — see src/routes/internal.test.ts's identical reasoning.

export class HostUnreachableError extends Error {
  /** Set when this "unreachable" was actually the SSRF guard refusing to
   * connect (issue #250), not a network failure. Without it the two are
   * indistinguishable to every caller — a blocked host would just go red in
   * the hosts panel with nothing to explain why. */
  readonly ssrfBlocked: SsrfBlockedError | null;

  constructor(hostId: string, cause: unknown) {
    // fetch() reports a lookup failure as `TypeError: fetch failed` with the
    // real error on `.cause`, so the useful message is two levels down —
    // hoist it into this message rather than making every log site dig.
    const blocked = findSsrfBlock(cause);
    const detail = blocked
      ? blocked.message
      : cause instanceof Error
        ? cause.message
        : String(cause);
    super(`Host ${hostId} is unreachable: ${detail}`);
    this.name = "HostUnreachableError";
    this.cause = cause;
    this.ssrfBlocked = blocked;
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

// #484 — the four new task-git proxy calls each wrap an agent-side git
// shell-out with its own timeout (git-push.ts/git-refs.ts/git-status.ts/
// git-worktree.ts), every one of which is already well above
// REQUEST_TIMEOUT_MS's 5s. Without an override here, this client would
// raise HostUnreachableError while the agent's own git call is still
// running — e.g. reporting push-failed on a branch that actually landed.
// Each constant below is the agent-side budget plus headroom, following the
// same "real, non-error delay this proxy must not preempt" reasoning as
// PREVIEW_REQUEST_TIMEOUT_MS/UPLOAD_REQUEST_TIMEOUT_MS above.
/** git-push.ts's GIT_TIMEOUT_MS is 120s (one `git push`, raised from 30s so
 * `--no-verify` doesn't have to also budget for a target repo's own
 * pre-push hook — see that file's header comment). Kept in lockstep with
 * that constant on purpose: falling behind it here is exactly the failure
 * mode this whole block's own comment warns against — reporting
 * push-failed/host-unreachable on a remote push that's still legitimately
 * running. */
const GIT_PUSH_REQUEST_TIMEOUT_MS = 140_000;
/** git-refs.ts's GIT_TIMEOUT_MS is 10s, and resolveDefaultBaseRef can run up
 * to 4 sequential git calls (fetch, symbolic-ref, 2x rev-parse candidates)
 * before this route's own resolveCommitSha adds a 5th. */
const GIT_BASE_REF_REQUEST_TIMEOUT_MS = 60_000;
/** git-worktree.ts's GIT_TIMEOUT_MS is 15s (one `git worktree add`). */
const GIT_WORKTREE_RESUME_REQUEST_TIMEOUT_MS = 20_000;
/** git-status.ts's GIT_TIMEOUT_MS is 5s (one `git status`). */
const GIT_STATUS_FRESH_REQUEST_TIMEOUT_MS = 10_000;

// Issue #345 — a dock-preview worktree's checkout/force-remove/sync
// (`git worktree add`/`remove --force`/`reset --hard`) can take longer than
// REQUEST_TIMEOUT_MS's 5s on a large repo — the agent's own runGit already
// allows 15s (GIT_TIMEOUT_MS, git-worktree.ts) per invocation before it
// gives up. checkoutBranchWorktree (prune, then add) and removeWorktree
// (remove, then prune) each run TWO sequential runGit calls agent-side —
// worst case 2×15s = 30s BEFORE the agent even replies, so this timeout
// needs real headroom beyond that, not just beyond a single 15s call
// (Hermes review, this PR — the original 30s left zero headroom and could
// abort a request the instant before the agent's response arrived,
// orphaning a real worktree the primary never tracked: an unrecoverable
// leak, same class as the accepted restart-leak limitation). 45s gives 15s
// of margin for network RTT on top of the 30s agent-side worst case.
// Distinct from PREVIEW_REQUEST_TIMEOUT_MS (that one covers the browser
// dev-server proxy, an unrelated "preview" — dock-preview worktrees are a
// different feature despite the name collision).
const GIT_WORKTREE_REQUEST_TIMEOUT_MS = 45_000;

// Connection-time SSRF pinning policy for host connections (issue #250).
// Identical to what hosts.ts and enrollment.ts accepted when the baseUrl was
// registered — a host on loopback or a private LAN is the normal deployment
// shape, so pinning here only ever blocks link-local/cloud-IMDS/shared-NAT.
// That narrow case is exactly the one that matters: every request below
// attaches this host's bearer token and HMAC signature headers, so a baseUrl
// rebound to an IMDS endpoint would hand those credentials straight to it.
// Rebinding to 10.x/192.168.x remains permitted, by design.
const HOST_URL_POLICY: UrlGuardPolicy = { allowLoopback: true, allowPrivate: true };

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
  // Task Master's initial-turn prompt (see pty-manager.ts's
  // CreateSessionOptions.initialPrompt) — only meaningful for spawn(), not
  // openAttach() (attaching never re-spawns), but kept on the shared
  // SessionTarget shape rather than splitting it for one optional field.
  initialPrompt?: string;
  // Issue #678 — the promote flow's seed prompt, for spawn() only (same
  // "meaningless for openAttach" posture as initialPrompt above — attaching
  // never re-spawns, so there's nothing to inject context into here).
  seedPrompt?: string;
  projectId?: number;
  // Issue #822 — see CreateSessionBody.env's own doc comment
  // (session-lifecycle.ts). Unlike initialPrompt/seedPrompt, this DOES
  // matter for openAttach(): a re-bootstrap on the agent side (its own
  // attachSocketToSession -> getOrCreate, internal.ts's /internal/ws/attach)
  // must reproduce the same env the original spawn used, and the agent has
  // nowhere else to read it from — it's DB-less, so it never saw the
  // primary's sessions.env column.
  env?: Record<string, string>;
}

export type SpawnSessionOptions = SessionTarget;

// Hermes review, PR #538 — spawn()'s result reports whether an
// `initialPrompt` (if one was sent) was actually understood and applied,
// echoed back from the agent's own POST /internal/sessions response rather
// than assumed locally. An agent build too old to have this route's
// `initialPrompt`/`skipPermissions` schema properties silently strips them
// (Fastify's default `removeAdditional` behavior applies even though the
// schema declares `additionalProperties: false`, verified empirically) — so
// the field's mere ABSENCE from an old build's response (parsed here as
// `undefined`, same as a field the response never included), not a `false`
// value, is itself the version-skew signal task-claim.ts's callers key off
// of to avoid trusting a locally-computed `seedDelivered` that the remote
// host may have silently failed to honor.
export interface SpawnResult {
  initialPromptApplied?: boolean;
}
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
  // Issue #249 / roadmap 7.5 — non-null only for a session-credentialed
  // (registered, #245) host with a live session; null for a manually-
  // registered static-token host, which never signs a request at all. Kept
  // as a mutable field, not derived from `token` each call, because it
  // rotates together with `token` on refresh (see refreshCredentials
  // below) — both come from the same DB row's session fields, and neither
  // is meaningful without the other.
  private sessionSecret: string | null;
  private readonly hostId: string;
  // Issue #245 — set only for a session-credentialed (registered) host;
  // absent (undefined) for a manually-registered static-token one, which
  // never retries on 401 (a wrong static token isn't going to become right
  // by asking the DB again). Issue #249 — returns sessionSecret alongside
  // token because a rotated session changes both together; re-signing a
  // retried request with a stale secret would just fail identically.
  private readonly refreshCredentials?: () => {
    token: string;
    sessionSecret: string | null;
  } | null;

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
    sessionSecret?: string | null;
    refreshCredentials?: () => { token: string; sessionSecret: string | null } | null;
  }) {
    this.hostId = opts.hostId;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.wsBaseUrl = this.baseUrl.replace(/^http/, "ws");
    this.token = opts.token;
    this.sessionSecret = opts.sessionSecret ?? null;
    this.refreshCredentials = opts.refreshCredentials;
  }

  // Connection-time SSRF pinning (issue #250) — every outbound call in this
  // class, HTTP and WS alike, goes through one of these two. Both re-run the
  // literal check first: `lookup` is never consulted for an IP-literal host,
  // and baseUrl comes from a DB row that may have changed since registration
  // validated it.
  private pinnedDispatcher(): RequestInit["dispatcher"] {
    assertAllowedUrl(this.baseUrl, HOST_URL_POLICY);
    return getPinnedDispatcher(HOST_URL_POLICY);
  }

  private pinnedWsOptions() {
    assertAllowedUrl(this.baseUrl, HOST_URL_POLICY);
    return { agent: getPinnedWsAgent(HOST_URL_POLICY, this.wsBaseUrl) };
  }

  /**
   * Issue #249 / roadmap 7.5 — builds the three signature headers for a
   * session-credentialed host; returns `{}` for a manually-registered
   * static-Bearer one (sessionSecret null), so every call site can
   * unconditionally spread this into its own headers object with no
   * if/else of its own. `requestTarget` must be exactly what actually goes
   * out on the wire (path + query, verbatim) — the agent recomputes the
   * canonical string from its own view of the same request and any
   * mismatch simply fails verification, so this has to match precisely,
   * not just semantically.
   */
  private signatureHeaders(
    method: string,
    requestTarget: string,
    body: string | Buffer | undefined,
  ): Record<string, string> {
    if (!this.sessionSecret) return {};
    const bodyHashed = !isUnsignedBodyPath(requestTarget);
    const bodyHash = bodyHashed ? hashBody(body ?? "") : "";
    const timestamp = String(Date.now());
    const nonce = crypto.randomBytes(16).toString("hex");
    const canonicalString = buildCanonicalString({
      method,
      requestTarget,
      timestamp,
      nonce,
      bodyHashed,
      bodyHash,
    });
    return {
      [SIGNATURE_HEADER]: sign(this.sessionSecret, canonicalString),
      [TIMESTAMP_HEADER]: timestamp,
      [NONCE_HEADER]: nonce,
    };
  }

  private async rawFetch(
    path: string,
    init: RequestInit | undefined,
    timeoutMs: number,
  ): Promise<Response> {
    // Issue #249 / roadmap 7.5 — computed fresh on every call (a new
    // timestamp/nonce each time), never cached/reused across a retry: the
    // 401-retry below calls rawFetch() again from scratch specifically so
    // this recomputes under the refreshed token/secret, with its own fresh
    // nonce rather than replaying the first attempt's.
    const sigHeaders = this.signatureHeaders(
      init?.method ?? "GET",
      path,
      init?.body as string | Buffer | undefined,
    );
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...init?.headers, Authorization: `Bearer ${this.token}`, ...sigHeaders },
        signal: AbortSignal.timeout(timeoutMs),
        // hosts.ts's SSRF guard only validates the *configured* baseUrl —
        // fetch following a redirect by default would still send the
        // bearer token to wherever a 3xx response points, bypassing that
        // guard entirely (e.g. an agent, or a MITM between primary and
        // agent, redirecting to a cloud IMDS endpoint). "manual" surfaces
        // the 3xx as a non-ok response (handled as HostUnreachableError
        // below) instead of ever issuing the follow-up request.
        redirect: "manual",
        // ...and this closes the other half of the same guard: the redirect
        // above can't be followed, and the hostname can't rebind between
        // registration and connect (issue #250).
        dispatcher: this.pinnedDispatcher(),
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
    // DB row and now. refreshCredentials() re-reads the row live; if
    // either the token or the session secret genuinely changed, one retry
    // with both fresh — never more than one, and never for a manually-
    // registered host (no refreshCredentials at all, see the constructor).
    // The retry calls rawFetch() again rather than replaying the same
    // signed request (issue #249 / roadmap 7.5): re-sending the first
    // attempt's headers would carry a signature computed under the OLD
    // secret (guaranteed to 401 again) and, if that first attempt actually
    // reached the agent before being rejected, a nonce it already recorded
    // (guaranteed to be rejected as a replay).
    if (res.status === 401 && this.refreshCredentials) {
      const fresh = this.refreshCredentials();
      if (fresh && (fresh.token !== this.token || fresh.sessionSecret !== this.sessionSecret)) {
        this.token = fresh.token;
        this.sessionSecret = fresh.sessionSecret;
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

  // Issue #647 / roadmap 7.8 — mirrors GET /internal/updates/status; see
  // that route's own comment for why it lives under /internal/ rather than
  // the primary's /api/updates/* path.
  getUpdateStatus(): Promise<UpdateStatus> {
    return this.request("/internal/updates/status");
  }

  applyUpdate(body: ApplyUpdateBody): Promise<{ phase: string; version: string }> {
    return this.request("/internal/updates/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  resolveActions(cwd: string): Promise<Launcher[]> {
    return this.request(`/internal/actions?cwd=${encodeURIComponent(cwd)}`);
  }

  resolveDock(cwd: string): Promise<DockControl[]> {
    return this.request(`/internal/dock?cwd=${encodeURIComponent(cwd)}`);
  }

  // U4 — the client half of the dock-config write triple; see
  // routes/internal.ts's /internal/dock-config for the agent-side
  // resolveWithinRoots containment these two rely on. Deliberately a
  // separate pair from resolveDock above, not a rename/reuse of it: that
  // route returns the MERGED view (global default + Docker-discovered
  // controls), the wrong shape for an editor to read back or write through
  // (see dock-config.ts's readDockConfig doc comment).
  resolveDockConfig(cwd: string): Promise<DockConfigReadResult> {
    return this.request(`/internal/dock-config?cwd=${encodeURIComponent(cwd)}`);
  }

  writeDockConfig(cwd: string, controls: DockControl[]): Promise<DockConfigReadResult> {
    return this.request(`/internal/dock-config?cwd=${encodeURIComponent(cwd)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ controls }),
    });
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
   * avoid. `opts.fresh` (#484) requests the same cache-bypassing read
   * task-promote.ts's local dirty-tree gate already uses — a stale "clean"
   * result could let a push silently exclude work committed moments ago
   * (see the route's own comment). Every existing caller (sidebar/GitPanel
   * polls) omits it and keeps the cached read, at the default timeout. */
  resolveGitStatus(
    cwd: string,
    opts?: { fresh?: boolean },
  ): Promise<{ isRepo: boolean; status: GitStatus | null }> {
    const url = `/internal/git-status?cwd=${encodeURIComponent(cwd)}${opts?.fresh ? "&fresh=1" : ""}`;
    return opts?.fresh
      ? this.request(url, undefined, GIT_STATUS_FRESH_REQUEST_TIMEOUT_MS)
      : this.request(url);
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
    // Issue #271 follow-up — absent on an older agent build that predates
    // this field (same degradation convention as the rest of this file's
    // optional response fields); `null` when the agent resolved it and
    // found no usable default. Both cases mean "the caller should fall
    // back to the current branch."
    defaultBranch?: string | null;
  } | null> {
    return this.request(
      `/internal/git-branches?cwd=${encodeURIComponent(cwd)}${detail ? "&detail=1" : ""}`,
    );
  }

  /** Creates a worktree on this agent's own filesystem (issue #271's
   * launcher-toggle/promote flows) — mirrors /internal/git-worktree's
   * `{cwd, baseRef, seed, branchName?}` -> `CreateWorktreeResult` shape
   * (issue #677: `{created, path?, branch?, reason?, detail?}`, not a bare
   * `{path, branch} | null`). Unlike the read-only git methods above, a
   * `created: false` result here isn't folded into an empty/absent value by
   * the caller — it means creation genuinely failed and the caller
   * (session-lifecycle.ts) must not proceed to spawn a session against a
   * worktree that doesn't exist. Passes GIT_WORKTREE_REQUEST_TIMEOUT_MS
   * explicitly (Hermes-style fix found during #677's research) — this was
   * previously the only worktree-creating RPC on this client left at the
   * 5s REQUEST_TIMEOUT_MS default, unlike its local-host counterpart
   * (createWorktree's own GIT_TIMEOUT_MS = 15s) and its sibling
   * resolveCheckoutBranchWorktree below (already on this same 45s budget),
   * so a slow-but-legitimate remote `git worktree add` could time out here
   * well before the git call itself would have. */
  resolveCreateWorktree(
    cwd: string,
    baseRef: string,
    seed: string,
    branchName?: string,
  ): Promise<CreateWorktreeResult> {
    return this.request(
      "/internal/git-worktree",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, baseRef, seed, branchName }),
      },
      GIT_WORKTREE_REQUEST_TIMEOUT_MS,
    );
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

  /** Checks out an EXISTING branch into a fresh detached-HEAD worktree on
   * this agent's own filesystem — the dock-preview flow (issue #345).
   * Mirrors /internal/git-worktree/checkout's `{cwd, branch}` ->
   * `{path, branch} | null` shape. Distinct from resolveCreateWorktree
   * above (a NEW branch from a baseRef). */
  resolveCheckoutBranchWorktree(
    cwd: string,
    branch: string,
  ): Promise<{ path: string; branch: string } | null> {
    return this.request(
      "/internal/git-worktree/checkout",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, branch }),
      },
      GIT_WORKTREE_REQUEST_TIMEOUT_MS,
    );
  }

  /** Force-removes a dock-preview worktree on this agent's own filesystem
   * (issue #345) — mirrors /internal/git-worktree/force-remove's
   * `{worktreePath, parentCwd?}` -> `{removed: boolean}` shape. Distinct
   * from resolveRemoveWorktreeIfClean above (never `--force`). */
  async resolveRemoveWorktree(worktreePath: string, parentCwd?: string): Promise<boolean> {
    const result = await this.request<{ removed: boolean }>(
      "/internal/git-worktree/force-remove",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ worktreePath, parentCwd }),
      },
      GIT_WORKTREE_REQUEST_TIMEOUT_MS,
    );
    return result.removed;
  }

  /** Resets a dock-preview worktree on this agent's own filesystem to the
   * current tip of a LOCAL branch ref (issue #345's worktreeRefresh
   * live-sync tick) — mirrors /internal/git-worktree/sync's
   * `{worktreePath, branch}` -> `{synced: boolean}` shape. */
  async resolveSyncWorktree(worktreePath: string, branch: string): Promise<boolean> {
    const result = await this.request<{ synced: boolean }>(
      "/internal/git-worktree/sync",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ worktreePath, branch }),
      },
      GIT_WORKTREE_REQUEST_TIMEOUT_MS,
    );
    return result.synced;
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

  /** Runs a fast-forward `git pull` on this agent's filesystem (issue #745).
   * Returns `{ pulled: boolean, reason?, detail? }` matching runGitPull's
   * GitPullResult shape. */
  resolveGitPull(cwd: string): Promise<GitPullResult> {
    return this.request("/internal/git-pull", {
      method: "POST",
      body: JSON.stringify({ cwd }),
    });
  }

  /** Resolves this agent's default base ref (and its pinned commit SHA) on
   * its own filesystem (#484) — mirrors /internal/git-base-ref's
   * `{ baseRef, sha }` shape. `resolveDefaultBaseRef` runs `git fetch
   * origin` first, hence the raised timeout — see the constant's own
   * comment. Never throws for a git-level failure: a non-repo cwd resolves
   * `{ baseRef: "HEAD", sha: null }`, the same last-resort fallback the
   * local path produces. */
  resolveHostBaseRef(cwd: string): Promise<{ baseRef: string; sha: string | null }> {
    return this.request(
      `/internal/git-base-ref?cwd=${encodeURIComponent(cwd)}`,
      undefined,
      GIT_BASE_REF_REQUEST_TIMEOUT_MS,
    );
  }

  /** Pushes a task's branch to `origin` on this agent's own filesystem
   * (#484) — mirrors /internal/git-push's `PushResult` shape. `cwd` must be
   * the task's worktree path, not the bare project root — see that route's
   * own comment. The token crosses once, over this already-signed,
   * IP-pinned channel; never logged by this method or the route it calls. */
  resolvePushBranch(cwd: string, branch: string, token: string): Promise<PushResult> {
    return this.request(
      "/internal/git-push",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, branch, token }),
      },
      GIT_PUSH_REQUEST_TIMEOUT_MS,
    );
  }

  /** Lists this agent's own on-disk task-worktree directories (#484) — for
   * the primary's boot-time orphan sweep (plugins/task-watcher.ts). Mirrors
   * /internal/git-worktree/task-dirs's `{ dirs }` shape; a pure filesystem
   * read, so the default timeout is fine. */
  async resolveTaskWorktreeDirs(cwd: string): Promise<string[]> {
    const result = await this.request<{ dirs: string[] }>(
      `/internal/git-worktree/task-dirs?cwd=${encodeURIComponent(cwd)}`,
    );
    return result.dirs;
  }

  /** Checks out an existing `mullion/task-<id>` branch into a fresh
   * worktree on this agent's own filesystem (#484) — for Retry (#483) on a
   * remote-hosted task. Mirrors /internal/git-worktree/resume's
   * `WorktreeResult | null` shape; `null` (not thrown) means the resume
   * failed for a git-level reason, same "not applicable, not unreachable"
   * posture as resolveCreateWorktree above. */
  resolveResumeTaskWorktree(cwd: string, branchName: string): Promise<WorktreeResult | null> {
    return this.request(
      "/internal/git-worktree/resume",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, branchName }),
      },
      GIT_WORKTREE_RESUME_REQUEST_TIMEOUT_MS,
    );
  }

  async spawn(opts: SpawnSessionOptions): Promise<SpawnResult> {
    return this.request("/internal/sessions", {
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
   * Reads a task's round-suffixed review-findings file (#760) off this
   * agent's own filesystem — mirrors /internal/task-review-findings's
   * `{ content: string | null }` shape exactly. `content: null` is a real
   * 200 response meaning "genuinely absent/empty", not a connectivity or
   * scope failure — those still surface as thrown HostUnreachableError/
   * HostRequestError from `request()` below, unchanged. A 404
   * specifically (an old peer build with no such route — version skew)
   * throws HostRequestError like any other 4xx (see that class's own doc
   * comment) rather than being swallowed here into a `null`, which is
   * exactly what would misread "the route doesn't exist" as "the file
   * doesn't exist" — session-backend.ts's RemoteBackend passes this
   * straight through so its own caller (task-reconciler.ts) sees the
   * distinction too.
   */
  async resolveReadTaskReviewFindings(taskId: number, round: number): Promise<string | null> {
    const result = await this.request<{ content: string | null }>(
      `/internal/task-review-findings?taskId=${taskId}&round=${round}`,
    );
    return result.content;
  }

  /**
   * Deletes a task's round-suffixed review-findings file (#760) off this
   * agent's own filesystem, once its content has been durably ingested.
   * Mirrors resolveReadTaskReviewFindings's own route.
   */
  async resolveDeleteTaskReviewFindings(taskId: number, round: number): Promise<void> {
    await this.request(`/internal/task-review-findings?taskId=${taskId}&round=${round}`, {
      method: "DELETE",
    });
  }

  /**
   * #778 — reads a task's Conventional Commits title file off this agent's
   * own filesystem, mirrors resolveReadTaskReviewFindings's own shape and
   * version-skew posture exactly (a 404 — the route doesn't exist on an old
   * peer build — throws HostRequestError, never collapses into `null`).
   */
  async resolveReadTaskCommitTitle(taskId: number): Promise<string | null> {
    const result = await this.request<{ content: string | null }>(
      `/internal/task-commit-title?taskId=${taskId}`,
    );
    return result.content;
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
    if (opts.env !== undefined) {
      query.set("env", JSON.stringify(opts.env));
    }
    const requestTarget = `/internal/ws/attach?${query.toString()}`;
    return new NodeWebSocket(`${this.wsBaseUrl}${requestTarget}`, {
      headers: {
        authorization: `Bearer ${this.token}`,
        ...this.signatureHeaders("GET", requestTarget, undefined),
      },
      ...this.pinnedWsOptions(),
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
    const requestTarget = `/internal/ws/browser/${sessionId}?projectId=${projectId}`;
    return new NodeWebSocket(`${this.wsBaseUrl}${requestTarget}`, {
      headers: {
        authorization: `Bearer ${this.token}`,
        ...this.signatureHeaders("GET", requestTarget, undefined),
      },
      ...this.pinnedWsOptions(),
    });
  }

  /**
   * Opens (but does not wait for) a WS connection to this agent's
   * `/internal/ws/events` (issue #166) — the events-channel counterpart to
   * openAttach() above, bearer-authed the same header-only way (the `ws`
   * package, not the browser/global WebSocket API, is what makes a custom
   * Authorization header possible on the upgrade request). Unlike
   * openAttach(), this takes no per-session target — it's one aggregated
   * stream covering every session this agent tracks, so there are no query
   * params to build. Callers (routes/events.ts's relayRemoteEventsHost,
   * services/remote-event-subscriber.ts) own the open/error/close lifecycle
   * and the actual frame relaying/handling.
   *
   * `maxPayload` bounds inbound frames on this (client) socket, matching
   * plugins/websocket.ts's own 1 MiB server-side cap (Hermes review, PR
   * #564 round 4) — without it, `ws`'s 100 MiB default leaves both callers
   * exposed to an oversized frame from a buggy or compromised agent: an
   * unbounded `JSON.parse` and, for remote-event-subscriber.ts, an
   * unbounded flush-buffer entry. A frame over the cap makes `ws` close the
   * connection (RFC 6455 1009) rather than deliver it — both callers
   * already handle an unexpected close via their normal reconnect/relay
   * teardown paths, so this doesn't need its own error handling.
   */
  openEventsStream(): NodeWebSocket {
    const requestTarget = "/internal/ws/events";
    return new NodeWebSocket(`${this.wsBaseUrl}${requestTarget}`, {
      headers: {
        authorization: `Bearer ${this.token}`,
        ...this.signatureHeaders("GET", requestTarget, undefined),
      },
      maxPayload: 1024 * 1024,
      ...this.pinnedWsOptions(),
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
    const requestTarget = `/internal/preview/${port}${pathAndQuery}`;
    const headers = new Headers(init.headers);
    // Issue #249 / roadmap 7.5 — `init.headers` here is seeded from a
    // BROWSER-controlled request forwarded through the preview proxy
    // (preview-proxy.ts), unlike every other call site in this file, which
    // only ever builds its own headers from scratch. Delete-then-set, never
    // just set-without-delete: this route's own request body is exempt from
    // hashing (isUnsignedBodyPath), so if the auth/signature headers below
    // were only conditionally set (empty for a static-Bearer host) a
    // browser could otherwise inject its own x-request-signature/
    // -timestamp/-nonce and have them pass straight through unexamined.
    headers.delete("authorization");
    headers.delete(SIGNATURE_HEADER);
    headers.delete(TIMESTAMP_HEADER);
    headers.delete(NONCE_HEADER);
    headers.set("authorization", `Bearer ${this.token}`);
    for (const [key, value] of Object.entries(
      this.signatureHeaders(init.method, requestTarget, undefined),
    )) {
      headers.set(key, value);
    }
    try {
      return await fetch(`${this.baseUrl}${requestTarget}`, {
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
        dispatcher: this.pinnedDispatcher(),
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
    const requestTarget = `/internal/ws/preview?${query.toString()}`;
    return new NodeWebSocket(`${this.wsBaseUrl}${requestTarget}`, {
      headers: {
        authorization: `Bearer ${this.token}`,
        ...this.signatureHeaders("GET", requestTarget, undefined),
      },
      ...this.pinnedWsOptions(),
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
        dispatcher: this.pinnedDispatcher(),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // Cookie profiles are primary-only state (see routes/browser-cookies.ts's
  // own comment) — there is no list/import/upload/delete dispatch to an
  // agent at all, so this class carries no methods for them (issue #522;
  // the agent-side routes these used to call always 500'd, since an agent
  // has no app.db to satisfy them).

  getDevServerStatus(port: number, scheme: "http" | "https"): Promise<{ online: boolean }> {
    return this.request<{ online: boolean }>(
      `/internal/dev-server-status?port=${port}&scheme=${scheme}`,
      { method: "GET" },
    );
  }
}

// Cached per (app instance, hostId), self-invalidating on
// token/baseUrl/session change (compared against the current DB row on
// every lookup) rather than requiring host-registry.ts to explicitly
// notify this module — keeps the two services free of a circular import.
// sessionIdEnc is included (issue #245 / roadmap 7.1) so a rotated session
// rebuilds the cached client with the fresh credential, same as an edited
// baseUrl/authTokenEnc already does. sessionSecretEnc is included too
// (Hermes review, PR #531): host-registry.ts's issueSession/clearHostSession
// always write/clear sessionIdEnc and sessionSecretEnc together today, so
// this is currently redundant with the sessionIdEnc check — but comparing
// only one of two fields that are SUPPOSED to always change together is
// exactly the kind of place a future partial-update bug would silently
// land, undetected, since nothing here would notice the secret went stale
// while the id didn't.
const clientCache = new WeakMap<
  FastifyInstance,
  Map<
    string,
    {
      client: RemoteHostClient;
      baseUrl: string | null;
      authTokenEnc: string | null;
      sessionIdEnc: string | null;
      sessionSecretEnc: string | null;
    }
  >
>();

// Issue #245 / roadmap 7.1 — a host that has successfully registered
// (claimed or enrolled) has BOTH a session and, possibly, a leftover
// manual authTokenEnc; the session is always preferred once it exists and
// hasn't expired; a null/expired session falls back to the manual token
// (empty string if there's none either — a still-pending enrolled row with
// no session yet, which correctly fails auth loudly rather than silently).
//
// Issue #249 / roadmap 7.5 — sessionSecret rides alongside token, from the
// SAME live-session check, rather than being derived from `token` itself:
// signing must only ever happen for an actual live session, never for the
// static-token fallback branch, and gating both fields on one shared
// condition is what keeps that invariant impossible to accidentally
// desync. sessionSecret is deliberately still null if `sessionSecretEnc`
// is somehow missing despite a live, unexpired sessionIdEnc — a state
// issueSession()/clearHostSession() (host-registry.ts) never actually
// produce, since they always write/clear all three session fields
// together, but if it ever did happen this fails closed (the client signs
// nothing, so the agent's onRequest gate — which requires a signature for
// ANY session-matched request — rejects every request from it) rather than
// silently treating a token-bearing client as a legitimate static one.
function resolveCurrentCredentials(
  app: FastifyInstance,
  row: NonNullable<ReturnType<typeof getHostRow>>,
): { token: string; sessionSecret: string | null } {
  const hasLiveSession =
    row.sessionIdEnc !== null &&
    row.sessionExpiresAt !== null &&
    row.sessionExpiresAt.getTime() > Date.now();
  if (hasLiveSession) {
    return {
      token: app.encryption.decryptString(row.sessionIdEnc!),
      sessionSecret: row.sessionSecretEnc
        ? app.encryption.decryptString(row.sessionSecretEnc)
        : null,
    };
  }
  return { token: decryptToken(app, row), sessionSecret: null };
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
    cached.sessionIdEnc === row.sessionIdEnc &&
    cached.sessionSecretEnc === row.sessionSecretEnc
  ) {
    return cached.client;
  }

  const credentials = resolveCurrentCredentials(app, row);
  const client = new RemoteHostClient({
    hostId,
    baseUrl: row.baseUrl,
    token: credentials.token,
    sessionSecret: credentials.sessionSecret,
    // Only a registered (has-or-had-a-session) host gets a refresh
    // callback — retrying a wrong static token on 401 would just fail
    // again identically, so there's nothing to gain and it'd mask the
    // real "check its agent token" error with an extra round trip.
    refreshCredentials: row.sessionIdEnc
      ? () => {
          const fresh = getHostRow(app, hostId);
          return fresh ? resolveCurrentCredentials(app, fresh) : null;
        }
      : undefined,
  });
  hostMap.set(hostId, {
    client,
    baseUrl: row.baseUrl,
    authTokenEnc: row.authTokenEnc,
    sessionIdEnc: row.sessionIdEnc,
    sessionSecretEnc: row.sessionSecretEnc,
  });
  return client;
}
