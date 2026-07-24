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
    // Absolute path to the versioned-release install root (e.g.
    // ~/opt/mullion), i.e. the parent of `releases/`, `current` (a symlink
    // this process's WorkingDirectory points into), and `data/` — see
    // deploy/README.md and deploy/install.sh. Empty (the default, and every
    // dev checkout via `make dev`) means "not a versioned install": the
    // update-checker service still runs (GET /api/updates/check is always
    // safe, read-only), but POST /api/updates/apply refuses — there is no
    // releases/ dir to install into or `current` symlink to flip, and
    // self-update.sh assumes both exist.
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
});

declare module "fastify" {
  interface FastifyInstance {
    config: {
      NODE_ENV: "development" | "production" | "test";
      PORT: number;
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
      MULLION_AUTH_TOKEN: string;
      MULLION_SESSION_SECRET: string;
      MULLION_OIDC_ISSUER: string;
      MULLION_OIDC_CLIENT_ID: string;
      MULLION_OIDC_CLIENT_SECRET: string;
      MULLION_OIDC_REDIRECT_URI: string;
      GITHUB_OAUTH_CLIENT_ID: string;
      PREVIEW_BASE_HOST: string;
      MULLION_HOME: string;
      MULLION_UPDATE_REPO: string;
      MULLION_SERVICE_UNIT: string;
    };
  }
}
