import type { FastifyInstance } from "fastify";

/**
 * Issue #3476 — the deprecation notices for the legacy host kinds.
 *
 * Decision #3320 (revised): once the replacements ship, the legacy paths are
 * deprecated. This module carries the notices — and, since issue #3477, the
 * text of the two refusals the gate answers with. The gating itself
 * (MULLION_ALLOW_LEGACY_HOSTS) lives in the routes that own each path; the
 * per-host signal the UI reads is HostSummary.deprecatedKind
 * (src/services/host-registry.ts).
 *
 * Two notices live here:
 *
 * - the startup warning, when the fleet-wide enrollment secret is configured
 *   (MULLION_ENROLLMENT_SECRET) — the primary-side half of the fleet-secret
 *   kind: the operator's own configuration is on its way out;
 * - the once-per-process warning on the first fleet-secret enrollment — the
 *   host-side half: it says so at the moment a host actually enrolls, so an
 *   operator watching the log sees the path still in use.
 *
 * And, since issue #3477, three more:
 *
 * - the once-per-process warning on the first REFUSED fleet-secret
 *   enrollment — the gate is on and the operator needs to know why the fleet
 *   stopped answering (it has a variant per cause: a peer outside the
 *   allowed CIDRs, and a host whose advertised address no longer matches
 *   its row);
 * - the message the create-host route answers 400 with.
 */

/** What the primary logs at startup when the fleet enrollment secret is set. */
export const LEGACY_ENROLLMENT_SECRET_WARNING =
  "MULLION_ENROLLMENT_SECRET is set — deprecated: use automation tokens instead; " +
  "removal is planned.";

/**
 * Issue #3477 — what the primary logs at startup when the fleet enrollment
 * secret is set AND the legacy gate is off. The path is not merely deprecated
 * then: it no longer CREATES a host, and an operator whose agents stop
 * enrolling needs to read that off the boot log rather than guess. The hosts
 * that already exist may still register — the gate stops new ones.
 */
export const LEGACY_ENROLLMENT_SECRET_REFUSED_WARNING =
  "MULLION_ENROLLMENT_SECRET is set — deprecated and refused for new hosts: use automation " +
  "tokens instead; set MULLION_ALLOW_LEGACY_HOSTS=true to accept fleet-secret enrollment again.";

/** What the primary logs once, when the first host enrolls with the fleet secret. */
export const LEGACY_FLEET_ENROLLMENT_WARNING =
  "a host enrolled with the fleet secret — deprecated: use automation tokens instead; " +
  "removal is planned.";

/**
 * Issue #3477 — what the primary logs once, when it refuses the first
 * fleet-secret enrollment because the legacy gate is off.
 *
 * It names TWO ways out, because the refusal cannot tell them apart: the
 * host may be new (the gate did its job), or it may be a host that already
 * exists but no longer advertises the address on its row (the row is there;
 * the address on it is stale). Flipping the flag is only the right advice
 * for the first — for the second it would create a SECOND row for a host
 * the operator already has.
 */
export const LEGACY_FLEET_ENROLLMENT_REFUSED_WARNING =
  "a host tried to enroll with the fleet secret — refused: the fleet-wide enrollment " +
  "secret is deprecated (use automation tokens instead) and the gate refuses to create new " +
  "legacy hosts; set MULLION_ALLOW_LEGACY_HOSTS=true to accept them again, or check that the " +
  "host still advertises the address it enrolled with (Settings → Hosts → Edit).";

/**
 * Issue #3477 — the same refusal, but the peer address was outside
 * MULLION_ENROLLMENT_ALLOWED_CIDRS. It is a separate notice because the
 * operator has to tell the two apart: one is a host that does not exist
 * yet, the other a host that may not register from where it is.
 */
