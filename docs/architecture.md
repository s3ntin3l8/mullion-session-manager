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
replays what it's given. **The exception** is `src/services/hook-adapters/`:
each adapter's own `commandTransform` (Claude Code appends `--settings`/
`--mcp-config`/`--plugin-dir`; Codex and agy append their own MCP/model
flags the same way) inspects and rewrites the launch command at spawn time,
and a handful of narrow, purpose-built helpers exported alongside them —
`commandIsOpencode`/`commandModelCli`/`commandSupportsSeed`/`buildModelFlag`/
`validateModel`/`validateCliModel` (`hook-adapters/index.ts`/`shared.ts`) —
are what callers elsewhere (`task-claim.ts`, `task-reconciler.ts`,
`task-model-resolve.ts`, `routes/sessions.ts`) use to branch on a command's
agent family or inject a model flag, rather than re-deriving that shape
themselves with their own ad-hoc parsing. Any `session.command` inspection
outside these sanctioned adapter/helper call sites is the red flag, not a
call into one of them.

The scope's unit name (`crs-session-<instanceId>-<id>`,
`session-process.ts`'s `scopeUnitName`) is namespaced per Mullion instance
(issue #1140) since the underlying systemd `--user` namespace is
Unix-user-global while `sessions.id` is per-database. The unit name itself
is not what identifies a session as this instance's own, though — that's
always resolved from the scope's dtach socket path
(`listOwnedScopes`/`resolveOwningUnit`), which is per-instance by
construction and handles a pre-rename session's legacy unit name the same
way as a namespaced one.

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
  (Playwright browser-control lifecycle backing the routes below), `device`
  (the Android emulator/scrcpy `DeviceManager` backing the routes below —
  registers regardless of `DEVICE_ENABLED`, inert until it's set, same
  posture as `browser` — see [`device-panel.md`](device-panel.md)),
  `event-store` (wires the persisted-history query surface behind
  `GET /api/events`), `push` (web-push subscription lifecycle),
  `host-heartbeat`, `github-pr-poller`, `webhook-reconciler`, `task-watcher`,
  `git-fetcher` — these are the always-on primary-side pollers/reconcilers
  for multi-host, GitHub, Task Master, and webhook registration; see those
  subsystems' own docs for what each does. `runtime-settings` applies
  Settings → Server's log-level override once the DB is available (and on
  every later Settings change). `agent-bridge` decorates `app.connectedBridges`
  (the live SSH-agent bridge connection map `routes/agent-bridge.ts` and
  `ssh-agent-fanout.ts` both read) and `bridge-cleanup` periodically sweeps
  expired pairing codes off the `bridges` table — both primary-only, part of
  the SSH-agent bridge (issue #820, see `docs/ssh-agent.md`). `ssh-agent`
  registers on **both** roles: on an `agent`-role host it materializes the
  local unix socket a launched session's `SSH_AUTH_SOCK` points at, wired to
  the primary's dial-in; on the primary it serves that same socket for the
  primary's own local sessions directly. `ssh-agent-fanout` (primary-only)
  reconciles which bridge serves which enrolled host whenever a bridge
  connects/disconnects or a host is enrolled/removed. `agent-enrollment` and
  `request-nonce` are the mirror image of the primary-side pollers above:
  registered only on an `agent`-role host, not the primary, for enrolling
  with and verifying signed requests from its primary. `bundle-sync` is the
  one plugin that runs on both roles (issue #941 — a boot-time `onReady`
  hook, registered on both the primary and an `agent`-role host, that syncs
  the shipped `src/bundle/skills/` bundle into **all four CLIs'** (Claude
  Code, codex, agy, opencode) own global skill/agent directory once per
  process start, tracked by a manifest at `~/.mullion/bundle-sync.json`; see
  `src/services/bundle-sync.ts` and
  [`agent-guide.md`](agent-guide.md#where-your-skills-actually-come-from)).
  Before this shipped, codex and agy got a real per-launch copy
  (`installBundleSkills`, called fire-and-forget on every session spawn —
  still called today too, as a cheap idempotent fallback for the rare case
  where boot-time sync hasn't run yet on this host) while Claude Code and
  opencode got a zero-copy per-session pointer instead
  (`hook-adapters/claude-code.ts`'s `--plugin-dir`,
  `hook-adapters/opencode.ts`'s `skills.paths`); `bundle-sync` aligned all
  four onto the one boot-time mechanism. Claude Code's `--plugin-dir` is
  **not** fully retired by this, though: it's still emitted per-session
  whenever a project has its own DB-authored skill/reviewer content to
  compose alongside the shipped bundle (`composeClaudeSessionBundle`), and
  it falls back to pointing at the plain shipped bundle directly whenever
  `isBundleSyncedFor("claude-code")` reports the boot-time sync hasn't run
  yet on this host.
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
  [`socket-api.md`](socket-api.md)), `tasks` (Task Master's CRUD plus its
  action verbs — claim/approve/reject/retry/re-review/give-up/archive/
  unarchive/archive-merged/clear-done/merge — see [`tasks.md`](tasks.md)),
  `ws-tasks` (`/ws/tasks` — live task-transition push, see
  [`tasks.md`](tasks.md)), `bundle-sync` (`GET`/`POST /api/bundle-sync/*` —
  reports and re-triggers THIS process's own boot-time bundle sync,
  host-local by design; see the `bundle-sync` plugin above),
  `agent-bridge` (the primary-side SSH-agent bridge surface — pairing-code
  issue/redeem, bridge list/reorder/rotate/delete, and the
  `/internal/ws/ssh-agent` dial-in an agent host uses to connect back — see
  `docs/ssh-agent.md`), `dock-config` (`GET`/`PUT
/api/projects/:id/dock/config` — the write half of a project's dock
  config; the existing `GET /api/projects/:id/dock` on `projects` stays the
  merged, Docker-discovery-aware read), `opencode-models` (`GET
/api/opencode/models` and `GET /api/agy/models` — bare-array model catalogs
  for the Settings model pickers, despite the route's own name only naming
  opencode), `system-resources` (Settings → Server's resource-monitoring
  surface — CPU/memory/disk sampling and Docker storage inspection/prune),
  `internal-schemas` (not a route file at all — the extracted JSON Schema
  bodies/params `internal.ts`'s DB-less agent API registers, kept out of
  `internal.ts` itself to stop ~450 lines of hand-written schema literals
  drifting from their own parallel TS interfaces), `skills` (per-agent Skill enable/disable),
  `agent-rules` (per-agent rule-file read/write), `settings` (the runtime
  Settings-override store backing Task Master's safety envelope and other
  deploy-time-default overrides), `updates` (Settings → Server's
  "Update now" flow), `push` (`GET /api/push/vapid-public-key`, `POST
/api/push/subscribe`/`unsubscribe` — the web-push subscription surface
  backing mobile/background attention alerts), `browser`/
  `browser-automation`/`browser-cookies`/`browser-urls` (the Playwright
  browser-control REST surface, `/ws/browser/:sessionId` streaming, and
  cookie-profile import — see [`browser-automation.md`](browser-automation.md)),
  `device`/`devices` (`/ws/device/:deviceId` H.264 streaming + input proxy,
  and the `devices` CRUD/action/pair REST surface, respectively) and `avds`
  (AVD listing/creation and installed-system-image/device-profile listing —
  see [`device-panel.md`](device-panel.md)), `project-urls` (per-project saved external-URL shortcuts), `project-tooling`
  (`GET`/`PUT`/`DELETE /api/projects/:id/tooling[/skill|/reviewer-agent]` —
  a project's DB-authored pinned note/skill/reviewer subagent, primary-only,
  no host branching — see [`agent-context.md`](agent-context.md)),
  `project-setup` (`POST /api/projects/:id/setup/preview`/`apply`/`generate` —
  scaffold a committed briefing region + starter skill/reviewer into a
  project's own repo as a real pull request; all three work for local AND
  remote-hosted projects. `preview`/`apply` (issue #895) use
  `host-files.ts`'s `readHostFiles`/`writeHostFiles`, `host-git.ts`'s
  `resolveHostFileDiff`/`commitHostWipChanges`. `generate` (real
  agent-generated content instead of placeholder text) needed a separate
  fix on top (issue #1101): it spawns a real agent CLI turn
  (`scaffold-generate.ts`'s `generateScaffoldContent`), which now runs on
  whichever host owns the project's checkout via a new
  `POST /internal/run-generation-turn` route — see
  [`agent-context.md`](agent-context.md#scaffolding-it-into-the-repo-instead)),
  `workflow-conventions` (`GET /api/workflow-conventions/questions`, `POST
/api/workflow-conventions/preview` — the two read-only endpoints backing
  the Settings → Agent context & skills wizard; neither reads nor writes the actual
  `settings.sessions.workflowConventionsText` value, which rides the
  ordinary `PATCH /api/settings` path — see
  [`agent-context.md`](agent-context.md#workflow-conventions-issue-937)).
- `src/services/` — ~140 files; grouped here by subsystem rather than
  listed flat (see each subsystem's own doc for the full detail):
  - **Sessions & hosting**: `pty-manager` (dtach/node-pty session
    lifecycle), `project-config` (layered `.crs/actions.json`/`dock.json` +
    `package.json`/`tasks.json` resolution), `agent-detect`,
    `attention-detect` (BEL/OSC parsing), `session-reconciler`,
    `cgroup-inventory` (per-session process inventory via each dtach
    master's own transient systemd scope), `event-history` (query/insert/
    retention logic behind the opt-in persisted session-event history — see
    `src/plugins/event-store.ts`), `encryption` (AES-256-GCM), `date-utils`,
    `host-registry`/`remote-host-client`/`session-backend` (multi-host
    routing — see [`multi-host.md`](multi-host.md)), `control-protocol`/
    `control-socket-addr`/`socket-channel`/`unix-socket`/`ws-pipe` (the
    control socket's transport — see [`socket-api.md`](socket-api.md)),
    `oidc` (native OIDC login — see [`auth.md`](auth.md)), `push-delivery`/
    `push-store` (the web-push subscription/delivery surface behind
    `src/routes/push.ts`).
  - **Git & browser previews**: `git-branch`/`git-branch-delete`/
    `git-status`/`git-diff`/`git-fetch`/`git-push`/`git-refs`/`git-ignore`/
    `git-env` (the Git panel's own read/write operations — see
    [`git-panel.md`](git-panel.md); every call routes through `git-env.ts`'s
    `gitEnv()` to stay outside the env-leak-corruption class),
    `preview-registry`/`preview-host`/`http-proxy`/`dev-server-detect`/
    `docker-service-detect`/`url-guard`/`pinned-connect` (browser previews,
    Docker Compose discovery, and their SSRF guards, including
    connection-time IP pinning — see
    [`browser-previews.md`](browser-previews.md)), `browser-manager`/
    `browser-cookie-import`/`session-browsers` (the Playwright pool,
    per-project storage state, and cookie-profile import behind
    [`browser-automation.md`](browser-automation.md)).
  - **Task Master**: `task-state`/`task-claim`/`task-dispatch`/
    `task-github-sync`/`task-promote`/`task-approve`/`task-reconciler`/
    `task-watcher`/`task-events`/`task-config`/`task-agent-resolve`/
    `task-model-resolve`/`task-dependencies`/`task-issue-context`/
    `task-prompt`/`task-reseed`/`task-rate-limit-grace` (the transition
    table and live `/ws/tasks` broadcast, the claim/dispatch queue, GitHub
    sync, PR promotion and approval, the reconciler that drives autonomous
    progress — gates, auto-return, auto-approve, auto-rebase, rate-limit
    grace — the poll/webhook ingest watcher, dependency-aware claiming,
    prompt construction, re-seeding, and worker/review agent + model
    resolution — see [`tasks.md`](tasks.md) and
    [`tasks-internals.md`](tasks-internals.md)), `git-worktree` (per-task
    worktree create/remove/prune, including the boot-time orphan sweep and
    remote-host proxying), `release-merge`/`project-release-please`
    (autorelease-after-merge decision logic and the release-please
    detection/auto-enable sweep — see
    [`tasks-internals.md`](tasks-internals.md#autorelease-after-tasks-land-744)).
  - **Bundle & agent context**: `hook-protocol` (hook message validation),
    `hook-adapters/` (per-agent hook auto-injection at spawn — Claude Code,
    OpenCode, Codex, and agy; Codex's and agy's are both managed merges into
    the user's real `~/.codex/hooks.json` / `~/.gemini/config/hooks.json`,
    not ephemeral like Claude Code/OpenCode — Codex's own hook-trust model
    and `CODEX_HOME`'s all-or-nothing scope rule out an ephemeral injection
    there; agy has no documented env var to relocate its config at all —
    see [`agent-hooks.md`](agent-hooks.md)), `hook-adapters/mullion-bundle`
    (ships `src/bundle/skills/`'s eight skills — `host`, `browser`,
    `troubleshooting`, `session-ops`, `taskmaster-issues`, `task-worker`,
    `task-reviewer`, `manual-review-methodology` — into all four CLIs' own
    global skill/agent directories via `bundle-sync.ts`'s boot-time sync
    (see the `bundle-sync` plugin above), and — the same mechanism,
    extended — composes a per-session Claude Code `--plugin-dir` carrying a
    PROJECT's own DB-authored skill/reviewer subagent alongside the shipped
    bundle when one is configured; opencode's own project skill/reviewer
    instead ride its `skills.paths`/`agent/` config keys directly — see
    [`agent-context.md`](agent-context.md)), `skills` (per-agent Skill
    discovery/enable-disable across Claude Code/codex/opencode/agy's own
    config locations, plus the hand-rolled SKILL.md frontmatter parser
    `mullion-bundle.ts`/`mullion-scaffold.ts` both reuse), `marked-region`
    (the `<!-- mullion:*:start/end -->` marker-delimited-region read/write
    helpers shared by `agent-guide.ts`, `project-briefing.ts`, and
    `mullion-scaffold.ts`), `project-briefing`/`project-tooling` (a
    project's own DB-authored briefing/skill/reviewer — resolution vs. a
    committed AGENTS.md region, and the primary-only DB row backing it,
    respectively — see [`agent-context.md`](agent-context.md)),
    `mullion-scaffold` (pure "current file contents + options → target file
    set" computation backing the scaffold-as-PR flow — see
    [`agent-context.md`](agent-context.md#scaffolding-it-into-the-repo-instead)),
    `opencode-session-transfer` (PR #696 — full opencode conversation-
    history carryover into a promoted worktree via `opencode export`/
    `import`, re-keying the imported session to the worktree's project/
    directory; local host only — see [`agent-hooks.md`](agent-hooks.md)),
    `agent-guide` (serves this doc set's own
    [`agent-guide.md`](agent-guide.md) into a spawned session at
    `SessionStart`).
  - **Devices**: `device-manager`/`device-process`/`device-defaults`/
    `device-discovery` (the Android emulator/scrcpy lifecycle — spawn under
    a transient `systemd --user` scope, adb+scrcpy attach, restart-survival
    reattach, port allocation, mDNS discovery — and its scope-naming/
    marker-file/liveness plumbing, deliberately a separate implementation
    from `pty-manager`/`session-process`, not a generalization of them),
    `avd-manager` (AVD listing/creation and installed-system-image scanning
    — the provisioning counterpart to `device-manager`'s running half; see
    [`device-panel.md`](device-panel.md)).
  - **SSH agent** (issue #820, see [`ssh-agent.md`](ssh-agent.md)):
    `ssh-agent-socket` (the local unix socket a launched session's
    `SSH_AUTH_SOCK` points at), `ssh-agent-mux` (the multiplexed channel
    protocol carried over the primary↔agent-host bridge websocket),
    `ssh-agent-fanout` (which bridge serves which enrolled host),
    `ssh-agent-filter` (per-project/session key-forwarding scope),
    `ssh-agent-relay`, `bridge-registry` (the `bridges` table's pairing-code
    issue/redeem/rotate/expiry logic), `request-scheme`.
  - **GitHub & release**: `github`/`github-integration`/
    `github-device-flow`/`git-remote`/`github-webhook`/`github-pr-poller`/
    `github-activity-tracker`/`github-ws-broadcast`/`github-app`/
    `github-write` (GitHub status + connect flows + webhook registration +
    adaptive polling + WS push + GitHub App installation-token minting +
    the write-side API client Task Master's sync/promote use — see
    [`github-integration.md`](github-integration.md)).
  - **Host & update**: `systemd-unit` (cgroup-based autodetection of the
    running unit for self-update), `update-checker` (Settings → Server's
    update surface).
- `src/mcp/` — the MCP server Mullion exposes over the same control socket
  the `mullion` CLI uses: `server.mjs` (the MCP protocol handler),
  `client.mjs` (control-socket client), `tools.mjs` (21 tool definitions
  spanning session/project/preview/browser control, device control
  (`list_devices`/`use_device`/`device_action`/`start_device`/`stop_device`/
  `delete_device`), and a project's DB-authored tooling
  (`get_project_tooling`/`set_project_tooling`) — `list_previews`/
  `set_project_tooling`/`delete_device` are full-scope-only, refused for an
  in-session agent's own session-scoped token). Copied byte-for-byte into `dist/mcp/`
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
- `deploy/` — `install.sh` (the versioned-install/self-update flow),
  `mullion.service`/`mullion-agent.service` (the primary/agent-role
  `systemd --user` unit templates), `traefik-dynamic.yml`/
  `authentik-middleware-example.yml` (reverse-proxy + identity-header
  templates for the trusted-gateway posture — see [`auth.md`](auth.md)),
  `macos/` (the macOS tray-app installer's background image) — fully
  supported native host deployment; see
  [`../deploy/README.md`](../deploy/README.md).
- `docs/` — see [`README.md`](README.md) for the full index.
- `.github/workflows/` — thin callers of the reusable workflows in
  `s3ntin3l8/.github` — see [`ci-cd.md`](ci-cd.md).
- `.claude/` — `settings.json` + `hooks/session-start.sh`: a SessionStart
  hook that installs deps and tooling so
  [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web)
  sessions can build, test, and lint (runs only in the remote env);
  `agents/mullion-reviewer.md` (a Claude Code sub-agent preloaded with this
  repo's own review invariants — see
  [`.claude/skills/mullion-review-invariants/SKILL.md`](../.claude/skills/mullion-review-invariants/SKILL.md),
  which the sub-agent reads first) and `skills/mullion-review-invariants/`
  (that skill itself, the mechanically-checkable form of this doc's own
  session model / opaque-blob / ESM / config / migration / worktree
  invariants).
