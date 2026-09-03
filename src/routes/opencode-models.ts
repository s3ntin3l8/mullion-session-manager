import type { FastifyInstance } from "fastify";
import { listOpenCodeModels } from "../services/opencode-models.js";

export async function opencodeModelsRoute(app: FastifyInstance) {
  app.get("/api/opencode/models", async (_request, reply) => {
    reply.type("application/json");
    // Bare array, matching every other list endpoint in this app (/api/bridges,
    // /api/hosts, /api/skills, /api/workspaces, /api/actions, /api/projects —
    // all typed `request<T[]>` on the frontend). Do NOT wrap this in
    // `{ models }` — frontend/src/api/system.ts's `listOpenCodeModels` is typed
    // `request<string[]>`, and the mismatch crashed ModelsSection's `.map()`
    // silently past `tsc` (the response body is asserted `as Promise<T>`).
    return await listOpenCodeModels();
  });
}
