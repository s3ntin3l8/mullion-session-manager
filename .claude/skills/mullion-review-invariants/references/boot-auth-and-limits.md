# Boot, auth gate, sessions directory and rate limits

Read this when a diff touches `buildApp` boot checks, auth or credential env
vars, the CSRF origin check, the default bind or encryption key, how the
sessions directory is resolved, or any route-level rate limiter. Verified
against `origin/main` baf16a1e; code is cited by symbol, not line.

## 1. Every half-configured auth state refuses to boot

**Invariant.** `buildApp` in `src/app.ts` throws on each partial or empty auth
configuration: an agent with no token or enrollment path, token or OIDC auth
without `MULLION_SESSION_SECRET`, a token that is blank after trimming, no auth
at all without `MULLION_TRUST_GATEWAY`, and `PREVIEW_AUTH_REQUIRED` with no
auth. A new auth or credential env var needs its own "set but incomplete"
throw. `MULLION_TRUST_GATEWAY` is only an acknowledgement; it never grants or
gates anything itself.

**Breaks.** A throw softened to a warning boots the primary with `authPlugin`
installing no hook, or with a forgeable unsigned cookie, and every route is
open.

**Check.** Diff `src/app.ts` and `src/plugins/env.ts`; each new auth-ish key
should have a matching throw and a boot test.

## 2. One normalised credential reader

**Invariant.** Every runtime reader of the operator token (login, bearer check,
control-socket handshake) goes through `configuredToken()` / `isAuthEnabled()`
in `src/services/auth.ts`, which trim. A new entry point (socket, relay, CLI,
webhook) must not compare against the raw config value or apply its own
emptiness test.

**Breaks.** A padded token authenticates trimmed on one surface and raw on
another, so surfaces disagree about who is authenticated.

**Check.** `git grep -n MULLION_AUTH_TOKEN -- src` outside `env.ts`, `app.ts`,
the CLI and MCP code should show only `src/services/auth.ts`.

## 3. The origin gate derives the expected origin per request

**Invariant.** The CSRF check in `src/plugins/auth.ts` compares `Origin` with
`requestOrigin()` (`src/services/request-scheme.ts`), built from the request's
own scheme and Host, never from `CORS_ORIGIN` or a literal. It runs in cookie
and gateway-only modes, skips preview hosts, and allows an absent Origin. Any
new mutating or WebSocket route stays behind it.

**Breaks.** A foreign page drives `/ws/terminal` or mutating `/api/*` with the
browser's ambient cookie; a hardcoded origin 403s deployments behind another
host.

**Check.** Look for an early-returning hook ahead of the origin check, or a
route registered outside `authPlugin`'s scope.

## 4. Safe default bind and exact key length

**Invariant.** `HOST` defaults to `127.0.0.1`; a wider bind is opt-in.
`EncryptionService` and the boot check require exactly 32 decoded bytes and
never truncate or pad. A new env key must appear in `docs/configuration.md` and
`.env.example` (`npm run check:env-docs`).

**Breaks.** An upgrade silently exposes the port on every interface, or a short
key becomes a silent weakening of stored host credentials.

**Check.** The `HOST` default in `src/plugins/env.ts`; any `subarray` or
padding in `src/services/encryption.ts`.

## 5. The sessions directory is an ownership set and is never deleted

**Invariant.** `resolveSessionsDirs` (`src/plugins/pty.ts`) yields a current
dir plus an owned set: every fallback root this repo has shipped
(`shippedFallbackRoots`) and the `sessions-dirs.json` history, bounded on read
and write. Consumers (`PtyManager`, the scope backend, `DeviceManager`) merge
their own dir into it via `resolveOwnedDirs`. `secureFallbackDir` creates the
fallback `0700` and refuses symlinks and foreign owners with `lstat`. A per-root
`mkdir` failure falls through to the next root. Shutdown never `rmSync`s it.

**Breaks.** A scope whose socket sits in an unclaimed earlier root is read as
confidently dead, so the reconciler exits a live session. Deleting the dir
removes live dtach sockets and hook tokens.

**Check.** A new root must be added to `shippedFallbackRoots`; flag any new
removal of the dir and any `sessionsDir` parameter taking a bare string.

## 6. Per-route rate limits never equal the global ceiling

**Invariant.** The frontend tells a global 429 from a per-route one by
comparing `x-ratelimit-limit` with the global max. No per-route limiter's `max`
may equal `RATE_LIMIT_MAX` (default `GLOBAL_RATE_LIMIT_MAX_DEFAULT`), and
`assertNoRateLimitMaxCollision` refuses to boot on a collision. The static-shell
exemption is an allowlist.

**Breaks.** A login-limiter 429 that looks global freezes the whole dashboard
for the Retry-After window.

**Check.** Any new `max:` in a route's rate-limit config against the default;
a second literal 300 is a red flag.
