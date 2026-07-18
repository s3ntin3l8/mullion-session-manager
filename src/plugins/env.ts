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
      GITHUB_OAUTH_CLIENT_ID: string;
      PREVIEW_BASE_HOST: string;
    };
  }
}
