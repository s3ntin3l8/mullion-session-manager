import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, desc, eq, gt, isNotNull, isNull, lt, or } from "drizzle-orm";
import { hostPairings } from "../db/schema.js";
import { timingSafeTokenMatch } from "./crypto-utils.js";
import {
  createPairedHost,
  reissuePairedIdentity,
  type HostRegistration,
  type RegisterAgentInput,
} from "./host-registry.js";

// Issue #2449 / epic #2230 — one-time EXECUTION-HOST pairing, modeled on
// bridge-registry.ts's pairing: a 10-minute single-use code, a constant-time
// scan over every candidate, and the code consumed in the same transaction
// that creates the host and its machine identity (#2568). This grants
// execution permission only; it never shares an SSH key (that is the separate
// agent-bridge pairing). Headless Ansible enrollment (routes/enrollment.ts)
// is untouched and converges on the same identity.

export const HOST_PAIRING_TTL_MS = 10 * 60 * 1000;
// After a successful redeem the code stays matchable this long, but only for
// the SAME request id: a Helper whose response was lost retries onto the same
// host instead of leaving an orphan and needing a new code.
export const HOST_PAIRING_RETRY_WINDOW_MS = 10 * 60 * 1000;

export type PairingState = "pending" | "paired" | "expired" | "revoked";

export interface IssuedHostPairing {
  id: string;
  code: string;
  expiresAt: Date;
}

export interface HostPairingSummary {
  id: string;
  label: string | null;
  state: PairingState;
  expiresAt: Date;
  createdAt: Date;
  hostId: string | null;
}

type PairingRow = typeof hostPairings.$inferSelect;

function hashRequestId(requestId: string): string {
  return crypto.createHash("sha256").update(requestId).digest("hex");
}

/** Drops the secret of every code that can no longer be redeemed or retried,
 * and the audit rows older than a day. Cheap; called when issuing and listing. */
export function cleanupHostPairings(app: FastifyInstance): void {
  const now = new Date();
  const retryCutoff = new Date(now.getTime() - HOST_PAIRING_RETRY_WINDOW_MS);
  app.db
    .update(hostPairings)
    .set({ codeEnc: null })
    .where(
      and(
        isNotNull(hostPairings.codeEnc),
        or(
          and(isNull(hostPairings.redeemedAt), lt(hostPairings.expiresAt, now)),
          and(isNotNull(hostPairings.redeemedAt), lt(hostPairings.redeemedAt, retryCutoff)),
        ),
      ),
    )
    .run();
  app.db
    .delete(hostPairings)
    .where(
      and(
        isNull(hostPairings.redeemedAt),
        lt(hostPairings.expiresAt, new Date(now.getTime() - 24 * 60 * 60 * 1000)),
      ),
    )
    .run();
}

export function issueHostPairingCode(
  app: FastifyInstance,
  opts: { label?: string } = {},
): IssuedHostPairing {
  cleanupHostPairings(app);
  const id = crypto.randomUUID();
  const code = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + HOST_PAIRING_TTL_MS);
  app.db
    .insert(hostPairings)
    .values({
      id,
      codeEnc: app.encryption.encryptString(code),
      expiresAt,
      label: opts.label?.trim() || null,
    })
    .run();
  return { id, code, expiresAt };
}

function stateOf(row: PairingRow): PairingState {
  if (row.redeemedAt) return "paired";
  if (row.revokedAt) return "revoked";
  return row.expiresAt.getTime() <= Date.now() ? "expired" : "pending";
}

export function listHostPairings(app: FastifyInstance): HostPairingSummary[] {
  cleanupHostPairings(app);
  return app.db
    .select()
    .from(hostPairings)
    .orderBy(desc(hostPairings.createdAt))
    .limit(50)
    .all()
    .map((row) => ({
      id: row.id,
      label: row.label,
      state: stateOf(row),
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      hostId: row.redeemedHostId,
    }));
}

/** Cancels a pending code. False when it is unknown or already redeemed
 * (a paired host is revoked through /api/hosts/:id/revoke instead). */
