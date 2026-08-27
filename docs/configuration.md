# Configuration

All config is validated at startup by `@fastify/env` — the schema in
[`src/plugins/env.ts`](../src/plugins/env.ts) is the single source of truth.
This page is the single documented copy of it; every other doc that used to
carry its own env-var table links here instead, so a value only ever needs
updating in one place. `npm run lint` (and so `make lint`, CI, and the
pre-commit hook) runs `scripts/check-env-docs.mjs`, which fails if
`src/plugins/env.ts`, `.env.example`, and this page's tables ever name a
different set of keys — a new env var can't go undocumented the way
`PREVIEW_RATE_LIMIT_MAX` briefly did.

Copy `.env.example` to `.env` to get every key with its default and an
explanatory comment. Booleans accept `true`/`false` (see
`src/plugins/env.ts`'s own note on the pitfall of writing e.g. `"false"` in
a way that doesn't coerce to `false`).

## Core

| Variable            | Default           | Description                                                                                                      |
| ------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`          | `development`     | `development` \| `production` \| `test`                                                                          |
| `PORT`              | `3000`            | HTTP listen port                                                                                                 |
| `HOST`              | `127.0.0.1`       | interface `app.listen()` binds to; loopback-only by default, see [`auth.md`](auth.md#network-exposure-issue-603) |
| `LOG_LEVEL`         | `info`            | pino log level                                                                                                   |
| `CORS_ORIGIN`       | _(empty)_         | comma-separated allowlist; empty disables CORS                                                                   |
| `RATE_LIMIT_MAX`    | `100`             | max requests per window                                                                                          |
| `RATE_LIMIT_WINDOW` | `1 minute`        | rate-limit window                                                                                                |
| `FRONTEND_DIST`     | `./frontend/dist` | built frontend assets; served at `/` once present                                                                |
| `PROJECTS_ROOTS`    | _(empty)_         | comma-separated dirs to scan for `GET /api/projects/discover`                                                    |
| `CRS_CONFIG_DIR`    | `~/.config/crs`   | global launcher/dock config dir (a project's own `.crs/` wins)                                                   |

## Database and sessions

| Variable                | Default              | Description                                                                                                                                                                                         |
| ----------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | `file:./data/app.db` | SQLite `file:` URL                                                                                                                                                                                  |
| `DB_ENCRYPTION_KEY`     | _(empty)_            | base64url 32-byte key; enables encryption-at-rest                                                                                                                                                   |
| `SESSIONS_DIR`          | `./data/sessions`    | dir holding one dtach socket per terminal session                                                                                                                                                   |
| `MULLION_SOCKET_PATH`   | _(empty)_            | path for the control socket (the `mullion` CLI's transport); empty derives it from `SESSIONS_DIR` — see [`socket-api.md`](socket-api.md)                                                            |
| `MULLION_SSH_AUTH_SOCK` | _(empty)_            | path to a unix socket implementing the SSH agent protocol, injected as `SSH_AUTH_SOCK` into every session; empty leaves an inherited `SSH_AUTH_SOCK` untouched — see [`ssh-agent.md`](ssh-agent.md) |

Generate an encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## Auth (optional, off by default)

See [`auth.md`](auth.md) for the full setup/security writeup.

| Variable                     | Default   | Description                                                                                                                                                                                |
| ---------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MULLION_AUTH_TOKEN`         | _(empty)_ | shared token gating every `/api/*` route and every `/ws/*` upgrade (prefix-matched, so any future `/ws/*` route inherits it too); empty disables in-process auth entirely                  |
| `MULLION_TRUST_GATEWAY`      | `false`   | required to boot with neither `MULLION_AUTH_TOKEN` nor `MULLION_OIDC_*` set — acknowledges a reverse-proxy gateway already gates access; adds no check of its own (boot refuses otherwise) |
| `MULLION_SESSION_SECRET`     | _(empty)_ | signs the session cookie; required whenever `MULLION_AUTH_TOKEN` or `MULLION_OIDC_*` is set (boot refuses otherwise)                                                                       |
| `MULLION_OIDC_ISSUER`        | _(empty)_ | OIDC discovery/issuer URL; all four `MULLION_OIDC_*` keys must be set together                                                                                                             |
| `MULLION_OIDC_CLIENT_ID`     | _(empty)_ | OIDC client id                                                                                                                                                                             |
| `MULLION_OIDC_CLIENT_SECRET` | _(empty)_ | OIDC client secret (confidential client — this process does the code exchange server-side)                                                                                                 |
| `MULLION_OIDC_REDIRECT_URI`  | _(empty)_ | must exactly match a redirect URI registered at the provider, e.g. `https://mullion.example.com/api/auth/oidc/callback`                                                                    |

## Multi-host

See [`multi-host.md`](multi-host.md) for the full design.

| Variable                           | Default   | Description                                                                                                                                                 |
| ---------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MULLION_ROLE`                     | `primary` | `primary` \| `agent` — `agent` is a DB-less process that only runs PtyManager locally                                                                       |
| `MULLION_AGENT_TOKEN`              | _(empty)_ | shared secret an `agent` process's internal API requires on every request; not needed on an agent that self-registers                                       |
| `MULLION_PRIMARY_URL`              | _(empty)_ | `agent`-side: base URL of the primary to self-register with; requires `MULLION_ENROLLMENT_TOKEN` too                                                        |
| `MULLION_ENROLLMENT_TOKEN`         | _(empty)_ | `agent`-side: bootstrap credential presented to `POST /api/internal/register`; used once per boot, never as an inbound credential                           |
| `MULLION_AGENT_ADVERTISE_URL`      | _(empty)_ | `agent`-side: `baseUrl` this agent reports at registration; falls back to `http://<hostname>:<PORT>`                                                        |
| `MULLION_AGENT_NAME`               | _(empty)_ | `agent`-side: human label for this host in the primary's Hosts list; falls back to the reported hostname                                                    |
| `MULLION_ENROLLMENT_SECRET`        | _(empty)_ | `primary`-side: fleet-wide secret that lets an agent enroll as a brand-new host; empty disables enrollment (pre-provisioned claim registration still works) |
| `MULLION_ENROLLMENT_ALLOWED_CIDRS` | _(empty)_ | `primary`-side: comma-separated CIDRs; when set, additionally restricts which peer IPs may enroll a brand-new host (never affects claim registration)       |
| `HOST_HEARTBEAT_INTERVAL_SECONDS`  | `30`      | seconds between the primary's liveness sweeps of every registered remote host's `/health` route; `0` disables the poller                                    |

`deploy/install.sh --role agent` additionally reads
`MULLION_AGENT_PROJECTS_ROOTS`/`MULLION_AGENT_PRIMARY_URL`/
`MULLION_AGENT_ENROLLMENT_TOKEN` from its own invoking environment and
writes them into the agent's `.env` as the vars above — see
[`deploy/README.md`](../deploy/README.md)'s "Automating agent deploys"
section for the installer-side contract.

## GitHub integration

See [`github-integration.md`](github-integration.md) for the full design.

| Variable                      | Default   | Description                                                                                                                                                                                                      |
| ----------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_OAUTH_CLIENT_ID`      | _(empty)_ | GitHub OAuth App client id; enables the device-flow "Connect with GitHub" button. PAT connect works with no client id at all                                                                                     |
| `MULLION_WEBHOOK_BASE_URL`    | _(empty)_ | public `https://` base URL GitHub POSTs webhook events to; empty disables webhook support (polling stays active as the fallback)                                                                                 |
| `MULLION_WEBHOOK_SECRET`      | _(empty)_ | HMAC-SHA256 secret for webhook payload verification. Empty by default; if left empty when webhooks are enabled, one is auto-generated and persisted on first enable rather than requiring you to set it up front |
| `GITHUB_POLL_INTERVAL_ACTIVE` | `15`      | seconds between adaptive GitHub poller ticks while a repo has open PRs or running CI                                                                                                                             |
| `GITHUB_POLL_INTERVAL_QUIET`  | `60`      | seconds between adaptive GitHub poller ticks while no repo has open PRs or running CI                                                                                                                            |
| `GITHUB_POLL_STALE_THRESHOLD` | `300`     | seconds without a webhook delivery before the poller enters stalled mode and syncs at 30s instead                                                                                                                |

## Task Master

See [`tasks.md`](tasks.md) for the full lifecycle/design.

| Variable                                | Default        | Description                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MULLION_TASK_MASTER_ENABLED`           | `false`        | deploy-time default for autonomous Task Master behavior (GitHub ingest, auto-claim, claim/approve/retry); runtime-overridable from Settings → Task Master                                                                                                                                                                                                                                     |
| `MULLION_TASK_LABEL`                    | `mullion-task` | GitHub issue label the task watcher polls/ingests for; env-only (changing it mid-flight would orphan already-labeled issues)                                                                                                                                                                                                                                                                  |
| `MULLION_TASK_POLL_INTERVAL`            | `60`           | seconds between task-watcher poll sweeps; env-only (a GitHub rate-limit tradeoff)                                                                                                                                                                                                                                                                                                             |
| `MULLION_TASK_MAX_CONCURRENT`           | `2`            | install-wide cap on tasks `in_progress` (live workers) at once — `claimed` is the queue and doesn't count, so a manual claim past this cap queues instead of failing; Settings-overridable — see [`tasks.md`](tasks.md#configuring-task-master)                                                                                                                                               |
| `MULLION_TASK_BUDGET_MINUTES`           | `120`          | wall-clock minutes before the reconciler force-fails a stuck claim; `0` = unlimited; Settings-overridable                                                                                                                                                                                                                                                                                     |
| `MULLION_TASK_PROGRESS_COMMENT_MINUTES` | `15`           | minimum minutes between two `in_progress` progress comments on the same linked issue; `0` = no throttle; Settings-overridable                                                                                                                                                                                                                                                                 |
| `MULLION_TASK_SKIP_PERMISSIONS`         | `false`        | passes the resolved agent's own skip-permissions flag at spawn, so an autonomous worker doesn't stall at a permission/trust prompt with no one to answer it. Off by default — bypassing every tool-permission check is an explicit opt-in. Runtime-overridable from Settings → Task Master. Distinct from the launcher-only `skipPermissionsAgents` setting, which never reaches these spawns |

## Browser previews

See [`browser-previews.md`](browser-previews.md) for the full design.

| Variable                 | Default   | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PREVIEW_BASE_HOST`      | _(empty)_ | base host for browser preview subdomains (`preview-<slug>.<host>`); empty disables the subdomain-proxy feature entirely — direct-embed previews still work                                                                                                                                                                                                                                                                                                                                     |
| `PREVIEW_AUTH_REQUIRED`  | `false`   | requires a bootstrap token/preview cookie before proxying a preview-host request, on top of any gateway forwardAuth; requires `MULLION_SESSION_SECRET` — see [`auth.md`](auth.md)                                                                                                                                                                                                                                                                                                              |
| `PREVIEW_RATE_LIMIT_MAX` | `2000`    | per-IP requests/minute ceiling on the preview subdomain proxy (`preview-proxy.ts`'s replacement counter for the exemption a preview otherwise needs from `RATE_LIMIT_MAX`, so a single page load's dozens of subresource requests don't 429 partway through the first paint). Deliberately its own config rather than a multiplier of `RATE_LIMIT_MAX`. `0` is **not** "unlimited" here — it 429s every request after the first in a window — so the schema rejects anything below `1` at boot |

## Browser automation (Playwright)

See [`browser-automation.md`](browser-automation.md) for the full design.

| Variable                | Default           | Description                                                                                                                                                                                                                                                                     |
| ----------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BROWSER_ENABLED`       | `false`           | gates the whole Playwright-driven Controllable Browser feature; when off, BrowserManager refuses to launch Chromium and the browser WS/REST routes return a clear 4xx. See [`deploy/README.md`](../deploy/README.md)'s Playwright/Chromium prerequisites before turning this on |
| `BROWSER_MAX_INSTANCES` | `4`               | max concurrent Chromium instances in the pool (one per project); bounds host memory — each headless instance is real memory even at idle                                                                                                                                        |
| `BROWSER_FRAMERATE`     | `10`              | target frames-per-second for the CDP screenshot stream                                                                                                                                                                                                                          |
| `BROWSER_DATA_DIR`      | `./data/browsers` | where per-project Playwright storage state (cookies/localStorage) is written so a project's browser starts already-authenticated across restarts; cwd-relative like `SESSIONS_DIR` — a versioned-release install overrides this to an absolute path (see `deploy/install.sh`)   |

## Deploy and update (versioned-release installs only)

Only relevant to a `deploy/install.sh`-provisioned host — see
[`deploy/README.md`](../deploy/README.md) for the full layout. Leave these
unset for a `make dev` source checkout.

| Variable               | Default                             | Description                                                                                                                                                                                                                                                                              |
| ---------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MULLION_HOME`         | _(empty)_                           | absolute path to the versioned-release install root (the parent of `releases/`, the `current` symlink, and `data/`); empty means a dev checkout — the update checker (`GET /api/updates/check`) still works, but applying an update (`POST /api/updates/apply`) refuses without this set |
| `MULLION_UPDATE_REPO`  | `s3ntin3l8/mullion-session-manager` | `owner/repo` polled for the latest GitHub Release by the update checker; override only for a fork publishing releases elsewhere                                                                                                                                                          |
| `MULLION_SERVICE_UNIT` | _(empty)_                           | override for the systemd `--user` unit `self-update.sh` restarts after applying an update; empty autodetects it from this process's own `/proc/self/cgroup` at apply time — set only if a host's cgroup layout defeats autodetection                                                     |

## Per-session (injected at spawn, not `@fastify/env`-validated)

These aren't in the schema above — they're written into a spawned session's
environment by `src/services/launch-plan.ts`, one set per session, not a
deploy-time default. See [`agent-hooks.md`](agent-hooks.md) and
[`socket-api.md`](socket-api.md).

A caller-supplied env (a dock control's `env`, see [`dock.md`](dock.md), or
a direct `POST /api/sessions` body) is applied FIRST, before every row in
the table below — so none of these can ever be overridden by it. Reserved
keys (`MULLION_*`, `SSH_AUTH_SOCK`) are rejected when a dock config is
saved, not silently dropped at launch time.

| Variable              | Description                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MULLION_HOOK_SOCKET` | path to this session's hook socket, read by the hook forwarder/adapters                                                                                                                    |
| `MULLION_HOOK_TOKEN`  | per-session token authenticating that socket connection                                                                                                                                    |
| `MULLION_SOCKET_PATH` | path to the control socket, so the `mullion` CLI run from inside a session defaults its targeting to that session with no flags                                                            |
| `MULLION_SESSION_ID`  | this session's own id, read by the `mullion` CLI and MCP client to scope calls to it                                                                                                       |
| `SSH_AUTH_SOCK`       | set to `MULLION_SSH_AUTH_SOCK`'s configured path when that's non-empty; otherwise this session's inherited `SSH_AUTH_SOCK` (if any) is left untouched — see [`ssh-agent.md`](ssh-agent.md) |
