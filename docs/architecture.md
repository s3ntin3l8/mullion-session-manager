# Architecture

A tour of the repo's layout: what lives where, and which subsystem doc owns
the detail.

**The non-obvious session model** — read this before touching
`src/services/pty-manager.ts` or the terminal WS protocol: a session is a
host PTY attached via `dtach`, running inside a transient `systemd --user`
scope so it survives service redeploys/restarts. The `sessions` DB row
records _intent_ (has this been explicitly killed?); live process state
lives only in `PtyManager`'s in-memory map, and routes merge the two rather
than trusting the DB column alone. `sessions.command` and
`workspaces.layout` are deliberately **opaque blobs** — the backend never
parses a shell command line or a dockview layout, it just stores and
replays what it's given.

- `src/app.ts` — the app factory (`buildApp()`); registers plugins then
  routes. `src/server.ts` calls it and handles listen + graceful shutdown
  (`SIGINT`/`SIGTERM`).
- `src/plugins/` — `env` (validated config, see [`configuration.md`](configuration.md)),
  `logging`, `security` (helmet, rate-limit, CORS, and the preview
  subdomains' `frame-src` CSP entry), `db` (migrations + `app.db`/
  `app.encryption` decorators), `pty` (`app.pty` session manager + periodic
  exited-session reconciler), `websocket`, `auth` (optional in-process
  auth — a global `onRequest` hook covering every `/api/*` route and every
  `/ws/*` upgrade by prefix, so `/ws/terminal`, `/ws/events`, `/ws/github`,
  `/ws/tasks`, and `/ws/browser/:sessionId` alike; inert until
  `MULLION_AUTH_TOKEN` or `MULLION_OIDC_*` is set — see [`auth.md`](auth.md)),
  `static` (serves the built frontend once it exists), `preview-proxy` (the
  subdomain reverse proxy + HMR websocket proxying for browser previews —
  see [`browser-previews.md`](browser-previews.md); fully inert until
  `PREVIEW_BASE_HOST` is set), `hooks` (`app.hookServer` — the agent hook
  socket, `MULLION_HOOK_SOCKET` injected per-session, plus
  `app.resolveHookGate` for the minimal review gate's decision round-trip;
  see [`agent-hooks.md`](agent-hooks.md)), `control-socket` (`app.controlServer` —
  the general-purpose control socket behind the `mullion` CLI; dispatches
  by re-entering the routes below via `app.inject()` rather than
  duplicating their logic — see [`socket-api.md`](socket-api.md)), `browser`
  (Playwright browser-control lifecycle backing the routes below),
  `event-store` (wires the persisted-history query surface behind
  `GET /api/events`), `push` (web-push subscription lifecycle),
  `host-heartbeat`, `github-pr-poller`, `webhook-reconciler`, `task-watcher`,
  `git-fetcher` — these are the always-on primary-side pollers/reconcilers
  for multi-host, GitHub, Task Master, and webhook registration; see those
  subsystems' own docs for what each does. `agent-enrollment` and
  `request-nonce` are the mirror image: registered only on an `agent`-role
  host, not the primary, for enrolling with and verifying signed requests
  from its primary. `bundle-sync` is the one plugin that runs on both roles
  (issue #941 — a boot-time `onReady` hook, registered on both the primary
  and an `agent`-role host, that syncs the shipped `src/bundle/skills/`
  bundle into each CLI's own global skill/agent directory once per process
  start, tracked by a manifest at `~/.mullion/bundle-sync.json`; see
  `src/services/bundle-sync.ts` and
  [`agent-guide.md`](agent-guide.md#where-your-skills-actually-come-from)).
  Ownership of installed content the manifest didn't (yet) track — e.g. the
  first sync after a shipped skill/agent gets renamed, or a
  deleted/corrupted manifest — is settled by two orphan-scan-safe markers,
  not the manifest: an installed skill directory carries a sibling
  `.mullion-managed` sentinel file (`INSTALLED_MARKER_NAME`,
  `mullion-bundle.ts`), and an installed flat agent `.md` file (which has no
  "inside" to carry a sibling file) instead carries an in-body HTML-comment
  marker, `<!-- mullion:managed -->` (`INSTALLED_AGENT_MARKER`) — the same
  inert-to-every-parser convention as `marked-region.ts`'s own
  `<!-- mullion:*:start/end -->` markers below, just a single sentinel line
  rather than a delimited region, since these files have no surrounding
  user content to preserve. `pruneOrphanManagedDirs`/`pruneOrphanManagedFiles`
  (mullion-bundle.ts) are the marker-gated scans both `syncBundleContent`
  and the legacy per-launch `installBundleSkills`/`uninstallBundleSkills`
  share — issues #947/#1090 — and neither ever removes a same-prefixed
  `mullion-*` skill directory or agent file that lacks its marker, even with
  no manifest at all (PR #891's ownership-safety rule).
- `src/routes/` — `health` (`/health`, `/ready`), `auth` (`/api/auth/login`,
  `/logout`, `/me`, and `/oidc/login`, `/oidc/callback` — see
  [`auth.md`](auth.md)), `root` (placeholder `/`, disabled once the
  frontend build exists — template-inherited), `projects` (CRUD, discovery,
  per-project actions/dock, and GitPanel's branch/worktree endpoints, see
  [`git-panel.md`](git-panel.md)), `sessions` (durable terminal sessions,
  including `POST /api/sessions/:id/review-gate` — the minimal review
  gate's decision endpoint, see [`agent-hooks.md`](agent-hooks.md), and
  `GET /api/sessions/:id/processes` — the cgroup-based per-session process
  inventory), `workspaces` (named/grouped saved layouts), `groups`
  (workspace groups), `agents` (installed shell/AI-CLI detection),
  `actions` (global launcher presets), `server-info`
  (`GET /api/server-info`, read-only diagnostics for Settings → Server
  info), `terminal` (`/ws/terminal` PTY bridge), `hosts` (remote-host
  registry for multi-host sessions), `enrollment` (`POST
/api/internal/register`/`/deregister` — an agent's self-registration
  handshake with the primary, see [`multi-host.md`](multi-host.md)),
  `internal` (an `agent` process's token-gated API, called by a `primary`'s
  host routing — including its own `POST
/internal/sessions/:id/review-gate`, so a review-gate decision reaches
  whichever host actually holds the pending hook connection), `integrations`
  (GitHub PAT/device-flow/GitHub-App connect, webhook toggle/management —
  see [`github-integration.md`](github-integration.md)), `webhooks`
  (`/api/webhooks/github` — the HMAC-verified webhook handler, including
  Task Master's webhook-driven ingest), `ws-github` (`/ws/github` —
  real-time event push to connected frontends), `previews` (list/create/
  read/delete browser previews — see [`browser-previews.md`](browser-previews.md)),
  `events` (`/ws/events` — the live notification-event stream, plus `GET
/api/events`, the opt-in persisted-history query — see
  [`socket-api.md`](socket-api.md)), `tasks` (Task Master's CRUD,
  claim/approve/reject/retry/give-up endpoints — see [`tasks.md`](tasks.md)),
  `ws-tasks` (`/ws/tasks` — live task-transition push, see
  [`tasks.md`](tasks.md)), `skills` (per-agent Skill enable/disable),
  `agent-rules` (per-agent rule-file read/write), `settings` (the runtime
  Settings-override store backing Task Master's safety envelope and other
  deploy-time-default overrides), `updates` (Settings → Server info's
  "Update now" flow), `push` (`GET /api/push/vapid-public-key`, `POST
/api/push/subscribe`/`unsubscribe` — the web-push subscription surface
  backing mobile/background attention alerts), `browser`/
  `browser-automation`/`browser-cookies`/`browser-urls` (the Playwright
  browser-control REST surface, `/ws/browser/:sessionId` streaming, and
  cookie-profile import — see [`browser-automation.md`](browser-automation.md)),
  `project-urls` (per-project saved external-URL shortcuts), `project-tooling`
  (`GET`/`PUT`/`DELETE /api/projects/:id/tooling[/skill|/reviewer-agent]` —
  a project's DB-authored pinned note/skill/reviewer subagent, primary-only,
  no host branching — see [`project-briefing.md`](project-briefing.md)),
  `project-setup` (`POST /api/projects/:id/setup/preview`/`apply` — scaffold
  a committed briefing region + starter skill/reviewer into a project's own
  repo as a real pull request; works for local AND remote-hosted projects
  (issue #895 — `host-files.ts`'s `readHostFiles`/`writeHostFiles`,
  `host-git.ts`'s `resolveHostFileDiff`/`commitHostWipChanges`).
  `POST /api/projects/:id/setup/generate` (real agent-generated content
  instead of placeholder text) is still local-host only — it spawns an
  agent CLI turn in-process rather than just reading/writing file content,
  so #895's primitives don't cover it; see issue #1101 — see
  [`project-briefing.md`](project-briefing.md#scaffolding-it-into-the-repo-instead)),
  `workflow-conventions` (`GET /api/workflow-conventions/questions`, `POST
/api/workflow-conventions/preview` — the two read-only endpoints backing
  the Settings → Sessions wizard; neither reads nor writes the actual
  `settings.sessions.workflowConventionsText` value, which rides the
  ordinary `PATCH /api/settings` path — see
  [`project-briefing.md`](project-briefing.md#workflow-conventions-issue-937)).
- `src/services/` — `pty-manager` (dtach/node-pty session lifecycle),
  `project-config` (layered `.crs/actions.json`/`dock.json` + `package.json`/
  `tasks.json` resolution), `agent-detect`, `attention-detect` (BEL/OSC
  parsing), `session-reconciler`, `cgroup-inventory` (per-session process
  inventory via each dtach master's own transient systemd scope),
  `event-history` (query/insert/retention logic behind the opt-in persisted
  session-event history — see `src/plugins/event-store.ts`), `encryption`
  (AES-256-GCM), `date-utils`, `host-registry`/`remote-host-client`/
  `session-backend` (multi-host routing — see [`multi-host.md`](multi-host.md)),
  `github`/`github-integration`/`github-device-flow`/`git-remote`/
  `github-webhook`/`github-pr-poller`/`github-activity-tracker`/
  `github-ws-broadcast`/`github-app`/`github-write` (GitHub status +
  connect flows + webhook registration + adaptive polling + WS push +
  GitHub App installation-token minting + the write-side API client Task
  Master's sync/promote use — see [`github-integration.md`](github-integration.md)),
  `task-state`/`task-claim`/`task-github-sync`/`task-promote`/
  `task-reconciler`/`task-watcher`/`task-events`/`task-config`/
  `task-agent-resolve` (Task Master: the transition table and live
  `/ws/tasks` broadcast, claim, GitHub sync, PR promotion, the reconciler
  that drives autonomous progress, the poll/webhook ingest watcher, runtime
  Settings-override config, and worker/review agent resolution — see
  [`tasks.md`](tasks.md)), `git-worktree` (per-task worktree
  create/remove/prune, including the boot-time orphan sweep and remote-host
  proxying — see [`tasks.md`](tasks.md)), `git-branch`/`git-branch-delete`/
  `git-status`/`git-diff`/`git-fetch`/`git-push`/`git-refs`/`git-ignore`/
  `git-env` (the Git panel's own read/write operations — see
  [`git-panel.md`](git-panel.md); every call routes through `git-env.ts`'s
  `gitEnv()` to stay outside the env-leak-corruption class), `preview-registry`/
  `preview-host`/`http-proxy`/`dev-server-detect`/`docker-service-detect`/
  `url-guard`/`pinned-connect` (browser previews, Docker Compose discovery,
  and their SSRF guards, including connection-time IP pinning — see
  [`browser-previews.md`](browser-previews.md)), `hook-protocol` (hook
  message validation), `hook-adapters/` (per-agent hook auto-injection at
  spawn — Claude Code, OpenCode, Codex, and agy; Codex's and agy's are both
  managed merges into the user's real `~/.codex/hooks.json` /
  `~/.gemini/config/hooks.json`, not ephemeral like Claude Code/OpenCode —
  Codex's own hook-trust model and `CODEX_HOME`'s all-or-nothing scope rule
  out an ephemeral injection there; agy has no documented env var to
  relocate its config at all — see [`agent-hooks.md`](agent-hooks.md)),
  `hook-adapters/mullion-bundle` (ships `src/bundle/skills/`'s seven skills
  — `host`, `browser`, `troubleshooting`, `session-ops`, `taskmaster-issues`,
  `task-worker`, `task-reviewer` — into every Claude Code session via a
  session-scoped `--plugin-dir`,
  installs the same skills into codex's/agy's own real global skill dirs
  (each `mullion-`-prefixed there to avoid colliding with a user's own
  skill) for the two agents with no ephemeral overlay, and — the same
  mechanism,
  extended — composes a per-session bundle carrying a PROJECT's own
  DB-authored skill/reviewer subagent alongside it; opencode's project
  skill/reviewer instead ride its own `skills.paths`/`agent/` config keys
  directly, no bundle involved — see
  [`project-briefing.md`](project-briefing.md)), `skills` (per-agent Skill
  discovery/enable-disable across Claude Code/codex/opencode/agy's own
  config locations, plus the hand-rolled SKILL.md frontmatter parser
  `mullion-bundle.ts`/`mullion-scaffold.ts` both reuse), `marked-region`
  (the `<!-- mullion:*:start/end -->` marker-delimited-region read/write
  helpers shared by `agent-guide.ts`, `project-briefing.ts`, and
  `mullion-scaffold.ts`), `project-briefing`/`project-tooling` (a project's
  own DB-authored briefing/skill/reviewer — resolution vs. a committed
  AGENTS.md region, and the primary-only DB row backing it, respectively —
  see [`project-briefing.md`](project-briefing.md)), `mullion-scaffold`
  (pure "current file contents + options → target file set" computation
  backing the scaffold-as-PR flow — see
  [`project-briefing.md`](project-briefing.md#scaffolding-it-into-the-repo-instead)),
  `opencode-session-transfer` (PR #696 — full opencode conversation-history
  carryover into a promoted worktree via `opencode export`/`import`,
  re-keying the imported session to the worktree's project/directory; local
  host only — see [`agent-hooks.md`](agent-hooks.md)),
  `agent-guide` (serves this doc set's own [`agent-guide.md`](agent-guide.md)
  into a spawned session at `SessionStart`), `push-delivery`/`push-store`
  (the web-push subscription/delivery surface behind `src/routes/push.ts`),
  `control-protocol`/`control-socket-addr`/`socket-channel`/`unix-socket`/
  `ws-pipe` (the control socket's transport — see [`socket-api.md`](socket-api.md)),
  `browser-manager`/`browser-cookie-import`/`session-browsers` (the
  Playwright pool, per-project storage state, and cookie-profile import
  behind [`browser-automation.md`](browser-automation.md)), `oidc`
  (native OIDC login — see [`auth.md`](auth.md)), `systemd-unit`
  (cgroup-based autodetection of the running unit for self-update),
  `update-checker` (Settings → Server info's update surface).
- `src/mcp/` — the MCP server Mullion exposes over the same control socket
  the `mullion` CLI uses: `server.mjs` (the MCP protocol handler),
  `client.mjs` (control-socket client), `tools.mjs` (session/project/
  preview/browser tool definitions). Copied byte-for-byte into `dist/mcp/`
  by `make build`; exec'd by `src/cli/mullion.mjs`'s `mullion mcp` command —
  see [`cli.md`](cli.md).
- `src/hooks/` — plain-JavaScript (not TypeScript) files loaded directly by
  an agent's own hook runner or plugin loader, not imported by the server
  process: `forwarder.mjs` bridges a shell-command-hook agent's stdin JSON
  to the hook socket (`forwarder-core.mjs` holds its pure, unit-tested
  per-agent mapping logic); `opencode-plugin.js` is OpenCode's own bridge,
  auto-injected via `OPENCODE_CONFIG_DIR` (OpenCode has no shell-command
  hooks, only a JS/TS plugin API); `forwarder-shim.sh` is a small POSIX `sh`
  script installed at a fixed, host-stable location
  (`~/.mullion/hooks/mullion-forwarder-shim.sh`) that agy's/Codex's
  host-global hook configs invoke instead of `forwarder.mjs` directly, so
  those configs never embed a checkout-specific path — see
  [`agent-hooks.md`](agent-hooks.md#how-a-hook-command-finds-the-forwarder).
  Copied byte-for-byte into `dist/hooks/` by `make build`.
- `src/cli/` — the `mullion` CLI: `mullion.mjs` is a thin, spawned
  `#!/usr/bin/env node` entry point (plain JavaScript, same dev/prod-parity
  reasoning as `src/hooks/`, copied byte-for-byte into `dist/cli/` by
  `make build`); a versioned install symlinks it at `~/.local/bin/mullion`
  (`deploy/install.sh`) — `package.json`'s `"bin"` field is documentary
  only (`npm ci --omit=dev` never links a root package's own bin). The
  actual arg parsing/command table (`core.mjs`) and control-socket client
  (`client.mjs`) are imported, not spawned, so they're unit-tested and
  count toward the coverage floor. See [`cli.md`](cli.md).
- `src/db/` — Drizzle schema, client, seed. Migrations live in `drizzle/`.
- `frontend/` — standalone Vite + React + TypeScript app (own
  `package.json`/tsconfig/eslint); dockview-based tiled terminal UI.
- `deploy/` — systemd `--user` unit + Traefik/Authentik config templates
  (fully supported native host deployment — see
  [`../deploy/README.md`](../deploy/README.md)).
- `docs/` — see [`README.md`](README.md) for the full index.
- `.github/workflows/` — thin callers of the reusable workflows in
  `s3ntin3l8/.github` — see [`ci-cd.md`](ci-cd.md).
- `.claude/` — `settings.json` + `hooks/session-start.sh`: a SessionStart
  hook that installs deps and tooling so
  [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web)
  sessions can build, test, and lint. Runs only in the remote env.
