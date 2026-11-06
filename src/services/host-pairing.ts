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
// bridge-registry.ts's pairing: a 10-minute single-use code, looked up by its
// SHA-256 (the code itself is never stored; it is 256 random bits, so a hash
// equality lookup leaks nothing a timing scan would protect), and the code
// consumed in the same transaction that creates the host and its machine
// identity (#2568). This grants
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

export type PairingRow = typeof hostPairings.$inferSelect;

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Drops the lookup hash of every code that can no longer be redeemed or retried,
 * and the audit rows older than a day. Cheap; called when issuing and listing. */
export function cleanupHostPairings(app: FastifyInstance): void {
  const now = new Date();
  const retryCutoff = new Date(now.getTime() - HOST_PAIRING_RETRY_WINDOW_MS);
  app.db
    .update(hostPairings)
    .set({ codeHash: null })
    .where(
      and(
        isNotNull(hostPairings.codeHash),
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
      codeHash: sha256Hex(code),
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
    .set({ revokedAt: new Date(), codeHash: null })
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
 * create a duplicate identity. A retry after the window is refused; the host
 * row stays and is reported as `unclaimed` (host-registry.ts) so the operator
 * can revoke or remove it.
 */
export function redeemHostPairingCode(
  app: FastifyInstance,
  presentedCode: string,
  input: RedeemHostPairingInput,
): HostRegistration | null {
  const now = new Date();
  const matched = findLivePairing(app, presentedCode, now);
  if (matched === undefined) return null;
  const requestHash = sha256Hex(input.requestId);

  if (matched.redeemedAt) {
    // Retry path: same request id, host still intact and not yet renewed.
    if (matched.redeemedAt.getTime() <= now.getTime() - HOST_PAIRING_RETRY_WINDOW_MS) return null;
    const prior = matched.redeemRequestHash;
    if (!prior || !matched.redeemedHostId || !timingSafeTokenMatch(requestHash, prior)) return null;
    return app.db.transaction(() => reissuePairedIdentity(app, matched.redeemedHostId!));
  }
  // A code past its expiry that was somehow still selected (clock edge) is dead.
  if (matched.expiresAt.getTime() <= now.getTime()) return null;

  return consumeHostPairing(app, matched, requestHash, input);
}

/**
 * Whether a redeem carrying this code and request id would be processed: the
 * code is unredeemed, unexpired and unrevoked, or it is a same-request retry of
 * a redeemed one inside its retry window. A cheap hash lookup that changes
 * nothing, so the route can let a legitimate redeem through its failure limiter.
 */
export function pairingRedeemWouldProceed(
  app: FastifyInstance,
  presentedCode: string,
  requestId: string,
): boolean {
  const now = new Date();
  const matched = findLivePairing(app, presentedCode, now);
  if (matched === undefined) return false;
  if (!matched.redeemedAt) return matched.expiresAt.getTime() > now.getTime();
  const prior = matched.redeemRequestHash;
  return (
    !!prior &&
    !!matched.redeemedHostId &&
    matched.redeemedAt.getTime() > now.getTime() - HOST_PAIRING_RETRY_WINDOW_MS &&
    timingSafeTokenMatch(sha256Hex(requestId), prior)
  );
}

function findLivePairing(
  app: FastifyInstance,
  presentedCode: string,
  now: Date,
): PairingRow | undefined {
  return app.db
    .select()
    .from(hostPairings)
    .where(
      and(
        eq(hostPairings.codeHash, sha256Hex(presentedCode)),
        isNull(hostPairings.revokedAt),
        or(
          gt(hostPairings.expiresAt, now),
          gt(hostPairings.redeemedAt, new Date(now.getTime() - HOST_PAIRING_RETRY_WINDOW_MS)),
        ),
      ),
    )
    .get();
}

/**
 * Consumes a pending pairing row and creates its host in one transaction. The
 * `redeemedAt IS NULL` guard on the UPDATE is what makes the consume atomic:
 * of two callers holding the same unredeemed row, only one sees a row come
 * back. Exported so a test can drive both callers in one tick.
 */
export function consumeHostPairing(
  app: FastifyInstance,
  pairing: PairingRow,
  requestHash: string,
  input: RedeemHostPairingInput,
): HostRegistration | null {
  return app.db.transaction((tx) => {
    const claimed = tx
      .update(hostPairings)
      .set({ redeemedAt: new Date(), redeemRequestHash: requestHash })
      .where(
        and(
          eq(hostPairings.id, pairing.id),
          isNull(hostPairings.redeemedAt),
          isNull(hostPairings.revokedAt),
        ),
      )
      .returning()
      .all();
    if (claimed.length === 0) return null;
    const registration = createPairedHost(app, {
      hostname: input.hostname,
      name: input.name ?? pairing.label ?? undefined,
      baseUrl: input.baseUrl,
      platform: input.platform,
      capabilities: input.capabilities,
    });
    tx.update(hostPairings)
      .set({ redeemedHostId: registration.hostId })
      .where(eq(hostPairings.id, pairing.id))
      .run();
    return registration;
  });
}
