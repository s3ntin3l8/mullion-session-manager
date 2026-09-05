import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { and, eq, gt, isNotNull, isNull, lt, or } from "drizzle-orm";
import { bridges } from "../db/schema.js";
import { timingSafeTokenMatch } from "./crypto-utils.js";

// Issue #820 — the credential model for a laptop/PC "helper" that dials OUT
// to `/ws/agent-bridge` on the primary, carrying its SSH agent's traffic
// out to every host that needs it (ssh-agent-mux.ts, ssh-agent-filter.ts,
// docs/ssh-agent.md's design plan). This module is pure DB + credential
// logic, mirroring host-registry.ts's shape deliberately (same
// pairing/session split as its D1/D2 enrollment flow, same
// constant-time-across-all-candidates compare, same encrypted-not-hashed
// secret storage) — see schema.ts's own comment on `bridges` for why this
// is a separate table from `hosts` rather than a variant host row. No
// routes wired up yet; that's a later PR in the same sequence.

type BridgeRow = typeof bridges.$inferSelect;

export interface BridgeSummary {
  id: string;
  name: string | null;
  platform: string | null;
  lastSeenAt: Date | null;
  /** `true` once paired (a live, unexpired session) — a row still sitting
   * on an unredeemed pairing code has neither a session nor, usually, a
   * name yet. */
  hasLiveSession: boolean;
  createdAt: Date;
}

function toSummary(row: BridgeRow): BridgeSummary {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    lastSeenAt: row.lastSeenAt,
    hasLiveSession: row.sessionExpiresAt !== null && row.sessionExpiresAt.getTime() > Date.now(),
    createdAt: row.createdAt,
  };
}

export function listBridges(app: FastifyInstance): BridgeSummary[] {
  return app.db.select().from(bridges).all().map(toSummary);
}

/** Internal use only — never send a raw row back over the API; it carries
 * every encrypted secret column. */
export function getBridgeRow(app: FastifyInstance, id: string): BridgeRow | undefined {
  const [row] = app.db.select().from(bridges).where(eq(bridges.id, id)).all();
  return row;
}

export function deleteBridge(app: FastifyInstance, id: string): void {
  app.db.delete(bridges).where(eq(bridges.id, id)).run();
}

// Issue #1052 — `issuePairingCode()` inserts a brand-new row every call, and
// expired-but-never-redeemed pairing codes are invisible to redeemPairingCode
// (its `pairingExpiresAt > NOW()` filter drops them) but still sit in the
// table carrying encrypted `pairing_secret_enc` payloads. Same shape for
// paired rows whose `sessionExpiresAt` has lapsed — once a session is past
// expiry there's no bootstrap credential left to bring the bridge back (a
// helper that needs to reconnect after session loss needs a fresh pairing
// code, not a retry), so the row is dead weight.
//
// Cleanup runs periodically from src/plugins/bridge-cleanup.ts (primary
// role only — an agent has no `bridges` table, see src/app.ts's role split),
// so a deployment with frequent Settings interactions doesn't accumulate
// abandoned rows unboundedly over months.
const SESSION_EXPIRED_BUFFER_MS = 60 * 60 * 1000;

export function cleanupExpiredPairingCodes(app: FastifyInstance): void {
  const now = new Date();
  const sessionExpiredCutoff = new Date(now.getTime() - SESSION_EXPIRED_BUFFER_MS);
  app.db
    .delete(bridges)
    .where(
      or(
        // Unpaired + pairing-code-expired: a fresh pairing code that was
        // never redeemed and is now past its 10-minute TTL.
        and(
          isNotNull(bridges.pairingExpiresAt),
          lt(bridges.pairingExpiresAt, now),
          isNull(bridges.sessionExpiresAt),
        ),
        // Paired + session-expired past the buffer: the bridge's last
        // session renewal lapsed more than the buffer ago. `findLiveSession`
        // already rejects these at verify time, but the row sits here until
        // something actively removes it — the buffer protects a session
        // that's only just lapsed (e.g. clock skew, a brief renewal gap)
        // from being wiped while the helper is about to renew.
        and(
          isNotNull(bridges.sessionExpiresAt),
          lt(bridges.sessionExpiresAt, sessionExpiredCutoff),
        ),
      ),
    )
    .run();
}

