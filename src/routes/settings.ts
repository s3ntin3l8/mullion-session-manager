import type { FastifyInstance } from "fastify";
import { settings } from "../db/schema.js";
import {
  deepMerge,
  getStoredSettings,
  sanitizeSettings,
  SETTINGS_ROW_ID,
  type AppSettings,
} from "../services/settings.js";

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

// No auth hook here, deliberately consistent with every other route in this
// app (projects/sessions/workspaces/groups/agents/terminal) — none of them
// authenticate either. The whole app assumes it's deployed behind an
// authenticating reverse-proxy gateway (see deploy/README.md's Authentik
// forward-auth templates), not that any individual route self-protects.
// That's an app-wide gap for a bare (gateway-less) deployment, not something
// specific to settings; tracked for an app-wide fix rather than bolted onto
// this one route.
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
      // Merge the partial patch onto the *current* stored settings (already
      // fully-defaulted by getStoredSettings) — deepMerge is the same helper
      // mergeSettings uses to layer a stored blob over DEFAULT_SETTINGS.
      const previous = getStoredSettings(app.db);
      const next: AppSettings = sanitizeSettings(deepMerge(previous, request.body));
      const data = JSON.stringify(next);

      // Upsert the singleton row — SQLite's ON CONFLICT DO UPDATE, matching
      // how a settings row simply doesn't exist until the first write.
      app.db
        .insert(settings)
        .values({ id: SETTINGS_ROW_ID, data })
        .onConflictDoUpdate({ target: settings.id, set: { data, updatedAt: new Date() } })
        .run();

      // Live-reconfigure the reconciler timer (see plugins/pty.ts) rather
      // than only picking up the new interval on next process restart.
      if (next.sessions.reconcileIntervalSeconds !== previous.sessions.reconcileIntervalSeconds) {
        app.reconfigureReconciler(next.sessions.reconcileIntervalSeconds);
      }

      // Explicit content-type — see the GET handler's comment above.
      reply.type("application/json");
      // Re-read rather than returning `next` directly: same persisted
      // value, but the response no longer flows straight from
      // request.body through this function's return.
      return getStoredSettings(app.db);
    },
  );
}
