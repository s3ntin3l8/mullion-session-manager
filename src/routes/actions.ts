import type { FastifyInstance } from "fastify";
import { getCachedAgents } from "../services/agent-detect.js";
import { resolveGlobalActions, type Launcher } from "../services/project-config.js";

/**
 * The global (non-project-specific) launcher preset list: every detected,
 * actually-available shell/agent CLI (src/services/agent-detect.js) plus
 * the user's own global `.crs/actions.json` under CRS_CONFIG_DIR — the
 * unified launcher concept behind vision items #5/#6/#7 (see the plan).
 * Shared with GET /api/projects/:id/actions (projects.ts), which layers a
 * project's own config sources on top of this same list.
 */
export async function resolveGlobalPresets(app: FastifyInstance): Promise<Launcher[]> {
  const detected = await getCachedAgents();
  const globalConfig = resolveGlobalActions(app.config.CRS_CONFIG_DIR);

  const merged = new Map<string, Launcher>();
  for (const agent of detected.filter((a) => a.available)) {
    merged.set(agent.id, { id: agent.id, title: agent.title, command: agent.command, kind: agent.kind });
  }
  // A user's own global config can override a detected preset's command by
  // reusing its id (e.g. always launch "claude --resume" instead of "claude").
  for (const launcher of globalConfig) merged.set(launcher.id, launcher);

  return [...merged.values()];
}

export async function actionsRoute(app: FastifyInstance) {
  app.get("/api/actions", async () => {
    return resolveGlobalPresets(app);
  });
}
