import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { eq, and, isNotNull, isNull, ne } from "drizzle-orm";
import { hosts, projects, sessions } from "../db/schema.js";
import { timingSafeTokenMatch } from "./crypto-utils.js";
// LOCAL_HOST_ID now physically lives in src/shared/constants.ts
// (re-exported by the frontend too, from the same file — see
// frontend/src/api.ts's own re-export). Re-exported below so every existing
// backend importer of this module keeps working unchanged. Runtime VALUE,
// not type-only, so this is a plain import.
import { LOCAL_HOST_ID, type HostRole } from "../shared/constants.js";

export { LOCAL_HOST_ID };

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
  // Issue #1721 / roadmap 8.7 — the host's own reported platform
  // ("darwin" | "linux" | "win32" | …), free-form and informational, same
  // non-enforced posture as hosts.agentMetadata and bridges.platform. Null
  // for a host that never reported one (a manually-added host, or an agent
  // build that predates the field) — a legitimate state, not a defect.
  platform: string | null;
  // Issue #1725 / roadmap 8.11 — whether this host is PARKED: it takes no
  // new work (the placement policy stops choosing it), but nothing about it
  // is torn down and it stays usable for manual placement. False for every
  // host as of this migration, so nothing changes until an operator parks
  // one.
  drained: boolean;
  // Issue #2239 — what the host is for: "main" (`local` only), "worker" or
  // "burst". Burst hosts stay out of automatic placement.
  role: HostRole;
  // Issue #2568 — whether the host has a live machine credential (a
  // persistent identity), and whether an operator revoked it. Never the
  // credential itself.
  hasMachineIdentity: boolean;
  machineIdentityRevoked: boolean;
  // baseUrl is null for "local" and for a "manual" host added without one
  // (Settings -> Add host, token minted by the primary) that is still
  // waiting for its agent: claimHost fills it in from the agent's own
  // registration call. An "enrolled" row is never baseUrl-less —
  // enrollHost sets it atomically. host-heartbeat.ts skips a null
  // baseUrl, so such a host reads "pending" until the agent claims it.
}

export interface CreateHostInput {
  name: string;
  /** Omit for a host still waiting on its agent: claimHost fills it in from the agent's own report. */
  baseUrl?: string;
  token: string;
}

export interface UpdateHostInput {
  name?: string;
  baseUrl?: string;
  /** Omit to leave the stored token untouched; pass a new value to rotate it. */
  token?: string;
  /**
   * Issue #1725 / roadmap 8.11 — park this host (it takes no new work) or
   * un-park it. It is a flag, not an action: nothing is terminated, and the
   * host stays usable for manual placement.
   */
  drained?: boolean;
  /** Issue #2239 — "worker" or "burst"; the route refuses "main" and any role change on `local`. */
  role?: HostRole;
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
    platform: row.platform,
    drained: row.drained,
    role: row.role,
    hasMachineIdentity: row.machineCredentialEnc !== null,
    machineIdentityRevoked: row.machineCredentialRevokedAt !== null,
  };
}

export function listHosts(app: FastifyInstance): HostSummary[] {
  return app.db.select().from(hosts).all().map(toSummary);
}

