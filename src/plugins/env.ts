import fp from "fastify-plugin";
import env from "@fastify/env";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

// Exported (not just used below) so test/setup.ts can derive the full list
// of config keys it needs to reset to a clean slate for every test file —
// see that file's comment for why deleting these one by one, per failing
// test, doesn't scale.
export const schema = {
  type: "object",
  required: [],
  properties: {
    NODE_ENV: {
      type: "string",
      default: "development",
      enum: ["development", "production", "test"],
    },
    PORT: {
      type: "number",
      default: 3000,
    },
    // Interface src/server.ts's app.listen() binds to. Defaults to loopback
    // only (issue #603) — a fresh install is reachable from nowhere but this
    // host until an operator deliberately widens it. A same-host reverse
    // proxy (Traefik, per deploy/README.md) reaches this over loopback and
    // is unaffected by this default; set HOST=0.0.0.0 (or a specific
    // interface address) only when Mullion itself needs to be reachable
    // directly, e.g. no gateway in front. Orthogonal to MULLION_TRUST_GATEWAY
    // below: that flag is about whether no-in-process-auth is an
    // acknowledged choice, this is about which interfaces can even dial in.
    HOST: {
      type: "string",
      default: "127.0.0.1",
    },
    LOG_LEVEL: {
      type: "string",
      default: "info",
      enum: ["fatal", "error", "warn", "info", "debug", "trace"],
    },
    DATABASE_URL: {
      type: "string",
      default: "file:./data/app.db",
    },
    DB_ENCRYPTION_KEY: {
      type: "string",
      default: "",
    },
    CORS_ORIGIN: {
      type: "string",
      default: "",
    },
    RATE_LIMIT_MAX: {
      type: "number",
      default: 100,
    },
    RATE_LIMIT_WINDOW: {
      type: "string",
      default: "1 minute",
    },
    // Directory holding dtach sockets, one per terminal session. Sessions
    // outlive this process (and its redeploys) as long as this directory
    // does too — see .claude/plans/ok-i-m-thinking-of-merry-corbato.md.
    SESSIONS_DIR: {
      type: "string",
      default: "./data/sessions",
    },
    // Built frontend assets (frontend/ has its own package.json — `npm run
    // build` there emits this dir). Resolved relative to the process cwd,
    // same as SESSIONS_DIR above. staticPlugin only serves it, and rootRoute
    // only falls back to its placeholder response, when this actually
    // exists — see src/plugins/static.ts.
    FRONTEND_DIST: {
      type: "string",
      default: "./frontend/dist",
    },
    // Comma-separated list of directories to scan (immediate subdirectories
    // only) for candidate projects — see GET /api/projects/discover in
    // src/routes/projects.ts. "~" is expanded to the server's home dir
    // (src/services/project-config.ts's expandHome()). Empty by default:
    // discovery is opt-in, never assumed.
    PROJECTS_ROOTS: {
      type: "string",
      default: "",
    },
    // Global (non-per-project) config dir for launcher/dock defaults — see
    // src/services/project-config.ts. Same "~" expansion as PROJECTS_ROOTS.
    // A per-project ".crs/" dir inside a project's own cwd always takes
    // precedence over this.
    CRS_CONFIG_DIR: {
      type: "string",
      default: "~/.config/crs",
    },
    // Multi-host support (issue #26) — "primary" (default, preserves today's
    // single-process behavior) owns the DB and serves the frontend, and will
    // proxy host-scoped work to remote "agent" processes over the internal
    // API in src/routes/internal.ts (the primary side that actually calls
    // it lands in a later PR). "agent" is DB-less: it runs PtyManager
    // locally (unchanged) and exposes only that token-gated internal API —
    // see src/app.ts's fail-closed boot check.
    MULLION_ROLE: {
      type: "string",
      default: "primary",
      enum: ["primary", "agent"],
    },
    // Signs the session cookie src/plugins/auth.ts issues once
    // MULLION_AUTH_TOKEN or MULLION_OIDC_* (issue #30) is configured. Empty
    // by default, matching every other opt-in secret here — but unlike
    // MULLION_AUTH_TOKEN, an *enabled* in-process auth with no session
    // secret is a real invariant violation (an unsigned cookie is
    // forgeable), so src/app.ts refuses to boot in that combination rather
    // than silently degrading, mirroring the MULLION_AGENT_TOKEN boot check
    // just above. Generate with `openssl rand -hex 32`; rotating it
    // invalidates all existing sessions (a deliberate way to force
    // re-login).
    MULLION_SESSION_SECRET: {
      type: "string",
      default: "",
    },
    // Shared secret an "agent" role's internal API (src/routes/internal.ts)
    // requires on every request, including the /internal/ws/attach upgrade —
    // see src/app.ts's fail-closed boot check: role "agent" with an empty
    // token refuses to start. Unused when role is "primary" — per-remote-
    // host tokens will live in the `hosts` table instead.
    //
    // Treat this as a full host-compromise credential, not a lightweight
    // API key: /internal/ws/attach runs `${SHELL} -lc "<command>"` for any
    // request bearing a valid token, so a leaked token is arbitrary command
    // execution on the agent host. Generate it with real entropy (e.g.
    // `openssl rand -hex 32`), scope it per agent, and rotate it the same
    // way you would an SSH key with shell access to that box.
    MULLION_AGENT_TOKEN: {
      type: "string",
      default: "",
    },
    // Seconds between the primary's liveness sweeps of every registered
    // remote host (issue #246 / roadmap 7.2) — a poll of each host's
    // already-unauthenticated /health route, independent of the
    // request-auth mode a given host uses. Feeds the Settings Hosts list's
    // health dot (see src/services/host-heartbeat.ts); does not affect
    // reconciler behavior for sessions on an unreachable host, which stays
    // "unknown, never exited" regardless of heartbeat status. 0 disables
    // the poller entirely (no background timer at all, same "0 = off"
    // convention as MULLION_TASK_BUDGET_MINUTES above).
    HOST_HEARTBEAT_INTERVAL_SECONDS: {
      type: "number",
      default: 30,
      minimum: 0,
    },
    // Issue #245 / roadmap 7.1 — agent-initiated registration. Six new vars,
    // split by which role reads them (an agent has no use for the two
    // primary-only ones and vice versa — see src/app.ts's role split).
    //
    // Agent side — where to find the primary and what bootstrap credential
    // to present. Deliberately a SEPARATE variable from MULLION_AGENT_TOKEN
    // above, not a reuse of it: this is an *outbound* one-time-use bootstrap
    // credential (POST /api/internal/register only), never checked against
    // an *inbound* request the way MULLION_AGENT_TOKEN is — conflating the
    // two would mean one leaked agent env file grants Bearer access to
    // every OTHER agent's /internal/ws/attach (arbitrary command execution
    // fleet-wide), the exact opposite of "a different token per agent"
    // (docs/multi-host.md). An enrolled agent has no MULLION_AGENT_TOKEN at
    // all — its inbound credential is the session the primary issues here.
    MULLION_PRIMARY_URL: {
      type: "string",
      default: "",
    },
    MULLION_ENROLLMENT_TOKEN: {
      type: "string",
      default: "",
    },
    // Self-reported baseUrl at registration time — where THIS agent is
    // actually reachable, since the primary can't otherwise know it (no
    // admin hand-typed it into Settings → Add host). Empty means
    // "autodetect" — agent-enrollment.ts falls back to hostname + PORT.
    MULLION_AGENT_ADVERTISE_URL: {
      type: "string",
      default: "",
    },
    // Optional human label shown in the primary's Hosts list; falls back to
    // hostname (same autodetect posture as ADVERTISE_URL above) when unset.
    MULLION_AGENT_NAME: {
      type: "string",
      default: "",
    },
    // Primary side — the fleet-wide shared secret an agent's
    // MULLION_ENROLLMENT_TOKEN can match to self-register a brand-new host
    // row (routes/enrollment.ts's "enroll" path). Empty (the default) means
    // this path is disabled entirely; an agent can still register by
    // *claiming* an existing, admin-created host row instead (matching its
    // token against that row's own authTokenEnc) — see routes/enrollment.ts.
    // Treat this exactly like MULLION_AGENT_TOKEN: real entropy (openssl
    // rand -hex 32), since anyone who presents it can create a host row,
    // and a host row on this app is an arbitrary-command-execution trust
    // grant (docs/multi-host.md).
    MULLION_ENROLLMENT_SECRET: {
      type: "string",
      default: "",
    },
    // Optional additional gate on the "enroll a new host" path only (never
    // the "claim an existing row" path, which already requires knowing that
    // row's own per-host token): comma-separated IPv4 CIDR ranges the
    // registering request's peer address must fall inside. Empty (the
    // default) means no additional restriction beyond the shared secret
    // itself.
    MULLION_ENROLLMENT_ALLOWED_CIDRS: {
      type: "string",
      default: "",
    },
    // Optional in-process auth (issue #19) for the primary role: a single
    // shared token/API key, checked via src/plugins/auth.ts's global
    // onRequest gate against every HTTP route and the /ws/terminal upgrade
    // (and, separately, previewProxyPlugin's own raw upgrade path — see that
    // plugin's comments). Empty by default: in-process auth is opt-in and
    // off, matching this app's existing "run behind an authenticating
    // gateway" model — see deploy/README.md. Setting this (or the
    // MULLION_OIDC_* keys below, for issue #30) also requires
    // MULLION_SESSION_SECRET, since the login endpoint mints a signed
    // session cookie for browser clients; a bearer Authorization header
    // works either way for scripts/curl. Treat this the same as
    // MULLION_AGENT_TOKEN: real entropy (openssl rand -hex 32), not a
    // memorable password.
    MULLION_AUTH_TOKEN: {
      type: "string",
      default: "",
    },
    // Required acknowledgement (issue #603) to boot the primary role with
    // neither MULLION_AUTH_TOKEN nor MULLION_OIDC_* configured — completes
    // this app's existing "every half-configured combination refuses to
    // boot" invariant (src/app.ts: partial OIDC, auth-without-session-secret,
    // a whitespace-only token, PREVIEW_AUTH_REQUIRED-without-auth,
    // agent-role-without-MULLION_AGENT_TOKEN) by closing the one gap that
    // wasn't half-configured, just silently unconfigured: with nothing set
    // here, authPlugin installs no onRequest hook at all
    // (src/plugins/auth.ts's own early return) and the dashboard is reachable
    // with no credential at all, behind nothing but a boot-time log.warn.
    // Setting this to true does NOT itself add any authorization check — it
    // is a deliberate statement that something else (normally a
    // reverse-proxy forwardAuth, e.g. Traefik+Authentik per
    // deploy/README.md) already authenticates every request before it
    // reaches this process. False by default: an operator must make this
    // choice explicitly, not inherit it as a schema default.
    MULLION_TRUST_GATEWAY: {
      type: "boolean",
      default: false,
    },
    // Native OIDC login (issue #30) — the second way (alongside
    // MULLION_AUTH_TOKEN above) to mint the same signed session cookie
    // src/plugins/auth.ts's gate checks. All four MULLION_OIDC_* keys must be
    // set together, or all left empty — src/app.ts refuses to boot on a
    // partial set (see isOidcConfigPartial in src/services/oidc.ts), since a
    // half-configured OIDC client can't complete discovery or the code
    // exchange. Setting these also requires MULLION_SESSION_SECRET, same as
    // MULLION_AUTH_TOKEN.
    //
    // The discovery/issuer URL (e.g. https://authentik.example.com/application/o/mullion/).
    MULLION_OIDC_ISSUER: {
      type: "string",
      default: "",
    },
    // Public client identifier registered at the provider — not a secret.
    MULLION_OIDC_CLIENT_ID: {
      type: "string",
      default: "",
    },
    // Confidential client secret — this process holds it and does the code
    // exchange server-side; the SPA never sees it or any OIDC token.
    MULLION_OIDC_CLIENT_SECRET: {
      type: "string",
      default: "",
    },
    // Must exactly match a redirect URI registered at the provider — e.g.
    // https://mullion.example.com/api/auth/oidc/callback. Not derived from
    // the incoming request (Host is client-controlled), and deliberately
    // explicit since this process is usually behind a reverse proxy that
    // knows its own external origin better than this process does.
    MULLION_OIDC_REDIRECT_URI: {
      type: "string",
      default: "",
    },
    // GitHub OAuth App client id (issue #27) — a public identifier, not a
    // secret, so it's fine to bake into a built frontend bundle or log line
    // unlike DB_ENCRYPTION_KEY/MULLION_AGENT_TOKEN above. Empty by default:
    // device-flow connect (Phase 4) is opt-in and simply doesn't render/
    // route until an operator registers a GitHub OAuth App (Device Flow
    // enabled) and sets this — a PAT still works with no client id at all.
    GITHUB_OAUTH_CLIENT_ID: {
      type: "string",
      default: "",
    },
    // Base host for the subdomain preview proxy (issue #28) — a preview is
    // served at "preview-<slug>.<PREVIEW_BASE_HOST>" so the proxied dev
    // server/external site sees "/" as its own root (no HTML/asset-URL
    // rewriting needed — see the plan). Empty by default: the feature is
    // opt-in and inert (src/plugins/preview-proxy.ts registers no routes,
    // GET /api/server-info reports previewsEnabled: false) until an operator
    // sets this, since it requires wildcard DNS + wildcard TLS in production
    // (see deploy/README.md).
    PREVIEW_BASE_HOST: {
      type: "string",
      default: "",
    },
    // Preview-host auth token (issue #383). Opt-in, default OFF: turning it
    // on breaks direct/bookmarked navigation straight to a preview URL (no
    // bootstrap token in that case, since the token only ever arrives via
    // BrowserPanel.tsx's own POST /api/previews/:slug/token mint) — existing
    // deployments relying on a gateway forwardAuth in front of the preview
    // router (deploy/README.md calls this "non-negotiable" when this flag is
    // off) must be unaffected by default. When on: previewProxyPlugin
    // (src/plugins/preview-proxy.ts) requires a valid bootstrap token
    // (query param) or preview cookie before proxying a preview-host
    // request, on top of whatever gateway auth already sits in front. See
    // src/services/preview-auth.ts and src/app.ts's matching boot-time
    // invariant (refuses to boot if this is true with an empty
    // MULLION_SESSION_SECRET, mirroring MULLION_AUTH_TOKEN's own check).
    PREVIEW_AUTH_REQUIRED: {
      type: "boolean",
      default: false,
    },
    // Finding AS5 — preview-host traffic is exempt from RATE_LIMIT_MAX (the
    // app-wide limiter, security.ts's own allowList) so a single preview
    // page load's dozens of subresource requests don't 429 partway through
    // the very first paint. That exemption used to have no compensating
    // meter at all when PREVIEW_AUTH_REQUIRED is off (the default) — this is
    // the ceiling on the replacement per-IP counter
    // (preview-proxy.ts's isPreviewRequestRateLimited), applied per minute.
    // Deliberately its own config, not a multiple of RATE_LIMIT_MAX baked
    // into code: a real dev server's cold load (every ESM module as its own
    // request, plus HMR) can plausibly need more headroom than an arbitrary
    // multiplier would predict, and an operator hitting this ceiling has no
    // other lever — see previewProxyPlugin's own doc comment on this
    // counter for the full reasoning.
    //
    // `minimum: 1` — same reasoning as MULLION_TASK_MAX_CONCURRENT above,
    // and unlike MULLION_TASK_BUDGET_MINUTES/_PROGRESS_COMMENT_MINUTES: 0
    // has no "unlimited" meaning here. hitFixedWindow's check is
    // `entry.count > max`, so 0 doesn't disable the limiter — the first
    // request in a window still opens it and returns false, but every
    // request after that 429s, silently taking down the whole preview
    // feature the moment an operator tries the "0 = no limit" convention
    // this schema uses elsewhere. Rejected at boot (ajv, via @fastify/env)
    // instead.
    PREVIEW_RATE_LIMIT_MAX: {
      type: "number",
      default: 2000,
      minimum: 1,
    },
    // Absolute path to the versioned-release install root (e.g.
    // ~/opt/mullion), i.e. the parent of `releases/`, `current` (a symlink
    // this process's WorkingDirectory points into), and `data/` — see
    // deploy/README.md and deploy/install.sh. Empty (the default, and every
    // dev checkout via `make dev`) means "not a versioned install": the
    // update-checker service still runs (GET /api/updates/check is always
    // safe, read-only), but POST /api/updates/apply refuses — there is no
    // releases/ dir to install into or `current` symlink to flip, and
    // self-update.sh assumes both exist.
    //
    // Also read directly off process.env (not app.config) by
    // hook-adapters/shared.ts's resolveHooksDir(), to resolve the merged
    // Codex hook's command through the stable `current` symlink rather than
    // this release's own realpath — see that file's comment (issue #259).
    MULLION_HOME: {
      type: "string",
      default: "",
    },
    // "owner/repo" polled for the latest GitHub Release by the update
    // checker (src/services/update-checker.ts) — same public, unauthenticated
    // REST API as src/services/github.ts, just a different endpoint
    // (/releases/latest vs. /issues). Defaults to this project's own repo;
    // override only for a fork publishing releases somewhere else.
    MULLION_UPDATE_REPO: {
      type: "string",
      default: "s3ntin3l8/mullion-session-manager",
    },
    // Explicit override for the systemd --user unit self-update.sh restarts
    // (src/routes/updates.ts, src/services/systemd-unit.ts). Empty (the
    // default) means "autodetect": resolve it from this process's own
    // /proc/self/cgroup at apply time, falling back to
    // resolveServiceUnit's DEFAULT_SERVICE_UNIT if that fails. Set this only
    // when a host's cgroup layout defeats autodetection — a normal
    // deploy/install.sh install (or a rename of that unit) needs no override,
    // since detection reads whatever unit is actually running.
    MULLION_SERVICE_UNIT: {
      type: "string",
      default: "",
    },
    // Whether the Claude Code hook adapter registers the blocking
    // `PreToolUse` review gate on Bash (issue #178) — see
    // src/services/hook-adapters/claude-code.ts's buildClaudeHookSettings.
    // Default OFF: an autonomous/unattended session has nobody to click
    // Approve/Deny, so gating every Bash call by default stalls it on every
    // shell command until the server-side timeout fails it closed
    // (hooks.ts's GATE_TIMEOUT_MS) — the opposite of this app's "autonomous
    // dashboard" value prop. Same "real feature, off by default" posture as
    // the roadmap's MULLION_TASK_MASTER_ENABLED. The non-blocking
    // Notification/Stop/PostToolUse hooks are unaffected by this flag and
    // stay on unconditionally.
    MULLION_REVIEW_GATE_ENABLED: {
      type: "boolean",
      default: false,
    },
    // Gates autonomous Task Master behavior — the background watcher's
    // GitHub ingest + auto-claim, and the claim/approve endpoints. Default
    // OFF, same "real feature, off by default" posture as
    // MULLION_REVIEW_GATE_ENABLED above. Does NOT gate reject (the escape
    // hatch for a task already in review — Hermes review, PR #480, fourth
    // pass), an already-claimed task's own budget enforcement/status sync,
    // or the local task board (6.9/#233) — GET/POST/PATCH/DELETE /api/tasks
    // work regardless, per the roadmap's Flag semantics decision: once
    // local tasks can exist with no GitHub issue, "GET /api/tasks returns
    // []" is no longer a property this flag can promise.
    MULLION_TASK_MASTER_ENABLED: {
      type: "boolean",
      default: false,
    },
    // GitHub issue label the task watcher polls for (issue #214). Every
    // open, locally-hosted project's repo is scanned for open issues
    // carrying this label; each becomes a pending task record.
    MULLION_TASK_LABEL: {
      type: "string",
      default: "mullion-task",
    },
    // Seconds between task-watcher poll sweeps — mirrors github-pr-poller's
    // POLL_INTERVAL_MS, just configurable here since the watcher's cadence
    // trades off directly against GitHub API quota across every connected
    // project.
    MULLION_TASK_POLL_INTERVAL: {
      type: "number",
      default: 60,
    },
    // Phase 6 Task Master safety envelope (6.2/#215, roadmap's Security &
    // trust row) — install-wide cap on tasks in "claimed"/"in_progress" at
    // once. Enforced transactionally at claim time (both manual and
    // auto-claim share the same reservation path), so this is the actual
    // ceiling on concurrently-running autonomous agents, not just a soft
    // throttle. Default 2: conservative, since each claim spawns a real
    // agent process and worktree. `minimum: 1` — unlike the budget below,
    // 0 here has no "unlimited" meaning: the cap check is
    // `inFlight.length >= max`, so 0 (or a negative value, absent this
    // bound) would make every claim 429 forever.
    MULLION_TASK_MAX_CONCURRENT: {
      type: "number",
      default: 2,
      minimum: 1,
    },
    // Phase 6 Task Master safety envelope (6.2/#215) — wall-clock minutes a
    // claim gets before the reconciler force-fails it and terminates its
    // session, regardless of what the agent is doing. 0 = unlimited (opt
    // out of the budget entirely) — the inverse of MULLION_TASK_MAX_CONCURRENT's
    // 0, which means "never." Default 120: generous enough for a real
    // task, bounded enough that a stuck/looping autonomous agent doesn't
    // run forever.
    MULLION_TASK_BUDGET_MINUTES: {
      type: "number",
      default: 120,
      minimum: 0,
    },
    // Phase 6 Task Master (6.4/#217) — minimum minutes between two
    // "in_progress" progress comments task-github-sync.ts posts to the
    // same linked issue, so a chatty agent (or a reconciler tick that
    // observes "still working" repeatedly) can't spam one comment per
    // poll. 0 = no throttle (comment every time). Default 15.
    MULLION_TASK_PROGRESS_COMMENT_MINUTES: {
      type: "number",
      default: 15,
      minimum: 0,
    },
    // Whether an unattended task spawn (claim/auto-claim/retry/review agent)
    // passes skipPermissions through to the agent's own flag. Default OFF:
    // an unattended agent bypassing every permission prompt is a deliberate
    // opt-in, not the safe default — same posture as
    // MULLION_TASK_MASTER_ENABLED/MULLION_REVIEW_GATE_ENABLED above.
    // Distinct from settings.launchers.skipPermissionsAgents, which only
    // drives the frontend's manual-launch CommandPalette and never reaches
    // task-claim.ts's spawns. Overridable at runtime via
    // settings.taskMaster.skipPermissions, same two-layer contract as the
    // rest of this envelope (see task-config.ts).
    MULLION_TASK_SKIP_PERMISSIONS: {
      type: "boolean",
      default: false,
    },
    // Public base URL for GitHub webhook delivery (issue #221). This is the
    // URL GitHub posts events to — typically a path behind the reverse proxy
    // that serves the frontend (e.g. https://mullion.example.com/api/webhooks/github).
    // Empty by default: webhooks are opt-in and inert (the registration
    // toggle, the webhook handler route, and the adaptive-polling safety-net
    // all coexist without it — see github-pr-poller.ts).
    MULLION_WEBHOOK_BASE_URL: {
      type: "string",
      default: "",
    },
    // HMAC secret for webhook payload verification. If empty on first enable,
    // the webhook registration service auto-generates one. Once set, persists
    // across restarts so already-registered webhooks keep working.
    MULLION_WEBHOOK_SECRET: {
      type: "string",
      default: "",
    },
    // Seconds between adaptive poller ticks when a repo has open PRs or
    // running CI. Lower = more responsive, higher = less GitHub API quota burn.
    GITHUB_POLL_INTERVAL_ACTIVE: {
      type: "number",
      default: 15,
    },
    // Seconds between adaptive poller ticks when no repo has open PRs or
    // running CI. Matches the original 60s poll interval.
    GITHUB_POLL_INTERVAL_QUIET: {
      type: "number",
      default: 60,
    },
    // Seconds without a webhook delivery before the poller goes into stalled
    // mode (a safety-net re-sync at 30s). Once a webhook is received, the
    // poller returns to active/quiet as appropriate.
    GITHUB_POLL_STALE_THRESHOLD: {
      type: "number",
      default: 300,
    },
    // Phase 3 (#179) — gates the whole Playwright-driven Controllable
    // Browser feature: BrowserManager refuses to launch Chromium (every
    // method throws) and the browser WS/REST routes (#180/#183) return a
    // clear 4xx when this is false. Default OFF, same "real feature, off by
    // default" posture as MULLION_REVIEW_GATE_ENABLED/MULLION_TASK_MASTER_ENABLED
    // above — Playwright's Chromium download is a meaningful host footprint
    // (see deploy/install.sh) that shouldn't happen just because the
    // `playwright` package is now a runtime dependency.
    BROWSER_ENABLED: {
      type: "boolean",
      default: false,
    },
    // Bounds concurrent Chromium processes in the pool (one per project,
    // reused across pane open/close — see src/services/browser-manager.ts).
    // Each headless Chromium instance is real host memory even at idle.
    BROWSER_MAX_INSTANCES: {
      type: "number",
      default: 4,
    },
    // Target frames-per-second for the CDP screenshot stream (#180) —
    // configurable since it trades bandwidth/CPU against perceived
    // responsiveness.
    BROWSER_FRAMERATE: {
      type: "number",
      default: 10,
    },
    // Where per-project Playwright storage state (cookies/localStorage —
    // what lets a project's browser "persist across restarts", per #179) is
    // written. Cwd-relative default matches SESSIONS_DIR's own convention; a
    // versioned-release install overrides this to an absolute path the same
    // way (see deploy/install.sh) — a cwd-relative path would otherwise
    // resolve inside the `current` symlink and get orphaned on update.
    BROWSER_DATA_DIR: {
      type: "string",
      default: "./data/browsers",
    },
    // Phase 4 (#185) — path for the general-purpose control-socket listener
    // (src/plugins/control-socket.ts), the transport behind the `mullion`
    // CLI and any other local script that wants session/browser/event access
    // without an HTTP base URL or bearer token. Empty (the default) means
    // "derive from SESSIONS_DIR" (PtyManager.controlSocketPath — mirrors
    // hookSocketPath's own `<SESSIONS_DIR>/hooks.sock` placement) rather than
    // a fixed `~/.crs/mullion.sock`: SESSIONS_DIR is already the directory a
    // versioned install overrides to an absolute path (see BROWSER_DATA_DIR's
    // comment above and deploy/install.sh) — a literal `~/.crs/` default
    // would bypass that override and the 108-byte sun_path redirect
    // SESSIONS_DIR already carries (see commit 79b565c). Set this only to
    // relocate the socket off SESSIONS_DIR entirely.
    MULLION_SOCKET_PATH: {
      type: "string",
      default: "",
    },
  },
};

