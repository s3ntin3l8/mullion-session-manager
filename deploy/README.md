# Deployment

These files are **templates, not live config** — nothing here is installed,
enabled, or applied by anything in this repo or its CI. See the pivotal
architecture decision in
[`.claude/plans/ok-i-m-thinking-of-merry-corbato.md`](../.claude/plans/ok-i-m-thinking-of-merry-corbato.md):
the app runs **natively on the host** under `systemd --user`, not in the
Docker image CI builds and pushes — containerizing it would mean every
redeploy kills every live terminal session.

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
