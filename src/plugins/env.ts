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
    };
  }
}