function reportedHostname(row: HostRow): string | null {
  if (!row.agentMetadata) return null;
  try {
    const meta: unknown = JSON.parse(row.agentMetadata);
    const hostname = (meta as { hostname?: unknown } | null)?.hostname;
    return typeof hostname === "string" && hostname.trim() !== "" ? hostname.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Issue #2582 — flags probable duplicate rows left by an agent that lost its
 * identity (its state file did not survive a restart) and so re-enrolled as a
 * new host. Computed on read, no column; never merges or deletes anything.
 *
 * Returns newer-host-id -> ids of OLDER enrolled rows that share its advertised
 * baseUrl or self-reported hostname, are offline, and have no active session.
 * Two live agents behind one URL are never flagged: neither is offline.
 * `healthOf` is the heartbeat verdict, so this module stays free of the tracker.
 */
export function findPossibleDuplicates(
  app: FastifyInstance,
  healthOf: (hostId: string) => string,
): Map<string, string[]> {
  const enrolled = app.db
    .select()
    .from(hosts)
    .where(eq(hosts.origin, "enrolled"))
    .all()
    .filter((r) => r.id !== LOCAL_HOST_ID);
  const result = new Map<string, string[]>();
  if (enrolled.length < 2) return result;

  // A session runs on its own host when it has one, else its project's.
  const busy = new Set<string>();
  const active = app.db
    .select({ sessionHost: sessions.hostId, projectHost: projects.hostId })
    .from(sessions)
    .leftJoin(projects, eq(sessions.projectId, projects.id))
    .where(eq(sessions.status, "active"))
    .all();
  for (const a of active) {
    const id = a.sessionHost ?? a.projectHost;
    if (id) busy.add(id);
  }

  const stale = enrolled.filter((r) => healthOf(r.id) === "offline" && !busy.has(r.id));
  for (const newer of enrolled) {
    const hostname = reportedHostname(newer);
    const olderIds = stale
      .filter(
        (old) =>
          old.id !== newer.id &&
          old.createdAt.getTime() < newer.createdAt.getTime() &&
          ((newer.baseUrl !== null && old.baseUrl === newer.baseUrl) ||
            (hostname !== null && reportedHostname(old) === hostname)),
      )
      .map((old) => old.id);
    if (olderIds.length > 0) result.set(newer.id, olderIds);
  }
  return result;
}

/** Internal use only (session-backend.ts, remote-host-client.ts) — includes
 * the encrypted token. Never send this row shape back over the API. */
export function getHostRow(app: FastifyInstance, id: string): HostRow | undefined {
  const [row] = app.db.select().from(hosts).where(eq(hosts.id, id)).all();
  return row;
}

export function decryptToken(app: FastifyInstance, row: HostRow): string {
  if (!row.authTokenEnc) return "";
  return app.encryption.decryptString(row.authTokenEnc);
}

/**
 * A fresh per-host credential: the same 32-random-bytes-as-hex shape as the
 * session secrets below, so timingSafeTokenMatch's fixed-length assumption
 * (crypto-utils.ts) holds for tokens the primary mints itself.
 */
export function mintHostToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function createHost(app: FastifyInstance, input: CreateHostInput): HostSummary {
  const [created] = app.db
    .insert(hosts)
    .values({
      id: crypto.randomUUID(),
      name: input.name,
      baseUrl: input.baseUrl ?? null,
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
      // Issue #1725 — parking a host changes nothing but the flag: no
      // session is killed, no worktree removed, no agent contacted.
      ...(input.drained !== undefined ? { drained: input.drained } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.token !== undefined
        ? {
            authTokenEnc: app.encryption.encryptString(input.token),
            // Issue #245 / roadmap 7.1 (independent review, PR #528) —
            // rotating a host's manual token is how an admin responds to a
            // suspected credential leak, and resolveCurrentCredentials() always
            // prefers a live, unexpired session over authTokenEnc. Without
            // this, rotating the token here would silently do nothing for
            // a claimed host: the primary would keep presenting the
            // now-orphaned old session indefinitely (it renews itself
            // forever), giving the admin false confidence the leak was
            // closed. Clearing the session forces resolveCurrentCredentials()
            // to fall back to the freshly-rotated token immediately, and
            // the agent's own next renewal attempt 401s and falls back to
            // re-registering with whatever bootstrap credential it has.
            sessionIdEnc: null,
            sessionSecretEnc: null,
            sessionExpiresAt: null,
            // Issue #2568 — minting a new bootstrap token is how an operator
            // re-arms a host whose machine identity was revoked, so the
            // revoked marker (which blocks claiming the row) is lifted.
            machineCredentialRevokedAt: null,
          }
        : {}),
    })
    .where(eq(hosts.id, id))
    .returning()
    .all();
  return updated.length > 0 ? toSummary(updated[0]) : undefined;
}

function countProjectsForHost(app: FastifyInstance, hostId: string): number {
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
  // Issue #2568 — the machine credential, present only on the responses that
  // hand one out: a first registration by an agent that asked for one, and
  // every credential-authenticated renewal (which rotates it). The agent
  // persists it; the primary keeps it only encrypted.
  machineCredential?: string;
}

export interface RegisterAgentInput {
  baseUrl: string;
  hostname: string;
  name?: string;
  capabilities?: unknown;
  // Issue #1721 / roadmap 8.7 — the agent's own platform
  // ("darwin" | "linux" | "win32" | …), reported free-form. Optional: an
  // agent build that predates the field simply does not send it, and the
  // column stays null. Never a gate — nothing branches on it (see
  // bridges.platform's own posture).
  platform?: string;
  // Issue #2568 — set by an agent that persists a machine identity. An agent
  // that predates it (or any manual caller) leaves it unset and is served the
  // legacy way: no credential is issued, and enrollHost dedupes on baseUrl.
  wantsMachineCredential?: boolean;
}

// Issue #2568 — a machine credential slides: each use pushes expiry out by
// this much, so an agent that is merely offline for a while keeps its
// identity, while one abandoned for a quarter stops being accepted.
const MACHINE_CREDENTIAL_TTL_MS = 90 * 24 * 60 * 60 * 1000;
// How long the PREVIOUS credential stays acceptable after a rotation, for an
// agent whose response was lost. Matches the session TTL: the agent renews at
// ~12 h, so a lost response is retried well inside it.
const MACHINE_CREDENTIAL_GRACE_MS = SESSION_TTL_MS;

const LEGACY_AGENT_NOTICE =
  "[host-registry] a legacy agent registered without a machine identity " +
  "(no state file / old release); it keeps working, but upgrade the agent to get a " +
  "persistent identity and renewable credential";

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
// Finding AS13: this used to `continue` past the rest of the loop body the
// moment a row matched — early-exiting the loop itself (via `return` inside
// the loop) once a match was found. The per-row compare
// (timingSafeTokenMatch) is constant-time, but the *loop* wasn't: which
// iteration returns leaks a row's position in `candidates`, and — more
// concretely — a call against a token near the front of the table does
// fewer AES-GCM decrypts than one near the back or one that matches
// nothing. Now every candidate is unconditionally decrypted and compared,
// so total work is the same (len(candidates) decrypts + compares) no matter
// which row matches or whether any do; only the first match (by iteration
// order) is kept, same as before.
//
// Hermes review, PR #579: decryptString throws DecryptionError on a
// malformed row (bad GCM auth tag, wrong shape) — the pre-AS13 code only
// ever reached a corrupt row if it was scanned *before* any match, so a
// corrupt row *after* the match was simply never decrypted (the early
// return skipped it). Now every row is decrypted unconditionally, so
// without a try/catch here a single corrupt row anywhere in the table would
// throw and break claimHost for every caller, including one presenting the
// correct token for a perfectly healthy row. A failed decrypt is treated as
// a non-match (logged, not swallowed silently) rather than re-thrown —
// keeps the "decrypt every candidate" property this fix exists for while
// not letting one bad row deny every legitimate claim.
export function claimHost(
  app: FastifyInstance,
  presentedToken: string,
  input: RegisterAgentInput,
): HostRegistration | null {
  const candidates = app.db
    .select()
    .from(hosts)
    .where(
      and(
        ne(hosts.id, LOCAL_HOST_ID),
        isNotNull(hosts.authTokenEnc),
        // Issue #2568 — revocation is final: a revoked identity cannot be
        // won back with the bootstrap token. Rotating the token re-arms it.
        isNull(hosts.machineCredentialRevokedAt),
      ),
    )
    .all();
  let matchedRow: HostRow | undefined;
  for (const row of candidates) {
    let isMatch = false;
    try {
      const decrypted = app.encryption.decryptString(row.authTokenEnc!);
      // Issue #1059 — both sides are server-minted fixed-length secrets
      // (see host-registry.ts's authToken issuer), so
      // timingSafeTokenMatch's length-side-channel is bounded — see
      // crypto-utils.ts for the full constraint.
      isMatch = timingSafeTokenMatch(presentedToken, decrypted);
    } catch (err) {
      app.log.warn(
        { err, hostId: row.id },
        "claimHost: failed to decrypt a candidate host's token; treating it as a non-match",
      );
    }
    if (isMatch && matchedRow === undefined) matchedRow = row;
  }
  if (matchedRow === undefined) return null;
  app.db
    .update(hosts)
    .set({
      baseUrl: input.baseUrl,
      origin: "manual",
      agentMetadata: JSON.stringify({
        hostname: input.hostname,
        capabilities: input.capabilities ?? null,
      }),
      // Issue #1721 — the agent's own self-report. A claim (a
      // manually-provisioned row an agent presents its token for) is still
      // an agent self-report, so its platform is recorded here too.
      //
      // An ABSENT platform is not a reset: an agent build that predates
      // the field does not send one, and that must not erase what a
      // newer build recorded earlier (the same rule
      // recordHostSelfReport() applies on the renewal path).
      ...(input.platform ? { platform: input.platform } : {}),
    })
    .where(eq(hosts.id, matchedRow.id))
    .run();
  return withMachineCredential(app, issueSession(app, matchedRow.id), input);
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
  // Issue #2568 — an agent that persists an identity is matched by host id on
  // every later registration, so baseUrl is not an identity for it: two
  // agents sharing an advertised URL each get their own row (and credential)
  // instead of re-stealing one. Only the legacy path below still dedupes.
  if (input.wantsMachineCredential) return insertEnrolledHost(app, input);
  const metadata = JSON.stringify({
    hostname: input.hostname,
    capabilities: input.capabilities ?? null,
  });
  const [existing] = app.db
    .select()
    .from(hosts)
    .where(
      and(
        eq(hosts.origin, "enrolled"),
        eq(hosts.baseUrl, input.baseUrl),
        isNull(hosts.machineCredentialRevokedAt),
        // A row with a machine identity belongs to an agent that presents it;
        // a legacy agent must not be able to take it over by URL.
        isNull(hosts.machineCredentialEnc),
      ),
    )
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
      .set({
        name: input.name?.trim() || input.hostname,
        agentMetadata: metadata,
        // Issue #1721 — the platform is refreshed on every enrollment, not
        // only on the first: an agent's platform does not change, but a
        // RE-ENROLLED agent (a wiped install root re-registering against a
        // row that survived) may report a different one — and one that
        // reports NONE (an older build, a downgrade, a mixed fleet) must
        // not erase what was recorded before. An absent platform is not a
        // reset, the same rule recordHostSelfReport() applies on renewal.
        ...(input.platform ? { platform: input.platform } : {}),
      })
      .where(eq(hosts.id, existing.id))
      .run();
    app.log.warn({ hostId: existing.id }, LEGACY_AGENT_NOTICE);
    return issueSession(app, existing.id);
  }
  app.log.warn(LEGACY_AGENT_NOTICE);
  return insertEnrolledHost(app, input);
}

function insertEnrolledHost(app: FastifyInstance, input: RegisterAgentInput): HostRegistration {
  const metadata = JSON.stringify({
    hostname: input.hostname,
    capabilities: input.capabilities ?? null,
  });
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
      platform: input.platform ?? null,
    })
    .run();
  return withMachineCredential(app, issueSession(app, id), input);
}

