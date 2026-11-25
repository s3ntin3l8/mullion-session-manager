import type { FastifyInstance } from "fastify";

/**
 * Issue #3476 — the deprecation notices for the legacy host kinds.
 *
 * Decision #3320 (revised): once the replacements ship, the legacy paths are
 * deprecated. This module only SAYS so — nothing here refuses, gates or
 * changes behaviour. The gating (MULLION_ALLOW_LEGACY_HOSTS) and the removal
 * are later issues; the per-host signal the UI reads is
 * HostSummary.deprecatedKind (src/services/host-registry.ts).
 *
 * Two notices live here:
 *
 * - the startup warning, when the fleet-wide enrollment secret is configured
 *   (MULLION_ENROLLMENT_SECRET) — the primary-side half of the fleet-secret
 *   kind: the operator's own configuration is on its way out;
 * - the once-per-process warning on the first fleet-secret enrollment — the
 *   host-side half: it says so at the moment a host actually enrolls, so an
 *   operator watching the log sees the path still in use.
 */

/** What the primary logs at startup when the fleet enrollment secret is set. */
export const LEGACY_ENROLLMENT_SECRET_WARNING =
  "MULLION_ENROLLMENT_SECRET is set — deprecated: use automation tokens instead; " +
  "removal is planned.";

/** What the primary logs once, when the first host enrolls with the fleet secret. */
export const LEGACY_FLEET_ENROLLMENT_WARNING =
  "a host enrolled with the fleet secret — deprecated: use automation tokens instead; " +
  "removal is planned.";

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
 * Nothing about the secret changes here: the host keeps enrolling exactly as
 * before, this only says that the path is on its way out and what replaces
 * it.
 */
export function warnLegacyEnrollmentSecretAtBoot(app: FastifyInstance): void {
  if (app.config.MULLION_ENROLLMENT_SECRET.trim() === "") return;
  emitOnce(app, LEGACY_ENROLLMENT_SECRET_WARNING);
}
