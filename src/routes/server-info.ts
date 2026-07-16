import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Read once at module load — package.json never changes at runtime, and this
// avoids a filesystem hit on every request. Resolved relative to this file
// (not process.cwd()) so it's correct regardless of where the process is
// launched from, matching the pattern other path-resolution in this repo
// uses (see pty-manager.ts's constructor comment on SESSIONS_DIR).
const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
const appVersion =
  (JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: string }).version ??
  "unknown";

// Read-only diagnostics for the Settings -> Server info tab (Phase 4b of the
// UI redesign plan). Deliberately never exposes DB_ENCRYPTION_KEY itself —
// only whether encryption-at-rest is enabled, mirroring how the frontend
// should never see secrets, just their presence/absence.
export async function serverInfoRoute(app: FastifyInstance) {
  app.get("/api/server-info", async () => {
    return {
      version: appVersion,
      nodeEnv: app.config.NODE_ENV,
      port: app.config.PORT,
      encryptionEnabled: app.config.DB_ENCRYPTION_KEY.length > 0,
      sessionsDir: app.config.SESSIONS_DIR,
      rateLimit: {
        max: app.config.RATE_LIMIT_MAX,
        window: app.config.RATE_LIMIT_WINDOW,
      },
      // Read-only display for Settings -> Projects & Launchers (neither is
      // secret — just local filesystem paths this server was configured
      // with; editing them from the browser is deliberately out of scope,
      // see the Phase 4b plan's "Backend gaps" section).
      projectsRoots: app.config.PROJECTS_ROOTS,
      crsConfigDir: app.config.CRS_CONFIG_DIR,
    };
  });
}
