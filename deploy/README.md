# Deployment

The pivotal architecture decision: the app runs **natively on the host**
under `systemd --user`, not in a container — containerizing it would mean
every redeploy kills every live terminal session. There is no Docker image;
the app installs from the CI-built release tarball instead (see "Layout and
updates" below). `traefik-dynamic.yml` and `authentik-middleware-example.yml`
remain
**templates, not live config** — nothing there is installed, enabled, or
applied by anything in this repo or its CI. `install.sh` and
`claude-remote-session.service` _are_ meant to be run/installed, via
`install.sh` itself (see "Install" below).

## Files

- `install.sh` — one-shot bootstrap for a fresh host: sets up the
  versioned-release layout below, installs the latest release, and installs
  and enables the systemd unit. Run once per host; updates after that go
  through the in-app "Update now" button instead (see below).
- `claude-remote-session.service` — `systemd --user` unit template that
  `install.sh` fills in and installs; runs `node dist/server.js` with
  `WorkingDirectory` set to the `current` symlink below.
- `traefik-dynamic.yml` — Traefik dynamic (file provider) router + service
  pointing at the app's local port.
- `authentik-middleware-example.yml` — reference only; you almost certainly
  already have a forwardAuth middleware defined and just need to reference
  its existing name in `traefik-dynamic.yml`, not create a new one.

## Layout and updates

Production doesn't run from a source checkout you'd also be editing — it
runs from its own versioned install root (`$MULLION_HOME`, e.g.
`~/opt/mullion`), fed by the CI-built release tarball
(`release-please.yml`'s `build-tarball` job) rather than a git checkout:

```
$MULLION_HOME
├── releases/
│   ├── 0.1.4/        ← unpacked release + node_modules (npm ci --omit=dev)
│   └── 0.1.5/
├── current -> releases/0.1.5      ← atomically flipped symlink
├── data/             ← DB + dtach sockets, OUTSIDE any release dir
│   ├── app.db
│   └── sessions/
├── .env
└── .update-status.json            ← updater progress, polled by the UI
```

**Why `data/` lives outside every release dir, and must stay that way:**
`DATABASE_URL` and `SESSIONS_DIR` (`src/plugins/env.ts`) default to
cwd-relative paths (`./data/app.db`, `./data/sessions`). The systemd unit's
`WorkingDirectory` is `current` — deliberately, so `drizzle/` and
`FRONTEND_DIST` (also cwd-relative) always resolve against whichever release
is live. But that means if `.env` left `DATABASE_URL`/`SESSIONS_DIR` at
their defaults too, the database and live terminal sockets would land
_inside_ the versioned release dir and get orphaned the moment `current` is
re-pointed at the next update. `install.sh` writes `.env` with both set to
absolute paths under `$MULLION_HOME/data/` for exactly this reason — if you
ever hand-edit `.env`, keep them absolute.

**Applying an update:** once installed, updates go through Settings ->
Server info's "Update now" button (`POST /api/updates/apply`,
`src/routes/updates.ts`), not by re-running `install.sh`. That launches
`scripts/self-update.sh` detached (the same `systemd-run --user --scope`
isolation `src/services/pty-manager.ts` uses for terminal sessions, so it
survives the restart it triggers in its own last step): download the new
release, `npm ci --omit=dev`, verify the native modules
(`better-sqlite3`/`node-pty`) actually load, flip the `current` symlink, and
`systemctl --user restart` the unit. Live terminal sessions survive the
restart (their dtach masters run in their own scopes, outside the unit's
cgroup); the database migrates forward automatically on the new process's
startup. A failed download/install/verify leaves `current` untouched — the
running app keeps serving the old release. Rollback is manual and
**code-only** (migrations are forward-only, so a DB already migrated by a
newer release can't go back): re-point `current` at an older
`releases/<version>` and restart, and only if no migration ran in between.

## Host prerequisites

Beyond `systemd --user` itself: **Node 26**, **`dtach`**, and — needed only
at install/update time, to compile `better-sqlite3`/`node-pty`'s native
bindings against this host's exact Node build — a C build toolchain
(`python3 make g++`). `install.sh` checks for `node`, `npm`, `dtach`,
`systemd-run`, `systemctl`, `curl`, `tar`, `timeout`, and `sha256sum` up
front and fails fast with a clear message if any are missing.

## Before installing anything

`install.sh` fills in `claude-remote-session.service`'s `CHANGEME` paths for
you (see "Install steps" below). `traefik-dynamic.yml` and
`authentik-middleware-example.yml` are still hand-edited — three
placeholders there need real values only you have:

1. **Hostname** this dashboard should answer on (`traefik-dynamic.yml`'s
   `Host()` rule).
2. **Your existing Authentik forwardAuth middleware's reference**
   (`name@provider`, e.g. `authentik@file`) to put in `traefik-dynamic.yml`'s
   `middlewares:` list.
3. **Your Traefik dynamic-config directory path**, so `traefik-dynamic.yml`
   ends up somewhere Traefik's file provider actually watches.

## Optional: in-process auth (issues #19, #30)

See [`docs/auth.md`](../docs/auth.md) for the full setup/security writeup;
this section covers how it fits into this deployment specifically.

The forwardAuth middleware above is still the recommended posture — it
rejects unauthenticated requests before they ever reach this process. But
it's no longer the only option: setting `MULLION_AUTH_TOKEN` (and
`MULLION_SESSION_SECRET`, required alongside it) in this app's own `.env`
turns on an in-process shared-token gate — a single token/password screen
in front of the dashboard, checked on every `/api/*` route and the
`/ws/terminal` upgrade, independent of anything Traefik does.

A second, alternative (or additional — both can be on at once) way to mint
that same session is native OIDC login: set `MULLION_OIDC_ISSUER`,
`MULLION_OIDC_CLIENT_ID`, `MULLION_OIDC_CLIENT_SECRET`, and
`MULLION_OIDC_REDIRECT_URI` (all four together — a partial set refuses to
boot) to add a "Sign in with SSO" button that redirects through your OIDC
provider (e.g. an Authentik application) and back to
`/api/auth/oidc/callback`. This process acts as a confidential OIDC
client — it holds the client secret and does the code exchange
server-side, so the SPA and browser never see an OIDC token, only the
resulting session cookie. `MULLION_OIDC_REDIRECT_URI` must exactly match a
redirect URI registered at the provider, e.g.
`https://mullion.example.com/api/auth/oidc/callback`.

Only the `openid`, `email`, and `profile` scopes are requested — every
OIDC-conformant provider recognizes those. A `groups` claim, if your
provider includes one on the ID token, is read and stored on the session
too, but nothing in this app currently requests or acts on it; whether it's
populated at all depends entirely on your provider's own claim-mapping
configuration (e.g. Authentik needs an explicit Scope Mapping added to the
provider before `groups` shows up), not on anything this app can force.

Either credential is off by default (a clear warning logs at boot when
neither is set), and both **compose with** forwardAuth rather than
replacing it — run any combination for defense in depth, or in-process auth
alone for a bare deployment with no gateway at all.

One gap worth knowing: **neither in-process auth mechanism extends to the
preview subdomain** (`preview-<slug>.<PREVIEW_BASE_HOST>` below) — a
same-origin session cookie can't reach a different subdomain, and a
browser `<iframe>` can't attach a bearer token either, so gating that
surface with this mechanism would just break every preview once auth is
turned on. The preview router still needs its own forwardAuth middleware
(point 4 in that section below) regardless of whether in-process auth is
enabled for the main dashboard.

## Optional: in-dashboard previews (issue #28)

See also [`docs/browser-previews.md`](../docs/browser-previews.md) for the
feature overview (including its worked example for a `mullion.s3ntin3l8.de`-
style deployment); this section covers only the production deploy side.

The browser pane itself (a project's dev server, or an arbitrary external
URL, opening in-dashboard) works with **no deploy changes at all** — with
`PREVIEW_BASE_HOST` unset (the default), it embeds the target directly, no
proxy involved. `PREVIEW_BASE_HOST` (`.env.example`) instead turns on the
**subdomain proxy** on top of that: previews move to
`preview-<slug>.<PREVIEW_BASE_HOST>`, needed once Mullion itself is served
over https (a plain-http dev server can't be embedded directly on an https
dashboard — mixed content) or to frame a site that refuses direct embedding.
Leave it empty (the default) to skip all of this — no preview _routes_
register, `traefik-dynamic.yml`'s preview router never receives traffic, and
the rest of this section doesn't apply — but the browser pane keeps working
in direct-embed mode regardless.

If you do set it, four things need real values/infrastructure, on top of
the three placeholders above:

1. **Wildcard DNS** — `*.<PREVIEW_BASE_HOST>` needs to resolve to the same
   place `CHANGEME_HOSTNAME` does (a single A/AAAA/CNAME wildcard record;
   individual preview slugs are never pre-registered, they're minted at
   runtime).
2. **Wildcard TLS** — a single-name cert (even one already covering
   `CHANGEME_HOSTNAME`) will not match `preview-<slug>.<PREVIEW_BASE_HOST>`.
   `traefik-dynamic.yml`'s preview router requests
   `*.CHANGEME_PREVIEW_BASE_HOST` via its `tls.domains` block, which forces
   a **DNS-01** challenge (HTTP-01 can't prove ownership of a wildcard) —
   make sure your `certResolver` is actually configured with a DNS provider
   plugin/credentials, not just the default HTTP-01 resolver most
   single-host Traefik setups use.
3. **`PREVIEW_BASE_HOST`** in this app's own `.env`, set to the _exact_
   same value as `CHANGEME_PREVIEW_BASE_HOST` in `traefik-dynamic.yml` —
   `src/services/preview-host.ts` matches the incoming `Host` header
   against this string verbatim (case-insensitively), so any mismatch
   (trailing dot, different casing normalized differently, a port included
   in one but not the other) means every preview 404s.
4. **The same forwardAuth middleware on the preview router as the main
   one** — already wired into `traefik-dynamic.yml`'s template, called out
   there as non-negotiable: without it, every preview is an unauthenticated
   open proxy on the internet.

**Risks worth knowing about, not blockers:**

- **WS-through-forwardAuth (the same Risk 3 M4 already flags below)**
  applies a second time here: a preview's own HMR websocket
  (`preview-<slug>.<PREVIEW_BASE_HOST>` upgrading `/hmr`-ish paths) is an
  independent upgrade from `/ws/terminal`'s, and needs the same
  session-cookie-survives-forwardAuth check verified live against your
  stack before you trust it in production.
- **The primary→agent hop is loopback-only, by construction, not by
  policy** — for a remote-hosted project's preview (issue #28 phase 6), the
  owning agent's `/internal/preview/:port/*` and `/internal/ws/preview`
  routes only ever dial `127.0.0.1:<port>` on themselves; the _host_
  portion of a project's `devServerUrl` is parsed but discarded for a
  remote project (see `src/plugins/preview-proxy.ts`'s and
  `src/routes/internal.ts`'s own comments) — even a fully compromised
  primary or a leaked `MULLION_AGENT_TOKEN` can only reach ports on the
  agent's own loopback through this path, not pivot into the agent's LAN.
- **External-URL previews (issue #28 phase 5) accept a real, documented
  SSRF surface** — `src/services/url-guard.ts` blocks IP-literal
  loopback/private/link-local/cloud-IMDS targets at creation time, but
  doesn't resolve hostnames, so a DNS-rebinding attacker (a hostname that
  resolves to a public IP at validation time and a private one at request
  time) isn't defended against today; the guard's own comments call this
  out as an accepted, known gap rather than an oversight.

## Install steps

```sh
# 1. App + systemd --user unit — sets up the layout above, installs the
# latest release, and installs + enables the unit with its CHANGEME
# placeholders filled in for you.
git clone https://github.com/s3ntin3l8/mullion-session-manager.git
cd mullion-session-manager
./deploy/install.sh ~/opt/mullion
systemctl --user status claude-remote-session.service

# 2. Traefik dynamic config (still manual — see "Before installing anything")
# edit the CHANGEME placeholders first
cp deploy/traefik-dynamic.yml <your-traefik-dynamic-config-dir>/
# Traefik's file provider picks it up automatically (watch or poll,
# depending on your config) — no Traefik restart should be needed.
```

After this, updates go through the in-app "Update now" button (see "Layout
and updates" above), not by re-running `install.sh` or `git pull`ing this
checkout — the checkout was only ever needed to get `install.sh` and
`claude-remote-session.service` onto the host once.

## What still needs a real, live check

Milestones 1–3 were each verified end-to-end against the real running app.
M4 can't be: the one thing that actually matters here — **whether a WS
upgrade request survives Authentik's forwardAuth redirect/cookie dance all
the way through Traefik** (Risk 3 in the plan) — only exists once this is
installed against your real Traefik/Authentik stack. Everything above this
line is "drafted and CI is green"; the actual GO/no-go for M4 is a joint
step after installing these for real:

- `curl`/a browser **without** an Authentik session gets rejected at
  Traefik, before ever reaching the app.
- With a session, the WS upgrade for `/ws/terminal` succeeds and streams
  data both ways (not just the initial HTTP upgrade handshake — actually
  type into a terminal through the proxy).
- `systemctl --user restart claude-remote-session.service` — sessions
  survive (same guarantee M1 already verified against a bare `systemd-run
--user --scope`, now through the real unit).