// A pairing code is deliberately short-lived — it's meant to be generated
// in Settings and pasted into the helper within the same sitting, not
// stored anywhere long-term. 10 minutes is generous for "copy, switch to a
// terminal, paste" without leaving a stale bootstrap credential valid for
// long if it's never used.
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

// Matches hosts.ts's own SESSION_TTL_MS — a bridge's live session is
// renewed well before expiry the same way an enrolled host's is
// (agent-enrollment.ts's own renewal timer; the future `mullion helper`
// CLI does the equivalent for a bridge).
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface PairingCode {
  bridgeId: string;
  /** The raw, single-use bootstrap secret — embed this (and the primary's
   * own externally-reachable base URL, which this module has no way to
   * know) into whatever one-paste format the caller composes for the user;
   * see `encodePairingPayload`. */
  code: string;
  expiresAt: Date;
}

export interface BridgeSession {
  bridgeId: string;
  sessionId: string;
  sessionSecret: string;
  expiresAt: Date;
}

/** Creates a brand-new, unpaired bridge row with a fresh pairing code.
 * Every call creates a NEW row — generating a second pairing code for the
 * same physical laptop just means an earlier, still-unredeemed code is
 * abandoned (it'll simply expire), never reused; there is no "regenerate
 * this bridge's code" operation, only "pair a new one." */
export function issuePairingCode(app: FastifyInstance): PairingCode {
  const id = crypto.randomUUID();
  const code = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);
  app.db
    .insert(bridges)
    .values({
      id,
      pairingSecretEnc: app.encryption.encryptString(code),
      pairingExpiresAt: expiresAt,
    })
    .run();
  return { bridgeId: id, code, expiresAt };
}

// Split out from issueSession() so redeemPairingCode() below can generate
// and encrypt a session's fields WITHOUT writing to the DB itself — it
// writes them as part of the same transaction that clears the pairing
// code, rather than issueSession()'s own separate, self-contained update.
// Pure (no DB access), so it's safe to call from inside or outside a
// transaction either way.
function buildSession(
  app: FastifyInstance,
  bridgeId: string,
): {
  session: BridgeSession;
  row: Pick<BridgeRow, "sessionIdEnc" | "sessionSecretEnc" | "sessionExpiresAt">;
} {
  const sessionId = crypto.randomBytes(32).toString("hex");
  const sessionSecret = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  return {
    session: { bridgeId, sessionId, sessionSecret, expiresAt },
    row: {
      sessionIdEnc: app.encryption.encryptString(sessionId),
      sessionSecretEnc: app.encryption.encryptString(sessionSecret),
      sessionExpiresAt: expiresAt,
    },
  };
}

function issueSession(app: FastifyInstance, bridgeId: string): BridgeSession {
  const { session, row } = buildSession(app, bridgeId);
  app.db.update(bridges).set(row).where(eq(bridges.id, bridgeId)).run();
  return session;
}

export interface RedeemPairingInput {
  name?: string;
  platform?: string;
}