// Makes this project's own .env authoritative over whatever happened to
// already be in process.env — needed because a terminal session run
// *inside* Mullion inherits the server's entire environment (PORT,
// DATABASE_URL, SESSIONS_DIR, ...) through the dtach/systemd-run process
// chain. Without this, a `make dev` started from such a session silently
// loses to an inherited PORT=3100 (or worse, DATABASE_URL/SESSIONS_DIR
// pointing at a production install's live DB/sockets) — issue #70. See
// pty-manager.ts's buildSessionEnv() for the source-side half of this fix
// (scrubbing those vars before a session is even spawned).
//
// @fastify/env's own `dotenv` option (backed by env-schema) has no override
// semantics — env-schema always lets process.env win over a loaded .env, and
// its `dotenv` option doesn't accept one (it doesn't even use the `dotenv`
// npm package internally, just node:util's parseEnv). So this loads .env
// itself and hands the parsed values to env-schema's `data` option instead,
// which — per env-schema's own merge order (env: true's process.env is
// merged first, `data` last) — wins over process.env. `dotenv` stays off
// since we've already handled loading it here.
//
// Deliberately does NOT write into process.env itself (e.g. via
// Object.assign(process.env, parsed)): that would leak past app.config into
// anything else reading process.env directly, and persist for the life of
// the process — an even wider blast radius than the bug it fixes. (It would
// also self-sabotage in exactly the scenario this fix targets: on a host
// where NODE_ENV itself arrived inherited/polluted, as observed on this box,
// mutating the real process.env is the last thing you want.) app.config is
// the only sanctioned way the rest of this app reads its own config; the one
// exception is src/db/client.ts's getDb(), used only by the standalone
// db:seed script outside the fastify app, unaffected either way.
//
// Trade-off: this also means an explicit shell override now loses to .env,
// e.g. `PORT=9999 make dev` binds whatever PORT is in .env, not 9999.
// Acceptable here since .env is meant to be the source of truth for a dev
// checkout.
//
// Inert in production: the systemd unit's WorkingDirectory is the release
// `current` symlink, which never has a .env of its own (see
// deploy/README.md) — existsSync(".env") is false there, so nothing is
// overridden.
//
// Skipped entirely under test — see env.test.ts for why the "respects
// environment variable overrides" test isn't affected by (and doesn't
// guard) this.
//
// `path` is exported/parameterized for tests only — production always calls
// this with no argument (the real ".env" at cwd); see env.test.ts's
// dedicated fixture-file test for the precedence flip this enables (an
// inherited process.env losing to .env), which the default call path can't
// exercise since it always resolves to this same real, gitignored file.
export function loadDotenvOverrides(path = ".env"): NodeJS.Dict<string> {
  if (process.env.NODE_ENV === "test") return {};
  if (!existsSync(path)) return {};
  return parseEnv(readFileSync(path, "utf8"));
}

