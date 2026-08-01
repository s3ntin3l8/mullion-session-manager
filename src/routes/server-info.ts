import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveTaskMasterConfig } from "../services/task-config.js";

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
      role: app.config.MULLION_ROLE,
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
      // Issue #383 — whether preview-proxy.ts's bootstrap-token/cookie gate
      // is active. BrowserPanel.tsx mints a bootstrap token (POST
      // /api/previews/:slug/token) and appends it to a preview iframe's URL
      // only when this is true; leaving it off (the default) keeps
      // direct/bookmarked navigation to a preview URL working with no
      // change in behavior.
      previewAuthRequired: app.config.PREVIEW_AUTH_REQUIRED,
      // Phase 2.5 Task Master (Thin Slice) — the frontend's single source of
      // truth for whether autonomous behavior (claim/approve/reject) is
      // available; the Tasks panel itself and the local board always
      // render regardless (see routes/tasks.ts's own doc comment — GET
      // /api/tasks always 200s with the local board's rows). Settings UI
      // follow-up: this now reports the *resolved* value (env default,
      // overridable via settings.taskMaster.enabled), not the raw env var —
      // flipping the Settings toggle updates this without a restart.
      taskMasterEnabled: resolveTaskMasterConfig(app).enabled,
      // Read-only display for Settings -> Task Master's "Environment
      // default: N" hints and its four editable fields' effective-value
      // fallback — same read-only-diagnostics precedent as rateLimit/
      // projectsRoots above. issueLabel/pollIntervalSeconds are here too
      // even though they're not settings-overridable (see task-config.ts's
      // doc comment on why): the section still needs to *display* them.
      taskMasterEnv: {
        enabled: app.config.MULLION_TASK_MASTER_ENABLED,
        maxConcurrent: app.config.MULLION_TASK_MAX_CONCURRENT,
        budgetMinutes: app.config.MULLION_TASK_BUDGET_MINUTES,
        progressCommentMinutes: app.config.MULLION_TASK_PROGRESS_COMMENT_MINUTES,
        issueLabel: app.config.MULLION_TASK_LABEL,
        pollIntervalSeconds: app.config.MULLION_TASK_POLL_INTERVAL,
      },
    };
  });
}
