import crypto from "node:crypto";

/**
 * Constant-time token compare — crypto.timingSafeEqual throws on unequal
 * lengths, so the length check that guards it is an unavoidable, accepted
 * side channel (the token's length, not its content) for a long random
 * shared secret. Shared by every in-process bearer-token gate: the
 * agent-role internal API (src/routes/internal.ts) and the primary's own
 * optional auth gate (src/plugins/auth.ts) — see MULLION_AGENT_TOKEN and
 * MULLION_AUTH_TOKEN in src/plugins/env.ts.
 *
 * **Fixed-length tokens only (issue #1059).** Every caller MUST present a
 * token of the SAME length as the expected one — the `provided.length !==
 * expected.length` short-circuit above is the documented side channel
 * (timingSafeEqual itself refuses to compare unequal-length buffers). This
 * is fine for every credential this gate currently handles (random
 * 32-byte session ids, generated API tokens), but it means dropping this
 * compare in front of a USER-CHOSEN password or any variable-length input
 * would leak the expected length on a wrong guess — the channel is real,
 * just bounded to "token lengths" rather than "token contents." See each
 * call site's own comment for the specific credential it compares.
 */
export function timingSafeTokenMatch(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}
