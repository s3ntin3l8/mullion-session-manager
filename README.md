<img src="frontend/public/logo.svg" width="40" height="40" alt="Mullion logo" align="left" />

# Mullion

A self-hosted, tiled, persistent browser dashboard for host-run AI CLI
terminals (Claude Code, Codex, opencode, ...). Sessions run on the host under
`dtach`, so closing the browser tab never kills them — the dashboard is a thin
attach-client, not the process owner.

Backend: [Fastify](https://fastify.dev/) + TypeScript (ESM) +
SQLite/[Drizzle](https://orm.drizzle.team/), with security middleware and full
CI/CD. Frontend: React + [dockview](https://dockview.dev/) (tiled splits/tabs)

- [xterm.js](https://xtermjs.org/).

## ✨ Features

- **Tiled.** A dockview-based split/tab layout turns the browser into mission
  control for however many terminals you're running at once — drag, split,
  and save named/grouped workspace layouts instead of juggling browser tabs.
- **Persistent.** Every session is a host PTY attached via `dtach`, running
  inside a transient `systemd --user` scope. Sessions survive redeploys,
  service restarts, and closed browser tabs — the dashboard reattaches to
  what's already running rather than owning the process.
- **Mission control.** One dashboard for every host-run AI CLI: a
  command-palette launcher with official CLI logos, project discovery, a
  per-project dock (see [`docs/dock.md`](docs/dock.md)) with branch/worktree
  selection and optional live-sync preview worktrees, and session status
  signals (exited detection, activity/attention) so you always know what's
  running and what needs you.
- **Multi-host.** Run sessions on more than one machine from a single
  dashboard — every other machine runs the same Mullion build, just started
  as an `agent` instead of the `primary`. See
  [`docs/multi-host.md`](docs/multi-host.md) for setup.
- **Browser previews.** Open a project's dev server — or any external URL —
  in a dockview panel next to your terminals, with working HMR, proxied
  same-origin so it isn't blocked as mixed content. Mullion also notices a
  dev server started by hand in a plain terminal and offers to wire it into
  the preview. See [`docs/browser-previews.md`](docs/browser-previews.md)
  for setup.
- **Browser automation & control.** Drive a project's Playwright-controlled
  Chromium browser programmatically via a REST API (navigate, click, fill,
  eval, snapshot, screenshot) or stream its interactive display over WebSockets.
  Import cookie profiles from Chrome/Firefox to start authenticated. See
  [`docs/browser-automation.md`](docs/browser-automation.md) for details.
- **GitHub integration.** Connect a PAT or GitHub OAuth device flow once,
  and any project with a github.com `origin` gets a Dock status widget and
  panel for open issues/PRs and Actions/CI status — with optional webhook-
  driven real-time CI updates, plus an opt-in GitHub App for repo-scoped,
  short-lived installation tokens on Task Master's own writes (see
  [`docs/github-integration.md`](docs/github-integration.md)).
- **Task Master.** Turn a labeled GitHub issue — or a task created directly
  on the board — into an autonomously-worked, reviewed, and promoted pull
  request: an agent claims it into an isolated worktree, works it, and a
  human decides whether to approve or send it back, with a configurable
  concurrency cap, time budget, and pause switch. Ingest is poll-driven by
  default, with optional webhook-driven ingest for near-real-time pickup.
  See [`docs/tasks.md`](docs/tasks.md) for the full design.
- **Optional in-process auth.** A shared-token gate and/or native OIDC login
  (e.g. against Authentik) — either or both, off by default, composable
  with (not a replacement for) an external forwardAuth gateway. See
  [`docs/auth.md`](docs/auth.md) for setup.
- **Persistent, queryable session history (opt-in).** Turn on
  Settings' event-persistence toggle to mirror notification events to a
  durable `session_events` table (with configurable retention), queryable
  via `GET /api/events`, the control socket's `events.query` op, or
  `mullion history` — primary-local only for now (see
  [`docs/socket-api.md`](docs/socket-api.md)/[`docs/cli.md`](docs/cli.md)).
  A frontend search/filter UI is a planned follow-up, not yet built.

> **Status:** the backend is feature-complete for projects, durable sessions,
> named/grouped workspace layouts, project discovery, unified launchers
> (shell/agent/`.crs`-config actions), per-project dock controls, session
> status signals (exited detection, activity/attention), multi-host session
> routing (see [`docs/multi-host.md`](docs/multi-host.md)), same-origin
> browser previews of dev servers/external URLs with HMR (see
> [`docs/browser-previews.md`](docs/browser-previews.md)), GitHub
> integration for per-project issue/PR/CI status, including webhook-driven
> real-time CI updates (see
> [`docs/github-integration.md`](docs/github-integration.md)), and Task
> Master — autonomous claim/work/review/promote of GitHub-issue or
> locally-created tasks, with a unified task/session Kanban board and live
> `/ws/tasks` updates (see [`docs/tasks.md`](docs/tasks.md)). The frontend
> now surfaces all of it — a tiled terminal UI (dockview splits/tabs), a
> command-palette launcher with official CLI logos, workspace groups with
> drag-to-reorder, a per-project dock (including branch/worktree
> management, see [`docs/git-panel.md`](docs/git-panel.md)), session status
> badges, a browser preview panel, a GitHub status widget, a unified
> Kanban board, and a Settings panel (including host management and
> integrations) — and is under active polish, not frozen. Auth is now optional and in-process, not only gateway-delegated —
> a shared-token gate and/or native OIDC login, either or both, off by
> default and composable with, not a replacement for, an external Traefik +
> Authentik forwardAuth gateway; see [`docs/auth.md`](docs/auth.md). Native
> deployment (systemd/Traefik/Authentik) is fully supported and documented
> under `deploy/` — see `deploy/README.md`.

## 🚀 Quick Start

```bash
make install          # install backend dependencies
cp .env.example .env  # configure environment (optional; defaults work)
make dev              # start the backend dev server (reload via tsx watch)
```

Then, for the frontend (separate Vite dev server, proxies `/api` and `/ws` to
the backend):

```bash
cd frontend && npm install && npm run dev
```

Backend API smoke test:

```bash
curl localhost:3000/health
curl localhost:3000/ready
curl -X POST localhost:3000/api/projects -H 'content-type: application/json' \
  -d '{"name":"my-project","cwd":"/home/me/projects/my-project"}'
curl localhost:3000/api/projects
```

## 📁 Structure

- `src/app.ts` — the app factory (`buildApp()`); registers plugins then routes.
- `src/plugins/` — `env` (validated config), `logging`, `security` (helmet,
  rate-limit, CORS, and the preview subdomains' `frame-src` CSP entry), `db`
  (migrations + `app.db`/`app.encryption` decorators), `pty` (`app.pty`
  session manager + periodic exited-session reconciler), `websocket`, `auth`
  (optional in-process auth — a global `onRequest` hook covering every
  `/api/*` route and every `/ws/*` upgrade (`/ws/terminal`, `/ws/events`,
  `/ws/github`, `/ws/tasks`); inert until
  `MULLION_AUTH_TOKEN` or `MULLION_OIDC_*` is set — see
  [`docs/auth.md`](docs/auth.md)), `static` (serves the
  built frontend once it exists), `preview-proxy` (the subdomain reverse
  proxy + HMR websocket proxying for browser previews — see
  [`docs/browser-previews.md`](docs/browser-previews.md); fully inert until
  `PREVIEW_BASE_HOST` is set), `hooks` (`app.hookServer` — the Phase 2 agent
  hook socket, `MULLION_HOOK_SOCKET` injected per-session, plus
  `app.resolveHookGate` for the minimal review gate's decision round-trip;
  see [`docs/agent-hooks.md`](docs/agent-hooks.md)), `control-socket`
  (`app.controlServer` — the Phase 4 general-purpose control socket behind
  the `mullion` CLI; dispatches by re-entering the routes below via
  `app.inject()` rather than duplicating their logic — see
  [`docs/socket-api.md`](docs/socket-api.md)).
- `src/routes/` — `health` (`/health`, `/ready`), `auth` (`/api/auth/login`,
  `/logout`, `/me`, and `/oidc/login`, `/oidc/callback` — see
  [`docs/auth.md`](docs/auth.md)), `root` (placeholder `/`, disabled once
  the frontend build exists — template-inherited), `projects` (CRUD +
  discovery + per-project actions/dock), `sessions` (durable terminal
  sessions, including `POST /api/sessions/:id/review-gate` — the minimal
  review gate's decision endpoint, see
  [`docs/agent-hooks.md`](docs/agent-hooks.md)), `workspaces`
  (named/grouped saved layouts), `groups` (workspace
  groups), `agents` (installed shell/AI-CLI detection), `actions` (global
  launcher presets), `server-info` (`GET /api/server-info`, read-only
  diagnostics for Settings → Server info), `terminal` (`/ws/terminal` PTY
  bridge), `hosts` (remote-host registry for multi-host sessions), `internal`
  (an `agent` process's token-gated API, called by a `primary`'s host
  routing — including its own `POST /internal/sessions/:id/review-gate`, so
  a review-gate decision reaches whichever host actually holds the pending
  hook connection), `integrations` (GitHub PAT/device-flow/GitHub-App connect + webhook toggle/management
  — see
  [`docs/github-integration.md`](docs/github-integration.md)), `webhooks`
  (`/api/webhooks/github` — the HMAC-verified webhook handler, including
  Task Master's webhook-driven ingest), `ws-github`
  (`/ws/github` — real-time event push to connected frontends), `previews`
  (list/create/read/delete browser previews — see
  [`docs/browser-previews.md`](docs/browser-previews.md)), `events`
  (`/ws/events` — the live notification-event stream, plus `GET
/api/events`, issue #213's opt-in persisted-history query — see
  [`docs/socket-api.md`](docs/socket-api.md)), `tasks` (Task Master's CRUD +
  claim/approve/reject/retry/give-up endpoints — see
  [`docs/tasks.md`](docs/tasks.md)), `ws-tasks` (`/ws/tasks` — live
  task-transition push, see [`docs/tasks.md`](docs/tasks.md)), `skills`
  (per-agent Skill enable/disable), `agent-rules` (per-agent rule-file
  read/write), `settings` (the runtime Settings-override store backing
  Task Master's safety envelope and other deploy-time-default overrides),
  `updates` (Settings → Server info's "Update now" flow),
  `browser`/`browser-automation`/`browser-cookies`/`browser-urls` (the
  Playwright browser-control REST surface and cookie-profile import — see
  [`docs/browser-automation.md`](docs/browser-automation.md)),
  `project-urls` (per-project saved external-URL shortcuts).
- `src/services/` — `pty-manager` (dtach/node-pty session lifecycle),
  `project-config` (layered `.crs/actions.json`/`dock.json` + `package.json`/
  `tasks.json` resolution), `agent-detect`, `attention-detect` (BEL/OSC
  parsing), `session-reconciler`, `event-history` (query/insert/retention
  logic behind issue #213's opt-in persisted session-event history — see
  `src/plugins/event-store.ts`), `encryption` (AES-256-GCM), `date-utils`,
  `host-registry`/`remote-host-client`/`session-backend` (multi-host routing
  — see [`docs/multi-host.md`](docs/multi-host.md)), `github`/
  `github-integration`/`github-device-flow`/`git-remote`/`github-webhook`/
  `github-pr-poller`/`github-activity-tracker`/`github-ws-broadcast`/
  `github-app`/`github-write` (GitHub status + connect flows + webhook
  registration + adaptive polling + WS push + GitHub App installation-token
  minting + the write-side API client Task Master's sync/promote use —
  see
  [`docs/github-integration.md`](docs/github-integration.md)),
  `task-state`/`task-claim`/`task-github-sync`/`task-promote`/
  `task-reconciler`/`task-watcher`/`task-events`/`task-config`/
  `task-agent-resolve` (Task Master: the transition table and live
  `/ws/tasks` broadcast, claim, GitHub sync, PR promotion, the reconciler
  that drives autonomous progress, the poll/webhook ingest watcher, runtime
  Settings-override config, and worker/review agent resolution — see
  [`docs/tasks.md`](docs/tasks.md)), `git-worktree` (per-task worktree
  create/remove/prune, including the boot-time orphan sweep and remote-host
  proxying — see [`docs/tasks.md`](docs/tasks.md)),
  `preview-registry`/`preview-host`/`http-proxy`/`dev-server-detect`/
  `url-guard` (browser previews + their SSRF guards — see
  [`docs/browser-previews.md`](docs/browser-previews.md)), `hook-protocol`
  (Phase 2 hook message validation) + `hook-adapters/` (per-agent hook
  auto-injection at spawn — Claude Code, OpenCode, Codex, and agy; Codex's
  and agy's are both managed merges into the user's real `~/.codex/
hooks.json` / `~/.gemini/config/hooks.json`, not ephemeral like Claude
  Code/OpenCode — Codex's own hook-trust model and `CODEX_HOME`'s
  all-or-nothing scope rule out an ephemeral injection there; agy has no
  documented env var to relocate its config at all — see
  [`docs/agent-hooks.md`](docs/agent-hooks.md)).
- `src/hooks/` — plain-JavaScript (not TypeScript) files loaded directly by
  an agent's own hook runner or plugin loader, not imported by the server
  process: `forwarder.mjs` bridges a shell-command-hook agent's stdin JSON
  to the hook socket (`forwarder-core.mjs` holds its pure, unit-tested
  per-agent mapping logic); `opencode-plugin.js` is OpenCode's own bridge,
  auto-injected via `OPENCODE_CONFIG_DIR` (OpenCode has no shell-command
  hooks, only a JS/TS plugin API). Copied byte-for-byte into `dist/hooks/`
  by `make build`.
- `src/cli/` — the `mullion` CLI (Phase 4, #134): `mullion.mjs` is a thin,
  spawned `#!/usr/bin/env node` entry point (plain JavaScript, same
  dev/prod-parity reasoning as `src/hooks/`, copied byte-for-byte into
  `dist/cli/` by `make build`); a versioned install symlinks it at
  `~/.local/bin/mullion` (`deploy/install.sh`) — `package.json`'s `"bin"`
  field is documentary only (`npm ci --omit=dev` never links a root
  package's own bin). The actual arg parsing/command table (`core.mjs`)
  and control-socket client (`client.mjs`) are imported, not spawned, so
  they're unit-tested and count toward the coverage floor. See
  [`docs/cli.md`](docs/cli.md).
- `src/db/` — Drizzle schema, client, seed. Migrations live in `drizzle/`.
- `frontend/` — standalone Vite + React + TypeScript app (own
  `package.json`/tsconfig/eslint); dockview-based tiled terminal UI.
- `deploy/` — systemd `--user` unit + Traefik/Authentik config templates
  (fully supported native host deployment — see `deploy/README.md`).
- `docs/` — deep-dive docs for specific subsystems:
  [`dock.md`](docs/dock.md),
  [`git-panel.md`](docs/git-panel.md) (branch/worktree management from the
  Dock, issue #442),
  [`multi-host.md`](docs/multi-host.md),
  [`browser-previews.md`](docs/browser-previews.md),
  [`browser-automation.md`](docs/browser-automation.md),
  [`github-integration.md`](docs/github-integration.md),
  [`tasks.md`](docs/tasks.md) (Task Master: lifecycle, agent selection,
  safety envelope, GitHub sync, worktree lifecycle),
  [`roadmap.md`](docs/roadmap.md) (phase-by-phase design history and
  architecture decisions),
  [`auth.md`](docs/auth.md),
  [`agent-hooks.md`](docs/agent-hooks.md),
  [`socket-api.md`](docs/socket-api.md),
  [`cli.md`](docs/cli.md),
  [`agent-guide.md`](docs/agent-guide.md) (issue #405 — the agent-facing
  skill/guide doc, auto-injected into Claude Code sessions at `SessionStart`).

## 🔧 Configuration

All config is validated at startup by `@fastify/env` (see `src/plugins/env.ts`).

| Variable                                | Default              | Description                                                                                                                                                                                                  |
| --------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                              | `development`        | `development` \| `production` \| `test`                                                                                                                                                                      |
| `PORT`                                  | `3000`               | HTTP listen port                                                                                                                                                                                             |
| `LOG_LEVEL`                             | `info`               | pino log level                                                                                                                                                                                               |
| `DATABASE_URL`                          | `file:./data/app.db` | SQLite `file:` URL                                                                                                                                                                                           |
| `DB_ENCRYPTION_KEY`                     | _(empty)_            | base64url 32-byte key; enables encryption-at-rest                                                                                                                                                            |
| `CORS_ORIGIN`                           | _(empty)_            | comma-separated allowlist; empty disables CORS                                                                                                                                                               |
| `RATE_LIMIT_MAX`                        | `100`                | max requests per window                                                                                                                                                                                      |
| `RATE_LIMIT_WINDOW`                     | `1 minute`           | rate-limit window                                                                                                                                                                                            |
| `SESSIONS_DIR`                          | `./data/sessions`    | dir holding one dtach socket per terminal session                                                                                                                                                            |
| `FRONTEND_DIST`                         | `./frontend/dist`    | built frontend assets; served at `/` once present                                                                                                                                                            |
| `PROJECTS_ROOTS`                        | _(empty)_            | comma-separated dirs to scan for `GET /api/projects/discover`                                                                                                                                                |
| `CRS_CONFIG_DIR`                        | `~/.config/crs`      | global launcher/dock config dir (a project's own `.crs/` wins)                                                                                                                                               |
| `MULLION_ROLE`                          | `primary`            | `primary` \| `agent` — see [`docs/multi-host.md`](docs/multi-host.md); `agent` is a DB-less process that only runs PtyManager locally                                                                        |
| `MULLION_AGENT_TOKEN`                   | _(empty)_            | shared secret an `agent` process's internal API requires on every request; not needed on an agent that self-registers (see `MULLION_PRIMARY_URL` below) — see [`docs/multi-host.md`](docs/multi-host.md)     |
| `MULLION_PRIMARY_URL`                   | _(empty)_            | `agent`-side: base URL of the primary to self-register with; requires `MULLION_ENROLLMENT_TOKEN` too — see [`docs/multi-host.md`](docs/multi-host.md)                                                        |
| `MULLION_ENROLLMENT_TOKEN`              | _(empty)_            | `agent`-side: bootstrap credential presented to `POST /api/internal/register`; used once per boot, never as an inbound credential — see [`docs/multi-host.md`](docs/multi-host.md)                           |
| `MULLION_AGENT_ADVERTISE_URL`           | _(empty)_            | `agent`-side: `baseUrl` this agent reports at registration; falls back to `http://<hostname>:<PORT>`                                                                                                         |
| `MULLION_AGENT_NAME`                    | _(empty)_            | `agent`-side: human label for this host in the primary's Hosts list; falls back to the reported hostname                                                                                                     |
| `MULLION_ENROLLMENT_SECRET`             | _(empty)_            | `primary`-side: fleet-wide secret that lets an agent enroll as a brand-new host; empty disables enrollment (pre-provisioned claim registration still works) — see [`docs/multi-host.md`](docs/multi-host.md) |
| `MULLION_ENROLLMENT_ALLOWED_CIDRS`      | _(empty)_            | `primary`-side: comma-separated CIDRs; when set, additionally restricts which peer IPs may enroll a brand-new host (never affects claim registration)                                                        |
| `HOST_HEARTBEAT_INTERVAL_SECONDS`       | `30`                 | seconds between the primary's liveness sweeps of every registered remote host's `/health` route; `0` disables the poller — see [`docs/multi-host.md`](docs/multi-host.md)                                    |
| `MULLION_AUTH_TOKEN`                    | _(empty)_            | shared token gating every `/api/*` route + `/ws/terminal`; empty disables in-process auth entirely — see [`docs/auth.md`](docs/auth.md)                                                                      |
| `MULLION_SESSION_SECRET`                | _(empty)_            | signs the session cookie; required whenever `MULLION_AUTH_TOKEN` or `MULLION_OIDC_*` is set (boot refuses otherwise) — see [`docs/auth.md`](docs/auth.md)                                                    |
| `MULLION_OIDC_ISSUER`                   | _(empty)_            | OIDC discovery/issuer URL; all four `MULLION_OIDC_*` keys must be set together — see [`docs/auth.md`](docs/auth.md)                                                                                          |
| `MULLION_OIDC_CLIENT_ID`                | _(empty)_            | OIDC client id                                                                                                                                                                                               |
| `MULLION_OIDC_CLIENT_SECRET`            | _(empty)_            | OIDC client secret (confidential client — this process does the code exchange server-side)                                                                                                                   |
| `MULLION_OIDC_REDIRECT_URI`             | _(empty)_            | must exactly match a redirect URI registered at the provider, e.g. `https://mullion.example.com/api/auth/oidc/callback`                                                                                      |
| `MULLION_REVIEW_GATE_ENABLED`           | `false`              | enables Claude Code's blocking `PreToolUse` review gate on Bash (issue #178); off by default since an unattended session has nobody to approve/deny it — see [`docs/agent-hooks.md`](docs/agent-hooks.md)    |
| `GITHUB_OAUTH_CLIENT_ID`                | _(empty)_            | GitHub OAuth App client id; enables the device-flow "Connect with GitHub" button — see [`docs/github-integration.md`](docs/github-integration.md). PAT connect works with no client id at all                |
| `MULLION_TASK_MASTER_ENABLED`           | `false`              | deploy-time default for autonomous Task Master behavior (GitHub ingest, auto-claim, claim/approve/retry); runtime-overridable from Settings → Task Master — see [`docs/tasks.md`](docs/tasks.md)             |
| `MULLION_TASK_LABEL`                    | `mullion-task`       | GitHub issue label the task watcher polls/ingests for; env-only (changing it mid-flight would orphan already-labeled issues) — see [`docs/tasks.md`](docs/tasks.md)                                          |
| `MULLION_TASK_POLL_INTERVAL`            | `60`                 | seconds between task-watcher poll sweeps; env-only (a GitHub rate-limit tradeoff) — see [`docs/tasks.md`](docs/tasks.md)                                                                                     |
| `MULLION_TASK_MAX_CONCURRENT`           | `2`                  | install-wide cap on tasks `claimed`/`in_progress` at once; Settings-overridable — see [`docs/tasks.md`](docs/tasks.md)                                                                                       |
| `MULLION_TASK_BUDGET_MINUTES`           | `120`                | wall-clock minutes before the reconciler force-fails a stuck claim; `0` = unlimited; Settings-overridable — see [`docs/tasks.md`](docs/tasks.md)                                                             |
| `MULLION_TASK_PROGRESS_COMMENT_MINUTES` | `15`                 | minimum minutes between two `in_progress` progress comments on the same linked issue; `0` = no throttle; Settings-overridable — see [`docs/tasks.md`](docs/tasks.md)                                         |
| `MULLION_WEBHOOK_BASE_URL`              | _(empty)_            | public `https://` base URL GitHub POSTs webhook events to; empty disables webhook support (polling stays active as the fallback) — see [`docs/github-integration.md`](docs/github-integration.md)            |
| `MULLION_WEBHOOK_SECRET`                | _(empty)_            | HMAC-SHA256 secret for webhook payload verification; auto-generated and persisted if unset on first enable — see [`docs/github-integration.md`](docs/github-integration.md)                                  |
| `GITHUB_POLL_INTERVAL_ACTIVE`           | `15`                 | seconds between adaptive GitHub poller ticks while a repo has open PRs or running CI — see [`docs/github-integration.md`](docs/github-integration.md)                                                        |
| `GITHUB_POLL_INTERVAL_QUIET`            | `60`                 | seconds between adaptive GitHub poller ticks while no repo has open PRs or running CI — see [`docs/github-integration.md`](docs/github-integration.md)                                                       |
| `GITHUB_POLL_STALE_THRESHOLD`           | `300`                | seconds without a webhook delivery before the poller enters stalled mode — see [`docs/github-integration.md`](docs/github-integration.md)                                                                    |
| `PREVIEW_BASE_HOST`                     | _(empty)_            | base host for browser preview subdomains (`preview-<slug>.<host>`); empty disables the feature entirely — see [`docs/browser-previews.md`](docs/browser-previews.md)                                         |
| `PREVIEW_AUTH_REQUIRED`                 | `false`              | requires a bootstrap token/preview cookie (issue #383) before proxying a preview-host request, on top of any gateway forwardAuth; requires `MULLION_SESSION_SECRET` — see [`docs/auth.md`](docs/auth.md)     |
| `MULLION_SOCKET_PATH`                   | _(empty)_            | path for the Phase 4 control socket (the `mullion` CLI's transport); empty derives it from `SESSIONS_DIR` — see [`docs/socket-api.md`](docs/socket-api.md)                                                   |

Generate an encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## 🛠️ Commands

Backend (repo root):

- `make dev` — dev server with reload
- `make test` / `make test-coverage` — Vitest suite
- `make test-e2e` — opt-in Phase 4 socket API e2e suite (real Unix sockets, a
  real spawned `mullion` CLI process, a real Chromium); not part of `make
test` or CI — see [`test/e2e/README.md`](test/e2e/README.md)
- `make lint` / `make typecheck` — ESLint / `tsc`
- `make build` — production build to `dist/`
- `npm run db:generate` — generate a migration from schema changes
- `npm run db:migrate` — apply migrations (also run automatically at startup)
- `npm run db:seed` — seed initial data

Frontend (`frontend/`):

- `npm run dev` — Vite dev server (proxies `/api`, `/ws` to the backend)
- `npm run build` — production build to `frontend/dist`
- `npm run lint` / `npm run typecheck`

`mullion` CLI (Phase 4, #134 — see [`docs/cli.md`](docs/cli.md)):

- A versioned install links it at `~/.local/bin/mullion`
  (`deploy/install.sh`); from a source checkout, run it directly:
  `node src/cli/mullion.mjs <command>`.
- Session lifecycle, the full browser-automation surface, project/preview/
  dock management, event tailing, and notifications — all over the same
  local Unix control socket the frontend itself talks to
  ([`docs/socket-api.md`](docs/socket-api.md)), no HTTP base URL or bearer
  token required when run from inside a session.

## 🛡️ Security

- `@fastify/helmet` (security headers), `@fastify/rate-limit`, and
  `@fastify/cors` are wired into every app via `src/plugins/security.ts`.
- Optional AES-256-GCM encryption-at-rest via `DB_ENCRYPTION_KEY` (see the
  `users.notes` column for an example).
- CodeQL scanning and dependency review run in CI; `detect-secrets` runs
  pre-commit. Follows the
  [s3ntin3l8 Global Security Policy](https://github.com/s3ntin3l8/.github/blob/main/SECURITY.md).

## 🚢 Deploy

Mullion runs **natively on the host** under `systemd --user`, not in a
container — the app shells out to `systemd-run`/`systemctl` and `dtach` to
keep terminal sessions alive across redeploys, which a container lifecycle
can't guarantee. There is no Docker image; `deploy/install.sh` bootstraps a
fresh host into a versioned-release layout (fed by a CI-built release
tarball) with a `systemd --user` unit, and updates after that go through the
in-app Settings → Server info "Update now" button. `deploy/` also has a
Traefik dynamic-config router and an Authentik forwardAuth reference — see
`deploy/README.md` for the full layout and install steps.

## 📦 Releases

Automated via [Release Please](https://github.com/googleapis/release-please).
Use [Conventional Commits](https://www.conventionalcommits.org/) to trigger
version bumps.

## 🙏 Credits

The session launcher's CLI logos are sourced from
[homarr-labs/dashboard-icons](https://github.com/homarr-labs/dashboard-icons)
(Apache-2.0) and [lobehub/lobe-icons](https://github.com/lobehub/lobe-icons)
(MIT) — see
[`frontend/src/assets/cli-logos/ATTRIBUTION.md`](frontend/src/assets/cli-logos/ATTRIBUTION.md)
for full attribution and license texts.
