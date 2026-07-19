# Deployment

These files are **templates, not live config** — nothing here is installed,
enabled, or applied by anything in this repo or its CI. The pivotal
architecture decision: the app runs **natively on the host** under
`systemd --user`, not in the Docker image CI builds and pushes —
containerizing it would mean every redeploy kills every live terminal
session.

## Files

- `claude-remote-session.service` — `systemd --user` unit that runs
  `node dist/server.js` directly on the host.
- `traefik-dynamic.yml` — Traefik dynamic (file provider) router + service
  pointing at the app's local port.
- `authentik-middleware-example.yml` — reference only; you almost certainly
  already have a forwardAuth middleware defined and just need to reference
  its existing name in `traefik-dynamic.yml`, not create a new one.

## Before installing anything

Three placeholders need real values only you have:

1. **Hostname** this dashboard should answer on (`traefik-dynamic.yml`'s
   `Host()` rule).
2. **Your existing Authentik forwardAuth middleware's reference**
   (`name@provider`, e.g. `authentik@file`) to put in `traefik-dynamic.yml`'s
   `middlewares:` list.
3. **Your Traefik dynamic-config directory path**, so `traefik-dynamic.yml`
   ends up somewhere Traefik's file provider actually watches.

Also fill in the `CHANGEME` paths in `claude-remote-session.service`
(repo checkout path, nvm-managed node binary path, `.env` location).

## Optional: in-dashboard previews (issue #28)

See also [`docs/browser-previews.md`](../docs/browser-previews.md) for the
feature overview (including its worked example for a `tessera.s3ntin3l8.de`-
style deployment); this section covers only the production deploy side.

The browser pane itself (a project's dev server, or an arbitrary external
URL, opening in-dashboard) works with **no deploy changes at all** — with
`PREVIEW_BASE_HOST` unset (the default), it embeds the target directly, no
proxy involved. `PREVIEW_BASE_HOST` (`.env.example`) instead turns on the
**subdomain proxy** on top of that: previews move to
`preview-<slug>.<PREVIEW_BASE_HOST>`, needed once Tessera itself is served
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
  primary or a leaked `TESSERA_AGENT_TOKEN` can only reach ports on the
  agent's own loopback through this path, not pivot into the agent's LAN.
- **External-URL previews (issue #28 phase 5) accept a real, documented
  SSRF surface** — `src/services/url-guard.ts` blocks IP-literal
  loopback/private/link-local/cloud-IMDS targets at creation time, but
  doesn't resolve hostnames, so a DNS-rebinding attacker (a hostname that
  resolves to a public IP at validation time and a private one at request
  time) isn't defended against today; the guard's own comments call this
  out as an accepted, known gap rather than an oversight.

## Install steps (manual — not automated by this repo)

```sh
# 1. systemd --user unit
mkdir -p ~/.config/systemd/user
cp deploy/claude-remote-session.service ~/.config/systemd/user/
# edit the CHANGEME placeholders first
systemctl --user daemon-reload
systemctl --user enable --now claude-remote-session.service
systemctl --user status claude-remote-session.service

# 2. Traefik dynamic config
# edit the CHANGEME placeholders first
cp deploy/traefik-dynamic.yml <your-traefik-dynamic-config-dir>/
# Traefik's file provider picks it up automatically (watch or poll,
# depending on your config) — no Traefik restart should be needed.
```

## What still needs a real, live check

Milestones 1–3 were each verified end-to-end against the real running app.
M4 can't be: the one thing that actually matters here — **whether a WS
upgrade request survives Authentik's forwardAuth redirect/cookie dance all
the way through Traefik** (Risk 3 in the plan) — only exists once this is
installed against your real Traefik/Authentik stack. Everything above this
line is "drafted and the Docker image builds cleanly"; the actual GO/no-go
for M4 is a joint step after installing these for real:

- `curl`/a browser **without** an Authentik session gets rejected at
  Traefik, before ever reaching the app.
- With a session, the WS upgrade for `/ws/terminal` succeeds and streams
  data both ways (not just the initial HTTP upgrade handshake — actually
  type into a terminal through the proxy).
- `systemctl --user restart claude-remote-session.service` — sessions
  survive (same guarantee M1 already verified against a bare `systemd-run
--user --scope`, now through the real unit).
