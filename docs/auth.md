# Authentication

Mullion has no application-layer auth by default — the standard deployment
model is a gateway in front of it (Traefik + Authentik forwardAuth, see
`deploy/README.md`). On top of that, two independent, **composable**
in-process auth mechanisms exist, both off by default: a shared-token gate
(issue #19) and native OIDC login (issue #30, e.g. against Authentik). Either
can be enabled alone, or both at once — they mint the same signed session
cookie, and `GET /api/auth/me` reports which are configured so the frontend
can offer whichever apply.

Neither mechanism replaces the gateway model; they compose with it for
defense in depth, or stand alone for a bare deployment with no gateway at
all.

## Shared token (issue #19)

The simplest option: one shared secret gates every `/api/*` route and the
`/ws/terminal` upgrade.

```bash
MULLION_AUTH_TOKEN=$(openssl rand -hex 32)
MULLION_SESSION_SECRET=$(openssl rand -hex 32)   # required alongside it
```

- `POST /api/auth/login` with `{ "token": "..." }` sets a signed, httpOnly
  session cookie on success; the SPA's login screen (`AuthGate.tsx`) does
  this for you.
- A `Bearer <token>` `Authorization` header also authenticates directly, no
  cookie needed — this is what keeps `curl`/scripts working without a
  browser session, and is the only option for a caller that can't hold
  cookies (a WebSocket upgrade can't send custom headers from a browser, so
  `/ws/terminal` only ever authenticates via the cookie, minted by the login
  step above).
- Treat this the same as `MULLION_AGENT_TOKEN` (real entropy, not a
  memorable password) — a leaked token is full dashboard access, including
  spawning/attaching to any terminal.

## Native OIDC login (issue #30)

A second, alternative way to mint the same session cookie: sign in through
an external OIDC provider instead of (or alongside) a shared token.

```bash
MULLION_OIDC_ISSUER=https://authentik.example.com/application/o/mullion/
MULLION_OIDC_CLIENT_ID=<client id>
MULLION_OIDC_CLIENT_SECRET=<client secret>
MULLION_OIDC_REDIRECT_URI=https://mullion.example.com/api/auth/oidc/callback
MULLION_SESSION_SECRET=$(openssl rand -hex 32)   # required alongside it
```

All four `MULLION_OIDC_*` keys must be set together, or all left empty — the
process refuses to boot on a partial set (a half-configured OIDC client
can't complete discovery or the code exchange, so this fails at startup
rather than confusingly on the first login attempt).

This app acts as a **confidential OIDC client**: it holds the client secret
and does the authorization-code exchange server-side, so the browser and SPA
never see an OIDC token, only the resulting session cookie. Only the
`openid`, `email`, and `profile` scopes are requested — every
OIDC-conformant provider recognizes those, unlike scope names such as
`groups`, which OIDC never standardized and which vary by provider (or don't
exist at all). If your provider includes a `groups` claim on the ID token
anyway (e.g. via a default claim mapping), it's read and stored on the
session, but nothing in this app currently requests or acts on it — whether
it's populated depends entirely on your provider's own claim-mapping
configuration, not on anything this app can force.

### Worked example: Authentik

1. In Authentik, create an **OAuth2/OpenID Provider**:
   - **Redirect URIs**: exactly `https://mullion.example.com/api/auth/oidc/callback`
     (must match `MULLION_OIDC_REDIRECT_URI` exactly).
   - **Client type**: Confidential.
   - Note the generated **Client ID** and **Client Secret**.
2. Create an **Application** using that provider, and note the provider's
   **OpenID Configuration Issuer** URL (Authentik shows this under the
   provider's overview, typically
   `https://authentik.example.com/application/o/<slug>/`) — this is
   `MULLION_OIDC_ISSUER`.
3. Set the four `MULLION_OIDC_*` variables above plus
   `MULLION_SESSION_SECRET`, and restart Mullion.
4. Open the dashboard — the login screen now shows a "Sign in with SSO"
   button alongside (or instead of) the token field, depending on what else
   is configured.

## How the session works

Both mechanisms above mint the same cookie (`mullion_session`, `httpOnly`,
`SameSite=Lax`, 30-day max age), signed (HMAC via `MULLION_SESSION_SECRET`)
but **not encrypted** — the payload is base64, not encrypted, so treat it as
client-readable. A token-only login's payload is just
`{ authenticated: true }`; an OIDC login's payload also carries the derived
identity claims (`sub`/`email`/`name`/`groups`) — never the raw
`id_token`/`access_token` from the provider, which are discarded the moment
the identity claims are extracted from them.

`GET /api/auth/me` is how the frontend decides what to render, reachable
without a credential (a request can't authenticate itself against a gate
that also blocks the one endpoint that authenticates it):

```jsonc
{
  "methods": { "token": true, "oidc": true }, // which mechanisms are configured
  "authenticated": false,
  "user": { "sub": "...", "email": "...", "name": "...", "groups": ["..."] }, // only present once authenticated via OIDC
}
```

## API surface

All under `/api/auth/`, exempt from the auth gate itself (see Security
below):

| Route                     | Method | Does                                                                                                                |
| ------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| `/api/auth/login`         | POST   | Body `{ token }`; sets the session cookie on a valid token.                                                         |
| `/api/auth/logout`        | POST   | Clears the session cookie.                                                                                          |
| `/api/auth/me`            | GET    | Reports `methods`/`authenticated`/`user` (see above).                                                               |
| `/api/auth/oidc/login`    | GET    | Redirects to the provider; sets a short-lived PKCE/state/nonce transaction cookie. Browser navigation, not a fetch. |
| `/api/auth/oidc/callback` | GET    | Exchanges the code, verifies the ID token, mints the session cookie, redirects to `/`.                              |

## Security

- **Fail-closed boot checks** (`src/app.ts`): either credential configured
  without `MULLION_SESSION_SECRET` refuses to boot (an unsigned cookie is
  forgeable); a partial `MULLION_OIDC_*` set refuses to boot too.
- **ID token signature verification is explicitly enabled.**
  [openid-client](https://github.com/panva/openid-client) does **not**
  verify the ID token's JWS signature by default for the authorization-code
  flow — per OIDC Core 3.1.3.7, TLS to the token endpoint is spec-permitted
  to stand in for it, since the token arrives over an already-authenticated
  channel, not the browser front-channel. This app enables
  `client.enableNonRepudiationChecks()` anyway (`src/services/oidc.ts`) for
  real defense-in-depth, verified by a dedicated integration test
  (`test/services/oidc.integration.test.ts`) that drives the real
  `openid-client` API against a mocked-transport IdP.
- **`redirect_uri` is always the configured value, never derived from the
  incoming request's path** — openid-client sends whatever path `currentUrl`
  resolves to as the token-exchange `redirect_uri`; building it from the
  configured `MULLION_OIDC_REDIRECT_URI` (plus only the callback's query
  string) keeps this correct even behind a reverse proxy that
  rewrites/strips a path prefix.
- **Open-redirect guard**: the OIDC callback always redirects to a hardcoded
  `/`, never a client-supplied `returnTo`/redirect parameter.
- **CSRF**: the `Bearer` header path is CSRF-immune by construction; the
  cookie path relies on `SameSite=Lax` (not `Strict` — the OIDC callback is
  a cross-site top-level navigation _back from the provider_, which
  `Strict` would silently drop the cookie on). A dedicated CSRF-token layer
  was deliberately left out as over-engineering for this threat model (a
  same-origin SPA with no cross-origin form posts).
- **Neither mechanism extends to the preview subdomain by default** — this
  is now _conditionally_ true, closed when `PREVIEW_AUTH_REQUIRED=true`
  (issue #383), still the pre-existing gap otherwise. With the flag off (the
  default), a same-origin session cookie can't reach a different subdomain
  (`preview-<slug>.<PREVIEW_BASE_HOST>`, see
  [`docs/browser-previews.md`](browser-previews.md)), and a browser
  `<iframe>` can't attach a bearer token either, so the preview proxy still
  needs its own forwardAuth middleware regardless of whether in-process auth
  is enabled for the main dashboard. `src/plugins/auth.ts`'s own bypass for
  this surface (skipping its onRequest check for a matching preview `Host`)
  is **host-only**, not method-scoped: that's only safe because
  `previewProxyPlugin`'s own onRequest hook now consumes _every_ HTTP method
  for a matching Host and always terminates the request itself (proxied, or
  an explicit 401/404/502/503) rather than ever falling through to a real
  `/api/*` handler — see both plugins' own doc comments for the exact
  invariant.

## Preview-host auth token (issue #383)

Setting `PREVIEW_AUTH_REQUIRED=true` closes the preview-subdomain gap above
in-process, **as long as one of the shared-token or OIDC mechanisms above is
also configured** — see the boot-time invariant below for why this isn't
optional. The literal design (a same-origin session cookie or bearer header
can't reach a cross-subdomain `<iframe>`) doesn't change; instead this is a
two-lifetime bootstrap scheme built on the same signed-payload primitive
(`src/services/signed-payload.ts`) the dashboard session and OIDC
transaction cookies already use:

1. An authenticated dashboard session calls
   `POST /api/previews/:slug/token` to mint a 60-second bootstrap token,
   which the frontend appends to the preview iframe's URL as a query
   parameter (`__mullion_preview`).
2. `previewProxyPlugin` (`src/plugins/preview-proxy.ts`) sees that token on
   the iframe's initial GET/HEAD navigation, verifies it against the
   requested slug, mints a long-lived, host-only preview cookie
   (`mullion_preview`), and 302-redirects to the same URL with the token
   stripped (so it never lands in browser history, a `Referer` header, or
   the previewed dev server's own access log).
3. Every subsequent request to that preview subdomain — including
   subresources the previewed app itself loads and the HMR WebSocket
   upgrade, neither of which can carry a query string — rides the cookie
   automatically. The WS upgrade path checks the cookie only, since there's
   no query string available on an upgrade request.

A request with neither a valid token nor a valid cookie gets a static 401
HTML response (no Host-derived content interpolated into it, since the Host
header is attacker-controllable).

**Opt-in, default off**: turning this on breaks direct/bookmarked navigation
straight to a preview URL, since there's no bootstrap token in that case —
existing deployments relying on a gateway forwardAuth in front of the preview
router are unaffected until this is explicitly enabled.

**Requires in-process auth to already be configured.** The bootstrap-token
mint route (`POST /api/previews/:slug/token`) sits behind the same
`src/plugins/auth.ts` gate as every other `/api/*` route — but that gate
installs no hook at all when neither `MULLION_AUTH_TOKEN` nor
`MULLION_OIDC_*` is set (see "Shared token"/"Native OIDC login" above). So
`src/app.ts`'s boot-time invariant refuses to start with
`PREVIEW_AUTH_REQUIRED=true` unless one of those is also configured —
without it, anyone who can reach the dashboard origin could mint their own
bootstrap token and walk straight through the gate this flag exists to add,
a strictly worse posture than leaving the flag off. The same invariant also
requires `MULLION_SESSION_SECRET` to be set (mirroring
`MULLION_AUTH_TOKEN`'s own check — there'd be nothing to sign the bootstrap
token/preview cookie with otherwise).

Preview hosts are exempt from the app-wide rate limiter (`src/plugins/security.ts`), so this
credential check couldn't rely on that limiter the way `auth.ts`'s own onRequest hook does — it
carries its own dedicated fixed-window counter instead (`src/plugins/preview-proxy.ts`,
30 failed attempts/minute per client IP, shared across the HTTP and WebSocket paths), counting only
failed attempts so a legitimately cookie-authenticated preview session's own traffic never
throttles itself.

## Current limitations

- No RP-initiated (provider-side) logout — that needs the `id_token` as an
  `id_token_hint`, which this app deliberately never retains once identity
  claims are extracted from it. Logout only clears the local session cookie.
- No per-user accounts, roles, or authorization decisions based on
  `groups`/identity — this is a binary "is this request allowed at all"
  gate (optionally with an identity badge), not multi-tenant RBAC. If a
  future feature needs `groups` for authorization, revisit the
  signed-but-not-encrypted cookie choice above first.
- The session cookie's identity payload is client-readable (signed, not
  encrypted) — fine for today's claims, but a constraint worth keeping in
  mind before adding anything more sensitive to it.
- **Preview cookie revocation is bounded, not instant** (issue #383,
  hardened by finding AS12): the preview cookie now uses a _sliding_ idle
  timeout rather than a flat 30-day TTL — `PREVIEW_COOKIE_MAX_AGE_SECONDS`
  is 24h, and a still-valid cookie older than half that is silently
  re-minted (fresh `issuedAt`, fresh full 24h window) on its next HTTP
  request, so a preview that's genuinely still being used never actually
  hits the cap. This still works within the same frontend constraint as
  before — no keepalive/401-retry for an already-open iframe (`AuthGate.tsx`
  checks `GET /api/auth/me` once on mount only, and a cross-origin iframe's
  parent can't observe a 401 happening inside it) — the refresh is
  transparent, not a forced re-auth round trip. The trade-off: killing the
  dashboard session or rotating `MULLION_AUTH_TOKEN` still doesn't
  invalidate an already-issued preview cookie outright, but a genuinely idle
  one (tab left open but untouched, or truly abandoned) now expires within
  ~24h instead of up to 30 days — that's the actual revocation-lag bound
  now, down from 30 days. Note this bound is specifically for an _idle_
  cookie: an attacker who captured one and keeps making requests with it
  rides the same sliding refresh a legitimate idle-but-open tab does, so
  continuous (mis)use isn't bounded by the 24h TTL at all — unlike the old
  flat 30-day cap, which did eventually expire even under continuous abuse.
  Revoking that case still requires killing the dashboard session or
  rotating `MULLION_AUTH_TOKEN` (which doesn't retroactively invalidate the
  preview cookie either, per above) — there's no per-cookie revocation
  list today.
- **Plain-HTTP + cross-registrable-domain deployments aren't supported** by
  `PREVIEW_AUTH_REQUIRED`: the preview cookie is `Secure`/`SameSite=None`/
  `Partitioned` when the request arrived over https, but falls back to
  `SameSite=Lax` over plain http (`None` without `Secure` is rejected by
  every modern browser outright) — Lax only actually reaches the preview
  subdomain's own subsequent requests when the dashboard and
  `PREVIEW_BASE_HOST` share a registrable domain. A plain-http deployment
  with a cross-registrable-domain dashboard isn't covered.