/**
 * Issue #2568 — a fresh machine credential for a host: the first one (claim /
 * enroll by an agent that asked for it) or a replacement after the operator
 * cleared the agent's state file. Returned in plaintext exactly once; stored
 * encrypted. A live previous credential moves to the grace slot (see below).
 */
function issueMachineCredential(app: FastifyInstance, hostId: string): string {
  const credential = crypto.randomBytes(32).toString("hex");
  // A claim cannot tell a deliberate re-enroll from a second agent sharing the
  // same per-host token. Keep a still-live credential in the grace slot so a
  // displaced agent converges onto the new one at its next renewal instead of
  // being 401-ed permanently.
  const existing = app.db
    .select({
      enc: hosts.machineCredentialEnc,
      revokedAt: hosts.machineCredentialRevokedAt,
      expiresAt: hosts.machineCredentialExpiresAt,
    })
    .from(hosts)
    .where(eq(hosts.id, hostId))
    .get();
  // An expired credential is already dead (renewMachineCredential rejects the
  // row), so it must not be revived into the grace slot.
  const replacesLive =
    !!existing?.enc &&
    !existing.revokedAt &&
    !!existing.expiresAt &&
    existing.expiresAt.getTime() > Date.now();
  if (replacesLive) {
    app.log.warn(
      { hostId },
      "[host-registry] a registration replaced a live machine identity; the displaced agent " +
        "(if any) converges via the grace credential. Expected after an operator re-enroll; a collision if two agents share one per-host token.",
    );
  }
  app.db
    .update(hosts)
    .set({
      machineCredentialEnc: app.encryption.encryptString(credential),
      machineCredentialPrevEnc: replacesLive ? existing.enc : null,
      machineCredentialRotatedAt: replacesLive ? new Date() : null,
      machineCredentialExpiresAt: new Date(Date.now() + MACHINE_CREDENTIAL_TTL_MS),
      machineCredentialRevokedAt: null,
    })
    .where(eq(hosts.id, hostId))
    .run();
  return credential;
}

