import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { eq, and, isNotNull, ne } from "drizzle-orm";
import { hosts, projects } from "../db/schema.js";
import { timingSafeTokenMatch } from "./crypto-utils.js";

export const LOCAL_HOST_ID = "local";

// Never includes the encrypted token — see listHosts/toSummary below. `id`
// is the stable identifier every project.hostId and session-backend lookup
// keys off; `local` is seeded by the migration and is the only host id
// that resolves to the in-process PtyManager (session-backend.ts) rather
// than a RemoteHostClient.
export interface HostSummary {
  id: string;
  name: string;
  baseUrl: string | null;
  isLocal: boolean;
  hasToken: boolean;
  createdAt: Date;
  // Issue #245 / roadmap 7.1 — "manual" (created via Settings -> Add host,
  // including every pre-#245 row, which has origin === null in the DB) vs
  // "enrolled" (auto-created by an agent's own registration call against
  // MULLION_ENROLLMENT_SECRET). Lets the Hosts list flag an unexpected
  // enrolled row for what it is, rather than looking identical to one an
  // admin deliberately added.
  origin: "manual" | "enrolled";
  // baseUrl is only ever null for "local" — enrollHost/claimHost always
  // set it atomically from the agent's own self-reported registration
  // call, so an "enrolled" row is never actually created in a
  // baseUrl-less "pending" state. host-heartbeat.ts's null-baseUrl skip
  // still exists as a defensive no-op for "local" and any future path
  // that might introduce one, not because "enrolled" currently produces
  // one (independent review, PR #528 — this comment previously claimed
  // otherwise).
}

export interface CreateHostInput {
  name: string;
  baseUrl: string;
  token: string;
}

export interface UpdateHostInput {
  name?: string;
  baseUrl?: string;
  /** Omit to leave the stored token untouched; pass a new value to rotate it. */
  token?: string;
}

export class UnknownHostError extends Error {
  constructor(hostId: string) {
    super(`Unknown host ${hostId}`);
    this.name = "UnknownHostError";
  }
}

export class HostHasProjectsError extends Error {
  constructor(
    hostId: string,
    public readonly projectCount: number,
  ) {
    super(`Host ${hostId} still has ${projectCount} project(s)`);
    this.name = "HostHasProjectsError";
  }
}

type HostRow = typeof hosts.$inferSelect;

function toSummary(row: HostRow): HostSummary {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    isLocal: row.id === LOCAL_HOST_ID,
    hasToken: row.authTokenEnc !== null && row.authTokenEnc !== "",
    createdAt: row.createdAt,
    origin: row.origin === "enrolled" ? "enrolled" : "manual",
  };
}

export function listHosts(app: FastifyInstance): HostSummary[] {
  return app.db.select().from(hosts).all().map(toSummary);
}

/** Internal use only (session-backend.ts, remote-host-client.ts) — includes
 * the encrypted token. Never send this row shape back over the API. */
export function getHostRow(app: FastifyInstance, id: string): HostRow | undefined {
  const [row] = app.db.select().from(hosts).where(eq(hosts.id, id)).all();
  return row;
}

export function getHostSummary(app: FastifyInstance, id: string): HostSummary | undefined {
  const row = getHostRow(app, id);
  return row ? toSummary(row) : undefined;
}

export function decryptToken(app: FastifyInstance, row: HostRow): string {
  if (!row.authTokenEnc) return "";
  return app.encryption.decryptString(row.authTokenEnc);
}

export function createHost(app: FastifyInstance, input: CreateHostInput): HostSummary {
  const [created] = app.db
    .insert(hosts)
    .values({
      id: crypto.randomUUID(),
      name: input.name,
      baseUrl: input.baseUrl,
      authTokenEnc: app.encryption.encryptString(input.token),
      origin: "manual",
    })
    .returning()
    .all();
  return toSummary(created);
}

export function updateHost(
  app: FastifyInstance,
  id: string,
  input: UpdateHostInput,
): HostSummary | undefined {
  const updated = app.db
    .update(hosts)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      ...(input.token !== undefined
        ? {
            authTokenEnc: app.encryption.encryptString(input.token),
            // Issue #245 / roadmap 7.1 (independent review, PR #528) —
            // rotating a host's manual token is how an admin responds to a
            // suspected credential leak, and resolveCurrentToken() always
            // prefers a live, unexpired session over authTokenEnc. Without
            // this, rotating the token here would silently do nothing for
            // a claimed host: the primary would keep presenting the
            // now-orphaned old session indefinitely (it renews itself
            // forever), giving the admin false confidence the leak was
            // closed. Clearing the session forces resolveCurrentToken()
            // to fall back to the freshly-rotated token immediately, and
            // the agent's own next renewal attempt 401s and falls back to
            // re-registering with whatever bootstrap credential it has.
            sessionIdEnc: null,
            sessionSecretEnc: null,
            sessionExpiresAt: null,
          }
        : {}),
    })
    .where(eq(hosts.id, id))
    .returning()
    .all();
  return updated.length > 0 ? toSummary(updated[0]) : undefined;
}

