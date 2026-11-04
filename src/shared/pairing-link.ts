// Issue #2449 — the `mullion://pair` deep link the dashboard hands the desktop
// Helper. It carries the primary URL and the one-time bootstrap code ONLY:
// never a durable credential, the fleet enrollment secret or an SSH key.
// Shared so the server, the dashboard's paste fallback and the tests agree on
// the exact shape (docs/multi-host.md, "Pairing a desktop Helper").

export const PAIRING_LINK_SCHEME = "mullion:";
export const PAIRING_CODE_PATTERN = /^[0-9a-f]{64}$/;

export interface PairingLink {
  url: string;
  code: string;
}

export function buildPairingLink({ url, code }: PairingLink): string {
  return `mullion://pair?url=${encodeURIComponent(url)}&code=${encodeURIComponent(code)}`;
}

/**
 * Parses a pairing link. Returns null for anything malformed: wrong scheme or
 * action, a missing or non-http(s) url, a code that is not 64 lowercase hex
 * characters, or unexpected extra parameters (a link must carry nothing else).
 */
export function parsePairingLink(link: string): PairingLink | null {
  let parsed: URL;
  try {
    parsed = new URL(link.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== PAIRING_LINK_SCHEME || parsed.hostname !== "pair") return null;
  const keys = [...parsed.searchParams.keys()];
  if (keys.length !== 2 || !keys.includes("url") || !keys.includes("code")) return null;
  const url = parsed.searchParams.get("url");
  const code = parsed.searchParams.get("code");
  if (!url || !code || !PAIRING_CODE_PATTERN.test(code)) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { url, code };
}
