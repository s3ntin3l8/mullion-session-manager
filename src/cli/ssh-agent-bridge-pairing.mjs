// Issue #820 (PR6) — deliberately duplicated from
// src/services/bridge-registry.ts's decodePairingPayload(), not imported:
// that module pulls in drizzle-orm and the DB schema, neither of which
// belong in a standalone laptop CLI (see ssh-agent-bridge-mux.mjs's own
// header comment for the general "why duplicated, not shared" reasoning).
// The format itself — plain base64url of `{baseUrl, code}` — is stable and
// intentionally trivial precisely so two independent implementations can't
// drift on it; if it ever needs to change, bridge-registry.ts's own
// encodePairingPayload() is the side that changes first, and this must be
// updated to match by hand.

/** Returns `null` for anything that isn't a well-formed payload — a
 * mistyped/truncated paste is this CLI's own input-validation concern, not
 * something to throw over. */
export function decodePairingPayload(encoded) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { baseUrl, code } = parsed;
  if (typeof baseUrl !== "string" || typeof code !== "string") return null;
  if (baseUrl === "" || code === "") return null;
  return { baseUrl, code };
}