export function countProjectsForHost(app: FastifyInstance, hostId: string): number {
  return app.db.select().from(projects).where(eq(projects.hostId, hostId)).all().length;
}

/**
 * Delete a host row. Refuses to delete `local` (the primary is always a
 * host to itself). Refuses a remote host that still owns projects unless
 * `cascade` is true, in which case the caller (routes/hosts.ts) is
 * responsible for having already best-effort-terminated every live session
 * on it — this function only ever touches DB rows, never app.pty or a
 * RemoteHostClient, to keep this module free of a session-backend.ts
 * dependency.
 */
export function deleteHost(app: FastifyInstance, id: string, opts: { cascade?: boolean } = {}) {
  if (id === LOCAL_HOST_ID) {
    throw new Error("cannot delete the local host");
  }
  const projectCount = countProjectsForHost(app, id);
  if (projectCount > 0 && !opts.cascade) {
    throw new HostHasProjectsError(id, projectCount);
  }
  const deleted = app.db.delete(hosts).where(eq(hosts.id, id)).returning().all();
  if (deleted.length === 0) throw new UnknownHostError(id);
}

// Issue #245 / roadmap 7.1 — agent-initiated registration & rotation.
// Session secrets live for this long before an agent must renew (at ~50%
// of this, per agent-enrollment.ts) — #157's own stated default.
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface HostRegistration {
  hostId: string;
  // `sessionId` is today's actual inbound credential (the `Authorization:
  // Bearer` value internal.ts's onRequest hook checks). `sessionSecret` is
  // NOT currently validated anywhere — it's provisioned now, encrypted at
  // rest like sessionId, so 7.5 (HMAC-signed requests, #249) can use it as
  // signing key material without another migration. It is not a second
  // authentication factor today; don't rely on it as one until 7.5 wires
  // verification in.
  sessionId: string;
  sessionSecret: string;
  expiresAt: Date;
}

export interface RegisterAgentInput {
  baseUrl: string;
  hostname: string;
  name?: string;
  capabilities?: unknown;
}

// Both halves of a session credential are generated with real entropy and
// stored encrypted, same rigor as authTokenEnc — see schema.ts's own
// comment on why sessionIdEnc in particular can't be a plain
// crypto.randomUUID() the way host row ids are. Overwrites any prior
// session unconditionally: registration and renewal are the same
// operation here, just reached via different auth paths (see
// routes/enrollment.ts).
function issueSession(app: FastifyInstance, hostId: string): HostRegistration {
  const sessionId = crypto.randomBytes(32).toString("hex");
  const sessionSecret = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  app.db
    .update(hosts)
    .set({
      sessionIdEnc: app.encryption.encryptString(sessionId),
      sessionSecretEnc: app.encryption.encryptString(sessionSecret),
      sessionExpiresAt: expiresAt,
    })
    .where(eq(hosts.id, hostId))
    .run();
  return { hostId, sessionId, sessionSecret, expiresAt };
}

/**
 * D1 path 1 ("claim") — the presented bootstrap token matches an existing
 * host row's own authTokenEnc (the pre-provisioned case: an admin already
 * created this row via Settings -> Add host, and the agent is now
 * presenting that same token to self-register instead of the primary never
 * learning the agent's URL any other way). Fills baseUrl/metadata from the
 * agent's self-report and issues a fresh session. Returns null if no row
 * matches — every candidate row is checked via timingSafeTokenMatch (not a
 * naive ===) so a per-byte oracle can't be built against any single row.
 */
export function claimHost(
  app: FastifyInstance,
  presentedToken: string,
  input: RegisterAgentInput,
): HostRegistration | null {
  const candidates = app.db
    .select()
    .from(hosts)
    .where(and(ne(hosts.id, LOCAL_HOST_ID), isNotNull(hosts.authTokenEnc)))
    .all();
  for (const row of candidates) {
    const decrypted = app.encryption.decryptString(row.authTokenEnc!);
    if (!timingSafeTokenMatch(presentedToken, decrypted)) continue;
    app.db
      .update(hosts)
      .set({
        baseUrl: input.baseUrl,
        origin: "manual",
        agentMetadata: JSON.stringify({
          hostname: input.hostname,
          capabilities: input.capabilities ?? null,
        }),
      })
      .where(eq(hosts.id, row.id))
      .run();
    return issueSession(app, row.id);
  }
  return null;
}

