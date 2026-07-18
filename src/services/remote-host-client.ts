import type { FastifyInstance } from "fastify";
import { WebSocket as NodeWebSocket } from "ws";
import type { DiscoveredCandidate, Launcher, DockControl } from "./project-config.js";
import type { SessionInfo } from "./pty-manager.js";
import type { DetectedAgent } from "./agent-detect.js";
import type { GitHubRepoRef } from "./git-remote.js";
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

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...init?.headers, Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
