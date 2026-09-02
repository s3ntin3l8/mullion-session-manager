// Shared fetch plumbing for every domain module under frontend/src/api/ —
// split out of the former flat frontend/src/api.ts (PR 22 of the refactoring
// roadmap). `request<T>` already centralizes credentials, content-type,
// ApiError, and 204->undefined; this is a MECHANICAL split, not a rewrite —
// every domain module below imports `request` from here rather than
// reimplementing any of this.

// Carries the HTTP status code alongside the backend's message so a caller
// can branch on the actual response (e.g. Settings -> Hosts' cascade-delete
// prompt checking `statusCode === 409`) instead of substring-matching
// error text, which silently breaks the moment the backend's wording changes.
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    // Machine-readable discriminator (e.g. "PROJECT_DIR_MISSING") — present
    // on the hand-built 4xx bodies that need one, undefined for plain
    // @fastify/sensible errors and successful-request paths. Lets a caller
    // branch on the actual failure instead of substring-matching `message`.
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// Thrown instead of ApiError when a gateway forward-auth session has
// expired (self-hosted deployments behind Traefik + Authentik or similar —
// see docs/auth.md's "Network exposure" section for the deployment shape
// this covers). Distinct from ApiError deliberately: callers like
// store/slices/sessions.ts must NOT fold this into `backendReachable` —
// that flag drives the "Mullion server unreachable" banner, whose subtext
// and Reconnect button both assume a transport/process failure, neither of
// which is true here. A caller that doesn't specifically care can still
// treat it as a generic failure (it's an Error), but the point of a
// distinct class is to let App.tsx show a correct "session expired" state
// instead of a misleading one.
export class AuthExpiredError extends Error {
  constructor() {
    super("Gateway session expired");
    this.name = "AuthExpiredError";
  }
}

// Thrown instead of a generic ApiError when the server returns HTTP 429
// (issue #959). Distinct from ApiError deliberately: a 429 is not a
// transport failure and not an auth-expiry — it's a "back off and retry"
// signal. `retryAfterMs` is parsed from the response's `Retry-After` header
// per RFC 7231 (seconds OR HTTP-date), with a 60s default when absent —
// the same default as @fastify/rate-limit's typical 1-minute window, so
// the frontend never retries sooner than the bucket can possibly refill.
// `request()`'s per-endpoint breaker uses this field to short-circuit
// later calls to the same key for `retryAfterMs` milliseconds; the live
// poll (store/slices/sessions.ts) uses it to skip its own ticks without
// flipping `backendReachable` (a 429 is not a "backend down" signal).
// `statusCode` is carried alongside so callers that want to branch on the
// raw HTTP status still can.
export class RateLimitedError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly retryAfterMs: number,
  ) {
    super(`Rate limited (HTTP ${statusCode}); retry in ${retryAfterMs}ms`);
    this.name = "RateLimitedError";
  }
}

// Per-endpoint 429 breaker. When the server says "this exact key is rate
// limited for N more ms," we honor N by short-circuiting any later call
// to the same `${method}:${path}` instead of going back to the network
// and getting another 429 — the cycle that produces the
// reload-bombs-the-empty-bucket / blank-page user-visible symptom (issue
// #959). Keyed on method+path (not just path) so a write and a read on
// the same URL with different rate-limit buckets stay independent — and
// so a future per-route bucket split on the server doesn't accidentally
// cross-cancel. Cleared on any successful response, the same way the
// auth-expiry reload guard is cleared (see the long comment on
// clearAuthExpiryReloadGuard below for the symmetry). Lazy expiry: an
// entry is removed the first time it's read after `until`, rather than
// on a timer — adds zero timers and matches the "no background work"
// style of the rest of this module.
const RATE_LIMIT_BREAKER = new Map<string, number>();

function breakerKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function getBreakerEntry(key: string): number {
  const until = RATE_LIMIT_BREAKER.get(key);
  if (until === undefined) return 0;
  if (Date.now() >= until) {
    RATE_LIMIT_BREAKER.delete(key);
    return 0;
  }
  return until;
}

function setBreakerEntry(key: string, until: number): void {
  RATE_LIMIT_BREAKER.set(key, until);
}

function clearBreakerEntry(key: string): void {
  RATE_LIMIT_BREAKER.delete(key);
}

