// Issue #29 — the Runway admin key, stored encrypted.
//
// Exactly the shape of the Hermes relay key (services/hermes-integration.ts):
// the `integrations` table's `provider` is a free-text primary key, so a new
// identity is a new row — no migration. Only `authTokenEnc` and
// `connectedAt` are populated; the PAT/OAuth/webhook columns stay null.
//
// The key is WRITE-ONLY over the API: GET returns only { hasKey, updatedAt },
// and the plaintext never leaves the backend (it is not in the settings blob,
// which GET /api/settings returns verbatim).
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { integrations } from "../db/schema.js";

/** The `integrations.provider` value for the Runway key. */
export const RUNWAY_PROVIDER = "runway";

/** Never includes the key — the same "hasKey-only summary" shape as
 * HermesIntegrationSummary. */
export interface RunwayIntegrationSummary {
  hasKey: boolean;
  updatedAt: Date | null;
}

type IntegrationRow = typeof integrations.$inferSelect;

function getRow(app: FastifyInstance): IntegrationRow | undefined {
  const [row] = app.db
    .select()
    .from(integrations)
    .where(eq(integrations.provider, RUNWAY_PROVIDER))
    .all();
  return row;
}

export function getRunwayIntegration(app: FastifyInstance): RunwayIntegrationSummary {
  const row = getRow(app);
  const hasKey = !!row?.authTokenEnc;
  return { hasKey, updatedAt: hasKey ? (row!.connectedAt ?? null) : null };
}

/**
 * Internal use only (services/runway-client.ts) — decrypts the stored key.
 *
 * Never send this back over the API or expose it to a session.
 */
export function getRunwayKey(app: FastifyInstance): string | null {
  const row = getRow(app);
  if (!row?.authTokenEnc) return null;
  return app.encryption.decryptString(row.authTokenEnc);
}

export function setRunwayKey(app: FastifyInstance, key: string): RunwayIntegrationSummary {
  const connectedAt = new Date();
  const authTokenEnc = app.encryption.encryptString(key);
  app.db
    .insert(integrations)
    .values({ provider: RUNWAY_PROVIDER, authTokenEnc, connectedAt })
    .onConflictDoUpdate({ target: integrations.provider, set: { authTokenEnc, connectedAt } })
    .run();
  return getRunwayIntegration(app);
}

export function clearRunwayKey(app: FastifyInstance): void {
  app.db.delete(integrations).where(eq(integrations.provider, RUNWAY_PROVIDER)).run();
}
