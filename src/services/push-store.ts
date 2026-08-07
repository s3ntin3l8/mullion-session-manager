import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { generateVAPIDKeys } from "web-push";
import { pushKeys, pushSubscriptions } from "../db/schema.js";

// Singleton row id — see db/schema.ts's `push_keys` table doc comment. Same
// convention as settings.ts's SETTINGS_ROW_ID.
const VAPID_KEYS_ROW_ID = 1;

export interface VapidKeyPair {
  publicKey: string;
  privateKey: string;
}

// Generated once, on first call, and persisted — no env var (see the
// `push_keys` table's own doc comment for why). Every subsequent call reads
// the same row back rather than regenerating, so a restart never rotates the
// key a browser already subscribed against.
export function getOrCreateVapidKeys(app: FastifyInstance): VapidKeyPair {
  const [row] = app.db.select().from(pushKeys).where(eq(pushKeys.id, VAPID_KEYS_ROW_ID)).all();
  if (row) {
    return {
      publicKey: row.publicKey,
      privateKey: app.encryption.decryptString(row.privateKeyEnc),
    };
  }

  const { publicKey, privateKey } = generateVAPIDKeys();
  const privateKeyEnc = app.encryption.encryptString(privateKey);
  app.db
    .insert(pushKeys)
    .values({ id: VAPID_KEYS_ROW_ID, publicKey, privateKeyEnc, createdAt: new Date() })
    .onConflictDoNothing()
    .run();
  // A concurrent first-call race would lose the onConflictDoNothing insert
  // and must read back whatever the winner persisted, not return the keys
  // just generated here — both callers need to agree on the same keypair.
  const [persisted] = app.db
    .select()
    .from(pushKeys)
    .where(eq(pushKeys.id, VAPID_KEYS_ROW_ID))
    .all();
  if (!persisted) throw new Error("Failed to persist VAPID keys");
  return {
    publicKey: persisted.publicKey,
    privateKey: app.encryption.decryptString(persisted.privateKeyEnc),
  };
}

export interface SubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}

// Upserts on `endpoint` (its unique index) — a browser re-subscribing (e.g.
// after pushsubscriptionchange, issue #95) with the same endpoint refreshes
// its keys rather than accumulating duplicate rows.
export function upsertSubscription(app: FastifyInstance, input: SubscriptionInput): void {
  const authKeyEnc = app.encryption.encryptString(input.auth);
  app.db
    .insert(pushSubscriptions)
    .values({
      endpoint: input.endpoint,
      p256dhKey: input.p256dh,
      authKeyEnc,
      userAgent: input.userAgent ?? null,
      createdAt: new Date(),
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        p256dhKey: input.p256dh,
        authKeyEnc,
        userAgent: input.userAgent ?? null,
      },
    })
    .run();
}

// No-op (not an error) when the endpoint isn't a known subscription — an
// unsubscribe request for an endpoint this server never stored (already
// pruned via a prior 404/410, or never subscribed) is not a client mistake.
export function removeSubscription(app: FastifyInstance, endpoint: string): void {
  app.db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).run();
}

export interface SubscriptionSummary {
  id: number;
  userAgent: string | null;
  createdAt: Date;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
}

// Never returns endpoint/keys — this is for a future Settings device list,
// which has no business round-tripping push credentials back to the browser.
export function listSubscriptions(app: FastifyInstance): SubscriptionSummary[] {
  return app.db
    .select({
      id: pushSubscriptions.id,
      userAgent: pushSubscriptions.userAgent,
      createdAt: pushSubscriptions.createdAt,
      lastSuccessAt: pushSubscriptions.lastSuccessAt,
      lastFailureAt: pushSubscriptions.lastFailureAt,
    })
    .from(pushSubscriptions)
    .all();
}

export interface SubscriptionForSend {
  endpoint: string;
  p256dh: string;
  auth: string;
}

// The send-time counterpart to listSubscriptions above — decrypts auth keys,
// so unlike that function this is for push-delivery.ts's own internal use
// only, never exposed via a route.
export function getSubscriptionsForSend(app: FastifyInstance): SubscriptionForSend[] {
  return app.db
    .select({
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dhKey,
      authEnc: pushSubscriptions.authKeyEnc,
    })
    .from(pushSubscriptions)
    .all()
    .map((row) => ({
      endpoint: row.endpoint,
      p256dh: row.p256dh,
      auth: app.encryption.decryptString(row.authEnc),
    }));
}

export function recordSendSuccess(app: FastifyInstance, endpoint: string): void {
  app.db
    .update(pushSubscriptions)
    .set({ lastSuccessAt: new Date() })
    .where(eq(pushSubscriptions.endpoint, endpoint))
    .run();
}

// Deliberately does NOT prune the row — a transient push-service outage is
// common and this alone shouldn't cost the user their subscription. Only a
// 404/410 send response (the push service itself saying the endpoint is
// gone) does that — see push-delivery.ts.
export function recordSendFailure(app: FastifyInstance, endpoint: string): void {
  app.db
    .update(pushSubscriptions)
    .set({ lastFailureAt: new Date() })
    .where(eq(pushSubscriptions.endpoint, endpoint))
    .run();
}
