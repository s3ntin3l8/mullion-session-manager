<img src="frontend/public/logo.svg" width="40" height="40" alt="Tessera logo" align="left" />

# Tessera

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
  per-project dock, and session status signals (exited detection,
  activity/attention) so you always know what's running and what needs you.
- **Multi-host.** Run sessions on more than one machine from a single
  dashboard — every other machine runs the same Tessera build, just started
  as an `agent` instead of the `primary`. See
  [`docs/multi-host.md`](docs/multi-host.md) for setup.
- **Browser previews.** Open a project's dev server — or any external URL —
  in a dockview panel next to your terminals, with working HMR, proxied
  same-origin so it isn't blocked as mixed content. See
  [`docs/browser-previews.md`](docs/browser-previews.md) for setup.
- **GitHub integration.** Connect a PAT or GitHub OAuth device flow once,
  and any project with a github.com `origin` gets a Dock status widget and
  panel for open issues/PRs and Actions/CI status. See
  [`docs/github-integration.md`](docs/github-integration.md).

> **Status:** the backend is feature-complete for projects, durable sessions,
> named/grouped workspace layouts, project discovery, unified launchers
> (shell/agent/`.crs`-config actions), per-project dock controls, session
> status signals (exited detection, activity/attention), multi-host session
> routing (see [`docs/multi-host.md`](docs/multi-host.md)), same-origin
> browser previews of dev servers/external URLs with HMR (see
> [`docs/browser-previews.md`](docs/browser-previews.md)), and GitHub
> integration for per-project issue/PR/CI status (see
> [`docs/github-integration.md`](docs/github-integration.md)). The frontend
> now surfaces all of it — a tiled terminal UI (dockview splits/tabs), a
> command-palette launcher with official CLI logos, workspace groups with
> drag-to-reorder, a per-project dock, session status badges, a browser
> preview panel, a GitHub status widget, and a Settings panel (including
> host management and integrations) — and is under active polish, not
> frozen. Not yet built: any in-app auth (access is delegated to the
> external Traefik + Authentik forwardAuth, by design). Native deployment
> (systemd/Traefik/Authentik) is drafted under `deploy/` but not yet
> installed anywhere — see `deploy/README.md`.

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
  session manager + periodic exited-session reconciler), `websocket`,
  `static` (serves the built frontend once it exists), `preview-proxy` (the
  subdomain reverse proxy + HMR websocket proxying for browser previews —
  see [`docs/browser-previews.md`](docs/browser-previews.md); fully inert
  until `PREVIEW_BASE_HOST` is set).
- `src/routes/` — `health` (`/health`, `/ready`), `users` (template-inherited
  example CRUD), `root` (placeholder `/`, disabled once the frontend build
  exists — also template-inherited), `projects` (CRUD + discovery +
  per-project actions/dock), `sessions` (durable terminal sessions),
  `workspaces` (named/grouped saved layouts), `groups` (workspace groups),
  `agents` (installed shell/AI-CLI detection), `actions` (global launcher
  presets), `server-info` (`GET /api/server-info`, read-only diagnostics for
  Settings → Server info), `terminal` (`/ws/terminal` PTY bridge), `hosts`
  (remote-host registry for multi-host sessions), `internal` (an `agent`
  process's token-gated API, called by a `primary`'s host routing),
  `integrations` (GitHub PAT/device-flow connect — see
  [`docs/github-integration.md`](docs/github-integration.md)), `previews`
  (create/read/delete browser previews — see
  [`docs/browser-previews.md`](docs/browser-previews.md)).
- `src/services/` — `pty-manager` (dtach/node-pty session lifecycle),
  `project-config` (layered `.crs/actions.json`/`dock.json` + `package.json`/
  `tasks.json` resolution), `agent-detect`, `attention-detect` (BEL/OSC
  parsing), `session-reconciler`, `encryption` (AES-256-GCM), `date-utils`,
  `host-registry`/`remote-host-client`/`session-backend` (multi-host routing
  — see [`docs/multi-host.md`](docs/multi-host.md)), `github`/
  `github-integration`/`github-device-flow`/`git-remote` (GitHub status +
  connect flows — see
  [`docs/github-integration.md`](docs/github-integration.md)),
  `preview-registry`/`preview-host`/`http-proxy`/`dev-server-detect`/
  `url-guard` (browser previews + their SSRF guards — see
  [`docs/browser-previews.md`](docs/browser-previews.md)).
- `src/db/` — Drizzle schema, client, seed. Migrations live in `drizzle/`.
- `frontend/` — standalone Vite + React + TypeScript app (own
  `package.json`/tsconfig/eslint); dockview-based tiled terminal UI.
- `deploy/` — systemd `--user` unit + Traefik/Authentik config templates
  (not installed by anything in this repo — see `deploy/README.md`).