export const LEGACY_FLEET_ENROLLMENT_REFUSED_ADDRESS_WARNING =
  "a host tried to enroll with the fleet secret from an address outside " +
  "MULLION_ENROLLMENT_ALLOWED_CIDRS — refused: the fleet-wide enrollment secret is " +
  "deprecated (use automation tokens instead) and the gate refuses to create new legacy " +
  "hosts; allow the address, or set MULLION_ALLOW_LEGACY_HOSTS=true.";

/**
 * Issue #3477 — the refusal above, but the fleet has a legacy host that
 * reports the same hostname as the agent that was turned away: the host
 * changed its address (a container recreated at a new IP, a Base URL the
 * operator edited in Settings), so it no longer matches the row it enrolled
 * with. The row exists — only the address on it is stale — and flipping the
 * gate is the wrong advice for it: the fix is to put the address the agent
 * now advertises on the row (Settings → Hosts → Edit, PATCH
 * /api/hosts/:id { baseUrl }) or to pair the host again.
 *
 * A separate notice, because the operator has to tell the two apart: one is
 * a host that does not exist yet, the other a host that is known but no
 * longer at the address on its row.
 */
export const LEGACY_FLEET_ENROLLMENT_REFUSED_ADDRESS_MISMATCH_WARNING =
  "a host tried to enroll with the fleet secret at an address no host row holds — refused: the " +
  "fleet-wide enrollment secret is deprecated (use automation tokens instead) and the gate refuses " +
  "to create new legacy hosts; a host that already exists has to advertise the address it enrolled " +
  "with (update it in Settings → Hosts → Edit, or PATCH /api/hosts/:id { baseUrl }), or set " +
  "MULLION_ALLOW_LEGACY_HOSTS=true to accept fleet-secret enrollment again.";

/**
 * Issue #3477 — what the primary logs once, when a host that already exists
 * re-registers with the fleet secret. The gate does not stop that — the host
 * is already on the fleet-secret path — but the path is on its way out, so
 * the operator sees that their fleet still depends on it.
 */
export const LEGACY_FLEET_ENROLLMENT_REUSED_WARNING =
  "a host that already existed re-registered with the fleet secret — deprecated: use " +
  "automation tokens or a one-time pairing code instead; removal is planned.";

/**
 * Issue #3477 — the 400 that POST /api/hosts answers with while the legacy
 * gate is off. It names the two replacements: the _Add host_ flow (a one-time
 * pairing code) and automation tokens (which mint one-off pairing codes).
 */
export const LEGACY_HOST_CREATE_REFUSED_MESSAGE =
  'adding a host by token is deprecated and refused — use "Add host" (it issues a ' +
  "one-time pairing code) or an automation token instead; set " +
  "MULLION_ALLOW_LEGACY_HOSTS=true to keep the old path.";

// The notices this process has emitted. One set, two jobs:
//
//   - each notice is emitted ONCE per process: a fleet of a hundred agents
//     enrolling must not fill the log with the same line, and the operator
//     needs to see it exactly once to know the path is still in use;
//   - it is also the RECORD of what was said. The notice is a module-scope
//     fact rather than a property of the app, so a test can read it after
//     the fact. The startup notice in particular is logged while the app is
//     still building (buildApp() boots the whole plugin tree before it
//     returns), so the boot test pins the LOGGED LINE as well — it captures
//     the process's stdout — and this record says the notice was emitted
//     exactly once.
const emitted = new Set<string>();

/** The deprecation notices this process has emitted. */
export function legacyHostDeprecationNotices(): ReadonlySet<string> {
  return emitted;
}

function emitOnce(app: FastifyInstance, message: string): void {
  if (emitted.has(message)) return;
  emitted.add(message);
  app.log.warn(message);
}

/**
 * The same once-per-process dedupe, but the line carries a context payload —
 * the host id the operator needs to find the row in Settings. The dedupe
 * stays on the MESSAGE, so a fleet of twenty agents still produces one line;
 * that line names the host it is about.
 */
function emitOnceWith(
  app: FastifyInstance,
  message: string,
  context: Record<string, unknown>,
): void {
  if (emitted.has(message)) return;
  emitted.add(message);
  app.log.warn(context, message);
}

