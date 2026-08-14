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

// Reload-loop guard: sessionStorage (not a module-level variable — a
// full-page reload resets JS state but not sessionStorage) records the last
// auto-reload attempt so a second detection within the window falls through
// to AuthExpiredError instead of reloading again. Without this, a gateway
// that keeps redirecting post-reload (misconfigured provider, a dead
// upstream IdP) would reload forever with no visible error. Kept short: a
// legitimate re-expiry this soon after a successful recovery is vanishingly
// unlikely, and the fallback state's own "sign in again" button gives the
// user a manual retry regardless.
const AUTH_EXPIRY_RELOAD_GUARD_KEY = "mullion:authExpiryReloadAt";
const AUTH_EXPIRY_RELOAD_GUARD_WINDOW_MS = 3 * 60 * 1000;

function recentlyAttemptedAuthExpiryReload(): boolean {
  try {
    const last = sessionStorage.getItem(AUTH_EXPIRY_RELOAD_GUARD_KEY);
    return last !== null && Date.now() - Number(last) < AUTH_EXPIRY_RELOAD_GUARD_WINDOW_MS;
  } catch {
    // Storage access can throw (privacy mode, disabled storage) — treat as
    // "no prior attempt recorded". Worst case is one extra reload rather
    // than a stuck fallback state; recordAuthExpiryReloadAttempt's own
    // try/catch below means the guard simply never engages for a session
    // that can't use sessionStorage at all, which is an acceptable
    // degradation, not a loop (the reload itself still only fires once per
    // detected redirect).
    return false;
  }
}

function recordAuthExpiryReloadAttempt(): void {
  try {
    sessionStorage.setItem(AUTH_EXPIRY_RELOAD_GUARD_KEY, String(Date.now()));
  } catch {
    // See recentlyAttemptedAuthExpiryReload's comment.
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
  if (!recentlyAttemptedAuthExpiryReload()) {
    recordAuthExpiryReloadAttempt();
    window.location.reload();
  }
  throw new AuthExpiredError();
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
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

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.message || `${path} failed with ${res.status}`, res.status, body.code);
  }
  if (res.status === 204) return undefined as T;

  // Same-origin variant of the same signal: some gateways resolve an
  // expired session with a 200 interstitial (an IdP-branded HTML page)
  // rather than a 3xx, which the opaqueredirect check above can't see.
  // Every real response this app's backend ever returns here is
  // application/json (confirmed: no `request<T>()` call site expects a
  // non-JSON 200 body — non-JSON success is 204, handled above); a 200
  // that isn't JSON is data from something other than this app's own
  // backend, not a payload to parse.
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return handleAuthExpiry();
  }

  return res.json() as Promise<T>;
}
