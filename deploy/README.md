# Deployment

The pivotal architecture decision: the app runs **natively on the host**
under `systemd --user`, not in a container — containerizing it would mean
every redeploy kills every live terminal session. There is no Docker image;
the app installs from the CI-built release tarball instead (see "Layout and
updates" below). `traefik-dynamic.yml` and `authentik-middleware-example.yml`
remain
**templates, not live config** — nothing there is installed, enabled, or
applied by anything in this repo or its CI. `install.sh` and
`mullion.service` _are_ meant to be run/installed, via `install.sh` itself
(see "Install" below).

## Files

- `install.sh` — one-shot bootstrap for a fresh host: sets up the
  versioned-release layout below, installs the latest release, installs
  and enables the systemd unit, and links the `mullion` CLI
  ([`docs/cli.md`](../docs/cli.md)) at `~/.local/bin/mullion` (pointed at
  `current`, so later updates need no changes there). Run once per host;
  updates after that go through the in-app "Update now" button instead (see
  below). `--role primary` (default) or `--role agent` — see "Automating
  agent deploys" below for the latter.
- `mullion.service` — `systemd --user` unit template that `install.sh`
  (`--role primary`) fills in and installs; runs `node dist/server.js` with
  `WorkingDirectory` set to the `current` symlink below.
- `mullion-agent.service` — the agent-role equivalent, installed by
  `install.sh --role agent`; identical binary, `MULLION_ROLE=agent` in its
  `.env` instead.
- `traefik-dynamic.yml` — Traefik dynamic (file provider) router + service
  pointing at the app's local port. Also includes a commented-out webhook
  router for GitHub webhook delivery — see
  [`docs/github-integration.md`](../docs/github-integration.md) — and a
  commented-out router exempting the SSH-agent bridge helper's two paths
  from forwardAuth — see "Optional: SSH-agent bridge behind a forwardAuth
  gateway" below.
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
│   ├── 0.2.10/       ← unpacked release + node_modules (npm ci --omit=dev)
│   └── 0.2.11/
├── current -> releases/0.2.11      ← atomically flipped symlink
├── data/             ← DB + dtach sockets, OUTSIDE any release dir
│   ├── app.db
│   ├── app.db-wal    ← WAL-mode sidecar files (SQLite runs with journal_mode=WAL)
│   ├── app.db-shm
│   ├── sessions/
│   └── browsers/     ← per-project Playwright storage state (#179)
├── browsers/         ← Playwright's downloaded Chromium (PLAYWRIGHT_BROWSERS_PATH)
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
`systemctl --user restart` the unit. Which unit: `src/routes/updates.ts`
resolves it at apply time from this process's own `/proc/self/cgroup` (see
`src/services/systemd-unit.ts`), falling back to `mullion.service` — so a
host that later renames the unit doesn't need any code change to keep
updating correctly. `MULLION_SERVICE_UNIT` (`.env.example`) is an explicit
override for the rare host whose cgroup layout defeats that autodetection.
Live terminal sessions survive the restart (their dtach masters run in
their own scopes, outside the unit's cgroup); the database migrates forward
automatically on the new process's startup. A failed download/install/verify
leaves `current` untouched — the running app keeps serving the old release.
Rollback is manual and **code-only** (migrations are forward-only, so a DB
already migrated by a newer release can't go back): re-point `current` at an
older `releases/<version>` and restart, and only if no migration ran in
between.

A host installed before the `mullion` CLI existed (Phase 4, #134) picks it
up automatically on its next update: `self-update.sh` (re)links
`~/.local/bin/mullion` right alongside the `current` flip, same as
`install.sh` does on a fresh install — no need to re-run `install.sh` by
hand.

**Updating an agent (issue #647 / roadmap 7.8):** an agent runs the exact
same `self-update.sh`, triggered from the primary's Settings → Hosts row
instead of run by hand — see
[`docs/multi-host.md`](../docs/multi-host.md)'s "Agent updates" section for
the full flow, including why it's `/internal/updates/apply` and not the
primary's own `/api/updates/apply` path. One exception: a host still running
a pre-#647 build has no `/internal/updates/*` routes yet, so its first
update still needs a manual re-run of the install steps above (or your own
config-management run); every update after that can go through the button.

## Host prerequisites

Beyond `systemd --user` itself: **Node 26**, **`dtach`**, and — needed only
at install/update time, to compile `better-sqlite3`/`node-pty`'s native
bindings against this host's exact Node build — a C build toolchain
(`python3 make g++`). `install.sh` checks for `node`, `npm`, `dtach`,
`systemd-run`, `systemctl`, `curl`, `tar`, `timeout`, and `sha256sum` up
front and fails fast with a clear message if any are missing.

**Playwright / Chromium (Phase 3, issue #179):** `install.sh` and
`scripts/self-update.sh` both run `npx playwright install chromium` after
`npm ci --omit=dev`, unconditionally — regardless of whether you ever turn
on `BROWSER_ENABLED` (schema default: `false`, see `src/plugins/env.ts`), so
enabling the feature later needs no reinstall. This is a one-time
download (~150–300MB) into `$MULLION_HOME/browsers`
(`PLAYWRIGHT_BROWSERS_PATH`, kept outside any release dir so it survives
updates), not a running-process cost when the feature is off.

Headless Chromium itself needs a handful of shared libraries
(`libnss3`, `libatk-1.0-0`, `libatk-bridge2.0-0`, `libcups2`, `libdrm2`,
`libgbm1`, `libasound2`, `libxkbcommon0`, `libxcomposite1`, `libxdamage1`,
`libxfixes3`, `libxrandr2`) that a minimal container/LXC host commonly
lacks — `install.sh` does **not** check for or install these (unlike the
binaries above, they can't be probed with a plain `command -v`, and
`playwright install-deps` needs root/apt, which conflicts with this
deploy model's unprivileged `systemd --user` posture). If Chromium fails
to launch once `BROWSER_ENABLED=true`, install these via your
distro's package manager first. Chromium is launched with `--no-sandbox`
(`src/services/browser-manager.ts`) since unprivileged containers commonly
block the user namespaces its sandbox needs — the app's own auth gate is
the isolation boundary in that case, not the browser sandbox.

## Before installing anything

`install.sh` fills in `mullion.service`'s `CHANGEME` paths for you (see
"Install steps" below). `traefik-dynamic.yml` and
`authentik-middleware-example.yml` are still hand-edited — three
placeholders there need real values only you have:

1. **Hostname** this dashboard should answer on (`traefik-dynamic.yml`'s
   `Host()` rule).
2. **Your existing Authentik forwardAuth middleware's reference**
   (`name@provider`, e.g. `authentik@file`) to put in `traefik-dynamic.yml`'s
   `middlewares:` list.
3. **Your Traefik dynamic-config directory path**, so `traefik-dynamic.yml`
   ends up somewhere Traefik's file provider actually watches.

Before you fill in the `services.claude-remote-session.loadBalancer.servers`
URL, read the network-exposure comment at the top of `traefik-dynamic.yml` —
if Traefik runs in Docker and this app runs natively on the host (the normal
shape here), the URL you pick determines whether the app is reachable _only_
from Traefik or from every other container on whatever Docker network
Traefik happens to share with it. Getting this wrong doesn't fail loudly:
the app comes up, forwardAuth works for browser traffic, and the gap is
invisible until something else on that network gets compromised.

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

Either credential is off by default, and both **compose with** forwardAuth
rather than replacing it — run any combination for defense in depth, or
in-process auth alone for a bare deployment with no gateway at all. If you
leave both off (relying entirely on the Traefik middleware above), the
process now refuses to boot unless you also set `MULLION_TRUST_GATEWAY=true`
(issue #603) — an explicit acknowledgement that something else is gating
access, replacing what used to be just a boot-time log warning. This
install's own Traefik container already satisfies that; a bare `make dev`
checkout with no gateway at all needs either a real credential above or this
flag.

Separately, `HOST` (`.env.example`) defaults to `127.0.0.1` — this process
only listens on loopback out of the box, which is exactly what
`traefik-dynamic.yml`'s own `loadBalancer.servers[].url` above targets
(`http://127.0.0.1:<port>`). Set `HOST=0.0.0.0` only if something other than
a co-located reverse proxy needs to dial this process directly.

**Upgrading an existing bare deployment (in-process auth, no gateway at
all)?** Before this change the listener always bound `0.0.0.0`, so an
install relying on `MULLION_AUTH_TOKEN`/OIDC alone (no Traefik in front —
the "in-process auth alone" model called out above) was reachable directly
from the network. `HOST` now defaults to loopback-only on upgrade too, and
because a real credential is already configured, `MULLION_TRUST_GATEWAY`'s
own boot check never fires to warn you — the process boots fine, just
silently unreachable from anywhere but this host. Add `HOST=0.0.0.0` to that
install's `.env` before upgrading if it needs to keep working exactly as it
did.

One gap worth knowing: **neither in-process auth mechanism extends to the
preview subdomain** (`preview-<slug>.<PREVIEW_BASE_HOST>` below) — a
same-origin session cookie can't reach a different subdomain, and a
browser `<iframe>` can't attach a bearer token either, so gating that
surface with this mechanism would just break every preview once auth is
turned on. The preview router still needs its own forwardAuth middleware
(point 4 in that section below) regardless of whether in-process auth is
enabled for the main dashboard.

## Optional: SSH-agent bridge behind a forwardAuth gateway (issues #820, #1072)

See [`docs/ssh-agent.md`](../docs/ssh-agent.md) for the feature itself; this
section covers only what a Traefik + forwardAuth (Authentik/Authelia/etc.)
deployment needs on top.

**The problem.** The SSH-agent bridge helper
(`src/cli/ssh-agent-helper.mjs`) is a plain Node `WebSocket` client — it has
no cookie jar and runs no OIDC flow. It authenticates by presenting its own
credential directly in the first handshake frame of the
`/ws/agent-bridge` connection, or in the body of its periodic
`POST /api/bridges/renew` renewal call — never a browser session cookie or a
`MULLION_AUTH_TOKEN` bearer header, since a laptop/PC running the helper has
no way to obtain either. When Mullion sits behind a forwardAuth gateway, the
gateway's SSO middleware intercepts every request before it reaches Mullion
at all and 302s it to the SSO challenge, so the helper's handshake and its
renewal call never get a chance to present that credential:

```
$ curl -i https://mullion.example.com/ws/agent-bridge
HTTP/2 302
location: https://authentik.example.com/application/o/authorize/?client_id=...&redirect_uri=...&state=...
```

**The two paths that need a gateway-level exemption** — exactly these, and
only these:

- `/ws/agent-bridge`
- `POST /api/bridges/renew`

These match `isProtectedPath`'s own exemptions in `src/plugins/auth.ts`
(around lines 108 and 116) exactly — both are exact-path matches there, not
prefix matches — so a router-level exemption that drifts from that in-app
list either reopens a path the app still expects to gate, or leaves the
helper unable to reach a path the app already treats as self-authenticating.
Keep the two lists in sync.

**Explicitly NOT exempt, and why the shape matters.** `POST /api/bridges`
(minting a _new_ pairing code) is a Settings-side admin action and stays
behind the normal gate, same as `POST /api/hosts` — see the comment
immediately above `isProtectedPath`'s `/ws/agent-bridge` case in
`src/plugins/auth.ts`. And `/ws/terminal` — a live, interactive PTY — must
never be reachable through this exemption. That's why the router below
matches the two exact paths above, not a `PathPrefix('/ws/')` bypass: a
prefix match on `/ws/` would be the wrong shape precisely because it would
also expose `/ws/terminal` to the same forwardAuth bypass (see
`src/plugins/auth.ts` around lines 117-118 for the same exact-match-vs-prefix
contrast in the in-app gate).

**The security implication.** When `MULLION_TRUST_GATEWAY=true` and neither
in-process auth mechanism is configured (`MULLION_AUTH_TOKEN`/OIDC — see
"Optional: in-process auth" above), `isAuthEnabled` returns false and
`authPlugin` never registers its `onRequest` hook at all (`src/plugins/auth.ts`
around lines 220-227); `isProtectedPath` simply never runs. In that
configuration — the one this whole section exists for — the router below
**is** the entire security boundary for `/ws/agent-bridge` and
`POST /api/bridges/renew`, not defense-in-depth on top of an in-app check
(contrast `src/app.ts` around lines 184-198, which is what forces the
`MULLION_TRUST_GATEWAY` acknowledgment in the first place). Any
IP-allowlisting or rate-limiting you want on these two paths belongs on this
router — there is nothing else in front of them.

**Traefik router.** `deploy/traefik-dynamic.yml` has a commented-out
`mullion-agent-bridge` router, in the same style and commented-out-by-default
posture as its `mullion-webhooks` router — copy it, uncomment it, and fill in
the same `CHANGEME_HOSTNAME`/`CHANGEME_CERTRESOLVER` placeholders as the main
router:

```yaml
mullion-agent-bridge:
  rule: "Host(`CHANGEME_HOSTNAME`) && (Path(`/ws/agent-bridge`) || Path(`/api/bridges/renew`))"
  priority: 100
  entryPoints:
    - websecure
  service: claude-remote-session
  tls:
    certResolver: CHANGEME_CERTRESOLVER
```

It matches only the two exact paths above (`Path()`, not `PathPrefix`, and
method-blind — the rule matches every HTTP method on those paths, same as
`isProtectedPath`'s own check) and carries no auth middleware, since the
helper's own credential is the auth check for this surface. Unlike
`mullion-webhooks`, which sidesteps any overlap by using its own
`CHANGEME_WEBHOOK_HOSTNAME`, this router shares `CHANGEME_HOSTNAME` with the
main router, so both match the same two paths. Because this router's rule is
the main router's rule plus the `&& (Path(...) || Path(...))` suffix,
Traefik's default longest-rule-wins tiebreak would already resolve this
correctly on its own — the bridge rule is always the longer string,
regardless of what hostname you fill in. The explicit `priority: 100` is set
anyway so precedence doesn't depend on that implicit character-count
computation; if you ever extend the main router's own `rule` (more `Host()`
alternatives, a long hostname list), keep `priority` comfortably above its
computed length so it doesn't creep past this static ceiling.

**nginx / Caddy / Cloudflare Tunnel:** not covered here — this repo only has
a live Traefik deployment to verify config shape against. See the issue
tracker for a follow-up once one of those is actually verified against a
real deployment, rather than speculatively authoring untested config for a
platform nobody here runs.

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
   one** — already wired into `traefik-dynamic.yml`'s template. This is
   still the default/only option when the opt-in `PREVIEW_AUTH_REQUIRED` env
   var (issue #383, see [`docs/auth.md`](../docs/auth.md)) is off: without
   either one, every preview is an unauthenticated open proxy on the
   internet — for every HTTP method, not just reads (the preview proxy
   forwards GET/HEAD/POST/PUT/PATCH/DELETE/etc. alike; see
   [`docs/browser-previews.md`](../docs/browser-previews.md)'s Security
   section). Setting `PREVIEW_AUTH_REQUIRED=true` instead closes this
   in-process, at the cost of a long-lived, weakly-revocable preview cookie
   and a plain-http + cross-registrable-domain constraint — see
   `docs/auth.md`'s Current limitations before relying on it in place of
   forwardAuth.

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
systemctl --user status mullion.service

# 2. Traefik dynamic config (still manual — see "Before installing anything")
# edit the CHANGEME placeholders first
cp deploy/traefik-dynamic.yml <your-traefik-dynamic-config-dir>/
# Traefik's file provider picks it up automatically (watch or poll,
# depending on your config) — no Traefik restart should be needed.
```

After this, updates go through the in-app "Update now" button (see "Layout
and updates" above), not by re-running `install.sh` or `git pull`ing this
checkout — the checkout was only ever needed to get `install.sh` and
`mullion.service` onto the host once.

## Automating agent deploys (issue #245 / roadmap 7.1 + 7.7)

An **agent** host (see [`docs/multi-host.md`](../docs/multi-host.md)) is the
identical build, just installed with `--role agent` instead of the default
`primary`:

```sh
git clone https://github.com/s3ntin3l8/mullion-session-manager.git
cd mullion-session-manager
./deploy/install.sh --role agent ~/opt/mullion
systemctl --user status mullion-agent.service
```

This installs `mullion-agent.service` (not `mullion.service`) and writes an
agent-shaped `.env` — no `DATABASE_URL`/`DB_ENCRYPTION_KEY`/`FRONTEND_DIST`
(an agent is DB-less and serves no frontend). What makes this genuinely
zero-touch for a fleet is that the credential variables below are read from
`install.sh`'s own environment if already exported — an Ansible task (or any
other config-management run) that sets them before invoking `install.sh`
never needs to hand-edit the resulting `.env` at all.

**Env contract** — set these on the agent before running `install.sh`
(exported into its environment, or templated directly into `.env` if you'd
rather manage the whole file yourself and skip `install.sh`'s generation
step by pre-creating it):

| Variable                         | Required?                                                     | Purpose                                                                                                                                                                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MULLION_AGENT_PROJECTS_ROOTS`   | recommended (warn-only)                                       | comma-separated dirs on this host to scan for project discovery — written to `.env`'s `PROJECTS_ROOTS`. Not fail-closed like the credential paths below: an agent boots fine with this empty, it just has nothing to discover — `install.sh` prints a warning, doesn't refuse to install |
| `MULLION_AGENT_PRIMARY_URL`      | yes, for self-registration                                    | the primary's base URL — written to `.env`'s `MULLION_PRIMARY_URL`                                                                                                                                                                                                                       |
| `MULLION_AGENT_ENROLLMENT_TOKEN` | yes, for self-registration                                    | must match the primary's `MULLION_ENROLLMENT_SECRET` — written to `.env`'s `MULLION_ENROLLMENT_TOKEN`                                                                                                                                                                                    |
| `MULLION_AGENT_ADVERTISE_URL`    | recommended for self-registration                             | this agent's own reachable base URL; see docs/multi-host.md's note on baseUrl uniqueness across a fleet                                                                                                                                                                                  |
| `MULLION_AGENT_NAME`             | optional                                                      | human label in the primary's Hosts list; defaults to hostname                                                                                                                                                                                                                            |
| `MULLION_AGENT_TOKEN`            | yes, for the manual-token path _instead of_ self-registration | a pre-provisioned static token, registered by hand on the primary                                                                                                                                                                                                                        |

`src/app.ts` refuses to boot an agent with neither credential path
configured — an incomplete `.env` fails loudly on first start, not silently.

**Example Ansible role** (self-registration path — the zero-touch flow this
whole feature exists for):

```yaml
# roles/mullion_agent/tasks/main.yml
- name: Allow this user's systemd --user instance to outlive our SSH session
  # Without this, systemd tears down the user manager instance (and
  # everything running under it, including mullion-agent.service) as soon
  # as Ansible's SSH connection to this host closes at the end of the play
  # — and it also won't come back on the next reboot. This is the same
  # requirement any `systemd --user` deploy has (see "Host prerequisites"
  # above); it's just newly load-bearing here because this is the first
  # fully non-interactive, disconnect-immediately deploy path in this repo
  # (independent review, deploy PR #529).
  become: true
  ansible.builtin.command:
    cmd: "loginctl enable-linger {{ ansible_user }}"
  changed_when: true

- name: Clone Mullion
  ansible.builtin.git:
    repo: https://github.com/s3ntin3l8/mullion-session-manager.git
    dest: /home/{{ ansible_user }}/mullion-src
    version: main

- name: Install as a self-registering agent
  # No `creates:` guard: install.sh is already idempotent on every step it
  # runs (reuses an already-downloaded release, leaves an existing .env
  # untouched, always re-installs/re-enables the systemd unit) — gating the
  # whole task on .env alone would skip the systemd-unit step entirely on a
  # re-run after a prior attempt died between writing .env and installing
  # the unit (Hermes review, deploy PR #529). install.sh also already runs
  # `systemctl --user enable --now` itself — no separate task needed for
  # that. There's deliberately no version pinning here either: install.sh
  # always installs whatever GitHub currently reports as "latest," so a
  # periodic/reconverge run of this role DOES pick up new releases (this
  # agent has no in-app "Update now" of its own — see the known limitation
  # below). It is NOT a general config-drift fixer, though: install.sh
  # leaves an existing .env completely untouched (see above), so changing
  # mullion_primary_url/mullion_enrollment_token/MULLION_AGENT_PROJECTS_ROOTS
  # in your role vars and re-running this play silently does nothing —
  # this is the exact zero-touch flow docs/multi-host.md sells token
  # rotation as a real response to a suspected leak on, so don't assume a
  # reconverge alone rotates a compromised enrollment token. To actually
  # change this agent's config, remove its existing .env first (or have
  # this role template .env directly, in which case skip install.sh's own
  # .env generation by pre-creating the file).
  ansible.builtin.command:
    cmd: ./deploy/install.sh --role agent /home/{{ ansible_user }}/opt/mullion
    chdir: /home/{{ ansible_user }}/mullion-src
  environment:
    # PATH must resolve `node`/`npm` non-interactively — Ansible's
    # ansible.builtin.command execs install.sh directly, with no login
    # shell in between, so a purely nvm-managed Node (nvm.sh is sourced
    # only by interactive/login shells) won't be on PATH here even though
    # it would be if you ran install.sh by hand over SSH. Point this at
    # wherever `node`/`npm` actually resolve non-interactively on your
    # image — a system package (recommended for an automated fleet) or the
    # specific nvm-managed version's bin dir.
    PATH: "/usr/bin:/usr/local/bin:{{ ansible_env.PATH }}"
    MULLION_AGENT_PROJECTS_ROOTS: "/home/{{ ansible_user }}/projects"
    MULLION_AGENT_PRIMARY_URL: "{{ mullion_primary_url }}"
    MULLION_AGENT_ENROLLMENT_TOKEN: "{{ mullion_enrollment_token }}"
    # MULLION_AGENT_ADVERTISE_URL: only set this if the agent's hostname
    # isn't already unique across your fleet — see the env contract above.
  no_log: true # this task's `environment:` carries a real secret
```

`mullion_primary_url` and `mullion_enrollment_token` are ordinary
role/group variables — keep the token in your vault
(`ansible-vault`), not committed alongside the playbook. No task on the
primary side is needed at all: `MULLION_ENROLLMENT_SECRET` is set once
there, and every agent booted with the matching
`MULLION_AGENT_ENROLLMENT_TOKEN` self-registers.

**Updating an agent:** as of issue #647 / roadmap 7.8, an agent has its own
self-update surface — see "Layout and updates" above and
[`docs/multi-host.md`](../docs/multi-host.md)'s "Agent updates" section.
Only a host still running a pre-#647 build needs the manual re-run described
there.

## What still needs a real, live check

Milestones 1–3 were each verified end-to-end against the real running app.
M4 can't be fully verified from this repo alone — the actual GO/no-go for it
is a joint step after installing these for real:

- `curl`/a browser **without** an Authentik session gets rejected at
  Traefik, before ever reaching the app.
- With a session, the WS upgrade for `/ws/terminal` succeeds and streams
  data both ways (not just the initial HTTP upgrade handshake — actually
  type into a terminal through the proxy).
- `systemctl --user restart mullion.service` — sessions
  survive (same guarantee M1 already verified against a bare `systemd-run
--user --scope`, now through the real unit).

**Risk 3 — whether a WS upgrade survives Authentik's forwardAuth
redirect/cookie dance through Traefik — is now answered**, from a real
production deployment: yes for the initial upgrade (`/ws/terminal` opens and
stays open through forwardAuth correctly), but **no for a reconnect after
the gateway session has expired**. A WebSocket handshake cannot follow the
3xx a forward-auth gateway issues for an expired session, so `/ws/events`,
`/ws/tasks` and `/ws/github` go silently dark on reconnect and never recover
on their own — `/ws/terminal` is spared mainly because it tends to just stay
open rather than reconnecting. Two related, and separately confirmed,
consequences worth checking for on your own stack:

- The app's frontend precaches its own shell as a PWA (`vite.config.ts`).
  Before this fix, that meant a plain browser refresh after a gateway
  session expired never even reached Traefik — it was served straight from
  the browser's Cache Storage — so the only thing that looked like it
  "fixed" the stuck app was any navigation that happened to bypass the
  cache. That's now excluded from the precache manifest; verify after
  deploying by checking a built `dist/sw.js` has no `index.html` entry.
- Ordinary `/api/*` requests now detect a forward-auth redirect (a
  same-origin-vs-cross-origin distinction — see `frontend/src/api/client.ts`)
  and recover with a top-level reload, which re-runs the forward-auth dance
  for every WS channel too, not just the one that made the failing request.
  Verify by deleting your forward-auth gateway's session cookie (not your
  IdP's core session cookie — see the distinction above) in DevTools and
  reloading: the app should recover on its own within moments, with no
  visible "unreachable" state and no manual visit to your IdP needed.