export function revokeHostPairing(app: FastifyInstance, id: string): boolean {
  const updated = app.db
    .update(hostPairings)
    .set({ revokedAt: new Date(), codeEnc: null })
    .where(and(eq(hostPairings.id, id), isNull(hostPairings.redeemedAt)))
    .returning()
    .all();
  return updated.length > 0;
}

export type RedeemHostPairingInput = Pick<
  RegisterAgentInput,
  "hostname" | "name" | "platform" | "capabilities"
> & { baseUrl?: string; requestId: string };

/**
 * Redeems a code for a host identity and machine credential. Null on any
 * failure (unknown, expired, revoked, replayed) — the route answers a uniform
 * 401 so the response never says which.
 *
 * Replay: a second redeem of an already-consumed code is refused UNLESS it
 * carries the same `requestId` within the retry window and the host has not
 * yet renewed — i.e. the Helper never saw the first response. That retry
 * re-issues the credential for the SAME host, so an interrupted setup cannot
 * create a duplicate identity. Every candidate is decrypted and compared
 * regardless of which matches (no early exit), and the consume runs in one
 * transaction with a guarded UPDATE so two concurrent redeems cannot both win.
 */
export function redeemHostPairingCode(
  app: FastifyInstance,
  presentedCode: string,
  input: RedeemHostPairingInput,
): HostRegistration | null {
  const now = new Date();
  const candidates = app.db
    .select()
    .from(hostPairings)
    .where(
      and(
        isNotNull(hostPairings.codeEnc),
        isNull(hostPairings.revokedAt),
        or(
          gt(hostPairings.expiresAt, now),
          gt(hostPairings.redeemedAt, new Date(now.getTime() - HOST_PAIRING_RETRY_WINDOW_MS)),
        ),
      ),
    )
    .all();
  let matched: PairingRow | undefined;
  for (const row of candidates) {
    let isMatch = false;
    try {
      isMatch = timingSafeTokenMatch(presentedCode, app.encryption.decryptString(row.codeEnc!));
    } catch (err) {
      app.log.warn(
        { err, pairingId: row.id },
        "redeemHostPairingCode: failed to decrypt a candidate pairing code; treating it as a non-match",
      );
    }
    if (isMatch && matched === undefined) matched = row;
  }
  if (matched === undefined) return null;
  const requestHash = hashRequestId(input.requestId);
  const pairingId = matched.id;

  if (matched.redeemedAt) {
    // Retry path: same request id, host still intact and not yet renewed.
    if (matched.redeemedAt.getTime() <= now.getTime() - HOST_PAIRING_RETRY_WINDOW_MS) return null;
    const prior = matched.redeemRequestHash;
    if (!prior || !matched.redeemedHostId || !timingSafeTokenMatch(requestHash, prior)) return null;
    return app.db.transaction(() => reissuePairedIdentity(app, matched!.redeemedHostId!));
  }
  // A code past its expiry that was somehow still selected (clock edge) is dead.
  if (matched.expiresAt.getTime() <= now.getTime()) return null;

  return app.db.transaction((tx) => {
    // The guard makes the consume atomic: only one concurrent redeem sees a
    // row come back.
    const claimed = tx
      .update(hostPairings)
      .set({ redeemedAt: new Date(), redeemRequestHash: requestHash })
      .where(
        and(
          eq(hostPairings.id, pairingId),
          isNull(hostPairings.redeemedAt),
          isNull(hostPairings.revokedAt),
        ),
      )
      .returning()
      .all();
    if (claimed.length === 0) return null;
    const registration = createPairedHost(app, {
      hostname: input.hostname,
      name: input.name ?? matched!.label ?? undefined,
      baseUrl: input.baseUrl,
      platform: input.platform,
      capabilities: input.capabilities,
    });
    tx.update(hostPairings)
      .set({ redeemedHostId: registration.hostId })
      .where(eq(hostPairings.id, pairingId))
      .run();
    return registration;
  });
}
