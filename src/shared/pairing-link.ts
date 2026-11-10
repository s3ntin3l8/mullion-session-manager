// Issue #2449 — the `mullion://pair` deep link the dashboard hands the desktop
// Helper. It carries the primary URL and the one-time bootstrap code ONLY:
// never a durable credential, the fleet enrollment secret or an SSH key.
// Shared so the server, the dashboard's paste fallback and the tests agree on
// the exact shape (docs/multi-host.md, "Pairing a desktop Helper").

const PAIRING_LINK_SCHEME = "mullion:";
export const PAIRING_CODE_PATTERN = /^[0-9a-f]{64}$/;

export interface PairingLink {
  url: string;
  code: string;
}

export function buildPairingLink({ url, code }: PairingLink): string {
  return `mullion://pair?url=${encodeURIComponent(url)}&code=${encodeURIComponent(code)}`;
}

/**
 * Normalizes an http(s) base URL to its bare origin (`scheme://host[:port]`).
 * Null for anything else: another scheme, embedded userinfo (a link must never
 * smuggle credentials to the Helper), or a malformed URL. Any path, query or
 * fragment is dropped.
 */
export function normalizePairingOrigin(value: string): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username !== "" || u.password !== "") return null;
  return u.origin;
}

/**
 * Parses a pairing link. Returns null for anything malformed: wrong scheme or
 * action, a missing or non-http(s) url, a url carrying userinfo, a code that
 * is not 64 lowercase hex characters, or unexpected extra parameters (a link
 * must carry nothing else). `url` in the result is the NORMALIZED origin.
 *
 * This is the REFERENCE for the Helper's own link parser (the Helper is a
 * separate program and must implement the same rules). The server never parses
 * a link in production: the dashboard only builds, displays and copies it.
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
  const origin = normalizePairingOrigin(url);
  if (origin === null) return null;
  return { url: origin, code };
}