// Visible for tests: the breaker is module-level state, so the tests need
// a way to reset it between cases without `vi.resetModules()` (which
// would also wipe every other module-level in the test file).
export function __resetRateLimitBreakerForTests(): void {
  RATE_LIMIT_BREAKER.clear();
}

// Parses an RFC 7231 `Retry-After` value: either a non-negative integer
// of seconds ("5") or an HTTP-date. Returns the millisecond delay. Falls
// back to `defaultMs` for any unparseable value — a missing/malformed
// header shouldn't ever be read as "retry immediately" (the cycle we're
// trying to break), and the default is the typical rate-limit window.
function parseRetryAfterMs(value: string | null, defaultMs: number): number {
  if (value === null || value === "") return defaultMs;
  // Seconds form: a non-negative integer. A bare number is the common
  // shape @fastify/rate-limit and most reverse proxies emit.
  if (/^\d+(\.\d+)?$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) return defaultMs;
    return Math.round(seconds * 1000);
  }
  // HTTP-date form: anything that Date can parse. The spec allows several
  // obsolete formats (RFC 1123, RFC 850, asctime) but in practice every
  // implementation we care about emits the IMF-fixdate / RFC 1123 form.
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return defaultMs;
  const delta = parsed - Date.now();
  if (delta <= 0) return 0;
  return delta;
}

const DEFAULT_RETRY_AFTER_MS = 60_000;

// Reload-loop guard: sessionStorage (not a module-level variable — a
// full-page reload resets JS state but not sessionStorage) records the last
// auto-reload attempt so a second detection within the window falls through
// to AuthExpiredError instead of reloading again. Without this, a gateway
// that keeps redirecting post-reload (misconfigured provider, a dead
// upstream IdP) would reload forever with no visible error. Kept short: a
// legitimate re-expiry this soon after a successful recovery is vanishingly
// unlikely, and the fallback state's own "sign in again" button gives the
// user a manual retry regardless. Cleared on the next successful request
// (see clearAuthExpiryReloadGuard) so a later, unrelated expiry still gets
// a silent reload instead of jumping straight to the banner.
const AUTH_EXPIRY_RELOAD_GUARD_KEY = "mullion:authExpiryReloadAt";
const AUTH_EXPIRY_RELOAD_GUARD_WINDOW_MS = 3 * 60 * 1000;

function recentlyAttemptedAuthExpiryReload(): boolean {
  try {
    const last = sessionStorage.getItem(AUTH_EXPIRY_RELOAD_GUARD_KEY);
    return last !== null && Date.now() - Number(last) < AUTH_EXPIRY_RELOAD_GUARD_WINDOW_MS;
  } catch {
    // Storage access can throw (privacy mode, disabled storage) — treat as
    // "no prior attempt recorded" here too, but see
    // recordAuthExpiryReloadAttempt below: the reload itself only fires if
    // *recording* the attempt also succeeds, so a session that can't use
    // sessionStorage never reloads at all, rather than looping.
    return false;
  }
}

