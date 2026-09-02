import type { FastifyInstance } from "fastify";
import { listOpenCodeModels } from "../services/opencode-models.js";

export async function opencodeModelsRoute(app: FastifyInstance) {
  app.get("/api/opencode/models", async (_request, reply) => {
    reply.type("application/json");
    const models = await listOpenCodeModels();
    return { models };
  });
}
