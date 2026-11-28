import type { FastifyInstance } from "fastify";
import { listHosts } from "./host-registry.js";

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
let deprecatedHostsWarned = false;

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
  deprecatedHostsWarned = false;
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

/**
 * Issue #3578 — boot-time notice when any host row is still on a deprecated
 * connection path (`legacy-agent` or `manual-token`).
 *
 * Logs at most one warning per process listing each affected host's name and
 * kind, stating that the connection method is removed in the next release and
 * that Re-pair (Settings → Hosts) replaces it. Never logs a token, credential,
 * or address.
 */
export function warnDeprecatedHostsAtBoot(app: FastifyInstance): void {
  if (deprecatedHostsWarned) return;
  const deprecated = listHosts(app).filter((h) => h.deprecatedKind !== null);
  if (deprecated.length === 0) return;
  deprecatedHostsWarned = true;
  const hostList = deprecated.map((h) => `${h.name} (${h.deprecatedKind})`).join(", ");
  emitOnce(
    app,
    `Deprecated host connection method(s) in use: ${hostList}. ` +
      "This connection method is removed in the next release — " +
      "Re-pair (Settings → Hosts) replaces it.",
  );
}