export const envPlugin = fp(async (app) => {
  await app.register(env, {
    schema: schema,
    dotenv: false,
    data: loadDotenvOverrides(),
  });

  if (
    app.config.MULLION_WEBHOOK_BASE_URL &&
    !app.config.MULLION_WEBHOOK_BASE_URL.startsWith("https://")
  ) {
    throw new Error("MULLION_WEBHOOK_BASE_URL must start with https://");
  }
  if (app.config.MULLION_WEBHOOK_BASE_URL) {
    try {
      new URL(app.config.MULLION_WEBHOOK_BASE_URL);
    } catch {
      throw new Error("MULLION_WEBHOOK_BASE_URL is not a valid URL");
    }
  }

  // Issue #245 / roadmap 7.1 — MULLION_PRIMARY_URL isn't restricted to
  // https:// the way MULLION_WEBHOOK_BASE_URL is above (a primary reached
  // over a private network/VPN on plain http is the common case for this
  // feature, same admin-trust posture as routes/hosts.ts's own baseUrl
  // validation), just checked for being a well-formed URL at all.
  if (app.config.MULLION_PRIMARY_URL) {
    let parsed: URL;
    try {
      parsed = new URL(app.config.MULLION_PRIMARY_URL);
    } catch {
      throw new Error("MULLION_PRIMARY_URL is not a valid URL");
    }
    // Hermes review, PR #528: new URL() accepts any scheme (ftp://,
    // file://, ...) — without this, a typo'd protocol passes boot
    // validation and the agent then retries a doomed fetch() against it
    // forever (agent-enrollment.ts's retry/backoff loop), failing silently
    // instead of refusing to boot with a clear error.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("MULLION_PRIMARY_URL must be an http(s) URL");
    }
  }
  if (app.config.MULLION_AGENT_ADVERTISE_URL) {
    let parsed: URL;
    try {
      parsed = new URL(app.config.MULLION_AGENT_ADVERTISE_URL);
    } catch {
      throw new Error("MULLION_AGENT_ADVERTISE_URL is not a valid URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("MULLION_AGENT_ADVERTISE_URL must be an http(s) URL");
    }
  }
});

