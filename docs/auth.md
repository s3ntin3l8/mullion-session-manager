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
- **Neither mechanism extends to the preview subdomain**
  (`preview-<slug>.<PREVIEW_BASE_HOST>`, see
  [`docs/browser-previews.md`](browser-previews.md)) — a same-origin session
  cookie can't reach a different subdomain, and a browser `<iframe>` can't
  attach a bearer token either. The preview proxy needs its own forwardAuth
  middleware regardless of whether in-process auth is enabled for the main
  dashboard.

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
