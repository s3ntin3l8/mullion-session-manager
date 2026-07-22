import type { FastifyInstance } from "fastify";
import { WebSocket as NodeWebSocket } from "ws";
import type { DiscoveredCandidate, Launcher, DockControl } from "./project-config.js";
import type { SessionInfo } from "./pty-manager.js";
import type { DetectedAgent } from "./agent-detect.js";
import type { GitHubRepoRef } from "./git-remote.js";
import type { GitStatus } from "./git-status.js";
import type {
  CreateWorktreeOptions,
  RemoveWorktreeOptions,
  WorktreeResult,
} from "./git-worktree.js";
import { getHostRow, decryptToken } from "./host-registry.js";

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
    body: string,
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
}

export type SpawnSessionOptions = SessionTarget;
export type OpenAttachOptions = SessionTarget;

export class RemoteHostClient {
  private readonly baseUrl: string;
  private readonly wsBaseUrl: string;
  private readonly token: string;
  private readonly hostId: string;

  private liveStatusCache: {
    key: string;
    ts: number;
    result: Record<string, SessionInfo | null>;
  } | null = null;
  // Concurrent misses on the same key (e.g. two browser tabs' list
  // requests landing in the same tick, before either has populated
  // liveStatusCache) share one HTTP call instead of each firing their own.
  private liveStatusInFlight = new Map<string, Promise<Record<string, SessionInfo | null>>>();

  constructor(opts: { hostId: string; baseUrl: string; token: string }) {
    this.hostId = opts.hostId;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.wsBaseUrl = this.baseUrl.replace(/^http/, "ws");
    this.token = opts.token;
  }

  private async request<T>(
    path: string,
    init?: RequestInit,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
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

  resolveActions(cwd: string): Promise<Launcher[]> {
    return this.request(`/internal/actions?cwd=${encodeURIComponent(cwd)}`);
  }

  resolveDock(cwd: string): Promise<DockControl[]> {
    return this.request(`/internal/dock?cwd=${encodeURIComponent(cwd)}`);
  }

  detectAgents(): Promise<DetectedAgent[]> {
    return this.request("/internal/agents");
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

  /** Worktree isolation (issue #100) — mirrors git-worktree.ts's own
   * createWorktree/removeWorktree signatures exactly (both run on THIS
   * agent's filesystem, same reasoning as resolveGitStatus above), so
   * routes/sessions.ts's local-vs-remote dispatch can call either side with
   * an identical options object. */
  createWorktree(opts: CreateWorktreeOptions): Promise<WorktreeResult | null> {
    return this.request("/internal/git-worktree", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts),
    });
  }

  async removeWorktree(opts: RemoveWorktreeOptions): Promise<void> {
    await this.request("/internal/git-worktree/remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts),
    });
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
  ): Promise<Record<string, SessionInfo | null>> {
    if (ids.length === 0) return Object.create(null);
    const key = [...ids].sort().join(",") + `|${idleThresholdMs}`;
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
      body: JSON.stringify({ ids, idleThresholdMs }),
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
    return new NodeWebSocket(`${this.wsBaseUrl}/internal/ws/attach?${query.toString()}`, {
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
   */
  async openPreviewHttp(
    port: number,
    pathAndQuery: string,
    init: { method: string; headers: Headers },
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    try {
      return await fetch(`${this.baseUrl}/internal/preview/${port}${pathAndQuery}`, {
        method: init.method,
        headers,
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
      });
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
}

// Cached per (app instance, hostId), self-invalidating on token/baseUrl
// change (compared against the current DB row on every lookup) rather than
// requiring host-registry.ts to explicitly notify this module — keeps the
// two services free of a circular import.
const clientCache = new WeakMap<
  FastifyInstance,
  Map<string, { client: RemoteHostClient; baseUrl: string | null; authTokenEnc: string | null }>
>();

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
  if (cached && cached.baseUrl === row.baseUrl && cached.authTokenEnc === row.authTokenEnc) {
    return cached.client;
  }

  const client = new RemoteHostClient({
    hostId,
    baseUrl: row.baseUrl,
    token: decryptToken(app, row),
  });
  hostMap.set(hostId, { client, baseUrl: row.baseUrl, authTokenEnc: row.authTokenEnc });
  return client;
}