declare module "fastify" {
  interface FastifyInstance {
    config: {
      NODE_ENV: "development" | "production" | "test";
      PORT: number;
      HOST: string;
      LOG_LEVEL: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
      DATABASE_URL: string;
      DB_ENCRYPTION_KEY: string;
      CORS_ORIGIN: string;
      RATE_LIMIT_MAX: number;
      RATE_LIMIT_WINDOW: string;
      SESSIONS_DIR: string;
      FRONTEND_DIST: string;
      PROJECTS_ROOTS: string;
      CRS_CONFIG_DIR: string;
      MULLION_ROLE: "primary" | "agent";
      MULLION_AGENT_TOKEN: string;
      HOST_HEARTBEAT_INTERVAL_SECONDS: number;
      MULLION_PRIMARY_URL: string;
      MULLION_ENROLLMENT_TOKEN: string;
      MULLION_AGENT_ADVERTISE_URL: string;
      MULLION_AGENT_NAME: string;
      MULLION_ENROLLMENT_SECRET: string;
      MULLION_ENROLLMENT_ALLOWED_CIDRS: string;
      MULLION_AUTH_TOKEN: string;
      MULLION_TRUST_GATEWAY: boolean;
      MULLION_SESSION_SECRET: string;
      MULLION_OIDC_ISSUER: string;
      MULLION_OIDC_CLIENT_ID: string;
      MULLION_OIDC_CLIENT_SECRET: string;
      MULLION_OIDC_REDIRECT_URI: string;
      GITHUB_OAUTH_CLIENT_ID: string;
      PREVIEW_BASE_HOST: string;
      PREVIEW_AUTH_REQUIRED: boolean;
      PREVIEW_RATE_LIMIT_MAX: number;
      MULLION_HOME: string;
      MULLION_UPDATE_REPO: string;
      MULLION_SERVICE_UNIT: string;
      MULLION_REVIEW_GATE_ENABLED: boolean;
      MULLION_TASK_MASTER_ENABLED: boolean;
      MULLION_TASK_LABEL: string;
      MULLION_TASK_POLL_INTERVAL: number;
      MULLION_TASK_MAX_CONCURRENT: number;
      MULLION_TASK_BUDGET_MINUTES: number;
      MULLION_TASK_PROGRESS_COMMENT_MINUTES: number;
      MULLION_TASK_SKIP_PERMISSIONS: boolean;
      BROWSER_ENABLED: boolean;
      BROWSER_MAX_INSTANCES: number;
      BROWSER_FRAMERATE: number;
      BROWSER_DATA_DIR: string;
      MULLION_SOCKET_PATH: string;
      MULLION_WEBHOOK_BASE_URL: string;
      MULLION_WEBHOOK_SECRET: string;
      GITHUB_POLL_INTERVAL_ACTIVE: number;
      GITHUB_POLL_INTERVAL_QUIET: number;
      GITHUB_POLL_STALE_THRESHOLD: number;
    };
  }
}