// Returns whether the attempt was actually recorded — the caller must NOT
// reload unless this returns true. If sessionStorage throws, there is no
// way to remember "a reload was already tried," so reloading anyway would
// re-fire on every single detection of the same redirect: an unbounded
// loop, not the "one extra reload" a missing guard would otherwise cause
// (Hermes review — the original version of this function had no return
// value and reloaded unconditionally, which was exactly that loop).
function recordAuthExpiryReloadAttempt(): boolean {
  try {
    sessionStorage.setItem(AUTH_EXPIRY_RELOAD_GUARD_KEY, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

// Called on every genuine success (see the two call sites in request()) so
// a later, unrelated auth expiry still gets a silent reload attempt instead
// of the guard treating it as "already tried recently." Without this, any
// recovery — successful reload or a manual sign-in — would leave the guard
// armed for a full AUTH_EXPIRY_RELOAD_GUARD_WINDOW_MS, so a second,
// legitimate expiry inside that window would skip straight to the banner
// even though a silent reload was available again.
function clearAuthExpiryReloadGuard(): void {
  try {
    sessionStorage.removeItem(AUTH_EXPIRY_RELOAD_GUARD_KEY);
  } catch {
    // Nothing to clean up if recordAuthExpiryReloadAttempt could never
    // write it in the first place.
  }
}

// Top-level navigation is the only thing that can re-run a gateway's
// forward-auth redirect dance and mint a fresh proxy session cookie — see
// vite.config.ts's long comment on the service-worker half of this same
// production incident. main.tsx's own registerSW() already reloads an
// open tab on a service-worker update for the identical reason ("this
// app's reconnect path — WS backoff, PTY reattach/redraw — is already a
// first-class, tested scenario, a reload just triggers the same reconnect
// a network blip would"), so this isn't a new risk class for the app.
function handleAuthExpiry(): never {
  if (!recentlyAttemptedAuthExpiryReload() && recordAuthExpiryReloadAttempt()) {
    window.location.reload();
  }
  throw new AuthExpiredError();
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Per-endpoint 429 breaker (issue #959). Checked before the fetch, so a
  // call to a key that was just 429'd never touches the network — the
  // cycle that produced the reload-blank-page symptom was each 4s tick
  // hitting `listSessions` while the previous one was still in the
  // 60-second bucket window. `breakerKey` is method+path so a write and a
  // read on the same URL stay independent.
  const method = init?.method ?? "GET";
  const key = breakerKey(method, path);
  const blockedUntil = getBreakerEntry(key);
  if (blockedUntil !== 0) {
    throw new RateLimitedError(429, blockedUntil - Date.now());
  }

  const res = await fetch(path, {
    ...init,
    // Same-origin only (never sent cross-origin) — required for the
    // optional in-process auth session cookie (issue #19,
    // src/plugins/auth.ts) to ride along; a no-op when MULLION_AUTH_TOKEN is
    // unset, since there's no cookie to send either way.
    credentials: "same-origin",
    // A gateway forward-auth redirect (Traefik + Authentik or similar) to a
    // different origin would otherwise be followed transparently and then
    // rejected by CORS — a bare TypeError indistinguishable from the
    // backend process being down. `redirect: "manual"` turns that into a
    // detectable opaque response (see the res.type check below) instead.
    // This is safe for every redirect this app's own backend issues today:
    // `src/routes/auth.ts`'s OIDC login/callback and
    // `src/plugins/preview-proxy.ts`'s cross-host redirect are both full-
    // page browser navigations, never something `request()` fetches. If
    // that ever changes, a same-origin 3xx would also land in the
    // opaqueredirect branch below and be reported as an auth-expiry reload
    // rather than silently followed — for an API call, surfacing an
    // unexpected redirect beats silently following it.
    redirect: "manual",
    // Only set this when there's actually a body — sending it on bodyless
    // requests (GET, DELETE) is invalid and some fetch layers reject it outright.
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });

  // `redirect: "manual"` resolves (never rejects) to this opaque shape for
  // any 3xx it intercepts — status 0, ok false, body unreadable. This is
  // the primary auth-expiry signal; see handleAuthExpiry's doc comment.
  if (res.type === "opaqueredirect") {
    return handleAuthExpiry();
  }

  if (res.status === 429) {
    // Server says "this key is rate limited" — record the window and
    // throw. The window is per-key (matches @fastify/rate-limit's per-
    // route bucket model, and any per-IP keyGenerator the server may add
    // later) and is cleared on the next successful response, mirroring
    // clearAuthExpiryReloadGuard below.
    const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"), DEFAULT_RETRY_AFTER_MS);
    setBreakerEntry(key, Date.now() + retryAfterMs);
    throw new RateLimitedError(429, retryAfterMs);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.message || `${path} failed with ${res.status}`, res.status, body.code);
  }
  if (res.status === 204) {
    clearAuthExpiryReloadGuard();
    clearBreakerEntry(key);
    return undefined as T;
  }

  // Same-origin variant of the same signal: some gateways resolve an
  // expired session with a 200 interstitial (an IdP-branded HTML page)
  // rather than a 3xx, which the opaqueredirect check above can't see.
  // Narrowed to text/html specifically (Hermes review) rather than "isn't
  // JSON" — that's what an IdP interstitial actually is, and treating any
  // other non-JSON 200 (text/plain, octet-stream, ...) as the same signal
  // would misreport a real, if unexpected, backend response as a session
  // expiry. Every real response this app's own backend returns here is
  // application/json (confirmed: no `request<T>()` call site expects a
  // non-JSON 200 body — non-JSON success is 204, handled above) or 204, so
  // a text/html 200 is data from something other than this app's own
  // backend either way.
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    return handleAuthExpiry();
  }

  clearAuthExpiryReloadGuard();
  clearBreakerEntry(key);
  return res.json() as Promise<T>;
}