/**
 * D1 path 2 ("enroll") — the presented bootstrap token matches the
 * fleet-wide MULLION_ENROLLMENT_SECRET (checked by the caller, not here —
 * that's a config compare, not a DB lookup). Creates a brand-new host row
 * from the agent's self-report, with no manual token of its own
 * (authTokenEnc stays null; this row's only credential going forward is
 * its session). Caller is responsible for whatever additional gating
 * (MULLION_ENROLLMENT_ALLOWED_CIDRS) applies before calling this.
 *
 * Idempotent on baseUrl (Hermes review, PR #528): a lost response after the
 * insert committed — network drop between the primary's write and the
 * agent receiving it — would otherwise make the agent's retry create a
 * second row for the same box, and claimHost can't dedupe them afterward
 * (an enrolled row has authTokenEnc: null, excluded from its scan). An
 * agent's advertised baseUrl is stable across that kind of immediate retry
 * (unlike a client-generated id, which the agent has nowhere to persist —
 * it's deliberately stateless across restarts), so an existing enrolled row
 * with the same baseUrl is reused — refreshed and re-sessioned — instead of
 * duplicated. Never matches a manually-created row (checks origin too), so
 * this can't be used to hijack a pre-provisioned host's identity.
 */
export function enrollHost(app: FastifyInstance, input: RegisterAgentInput): HostRegistration {
  const metadata = JSON.stringify({
    hostname: input.hostname,
    capabilities: input.capabilities ?? null,
  });
  const [existing] = app.db
    .select()
    .from(hosts)
    .where(and(eq(hosts.origin, "enrolled"), eq(hosts.baseUrl, input.baseUrl)))
    .all();
  if (existing) {
    // Independent review, PR #528: this dedup key is baseUrl, which only
    // proves "reaches the same address," not "is the same agent process" —
    // two agents sharing a hostname (e.g. both defaulting
    // MULLION_AGENT_ADVERTISE_URL from the same cloned VM/container image)
    // would collide here too, each re-stealing the row from the other on
    // their independent renewal cycles. That's indistinguishable at this
    // layer from the lost-response retry this dedup exists to fix, so it
    // isn't refused — but a still-live existing session (not yet expired)
    // being reused is the specific shape of that collision, worth
    // surfacing rather than resolving silently. See docs/multi-host.md's
    // note on baseUrl uniqueness.
    if (existing.sessionExpiresAt && existing.sessionExpiresAt.getTime() > Date.now()) {
      app.log.warn(
        { hostId: existing.id, baseUrl: input.baseUrl },
        "[host-registry] enrollHost reused a row with a still-live session — either a retried " +
          "registration from the same agent, or two agents advertising the same baseUrl",
      );
    }
    app.db
      .update(hosts)
      .set({ name: input.name?.trim() || input.hostname, agentMetadata: metadata })
      .where(eq(hosts.id, existing.id))
      .run();
    return issueSession(app, existing.id);
  }
  const id = crypto.randomUUID();
  app.db
    .insert(hosts)
    .values({
      id,
      name: input.name?.trim() || input.hostname,
      baseUrl: input.baseUrl,
      authTokenEnc: null,
      origin: "enrolled",
      agentMetadata: metadata,
    })
    .run();
  return issueSession(app, id);
}

/**
 * D2 — renewal. The agent re-authenticates with its own CURRENT session id
 * (not the bootstrap token) to get a fresh secret before TTL expiry.
 * Returns null on any mismatch (unknown hostId, no session on that row, a
 * stale/wrong session id, or a session id that matches but has already
 * expired — the TTL must actually bound a leaked credential, not just be
 * advisory) — the caller (routes/enrollment.ts) responds 401, and the
 * agent's own retry logic (agent-enrollment.ts) falls back to its
 * bootstrap token, exactly #157's "primary DB loss -> 401 -> re-register"
 * path.
 */
export function rotateSession(
  app: FastifyInstance,
  hostId: string,
  presentedSessionId: string,
): HostRegistration | null {
  const row = getHostRow(app, hostId);
  if (!row || !row.sessionIdEnc) return null;
  const decrypted = app.encryption.decryptString(row.sessionIdEnc);
  if (!timingSafeTokenMatch(presentedSessionId, decrypted)) return null;
  if (!row.sessionExpiresAt || row.sessionExpiresAt.getTime() <= Date.now()) return null;
  return issueSession(app, hostId);
}
