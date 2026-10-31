import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { integrations } from "../db/schema.js";
import { getStoredSettings } from "./settings.js";

// The Hermes review relay's API key, stored in the same `integrations` table
// as the GitHub credentials (`provider` is a free-text primary key, so a new
// identity is just a new row — no migration; see github-integration.ts's
// GITHUB_REVIEWER_PROVIDER for the same precedent). Only `authTokenEnc` and
// `connectedAt` are populated; the PAT/OAuth/webhook columns stay null.
export const HERMES_PROVIDER = "hermes";

// Never includes the key — same "hasKey-only summary" shape as HostSummary
// (host-registry.ts) and GitHubIntegrationSummary.
export interface HermesIntegrationSummary {
  hasKey: boolean;
  updatedAt: Date | null;
}

type IntegrationRow = typeof integrations.$inferSelect;

function getRow(app: FastifyInstance): IntegrationRow | undefined {
  const [row] = app.db
    .select()
    .from(integrations)
    .where(eq(integrations.provider, HERMES_PROVIDER))
    .all();
  return row;
}

export function getHermesIntegration(app: FastifyInstance): HermesIntegrationSummary {
  const row = getRow(app);
  const hasKey = !!row?.authTokenEnc;
  return { hasKey, updatedAt: hasKey ? (row!.connectedAt ?? null) : null };
}

/**
 * Can Task Master send a review to Hermes right now (#2369)? The operator has
 * turned `reviewRelay.taskMasterReviewer` on AND the connection is filled in:
 * an API URL and a stored key. Deliberately NOT `reviewRelay.provider`, which
 * switches on the GitHub-side relay — see that setting's own comment.
 *
 * Checks `hasKey` rather than decrypting the key, so it cannot throw on an
 * unreadable ciphertext; the dispatch path reads the real key when it needs
 * it. Re-asked wherever a `hermes` review agent is resolved or written, since
 * the flag and the key can both change after a task or project named it.
 */
export function hermesTaskReviewerUsable(app: FastifyInstance): boolean {
  const { taskMasterReviewer, apiUrl } = getStoredSettings(app.db).reviewRelay;
  return taskMasterReviewer === true && apiUrl.trim() !== "" && getHermesIntegration(app).hasKey;
}

/** Internal use only (services/hermes-review.ts) — decrypts the stored key.
 * Never send this back over the API or expose it to a session. */
export function getHermesKey(app: FastifyInstance): string | null {
  const row = getRow(app);
  if (!row?.authTokenEnc) return null;
  return app.encryption.decryptString(row.authTokenEnc);
}

export function setHermesKey(app: FastifyInstance, key: string): HermesIntegrationSummary {
  const connectedAt = new Date();
  const authTokenEnc = app.encryption.encryptString(key);
  app.db
    .insert(integrations)
    .values({ provider: HERMES_PROVIDER, authTokenEnc, connectedAt })
    .onConflictDoUpdate({ target: integrations.provider, set: { authTokenEnc, connectedAt } })
    .run();
  return getHermesIntegration(app);
}

export function clearHermesKey(app: FastifyInstance): void {
  app.db.delete(integrations).where(eq(integrations.provider, HERMES_PROVIDER)).run();
}
