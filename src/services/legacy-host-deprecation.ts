import type { FastifyInstance } from "fastify";

/**
 * Issue #3535 (follows #3476, #3477) — boot-time notice when the removed
 * fleet-wide enrollment secret is still configured in the operator's
 * environment.
 *
 * MULLION_ENROLLMENT_SECRET was removed from app.config (src/plugins/env.ts)
 * along with the fleet-secret enrollment path; if an operator still has it
 * set in their environment, log once at startup so they know the path is gone
 * and what replaces it (the Add host pairing flow and automation tokens).
 */

/** What the primary logs at startup when the removed fleet enrollment secret is still set. */
export const LEGACY_ENROLLMENT_SECRET_WARNING =
  "MULLION_ENROLLMENT_SECRET is set, but fleet-secret enrollment has been removed — " +
  'use the "Add host" pairing flow or automation tokens instead.';

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
 * Test-only reset: the notices are module-scope state, so a test that
 * asserts on them must not depend on what an earlier test in the same file
 * already logged (the same reason test/setup.ts resets the host-registry
 * notices before every test).
 */
export function resetLegacyHostDeprecationNotices(): void {
  emitted.clear();
}

/**
 * Warn at startup when the removed fleet-wide enrollment secret is still
 * present in the `.env` file or process environment.
 *
 * Accepts `dotenvOverrides` from `src/app.ts` (`loadDotenvOverrides()`) and
 * falls back to `process.env.MULLION_ENROLLMENT_SECRET` (mirroring `env.ts`'s
 * merged view, since `.env` is not written into `process.env`), because the
 * key was removed from `src/plugins/env.ts` (`app.config`) in #3535.
 */
export function warnLegacyEnrollmentSecretAtBoot(
  app: FastifyInstance,
  dotenvOverrides: NodeJS.Dict<string>,
): void {
  const secret =
    dotenvOverrides.MULLION_ENROLLMENT_SECRET ?? process.env.MULLION_ENROLLMENT_SECRET ?? "";
  if (secret.trim() === "") return;
  emitOnce(app, LEGACY_ENROLLMENT_SECRET_WARNING);
}