/**
 * Redeems a pairing code: single-use, and clears the pairing fields
 * unconditionally on a match (below) so the SAME code can never be
 * redeemed twice, even if the helper somehow retried the redeem call —
 * unlike enrollHost's baseUrl-keyed idempotent retry (host-registry.ts),
 * there's no stable identifier here to dedupe a retry against before a
 * session exists, so a second redeem attempt is simply refused (returns
 * null) rather than reused. A helper that never got the first response
 * needs a fresh pairing code, not a retry.
 *
 * Every unexpired candidate row is decrypted and compared unconditionally
 * (never short-circuited on the first match), mirroring claimHost's own
 * AS13 fix (host-registry.ts) — total work is the same regardless of which
 * row matches or whether any do, so timing can't leak a row's position. A
 * row that fails to decrypt is logged and treated as a non-match, not
 * re-thrown, for the identical reason claimHost does: a single corrupt row
 * must never deny every legitimate pairing attempt.
 *
 * The pairing-clear and the session-issue below run inside ONE transaction
 * (Hermes review, PR #859), not as two independent updates — this table's
 * pairing code is genuinely single-use with no idempotent-retry path (see
 * above), so a crash between "clear the code" and "issue the session"
 * would otherwise burn the code permanently with no session ever created,
 * leaving the row unrecoverable without deleting and re-pairing from
 * scratch. `better-sqlite3`'s driver is synchronous, so this transaction
 * has no await inside it and can't interleave with another call the way an
 * async driver's could.
 */
export function redeemPairingCode(
  app: FastifyInstance,
  presentedCode: string,
  input: RedeemPairingInput,
): BridgeSession | null {
  const candidates = app.db
    .select()
    .from(bridges)
    .where(and(isNotNull(bridges.pairingSecretEnc), gt(bridges.pairingExpiresAt, new Date())))
    .all();
  let matchedRow: BridgeRow | undefined;
  for (const row of candidates) {
    let isMatch = false;
    try {
      const decrypted = app.encryption.decryptString(row.pairingSecretEnc!);
      // Issue #1059 — both sides are server-minted fixed-length secrets
      // (see bridge-registry.ts's pairingSecret issuer), so
      // timingSafeTokenMatch's length-side-channel is bounded — see
      // crypto-utils.ts for the full constraint.
      isMatch = timingSafeTokenMatch(presentedCode, decrypted);
    } catch (err) {
      app.log.warn(
        { err, bridgeId: row.id },
        "redeemPairingCode: failed to decrypt a candidate bridge's pairing secret; treating it as a non-match",
      );
    }
    if (isMatch && matchedRow === undefined) matchedRow = row;
  }
  if (matchedRow === undefined) return null;
  const bridgeId = matchedRow.id;
  const { session, row: sessionRow } = buildSession(app, bridgeId);
  app.db.transaction((tx) => {
    tx.update(bridges)
      .set({
        name: input.name?.trim() || null,
        platform: input.platform ?? null,
        pairingSecretEnc: null,
        pairingExpiresAt: null,
        lastSeenAt: new Date(),
      })
      .where(eq(bridges.id, bridgeId))
      .run();
    tx.update(bridges).set(sessionRow).where(eq(bridges.id, bridgeId)).run();
  });
  return session;
}

// Shared by rotateBridgeSession and verifyBridgeSession — the read-only
// "does this bridgeId+sessionId match a live, unexpired session" check,
// with no side effects. Mirrors host-registry.ts's findLiveSession
// exactly.
function findLiveSession(
  app: FastifyInstance,
  bridgeId: string,
  presentedSessionId: string,
): BridgeRow | null {
  const row = getBridgeRow(app, bridgeId);
  if (!row || !row.sessionIdEnc) return null;
  const decrypted = app.encryption.decryptString(row.sessionIdEnc);
  // Issue #1059 — both sides are fixed-length (server-issued sessionId vs
  // inbound bearer); same assumption as the pairing-secret check above.
  if (!timingSafeTokenMatch(presentedSessionId, decrypted)) return null;
  if (!row.sessionExpiresAt || row.sessionExpiresAt.getTime() <= Date.now()) return null;
  return row;
}

/** Renewal — the helper re-authenticates with its own CURRENT session id
 * (not the pairing code, which no longer exists after redemption) to get a
 * fresh secret before TTL expiry. Returns null on any mismatch; the caller
 * is expected to respond however routes/enrollment.ts responds to
 * rotateSession's own null case (401), so the helper's retry logic can
 * fall back to prompting for a fresh pairing code — there's no bootstrap
 * credential left to silently fall back to once a session is lost, unlike
 * an agent host's MULLION_AGENT_TOKEN. */
