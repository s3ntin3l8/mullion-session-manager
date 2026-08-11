# Documentation index

Start at the repo root [`README.md`](../README.md) for the pitch, quick
start, and feature list. Everything below is deep-dive material, grouped by
when you'd reach for it.

## Using Mullion

- [`dock.md`](dock.md) — per-project dock: launchers, `dock.json`, Docker
  Compose service discovery, dev-server port auto-detection.
- [`git-panel.md`](git-panel.md) — branch and worktree management from the
  Dock: delete a branch, remove a worktree, prune stale metadata.
- [`browser-previews.md`](browser-previews.md) — embed a project's dev
  server or an external URL in-dashboard, with working HMR.
- [`browser-automation.md`](browser-automation.md) — drive a project's
  Playwright-controlled Chromium programmatically or watch it live.
- [`github-integration.md`](github-integration.md) — connect a repo for
  issue/PR/CI status, webhook-driven real-time updates, and the optional
  GitHub App.
- [`tasks.md`](tasks.md) — Task Master: turn a labeled issue (or a
  dashboard-created task) into an autonomously-worked, reviewed, and
  promoted pull request.
- [`multi-host.md`](multi-host.md) — run sessions on more than one machine
  from a single dashboard.

## Operating it

- [`configuration.md`](configuration.md) — every environment variable, in
  one place; the source every other doc's config section links to.
- [`auth.md`](auth.md) — the optional shared-token gate and native OIDC
  login, and how they compose with an external forwardAuth gateway.
- [`../deploy/README.md`](../deploy/README.md) — native `systemd --user`
  install, updates, and the Traefik/Authentik reference config.

## Extending and automating

- [`cli.md`](cli.md) — the `mullion` CLI: session lifecycle, browser
  automation, event tailing, notifications — all over the control socket.
- [`socket-api.md`](socket-api.md) — the control socket's wire protocol,
  for anything talking to it directly instead of through the CLI.
- [`agent-hooks.md`](agent-hooks.md) — the per-session hook socket that
  lets a running agent talk back to Mullion, and how it's auto-injected
  per agent CLI.
- [`agent-guide.md`](agent-guide.md) — the agent-facing guide auto-injected
  into a session at `SessionStart`; read this if you're an agent CLI
  running inside a Mullion-managed session.

## Background

- [`architecture.md`](architecture.md) — the plugins/routes/services tour:
  what lives where.
- [`roadmap.md`](roadmap.md) — phase-by-phase design history and
  architecture decisions. Mostly a historical record, not a forward-looking
  plan — see its own opening note.
