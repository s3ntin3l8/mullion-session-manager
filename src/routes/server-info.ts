import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Read once at module load — package.json never changes at runtime, and this
// avoids a filesystem hit on every request. Resolved relative to this file
// (not process.cwd()) so it's correct regardless of where the process is
// launched from, matching the pattern other path-resolution in this repo
// uses (see pty-manager.ts's constructor comment on SESSIONS_DIR).
const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
// Exported for reuse by src/routes/updates.ts, which needs the same
// "what version am I" value to compare against the latest GitHub release.
export const appVersion =
  (JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: string }).version ??
  "unknown";

// `DATABASE_URL` is a `file:` URL (e.g. "file:./data/app.db", see
// plugins/env.ts) — strip the scheme for a plain filesystem path to display,
// same idea as the sessionsDir/crsConfigDir paths below.
function dbPathFromUrl(databaseUrl: string): string {
  return databaseUrl.replace(/^file:/, "");
}

// Read-only diagnostics for the Settings -> Server info tab (Phase 4b of the
// UI redesign plan). Deliberately never exposes DB_ENCRYPTION_KEY itself —
// only whether encryption-at-rest is enabled, mirroring how the frontend
// should never see secrets, just their presence/absence.
export async function serverInfoRoute(app: FastifyInstance) {
  app.get("/api/server-info", async () => {
    return {
      version: appVersion,
      // "primary" always, in practice — this route only registers on the
      // primary role branch (src/app.ts skips it for "agent"), but surfaced
      // anyway so the Settings -> Server info tab has a single source for
      // it rather than the frontend hardcoding an assumption about which
      // role it's always talking to.
      role: app.config.TESSERA_ROLE,
      nodeEnv: app.config.NODE_ENV,
      port: app.config.PORT,
      encryptionEnabled: app.config.DB_ENCRYPTION_KEY.length > 0,
      sessionsDir: app.config.SESSIONS_DIR,
      dbPath: dbPathFromUrl(app.config.DATABASE_URL),
      // Seconds since this process started — the health banner's "uptime
      // 3d 14h" row. Whole seconds (not ms): nothing here needs sub-second
      // precision and it keeps the payload/formatting simple.
      uptimeSeconds: Math.floor(process.uptime()),
      rateLimit: {
        max: app.config.RATE_LIMIT_MAX,
        window: app.config.RATE_LIMIT_WINDOW,
      },
      // Read-only display for Settings -> Server info (deploy-time env
      // default — the *editable* runtime list lives in settings.projectRoots
      // via GET /api/settings, see src/routes/projects.ts's
      // resolveProjectRoots). Neither of these is secret, just local
      // filesystem paths this server was configured with.
      projectsRoots: app.config.PROJECTS_ROOTS,
      crsConfigDir: app.config.CRS_CONFIG_DIR,
      // Issue #28 — the frontend builds a preview pane's iframe src from
      // this ("preview-<slug>.<previewBaseHost>") and uses previewsEnabled
      // to decide whether to render the browser-pane trigger at all; both
      // are derived from the same opt-in env var (see plugins/env.ts).
      previewsEnabled: app.config.PREVIEW_BASE_HOST.trim() !== "",
      previewBaseHost: app.config.PREVIEW_BASE_HOST,
    };
  });
}
