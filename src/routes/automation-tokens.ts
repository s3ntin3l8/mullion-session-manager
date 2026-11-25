import type { FastifyInstance } from "fastify";
import { AUTOMATION_TOKEN_SCOPES, type AutomationTokenScope } from "../shared/constants.js";
import {
  AUTOMATION_TOKEN_DEFAULT_EXPIRES_DAYS,
  AUTOMATION_TOKEN_MAX_EXPIRES_DAYS,
  createAutomationToken,
  listAutomationTokens,
  revokeAutomationToken,
} from "../services/automation-tokens.js";
import { isValidCidrsCsv } from "../services/cidr.js";

// Issue #3440 — Operator API for automation tokens. Protected by normal
// operator auth (src/plugins/auth.ts); automation tokens (`mat_...`) are never
// accepted on these routes.

interface CreateBody {
  label: string;
  scopes: AutomationTokenScope[];
  expiresInDays?: number;
  allowedCidrs?: string | null;
  requireApproval?: boolean;
}

const createSchema = {
  body: {
    type: "object",
    required: ["label", "scopes"],
    additionalProperties: false,
    properties: {
      label: { type: "string", minLength: 1, maxLength: 80 },
      scopes: {
        type: "array",
        minItems: 1,
        maxItems: AUTOMATION_TOKEN_SCOPES.length,
        uniqueItems: true,
        items: { type: "string", enum: [...AUTOMATION_TOKEN_SCOPES] },
      },
      expiresInDays: {
        type: "integer",
        minimum: 1,
        maximum: AUTOMATION_TOKEN_MAX_EXPIRES_DAYS,
      },
      allowedCidrs: {
        anyOf: [{ type: "string", maxLength: 512 }, { type: "null" }],
      },
      requireApproval: { type: "boolean" },
    },
  },
};

export async function automationTokensRoute(app: FastifyInstance) {
  app.post<{ Body: CreateBody }>(
    "/api/automation-tokens",
    { schema: createSchema },
    async (request, reply) => {
      const { label, scopes, expiresInDays, allowedCidrs, requireApproval } = request.body;
      if (label.trim().length === 0) {
        return reply.badRequest("label must not be blank");
      }
      const trimmedCidrs = allowedCidrs?.trim() || null;
      if (trimmedCidrs !== null && !isValidCidrsCsv(trimmedCidrs)) {
        return reply.badRequest(
          "allowedCidrs must be a comma-separated list of IPv4 CIDRs (e.g. 10.0.0.0/8)",
        );
      }
      const created = createAutomationToken(app, {
        label,
        scopes,
        expiresInDays: expiresInDays ?? AUTOMATION_TOKEN_DEFAULT_EXPIRES_DAYS,
        allowedCidrs: trimmedCidrs,
        requireApproval,
      });
      reply.code(201);
      return created;
    },
  );

  app.get("/api/automation-tokens", async () => listAutomationTokens(app));

  app.delete<{ Params: { id: string } }>("/api/automation-tokens/:id", async (request, reply) => {
    if (!revokeAutomationToken(app, request.params.id)) return reply.notFound();
    reply.code(204);
  });
}
