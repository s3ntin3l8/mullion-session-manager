import type { FastifyInstance } from "fastify";
import {
  disconnect,
  getIntegration,
  InvalidTokenError,
  setPat,
} from "../services/github-integration.js";

interface SetTokenBody {
  token: string;
}

const setTokenSchema = {
  body: {
    type: "object",
    required: ["token"],
    additionalProperties: false,
    properties: {
      token: { type: "string", minLength: 1 },
    },
  },
};

// No auth hook here, same app-wide gateway-auth assumption as every other
// route (settings.ts, hosts.ts, projects.ts) — see settings.ts's comment.
// This is exactly why the summary this route returns never includes the
// token itself, only `connected`/`login`/`scopes` — see
// GitHubIntegrationSummary in services/github-integration.ts.
export async function integrationsRoute(app: FastifyInstance) {
  // No explicit reply.type() here (unlike settings.ts's GET/PATCH) —
  // Fastify already serializes a returned plain object as
  // application/json on its own, and hosts.ts/projects.ts don't set it
  // either. settings.ts's explicit call guards a genuinely free-form
  // string (the session-name pattern); the one free-form-ish field here,
  // `login`, is a GitHub username GitHub itself restricts to
  // alphanumeric/hyphen, not arbitrary user input (Hermes review, PR #38).
  app.get("/api/integrations/github", async () => {
    return getIntegration(app);
  });

  // Rate-limited like GET /api/projects/discover (src/routes/projects.ts) —
  // this also reaches out to api.github.com, so it shouldn't be hammerable.
  app.put<{ Body: SetTokenBody }>(
    "/api/integrations/github/token",
    { schema: setTokenSchema, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      try {
        return await setPat(app, request.body.token);
      } catch (err) {
        if (err instanceof InvalidTokenError) {
          return reply.badRequest(err.message);
        }
        throw err;
      }
    },
  );

  app.delete("/api/integrations/github", async (_request, reply) => {
    disconnect(app);
    reply.code(204);
  });
}