- `docs/` — deep-dive docs for specific subsystems:
  [`multi-host.md`](docs/multi-host.md),
  [`browser-previews.md`](docs/browser-previews.md),
  [`github-integration.md`](docs/github-integration.md).

## 🔧 Configuration

All config is validated at startup by `@fastify/env` (see `src/plugins/env.ts`).

| Variable                 | Default              | Description                                                                                                                                                                                   |
| ------------------------ | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`               | `development`        | `development` \| `production` \| `test`                                                                                                                                                       |
| `PORT`                   | `3000`               | HTTP listen port                                                                                                                                                                              |
| `LOG_LEVEL`              | `info`               | pino log level                                                                                                                                                                                |
| `DATABASE_URL`           | `file:./data/app.db` | SQLite `file:` URL                                                                                                                                                                            |
| `DB_ENCRYPTION_KEY`      | _(empty)_            | base64url 32-byte key; enables encryption-at-rest                                                                                                                                             |
| `CORS_ORIGIN`            | _(empty)_            | comma-separated allowlist; empty disables CORS                                                                                                                                                |
| `RATE_LIMIT_MAX`         | `100`                | max requests per window                                                                                                                                                                       |
| `RATE_LIMIT_WINDOW`      | `1 minute`           | rate-limit window                                                                                                                                                                             |
| `SESSIONS_DIR`           | `./data/sessions`    | dir holding one dtach socket per terminal session                                                                                                                                             |
| `FRONTEND_DIST`          | `./frontend/dist`    | built frontend assets; served at `/` once present                                                                                                                                             |
| `PROJECTS_ROOTS`         | _(empty)_            | comma-separated dirs to scan for `GET /api/projects/discover`                                                                                                                                 |
| `CRS_CONFIG_DIR`         | `~/.config/crs`      | global launcher/dock config dir (a project's own `.crs/` wins)                                                                                                                                |
| `TESSERA_ROLE`           | `primary`            | `primary` \| `agent` — see [`docs/multi-host.md`](docs/multi-host.md); `agent` is a DB-less process that only runs PtyManager locally                                                         |
| `TESSERA_AGENT_TOKEN`    | _(empty)_            | shared secret an `agent` process's internal API requires on every request; `agent` refuses to boot without one                                                                                |
| `GITHUB_OAUTH_CLIENT_ID` | _(empty)_            | GitHub OAuth App client id; enables the device-flow "Connect with GitHub" button — see [`docs/github-integration.md`](docs/github-integration.md). PAT connect works with no client id at all |
| `PREVIEW_BASE_HOST`      | _(empty)_            | base host for browser preview subdomains (`preview-<slug>.<host>`); empty disables the feature entirely — see [`docs/browser-previews.md`](docs/browser-previews.md)                          |

Generate an encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## 🛠️ Commands

Backend (repo root):

- `make dev` — dev server with reload
- `make test` / `make test-coverage` — Vitest suite
- `make lint` / `make typecheck` — ESLint / `tsc`
- `make build` — production build to `dist/`
- `npm run db:generate` — generate a migration from schema changes
- `npm run db:migrate` — apply migrations (also run automatically at startup)
- `npm run db:seed` — seed initial data

Frontend (`frontend/`):

- `npm run dev` — Vite dev server (proxies `/api`, `/ws` to the backend)
- `npm run build` — production build to `frontend/dist`
- `npm run lint` / `npm run typecheck`

## 🛡️ Security

- `@fastify/helmet` (security headers), `@fastify/rate-limit`, and
  `@fastify/cors` are wired into every app via `src/plugins/security.ts`.
- Optional AES-256-GCM encryption-at-rest via `DB_ENCRYPTION_KEY` (see the
  `users.notes` column for an example).
- CodeQL scanning and dependency review run in CI; `detect-secrets` runs
  pre-commit. Follows the
  [s3ntin3l8 Global Security Policy](https://github.com/s3ntin3l8/.github/blob/main/SECURITY.md).

## 🐳 Docker

```bash
docker build -t tessera .
docker run -p 3000:3000 \
  -e DB_ENCRYPTION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")" \
  tessera
```

Multi-stage build: includes `dtach` and builds the frontend into the image,
runs as a non-root user, and ships a `HEALTHCHECK`. This image is CI's build/
publish target, not the production deploy path — real deployments run
natively under `systemd --user` (see `deploy/`) so sessions survive redeploys.

## 🚢 Deploy

Native (non-Docker) deployment templates live under `deploy/` — a
`systemd --user` unit, a Traefik dynamic-config router, and an Authentik
forwardAuth reference. These are **templates only**: nothing here is
installed by this repo or its CI. See `deploy/README.md` for the manual
install steps and the three host-specific placeholders you need to fill in.

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