/**
 * Report the first fleet-secret enrollment. Called from the fleet-secret
 * branch of routes/enrollment.ts, so it fires exactly when a host enrolled
 * with the fleet-wide secret.
 */
export function noteLegacyFleetEnrollment(app: FastifyInstance): void {
  emitOnce(app, LEGACY_FLEET_ENROLLMENT_WARNING);
}

/**
 * Report the first REFUSED fleet-secret enrollment (issue #3477). Called from
 * the fleet-secret branch of routes/enrollment.ts when the legacy gate is
 * off, so it fires exactly when a host was turned away — and says once per
 * process why, because a fleet of agents re-registering on every boot would
 * otherwise fill the log with the same line.
 *
 * `addressNotAllowed` picks the variant for a peer outside
 * MULLION_ENROLLMENT_ALLOWED_CIDRS: the operator has to tell the two apart
 * (a host that does not exist yet, versus a host that may not register from
 * where it is), and both are refused with the same 401 the caller sees.
 *
 * `addressMismatchHostId` picks the variant for a host whose advertised
 * address no longer matches its row — the row exists, but at another address
 * — and names that row. The advice is different there: flipping the flag is
 * not what such a host needs, its row needs the address it now advertises.
 */
export function refuseLegacyFleetEnrollment(
  app: FastifyInstance,
  opts: { addressNotAllowed?: boolean; addressMismatchHostId?: string } = {},
): void {
  if (opts.addressNotAllowed) {
    emitOnce(app, LEGACY_FLEET_ENROLLMENT_REFUSED_ADDRESS_WARNING);
    return;
  }
  if (opts.addressMismatchHostId) {
    emitOnceWith(app, LEGACY_FLEET_ENROLLMENT_REFUSED_ADDRESS_MISMATCH_WARNING, {
      hostId: opts.addressMismatchHostId,
    });
    return;
  }
  emitOnce(app, LEGACY_FLEET_ENROLLMENT_REFUSED_WARNING);
}

/**
 * Report the first fleet-secret registration that was served by a host row
 * that already existed (issue #3477). The gate does not stop that — the
 * host is already on the fleet-secret path — but the path is on its way
 * out, so the operator sees that their fleet still depends on it.
 *
 * `hostId` names the row in the log line: an operator with twenty agents
 * has to be able to tell WHICH host still depends on the fleet secret, and
 * the row id is what Settings → Hosts lists it under.
 */
export function noteLegacyFleetHostReuse(app: FastifyInstance, hostId: string): void {
  emitOnceWith(app, LEGACY_FLEET_ENROLLMENT_REUSED_WARNING, { hostId });
}

/**
 * Test-only reset: the notices are module-scope state, so a test that
 * asserts on them must not depend on what an earlier test in the same file
 * already logged (the same reason test/setup.ts resets the host-registry
 * notices before every test).
 */
export function resetLegacyHostDeprecationNotices(): void {
  emitted.clear();
}

/**
 * Warn at startup when the fleet-wide enrollment secret is configured.
 *
 * Nothing about the secret changes here: this only says that the path is on
 * its way out and what replaces it. Since issue #3477 the gate decides which
 * of the two notices it is: with MULLION_ALLOW_LEGACY_HOSTS on, the secret
 * still works and the notice says "deprecated"; with it off (the default),
 * the secret is REFUSED, and a notice that only said "deprecated" would
 * leave the operator guessing why the fleet stopped enrolling.
 */
export function warnLegacyEnrollmentSecretAtBoot(app: FastifyInstance): void {
  if (app.config.MULLION_ENROLLMENT_SECRET.trim() === "") return;
  emitOnce(
    app,
    app.config.MULLION_ALLOW_LEGACY_HOSTS
      ? LEGACY_ENROLLMENT_SECRET_WARNING
      : LEGACY_ENROLLMENT_SECRET_REFUSED_WARNING,
  );
}
