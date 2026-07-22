import crypto from "node:crypto";

/**
 * Constant-time token compare — crypto.timingSafeEqual throws on unequal
 * lengths, so the length check that guards it is an unavoidable, accepted
 * side channel (the token's length, not its content) for a long random
 * shared secret. Shared by every in-process bearer-token gate: the
 * agent-role internal API (src/routes/internal.ts) and the primary's own
 * optional auth gate (src/plugins/auth.ts) — see MULLION_AGENT_TOKEN and
 * MULLION_AUTH_TOKEN in src/plugins/env.ts.
 */
export function timingSafeTokenMatch(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}