export function rotateBridgeSession(
  app: FastifyInstance,
  bridgeId: string,
  presentedSessionId: string,
): BridgeSession | null {
  const row = findLiveSession(app, bridgeId, presentedSessionId);
  if (!row) return null;
  return issueSession(app, bridgeId);
}

export function verifyBridgeSession(
  app: FastifyInstance,
  bridgeId: string,
  presentedSessionId: string,
): boolean {
  return findLiveSession(app, bridgeId, presentedSessionId) !== null;
}

/** Revokes a bridge's session credential outright — mirrors
 * clearHostSession's own reasoning (host-registry.ts): free, since nothing
 * depends on the outgoing session staying valid once the helper is
 * deliberately disconnecting or being revoked from Settings. Unlike an
 * agent host, there is no bootstrap credential left to fall back to after
 * this — a bridge that needs to reconnect after its session is cleared
 * needs a brand-new pairing code, not a retry. */
export function clearBridgeSession(app: FastifyInstance, bridgeId: string): void {
  app.db
    .update(bridges)
    .set({ sessionIdEnc: null, sessionSecretEnc: null, sessionExpiresAt: null })
    .where(eq(bridges.id, bridgeId))
    .run();
}

/** Updates lastSeenAt — call on every accepted `/ws/agent-bridge` message
 * or a periodic heartbeat, whichever the eventual route settles on. Kept
 * as its own cheap, side-effect-only function rather than folded into
 * verifyBridgeSession, since a caller that only wants to check liveness
 * (no observable side effect) is a different, equally valid use. */
export function touchBridgeLastSeen(app: FastifyInstance, bridgeId: string): void {
  app.db.update(bridges).set({ lastSeenAt: new Date() }).where(eq(bridges.id, bridgeId)).run();
}

export interface PairingPayload {
  /** The primary's own externally-reachable base URL — this module has no
   * way to know it (that's request/config context a future route has, not
   * this one), so the caller supplies it. */
  baseUrl: string;
  code: string;
}

/** Encodes the one string a user copies out of Settings and pastes into
 * the helper — bundles the pairing code together with the server URL it's
 * redeemed against, so "one paste" is literally true: the helper needs no
 * other configuration. Plain base64url of a small JSON object, not
 * encrypted or signed — the pairing code inside it is already the secret
 * (short-lived, single-use); the URL is not sensitive. Symmetric with
 * `decodePairingPayload`, and both are meant to be shared by the future
 * `/ws/agent-bridge` route (which encodes) and the `mullion helper` CLI
 * (which decodes), so the two ends can't drift on the format
 * independently. */
export function encodePairingPayload(payload: PairingPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** Returns `null` for anything that isn't a well-formed payload — a
 * mistyped/truncated paste is a user-input-validation concern for the
 * caller (the CLI), not something this function throws over.
 *
 * Issue #1055: also rejects payloads whose `baseUrl` isn't a well-formed
 * HTTP(S) URL — defense-in-depth, since the helper CLI's later
 * `isValidHttpBaseUrl` would catch it anyway, but catching it here means
 * a corrupted or tampered payload never reaches the helper's connection
 * code at all. */
export function decodePairingPayload(encoded: string): PairingPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { baseUrl, code } = parsed as Record<string, unknown>;
  if (typeof baseUrl !== "string" || typeof code !== "string") return null;
  if (baseUrl === "" || code === "") return null;
  if (!isValidHttpUrl(baseUrl)) return null;
  return { baseUrl, code };
}

/** Mirrors the helper CLI's own `isValidHttpBaseUrl` — kept local here
 * because this module is loaded in the backend process and the helper
 * file is `.mjs` (ESM, no TS, deliberately separate so it doesn't pull
 * in drizzle-orm). If either side ever changes the rule, the other must
 * be updated by hand (same deliberate-duplication rationale as
 * `decodePairingPayload` itself, called out at the top of the helper
 * file). */
function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
