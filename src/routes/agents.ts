import type { FastifyInstance } from "fastify";
import { getCachedAgents } from "../services/agent-detect.js";

export async function agentsRoute(app: FastifyInstance) {
  app.get<{ Querystring: { refresh?: string } }>("/api/agents", async (request) => {
    return getCachedAgents(request.query.refresh === "1");
  });
}
