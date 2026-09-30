import type { FastifyInstance } from "fastify";
import { getStoredSettings } from "./settings.js";

// GitHub's `author_association` values that imply the author has (at least)
// been granted access to the repo by its owner. Everything else — CONTRIBUTOR,
// FIRST_TIME_CONTRIBUTOR, FIRST_TIMER, MANNEQUIN, NONE — is an outsider: on a
// public repo they can open issues and comment freely, so their text must
// never reach an unattended worker agent unvetted.
export const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

/**
 * Whether text authored by `login` with GitHub association `association` may
 * be ingested as a task / injected into a worker prompt. Fails closed: a
 * missing association is untrusted unless the login is allowlisted (bot
 * accounts never carry OWNER/MEMBER/COLLABORATOR, so they need the allowlist).
 * `trustedLogins` is expected pre-lowercased (see resolveTrustedLogins).
 */
export function isTrustedAuthor(
  association: string | undefined,
  login: string | null | undefined,
  trustedLogins: ReadonlySet<string>,
): boolean {
  if (association !== undefined && TRUSTED_ASSOCIATIONS.has(association.toUpperCase())) {
    return true;
  }
  return login != null && trustedLogins.has(login.toLowerCase());
}

/** Union of MULLION_TASK_TRUSTED_LOGINS (env, comma-separated) and
 * settings.taskMaster.trustedLogins, lowercased — GitHub logins are
 * case-insensitive. Resolved fresh per call, like resolveTaskMasterConfig,
 * so a settings change applies on the next sweep/spawn without a restart. */
export function resolveTrustedLogins(app: FastifyInstance): Set<string> {
  const fromEnv = app.config.MULLION_TASK_TRUSTED_LOGINS.split(",");
  const fromSettings = getStoredSettings(app.db).taskMaster.trustedLogins;
  return new Set(
    [...fromEnv, ...fromSettings].map((l) => l.trim().toLowerCase()).filter((l) => l !== ""),
  );
}
