import type { FastifyInstance } from "fastify";
import { applySettingsPatch, getStoredSettings } from "../services/settings.js";

// The whole preferences blob is one JSON body — additionalProperties: true
// (rather than a strict per-field schema) because `mergeSettings` already
// deep-merges whatever shape a partial patch happens to have over the
// current defaults, the same "accept an opaque object, never inspect it
// structurally" pattern PATCH /api/workspaces uses for `layout`. Fastify
// still rejects a non-object body via `type: "object"`. deepMerge's
// type guard and sanitizeSettings' numeric-range clamp (both in
// services/settings.ts) are what actually keep a patch's *values* sane —
// this schema only proves the body is an object.
const patchSettingsSchema = {
  body: {
    type: "object",
    additionalProperties: true,
  },
};

// No *route-level* auth hook here, deliberately consistent with every other
// route in this app (projects/sessions/workspaces/groups/agents/terminal) —
// none of them self-protect individually. Two layers exist instead: the
// operator can put an authenticating reverse-proxy gateway in front (see
// deploy/README.md's Authentik forward-auth templates), and/or turn on this
// process's own optional in-process auth (issue #19,
// src/plugins/auth.ts) — a single global onRequest hook gating every
// /api/* route (this one included) at once, rather than each route wiring
// its own check. Both are opt-in; a bare deployment with neither configured
// is still wide open, by design (see that plugin's own doc comment).
export async function settingsRoute(app: FastifyInstance) {
  app.get("/api/settings", async (_request, reply) => {
    // Explicit content-type: this is a JSON API response, not an HTML
    // page — settings values (e.g. a stored session-name pattern) must
    // never be interpreted as markup by a client.
    reply.type("application/json");
    return getStoredSettings(app.db);
  });

  app.patch<{ Body: Record<string, unknown> }>(
    "/api/settings",
    { schema: patchSettingsSchema },
    async (request, reply) => {
      // Deep-merge + upsert + live-reconfigure — see applySettingsPatch's
      // own doc comment (services/settings.ts). Shared with
      // routes/bundle-sync.ts's POST /remove (issue #945), which flips
      // sessions.injectMullionBundle off through this exact same path.
      applySettingsPatch(app, request.body);

      // Explicit content-type: this is a JSON API response, not an HTML
      // page — settings values (e.g. a stored session-name pattern) must
      // never be interpreted as markup by a client.
      reply.type("application/json");
      // Re-read rather than returning applySettingsPatch's own return value
      // directly: same persisted value, but the response no longer flows
      // straight from request.body through this function's return.
      return getStoredSettings(app.db);
    },
  );
}
