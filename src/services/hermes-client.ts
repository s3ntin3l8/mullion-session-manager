import type { FastifyInstance } from "fastify";
import { getHermesKey } from "./hermes-integration.js";
import { assertAllowedUrl, getPinnedDispatcher } from "./pinned-connect.js";
import { getStoredSettings } from "./settings.js";
import type { UrlGuardPolicy } from "./url-guard.js";

/**
 * The Hermes HTTP client: configuration, the authenticated fetch, and the
 * three run calls (start, read, stop). It keeps no state, so every call
 * works the same after a Mullion restart. The GitHub review relay
 * (`hermes-review.ts`) and the Task Master reviewer (`hermes-task-review.ts`)
 * are both built on it.
 */

// Hermes sits on the operator's LAN, so private and loopback targets are
// legitimate here (same policy as a registered agent host). Link-local /
// cloud-metadata ranges stay blocked by url-guard regardless.
export const HERMES_URL_POLICY: UrlGuardPolicy = { allowLoopback: true, allowPrivate: true };

const HEALTH_TIMEOUT_MS = 5_000;
// POST /v1/runs answers 202 with a run id as soon as the run is admitted, so
// (unlike the old chat/completions call, which was held open until the agent
// finished) a timeout here is a real failure, not "accepted and running".
export const DISPATCH_TIMEOUT_MS = 15_000;
export const STATUS_TIMEOUT_MS = 10_000;
/** The most of any Hermes JSON response body that is read. */
export const MAX_JSON_BYTES = 256_000;

export class HermesNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HermesNotConfiguredError";
  }
}

export class HermesUnavailableError extends Error {
  // `message` is safe to return to a session (it travels back through the
  // control socket); `detail` may carry the configured URL / resolved
  // addresses / raw network errors, so it is only ever logged server-side —
  // except for the operator-only "Test connection" route.
  constructor(
    message: string,
    readonly detail?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "HermesUnavailableError";
  }
}

export class HermesAuthError extends Error {
  constructor(status: number) {
    super(
      `Hermes API rejected the key (HTTP ${status}) — check the key in Settings → Integrations`,
    );
    this.name = "HermesAuthError";
  }
}

/** Hermes already holds a run for this commit's idempotency key (409). */
export class ReviewConflictError extends Error {
  constructor() {
    super(
      "A review of this commit was already requested (possibly by the repository's own workflow) — wait for it instead of requesting again",
    );
    this.name = "ReviewConflictError";
  }
}

/**
 * Hermes' session authority refused the turn (409 `admission_conflict`).
 *
 * The session is stuck — the gateway paused it on an earlier conflict and
 * never recovers (NousResearch/hermes-agent#142731) — so every later round
 * for that pull request is refused at the door. The way out is a fresh
 * session — the caller retries the attempt there.
 */
export class ReviewSessionRefusedError extends Error {
  constructor(
    /** The session that refused the turn. */
    readonly sessionId: string,
  ) {
    super(
      `Hermes refused the turn for the review session of this pull request (${sessionId}) — that session is stuck and refuses every later round. The relay retries in a fresh session; asking again is not the way out of it.`,
    );
    this.name = "ReviewSessionRefusedError";
  }
}

/**
 * The statuses that mean the run is FINISHED. Everything else is treated as
 * live — the list is inverted on purpose: Hermes parks a run in statuses this
 * code has never heard of (`waiting_for_approval` while the agent waits for
 * a tool approval, for one), and a status missing from a "live" list reads as
 * finished, which dispatches a second review of a pull request that is still
 * being reviewed.
 *
 * "completed" is finished, but it is NOT evidence that a review landed
 * (Hermes reports "completed" for a run that posted nothing), so a completed
 * run is retried under a deeper key rather than treated as "already
 * reviewed".
 */
export const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

/**
 * The statuses that mean the run is GONE — Hermes does not know it any more
 * (its window elapsed, or the gateway lost it). Not live: there is nothing
 * running to wait for. "unknown" is here for the same reason: it is what the
 * API answers when the run's body was unreadable.
 */
export const GONE_RUN_STATUSES = new Set(["not_found", "expired", "unknown"]);

