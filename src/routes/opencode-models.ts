import type { FastifyInstance } from "fastify";
import { listAgyModels, listCodexModels, listOpenCodeModels } from "../services/opencode-models.js";
import { listMcodeModels } from "../services/mcode-models.js";

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

  // Same bare-array contract as the opencode route above.
  app.get("/api/agy/models", async (_request, reply) => {
    reply.type("application/json");
    return await listAgyModels();
  });

  app.get("/api/codex/models", async (_request, reply) => {
    reply.type("application/json");
    return await listCodexModels();
  });

  // Issue #1784 — mcode's model catalog. Unlike the three above this is NOT a
  // shell-out: `mcode provider list --json` hardcodes an empty model list for
  // mcode's own MiniMax providers, so the catalog is read from mcode's
  // `config.yaml` instead (see src/services/mcode-models.ts for the full
  // reasoning). Same bare-array contract.
  app.get("/api/mcode/models", async (_request, reply) => {
    reply.type("application/json");
    return await listMcodeModels();
  });
}