function withMachineCredential(
  app: FastifyInstance,
  registration: HostRegistration,
  input: RegisterAgentInput,
): HostRegistration {
  if (!input.wantsMachineCredential) {
    app.log.warn({ hostId: registration.hostId }, LEGACY_AGENT_NOTICE);
    return registration;
  }
  return { ...registration, machineCredential: issueMachineCredential(app, registration.hostId) };
}

function safeMatch(app: FastifyInstance, presented: string, enc: string | null): boolean {
  if (!enc) return false;
  try {
    // Both sides are server-minted 64-char hex (see crypto-utils.ts).
    return timingSafeTokenMatch(presented, app.encryption.decryptString(enc));
  } catch (err) {
    app.log.warn({ err }, "[host-registry] machine credential failed to decrypt; non-match");
    return false;
  }
}

/**
 * Issue #2568 — re-registration with a stored identity. Matched by host id
 * (never baseUrl); on success issues a fresh session and rotates the
 * credential, returning the new one.
 *
 * Presenting the CURRENT credential rotates it: the old one becomes the
 * previous credential, accepted for a grace period. Presenting the PREVIOUS
 * credential means the agent never saw the rotation's response: the already
 * -issued current credential is returned again (not rotated further), so the
 * retry converges instead of chasing its own tail. Null on any mismatch — an
 * unknown host, a revoked or expired credential — and the caller 401s.
 */
