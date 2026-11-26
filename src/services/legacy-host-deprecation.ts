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
 * And, since issue #3477, two more:
 *
 * - the once-per-process warning on the first REFUSED fleet-secret
 *   enrollment — the gate is on and the operator needs to know why the fleet
 *   stopped answering;
 * - the message the create-host route answers 400 with.
 */

/** What the primary logs at startup when the fleet enrollment secret is set. */
export const LEGACY_ENROLLMENT_SECRET_WARNING =
  "MULLION_ENROLLMENT_SECRET is set — deprecated: use automation tokens instead; " +
  "removal is planned.";

/**
 * Issue #3477 — what the primary logs at startup when the fleet enrollment
 * secret is set AND the legacy gate is off. The path is not merely deprecated
 * then: it is refused, and an operator whose agents stop enrolling needs to
 * read that off the boot log rather than guess.
 */
export const LEGACY_ENROLLMENT_SECRET_REFUSED_WARNING =
  "MULLION_ENROLLMENT_SECRET is set — deprecated and refused: use automation tokens " +
  "instead; set MULLION_ALLOW_LEGACY_HOSTS=true to accept fleet-secret enrollment again.";

/** What the primary logs once, when the first host enrolls with the fleet secret. */
export const LEGACY_FLEET_ENROLLMENT_WARNING =
  "a host enrolled with the fleet secret — deprecated: use automation tokens instead; " +
  "removal is planned.";

/**
 * Issue #3477 — what the primary logs once, when it refuses the first
 * fleet-secret enrollment because the legacy gate is off.
 */
export const LEGACY_FLEET_ENROLLMENT_REFUSED_WARNING =
  "a host tried to enroll with the fleet secret — refused: the fleet-wide enrollment " +
  "secret is deprecated (use automation tokens instead); set MULLION_ALLOW_LEGACY_HOSTS=true " +
  "to accept it again.";

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
 */
export function refuseLegacyFleetEnrollment(app: FastifyInstance): void {
  emitOnce(app, LEGACY_FLEET_ENROLLMENT_REFUSED_WARNING);
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