export function isTerminal(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

export function isGone(status: string): boolean {
  return GONE_RUN_STATUSES.has(status);
}

export interface HermesConfig {
  /** The API root, validated and without a trailing slash. */
  root: string;
  key: string;
}

export function baseUrl(apiUrl: string): string {
  try {
    assertAllowedUrl(apiUrl, HERMES_URL_POLICY);
  } catch {
    throw new HermesNotConfiguredError("The Hermes API URL in Settings is not a valid http(s) URL");
  }
  return apiUrl.replace(/\/+$/, "");
}

/**
 * The URL and key Hermes calls need, or a `HermesNotConfiguredError`.
 *
 * `requireProvider` (default true) also demands `reviewRelay.provider ===
 * "hermes"`. That setting only controls the GitHub-side relay, so the Task
 * Master reviewer passes `false`; the relay keeps the default.
 */
export function resolveHermesConfig(
  app: FastifyInstance,
  { requireProvider = true }: { requireProvider?: boolean } = {},
): HermesConfig {
  const { provider, apiUrl } = getStoredSettings(app.db).reviewRelay;
  if (requireProvider && provider !== "hermes") {
    throw new HermesNotConfiguredError(
      "No reviewer is configured for this Mullion — use the repository's own review process",
    );
  }
  const key = getHermesKey(app);
  if (!apiUrl || !key) {
    throw new HermesNotConfiguredError(
      "The Hermes review relay is not configured — choose Hermes and set the API URL and key in Settings → Integrations",
    );
  }
  return { root: baseUrl(apiUrl), key };
}

// Reads at most `maxBytes` of a response body, so the cap bounds the memory
// spent reading it (not just what's forwarded). Returns null when exceeded.
export async function readBounded(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readJson<T>(res: Response): Promise<T | null> {
  const text = await readBounded(res, MAX_JSON_BYTES).catch(() => null);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// `verbose` is for the operator-only Test connection route; everything a
// session can see gets the generic message, with the detail logged instead.
export async function checkHealth(root: string, verbose = false): Promise<void> {
  try {
    const res = await fetch(`${root}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      redirect: "manual",
      dispatcher: getPinnedDispatcher(HERMES_URL_POLICY),
    } as RequestInit);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    const detail = `Hermes API unreachable at ${root}/health (${(err as Error).message})`;
    throw new HermesUnavailableError(
      verbose ? detail : "The Hermes API is unreachable — review not dispatched",
      detail,
    );
  }
}

// One authenticated call against the Hermes API. Never follows a redirect with
// the bearer attached (see remote-host-client.ts's rawFetch for the same
// reasoning); a 401/403 is always HermesAuthError.
export async function hermesFetch(
  root: string,
  key: string,
  path: string,
  init: { method: string; body?: string; headers?: Record<string, string>; timeoutMs: number },
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${root}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      body: init.body,
      signal: AbortSignal.timeout(init.timeoutMs),
      redirect: "manual",
      dispatcher: getPinnedDispatcher(HERMES_URL_POLICY),
    } as RequestInit);
  } catch (err) {
    throw new HermesUnavailableError(
      "Could not reach the Hermes API",
      `${init.method} ${path}: ${(err as Error).message}`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    void res.body?.cancel().catch(() => undefined);
    throw new HermesAuthError(res.status);
  }
  return res;
}

// The API's own error text usually names the problem (e.g. a wrong `model`);
// keep a bounded snippet as server-side detail only.
export async function unavailableFromResponse(
  res: Response,
  what: string,
): Promise<HermesUnavailableError> {
  const snippet = (await readBounded(res, 2_000).catch(() => null)) ?? "(body too large)";
  const retryAfter = Number(res.headers.get("retry-after"));
  return new HermesUnavailableError(
    `Hermes API returned HTTP ${res.status} — ${what}`,
    `HTTP ${res.status}: ${snippet.slice(0, 500)}`,
    Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : undefined,
  );
}

export interface PostRunResult {
  runId: string;
  status: string;
  replayed: boolean;
}

/**
 * Starts a run (`POST /v1/runs`). Hermes reserves the idempotency key durably
 * for 24h: a retry of the same request replays the original run.
 */
export async function postRun(
  { root, key }: HermesConfig,
  r: {
    input: string;
    /** The Hermes session to run in. Without one Hermes derives it from the request text. */
    sessionId?: string;
    idempotencyKey: string;
    model?: string;
    /** Provider slug qualifying `model`; only sent together with one. */
    provider?: string;
  },
): Promise<PostRunResult> {
  const body = JSON.stringify({
    ...(r.model ? { model: r.model } : {}),
    ...(r.model && r.provider ? { provider: r.provider } : {}),
    input: r.input,
    // The session id is what makes the rounds of one pull request continue
    // the same conversation. Without it Hermes derives the session from the
    // request text, which made every request for a PR land in the same
    // session — and queue behind each other.
    ...(r.sessionId ? { session_id: r.sessionId } : {}),
  });
  const res = await hermesFetch(root, key, "/v1/runs", {
    method: "POST",
    body,
    headers: { "Idempotency-Key": r.idempotencyKey },
    timeoutMs: DISPATCH_TIMEOUT_MS,
  });
  if (res.status === 409) {
    // 409 also covers ownership / generation / identity refusals, which are not
    // "a review is already coming": only the idempotency conflict means that.
    const refusal = await readJson<{ error?: { code?: unknown }; code?: unknown }>(res);
    const code = refusal?.error?.code ?? refusal?.code;
    if (code === "idempotency_key_conflict") throw new ReviewConflictError();
    if (code === "admission_conflict" && r.sessionId) {
      throw new ReviewSessionRefusedError(r.sessionId);
    }
    throw new HermesUnavailableError(
      "Hermes refused the review request (HTTP 409) — review not dispatched",
      `HTTP 409: ${JSON.stringify(refusal)?.slice(0, 300)}`,
    );
  }
  if (!res.ok) throw await unavailableFromResponse(res, "review not dispatched");
  const parsed = await readJson<{ run_id?: unknown; status?: unknown; replayed?: unknown }>(res);
  if (typeof parsed?.run_id !== "string" || parsed.run_id === "") {
    throw new HermesUnavailableError(
      "Hermes accepted the request but returned no run id",
      `unexpected /v1/runs body: ${JSON.stringify(parsed)?.slice(0, 200)}`,
    );
  }
  return {
    runId: parsed.run_id,
    status: typeof parsed.status === "string" ? parsed.status : "queued",
    // Hermes answers a repeat of an earlier request with the ORIGINAL run
    // (possibly already finished) instead of starting one: the header says
    // so, and so does the body.
    replayed: res.headers.get("idempotency-replayed") === "true" || parsed.replayed === true,
  };
}

export interface HermesRun {
  /** Hermes' own status, "not_found" for a 404, or "unknown" for an unreadable 200. */
  status: string;
  /** Not truncated: bounded only by the `readJson` cap. */
  output?: string;
  error?: string;
  shuttingDown: boolean;
}

/** Reads a run (`GET /v1/runs/:id`). `output` and `error` are returned whole. */
export async function getRun({ root, key }: HermesConfig, runId: string): Promise<HermesRun> {
  const res = await hermesFetch(root, key, `/v1/runs/${encodeURIComponent(runId)}`, {
    method: "GET",
    timeoutMs: STATUS_TIMEOUT_MS,
  });
  if (res.status === 404) {
    void res.body?.cancel().catch(() => undefined);
    return { status: "not_found", shuttingDown: false };
  }
  if (!res.ok) throw await unavailableFromResponse(res, "could not read the run status");
  const run = await readJson<Record<string, unknown>>(res);
  // An empty / non-JSON / oversized 200 (e.g. a proxy page) is not "the run
  // does not exist"; keep that to a real 404.
  if (!run) return { status: "unknown", shuttingDown: false };
  const text = (v: unknown): string | undefined =>
    typeof v === "string" && v !== "" ? v : undefined;
  return {
    status: typeof run.status === "string" ? run.status : "unknown",
    output: text(run.output),
    error: text(run.error),
    shuttingDown: run.shutdown_requested_at != null,
  };
}

/**
 * Stops a run (`POST /v1/runs/:id/stop`). A run Hermes does not know (404)
 * resolves as "not_found" rather than throwing; the relay maps that itself.
 */
export async function stopRun(
  { root, key }: HermesConfig,
  runId: string,
): Promise<{ status: string; found: boolean }> {
  const res = await hermesFetch(root, key, `/v1/runs/${encodeURIComponent(runId)}/stop`, {
    method: "POST",
    timeoutMs: STATUS_TIMEOUT_MS,
  });
  if (res.status === 404) {
    void res.body?.cancel().catch(() => undefined);
    return { status: "not_found", found: false };
  }
  if (!res.ok) throw await unavailableFromResponse(res, "could not stop the run");
  const parsed = await readJson<{ status?: unknown }>(res);
  return { status: typeof parsed?.status === "string" ? parsed.status : "stopping", found: true };
}