export function renewMachineCredential(
  app: FastifyInstance,
  hostId: string,
  presented: string,
  input: Pick<RegisterAgentInput, "baseUrl" | "hostname" | "name" | "platform" | "capabilities">,
): HostRegistration | null {
  const row = getHostRow(app, hostId);
  if (!row || row.id === LOCAL_HOST_ID || !row.machineCredentialEnc) return null;
  if (row.machineCredentialRevokedAt) return null;
  if (!row.machineCredentialExpiresAt || row.machineCredentialExpiresAt.getTime() <= Date.now()) {
    return null;
  }
  // Evaluate both so timing does not reveal which slot matched.
  const isCurrent = safeMatch(app, presented, row.machineCredentialEnc);
  const prevLive =
    row.machineCredentialRotatedAt !== null &&
    Date.now() - row.machineCredentialRotatedAt.getTime() < MACHINE_CREDENTIAL_GRACE_MS;
  const isPrev = safeMatch(app, presented, prevLive ? row.machineCredentialPrevEnc : null);
  if (!isCurrent && !isPrev) return null;

  const selfReport = {
    // The identity is the host id, so the advertised URL follows the agent
    // (it may have moved); this is what replaces the baseUrl dedupe.
    baseUrl: input.baseUrl,
    agentMetadata: JSON.stringify({
      hostname: input.hostname,
      capabilities: input.capabilities ?? null,
    }),
    ...(input.platform ? { platform: input.platform } : {}),
  };
  const expiresAt = new Date(Date.now() + MACHINE_CREDENTIAL_TTL_MS);
  let credential: string;
  if (isCurrent) {
    credential = crypto.randomBytes(32).toString("hex");
    app.db
      .update(hosts)
      .set({
        ...selfReport,
        machineCredentialEnc: app.encryption.encryptString(credential),
        machineCredentialPrevEnc: row.machineCredentialEnc,
        machineCredentialRotatedAt: new Date(),
        machineCredentialExpiresAt: expiresAt,
      })
      .where(eq(hosts.id, hostId))
      .run();
  } else {
    credential = app.encryption.decryptString(row.machineCredentialEnc);
    app.db
      .update(hosts)
      // Slide the grace window: a stale holder that keeps presenting stays valid.
      .set({
        ...selfReport,
        machineCredentialRotatedAt: new Date(),
        machineCredentialExpiresAt: expiresAt,
      })
      .where(eq(hosts.id, hostId))
      .run();
    // Info, not warn: a lost renewal response produces the same line legitimately.
    app.log.info({ hostId }, "[host-registry] renewal accepted via the grace credential");
  }
  return { ...issueSession(app, hostId), machineCredential: credential };
}

