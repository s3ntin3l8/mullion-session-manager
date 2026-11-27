// Issue #3588 — what the preview proxy answers when a branch preview's dev
// server has exited: a readable page (for a browser that accepts HTML) saying
// so, with the exit code and the last lines of its output, instead of the raw
// `{"statusCode":502,…,"message":"preview unavailable"}`. API and other
// non-HTML clients keep the fixed JSON body.
//
// The output comes from the session row (`last_output`/`last_exit_code`,
// captured by the reconciler before the scope and the worktree went away,
// dock-exit-report.ts). It is the previewed dev server's own output, served
// on the preview's own host behind the same preview auth as the dev server
// itself — so the proxy never sends this page with its reflected-origin CORS
// header, which is only safe for the fixed error bodies.

import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { projects, sessions } from "../db/schema.js";
import { getPreviewBySlug } from "./preview-registry.js";

export const NO_RECIPE_HINT =
  "This project has no setup recipe; new worktrees and other hosts get no dependencies. Set one under the project's Agent context & skills (Setup recipe).";

export interface ExitedPreviewReport {
  branch: string | null;
  exitCode: number | null;
  output: string | null;
  noRecipe: boolean;
}

/** The report for `slug` when it is a BRANCH preview (its own branch and
 * port, not the project checkout's preview, which proxies to `devServerUrl`
 * whatever session it was last bound to) whose bound dock session is no
 * longer active; null otherwise. */
export function exitedPreviewReport(
  app: FastifyInstance,
  slug: string,
): ExitedPreviewReport | null {
  const preview = getPreviewBySlug(app, slug);
  if (!preview || preview.kind !== "project" || preview.sessionId === null) return null;
  if (preview.portPreview || !preview.branch || preview.upstreamPort === null) return null;
  const [row] = app.db
    .select({
      status: sessions.status,
      lastOutput: sessions.lastOutput,
      lastExitCode: sessions.lastExitCode,
      setupHint: sessions.setupHint,
      projectId: sessions.projectId,
      kind: sessions.kind,
    })
    .from(sessions)
    .where(eq(sessions.id, preview.sessionId))
    .all();
  if (!row || row.status === "active" || row.kind !== "dock") return null;
  let noRecipe = row.setupHint === "no-recipe";
  if (noRecipe && row.projectId !== null) {
    // Set since the start: the hint no longer applies.
    const [project] = app.db
      .select({ setupRecipe: projects.setupRecipe })
      .from(projects)
      .where(eq(projects.id, row.projectId))
      .all();
    if (project?.setupRecipe?.trim()) noRecipe = false;
  }
  return {
    branch: preview.branch ?? null,
    exitCode: row.lastExitCode,
    output: row.lastOutput,
    noRecipe,
  };
}

/** Whether a request's Accept header asks for HTML (a browser navigation). */
export function acceptsHtml(accept: string | string[] | undefined): boolean {
  const value = Array.isArray(accept) ? accept.join(",") : (accept ?? "");
  return /\btext\/html\b/i.test(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The page. No script; every interpolated value is escaped. `dashboardUrl`
 * is the operator's PREVIEW_AUTH_DASHBOARD_URL (boot-validated), or empty. */
export function buildExitedPreviewHtml(report: ExitedPreviewReport, dashboardUrl: string): string {
  const what = report.branch ? `The dev server for ${report.branch}` : "The dev server";
  const code = report.exitCode !== null ? ` (code ${report.exitCode})` : "";
  const headline = `${what} exited${code}.`;
  const output = report.output
    ? `<p>Its last output:</p><pre>${escapeHtml(report.output)}</pre>`
    : "<p>It left no output to show.</p>";
  const hint = report.noRecipe ? `<p><strong>${escapeHtml(NO_RECIPE_HINT)}</strong></p>` : "";
  const back = dashboardUrl
    ? `<p><a href="${escapeHtml(dashboardUrl)}">Back to the Mullion dashboard</a> to start it again.</p>`
    : "<p>Start it again from the Mullion dashboard.</p>";
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>Dev server exited</title>' +
    "<style>body{font-family:system-ui,sans-serif;margin:2rem;max-width:60rem;color:#222}" +
    "pre{background:#f4f4f4;padding:1rem;overflow:auto;white-space:pre-wrap}</style></head>" +
    `<body><h1>${escapeHtml(headline)}</h1>${hint}${output}${back}</body></html>`
  );
}
