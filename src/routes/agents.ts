import type { FastifyInstance } from "fastify";
import { getCachedAgents } from "../services/agent-detect.js";
import { SKIP_PERMISSION_FLAGS } from "../services/pty-manager.js";

export async function agentsRoute(app: FastifyInstance) {
  app.get<{ Querystring: { refresh?: string } }>("/api/agents", async (request) => {
    return getCachedAgents(request.query.refresh === "1");
  });

  app.get("/api/agents/skip-permissions-flags", async () => {
    return SKIP_PERMISSION_FLAGS;
  });
}