/**
 * Issue #2568 — final revocation of a host's machine identity. Drops the
 * credential, its grace copy and the live session, and marks the row so the
 * bootstrap token cannot claim it back. The agent gets 401 on its next
 * renewal and, by design, does not fall back to the bootstrap token.
 * Returns false for an unknown host.
 */
export function revokeMachineIdentity(app: FastifyInstance, hostId: string): boolean {
  const updated = app.db
    .update(hosts)
    .set({
      machineCredentialEnc: null,
      machineCredentialPrevEnc: null,
      machineCredentialRotatedAt: null,
      machineCredentialExpiresAt: null,
      machineCredentialRevokedAt: new Date(),
      sessionIdEnc: null,
      sessionSecretEnc: null,
      sessionExpiresAt: null,
    })
    .where(and(eq(hosts.id, hostId), ne(hosts.id, LOCAL_HOST_ID)))
    .returning()
    .all();
  return updated.length > 0;
}

// Shared by rotateSession (below) and verifyHostSession — the read-only
// "does this hostId+sessionId match a live, unexpired session" check, with
// no side effects. Returns null on any mismatch (unknown hostId, no session
// on that row, a stale/wrong session id, or a session id that matches but
// has already expired — the TTL must actually bound a leaked credential,
// not just be advisory).
function findLiveSession(
  app: FastifyInstance,
  hostId: string,
  presentedSessionId: string,
): HostRow | null {
  const row = getHostRow(app, hostId);
  if (!row || !row.sessionIdEnc) return null;
  const decrypted = app.encryption.decryptString(row.sessionIdEnc);
  // Issue #1059 — both sides are fixed-length (server-issued sessionId vs
  // inbound bearer); same assumption as the authToken check in claimHost
  // above — see crypto-utils.ts for the full constraint.
  if (!timingSafeTokenMatch(presentedSessionId, decrypted)) return null;
  if (!row.sessionExpiresAt || row.sessionExpiresAt.getTime() <= Date.now()) return null;
  return row;
}

