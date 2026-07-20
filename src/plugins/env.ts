import fp from "fastify-plugin";
import env from "@fastify/env";

const schema = {
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
    TESSERA_ROLE: {
      type: "string",
      default: "primary",
      enum: ["primary", "agent"],
    },
    // Signs the session cookie src/plugins/auth.ts issues once
    // TESSERA_AUTH_TOKEN or TESSERA_OIDC_* (issue #30) is configured. Empty
    // by default, matching every other opt-in secret here — but unlike
    // TESSERA_AUTH_TOKEN, an *enabled* in-process auth with no session
    // secret is a real invariant violation (an unsigned cookie is
    // forgeable), so src/app.ts refuses to boot in that combination rather
    // than silently degrading, mirroring the TESSERA_AGENT_TOKEN boot check
    // just above. Generate with `openssl rand -hex 32`; rotating it
    // invalidates all existing sessions (a deliberate way to force
    // re-login).
    TESSERA_SESSION_SECRET: {
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
    TESSERA_AGENT_TOKEN: {
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
    // TESSERA_OIDC_* keys below, for issue #30) also requires
    // TESSERA_SESSION_SECRET, since the login endpoint mints a signed
    // session cookie for browser clients; a bearer Authorization header
    // works either way for scripts/curl. Treat this the same as
    // TESSERA_AGENT_TOKEN: real entropy (openssl rand -hex 32), not a
    // memorable password.
    TESSERA_AUTH_TOKEN: {
      type: "string",
      default: "",
    },
    // Native OIDC login (issue #30) — the second way (alongside
    // TESSERA_AUTH_TOKEN above) to mint the same signed session cookie
    // src/plugins/auth.ts's gate checks. All four TESSERA_OIDC_* keys must be
    // set together, or all left empty — src/app.ts refuses to boot on a
    // partial set (see isOidcConfigPartial in src/services/oidc.ts), since a
    // half-configured OIDC client can't complete discovery or the code
    // exchange. Setting these also requires TESSERA_SESSION_SECRET, same as
    // TESSERA_AUTH_TOKEN.
    //
    // The discovery/issuer URL (e.g. https://authentik.example.com/application/o/tessera/).
    TESSERA_OIDC_ISSUER: {
      type: "string",
      default: "",
    },
    // Public client identifier registered at the provider — not a secret.
    TESSERA_OIDC_CLIENT_ID: {
      type: "string",
      default: "",
    },
    // Confidential client secret — this process holds it and does the code
    // exchange server-side; the SPA never sees it or any OIDC token.
    TESSERA_OIDC_CLIENT_SECRET: {
      type: "string",
      default: "",
    },
    // Must exactly match a redirect URI registered at the provider — e.g.
    // https://tessera.example.com/api/auth/oidc/callback. Not derived from
    // the incoming request (Host is client-controlled), and deliberately
    // explicit since this process is usually behind a reverse proxy that
    // knows its own external origin better than this process does.
    TESSERA_OIDC_REDIRECT_URI: {
      type: "string",
      default: "",
    },
    // GitHub OAuth App client id (issue #27) — a public identifier, not a
    // secret, so it's fine to bake into a built frontend bundle or log line
    // unlike DB_ENCRYPTION_KEY/TESSERA_AGENT_TOKEN above. Empty by default:
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
    // ~/opt/tessera), i.e. the parent of `releases/`, `current` (a symlink
    // this process's WorkingDirectory points into), and `data/` — see
    // deploy/README.md and deploy/install.sh. Empty (the default, and every
    // dev checkout via `make dev`) means "not a versioned install": the
    // update-checker service still runs (GET /api/updates/check is always
    // safe, read-only), but POST /api/updates/apply refuses — there is no
    // releases/ dir to install into or `current` symlink to flip, and
    // self-update.sh assumes both exist.
    TESSERA_HOME: {
      type: "string",
      default: "",
    },
    // "owner/repo" polled for the latest GitHub Release by the update
    // checker (src/services/update-checker.ts) — same public, unauthenticated
    // REST API as src/services/github.ts, just a different endpoint
    // (/releases/latest vs. /issues). Defaults to this project's own repo;
    // override only for a fork publishing releases somewhere else.
    TESSERA_UPDATE_REPO: {
      type: "string",
      default: "s3ntin3l8/tessera-session-manager",
    },
  },
};

export const envPlugin = fp(async (app) => {
  await app.register(env, {
    schema: schema,
    // Skip a real local .env under test: it's a developer's own machine
    // config (e.g. a PORT override to dodge another project's dev server
    // on the same box) and process.env always wins over it anyway, but an
    // *absent* key falls through to the .env file's value rather than the
    // schema default, which would make "defaults" tests fail depending on
    // what happens to be in a contributor's untracked .env. CI never has
    // one (it's gitignored), so this only changes local test behavior.
    dotenv: process.env.NODE_ENV !== "test",
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
      TESSERA_ROLE: "primary" | "agent";
      TESSERA_AGENT_TOKEN: string;
      TESSERA_AUTH_TOKEN: string;
      TESSERA_SESSION_SECRET: string;
      TESSERA_OIDC_ISSUER: string;
      TESSERA_OIDC_CLIENT_ID: string;
      TESSERA_OIDC_CLIENT_SECRET: string;
      TESSERA_OIDC_REDIRECT_URI: string;
      GITHUB_OAUTH_CLIENT_ID: string;
      PREVIEW_BASE_HOST: string;
      TESSERA_HOME: string;
      TESSERA_UPDATE_REPO: string;
    };
  }
}
