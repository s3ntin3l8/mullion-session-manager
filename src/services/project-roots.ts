import type { FastifyInstance } from "fastify";
import { expandHome, parseProjectsRootsEnv } from "./project-config.js";
import { getStoredSettings } from "./settings.js";

/**
 * Resolve the effective set of scan roots: settings.projectRoots (edited
 * from Settings -> Projects & discovery) wins when non-empty; an empty
 * settings array falls back to the deploy-time PROJECTS_ROOTS env var, so a
 * fresh install keeps working from its env config until someone actually
 * edits roots from the UI. DB-backed, so only meaningful on the primary —
 * an "agent" role (issue #26) has no settings and always uses
 * parseProjectsRootsEnv(app.config.PROJECTS_ROOTS) directly instead (see
 * routes/internal.ts).
 */
export function resolveProjectRoots(app: FastifyInstance): string[] {
  const projectRoots = getStoredSettings(app.db).projectRoots;
  if (projectRoots.length > 0) return projectRoots.map(expandHome);

  return parseProjectsRootsEnv(app.config.PROJECTS_ROOTS);
}