/**
 * Records an agent's self-report on an EXISTING row, without touching its
 * session credential (issue #1721 / roadmap 8.7).
 *
 * The renewal path (routes/enrollment.ts) re-presents the agent's current
 * session id to get a fresh secret before its TTL expires; it used to
 * ignore the registration body's self-report entirely, which meant the
 * platform could never be refreshed on a host that was already enrolled.
 * This is the seam that lets it be: the self-report is informational
 * state, so it is written on its own, independently of the credential
 * rotation.
 *
 * A field the caller does NOT supply is left exactly as it was — an
 * older agent build that reports no platform must not ERASE the platform a
 * newer build recorded earlier.
 */
export function recordHostSelfReport(
  app: FastifyInstance,
  hostId: string,
  report: { platform?: string },
): void {
  const patch: { platform?: string } = {};
  if (report.platform !== undefined && report.platform !== "") patch.platform = report.platform;
  if (Object.keys(patch).length === 0) return;
  app.db.update(hosts).set(patch).where(eq(hosts.id, hostId)).run();
}

/**
 * D2 — renewal. The agent re-authenticates with its own CURRENT session id
 * (not the bootstrap token) to get a fresh secret before TTL expiry. Returns
 * null on any mismatch — the caller (routes/enrollment.ts) responds 401,
 * and the agent's own retry logic (agent-enrollment.ts) falls back to its
 * bootstrap token, exactly #157's "primary DB loss -> 401 -> re-register"
 * path.
 */
export function rotateSession(
  app: FastifyInstance,
  hostId: string,
  presentedSessionId: string,
): HostRegistration | null {
  const row = findLiveSession(app, hostId, presentedSessionId);
  if (!row) return null;
  return issueSession(app, hostId);
}

/**
 * Issue #248 / roadmap 7.3 — the read-only counterpart to rotateSession,
 * used by the deregister endpoint. A deregister call only needs to prove
 * "I hold this host's current session," never to mint a new one — issuing a
 * fresh session on a call whose whole point is "I'm shutting down" would be
 * pointless and would just leave a credential nothing will ever use.
 */
export function verifyHostSession(
  app: FastifyInstance,
  hostId: string,
  presentedSessionId: string,
): boolean {
  return findLiveSession(app, hostId, presentedSessionId) !== null;
}

/**
 * Issue #248 / roadmap 7.3 (Hermes review, PR #530) — revokes a host's
 * session credential outright, called on deregister after verifyHostSession
 * confirms the caller holds it. This is free: a self-registered agent is
 * stateless and always re-establishes a brand-new session from its
 * bootstrap credential on its very next boot (agent-enrollment.ts), so
 * nothing depends on the outgoing session staying valid. Without this, a
 * session that just told the primary "I'm going away" would otherwise
 * remain a valid inbound Bearer credential for up to its full 24h TTL.
 * Same fields updateHost() clears when an admin rotates a claimed host's
 * token, for the same reason.
 *
 * Note this makes POST /api/internal/deregister non-idempotent: a second
 * call with the same (now-cleared) sessionId 401s via verifyHostSession
 * rather than repeating the prior 204 (independent review, PR #530). Not a
 * problem today — agent-enrollment.ts's callDeregister is a single
 * best-effort fetch with no retry — but worth remembering if retry logic
 * is ever added there, so a retried-but-actually-successful deregister
 * doesn't get logged as a failure.
 */
export function clearHostSession(app: FastifyInstance, hostId: string): void {
  app.db
    .update(hosts)
    .set({ sessionIdEnc: null, sessionSecretEnc: null, sessionExpiresAt: null })
    .where(eq(hosts.id, hostId))
    .run();
}
