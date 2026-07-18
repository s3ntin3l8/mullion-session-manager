// Shared http(s) URL validation for two different trust boundaries:
// - hosts.ts (issue #26): admin-only host registration — loopback and
//   private ranges are legitimate, common cases (this repo's own tests use
//   loopback), so only link-local/shared-NAT/cloud-IMDS ranges are
//   rejected. See its own comment for the full rationale.
// - previews.ts (issue #28 phase 5): a URL a user types into a browser-pane
//   address bar — untrusted input crossing a real privilege boundary (this
//   server fetches whatever it names on the caller's behalf), so loopback
//   and RFC1918/IPv6-ULA private ranges are rejected too, on top of the
//   same link-local/IMDS check.
//
// Both call the same underlying hostname classification — only the
// allowLoopback/allowPrivate policy flags differ per caller — so a fix to
// the classification logic (e.g. the IPv4-mapped-IPv6 bypass below) lands
// for both callers at once, not just whichever one happened to get it first.

const IPV4_LITERAL = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

type IPv4Octets = [number, number, number, number];

function ipv4Octets(hostname: string): IPv4Octets | null {
  const match = hostname.match(IPV4_LITERAL);
  if (!match) return null;
  const octets = match.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255)) return null;
  return octets as IPv4Octets;
}

function isLinkLocalOrSharedNatIPv4(octets: IPv4Octets): boolean {
  const [a, b] = octets;
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local, cloud IMDS)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (RFC 6598 shared NAT)
  return false;
}

function isLoopbackIPv4(octets: IPv4Octets): boolean {
  return octets[0] === 127; // 127.0.0.0/8
}

function isPrivateIPv4(octets: IPv4Octets): boolean {
  const [a, b] = octets;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 0) return true; // 0.0.0.0/8 ("this network")
  return false;
}

// IPv6 analogs of the checks above: link-local (fe80::/10, IPv6's
// 169.254.0.0/16), AWS's IPv6 instance-metadata address specifically,
// loopback (::1), the unspecified address (:: — blocked explicitly below,
// via the same allowLoopback gate as ::1; connects to localhost on most
// stacks, so this is a real loopback bypass if left unblocked, the same
// way IPv4 0.0.0.0 is), and unique-local (fc00::/7, IPv6's RFC1918
// analog). `URL#hostname` keeps the brackets for an IPv6 literal (e.g.
// "[fe80::1]"), so strip them first. Matched against a handful of
// equivalent textual forms rather than full RFC 4291 zero-compression
// canonicalization, which is overkill for this narrow, documented
// defense-in-depth check — same "cheap, not exhaustive" bar the IPv4
// checks above use.
const IPV6_LINK_LOCAL = /^fe[89ab][0-9a-f]:/i;
const IPV6_IMDS_FORMS = new Set([
  "fd00:ec2::254",
  "fd00:ec2:0:0:0:0:0:254",
  "fd00:ec2:0000:0000:0000:0000:0000:0254",
]);
const IPV6_UNIQUE_LOCAL = /^f[cd][0-9a-f]{2}:/i;

// An IPv6 address whose low 32 bits encode an IPv4 address bypasses the
// plain IPv4 checks (hostname is bracketed IPv6, not a bare dotted-quad)
// and the link-local/IMDS/unique-local regex/set above (none match this
// form) — a real bypass of the whole guard, not an edge case. RFC 4291
// defines two such encodings, and `new URL(...).hostname` normalizes both
// down to "::" (or "::ffff:") plus exactly two hex groups:
//   - IPv4-mapped: "::ffff:169.254.169.254" -> "::ffff:a9fe:a9fe"
//   - IPv4-compatible (deprecated but still parsed): "::169.254.169.254"
//     -> "::a9fe:a9fe" (no "ffff:" prefix) — a *distinct* hole from the
//     mapped form; the mapped-only version of this regex shipped first and
//     missed it (caught in review on PR #47).
// Both are unwrapped identically below. Deliberately over-inclusive: a
// legitimate compressed IPv6 address that happens to end in two hex groups
// gets reinterpreted as IPv4 too, since there's no way to distinguish "a
// real IPv4 embedding" from "coincidentally two hex groups after ::" from
// the string alone — a security guard should fail closed on that
// ambiguity, not open.
const IPV6_EMBEDDED_IPV4_HEX = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

function ipv6EmbeddedIPv4Octets(addr: string): IPv4Octets | null {
  const match = addr.match(IPV6_EMBEDDED_IPV4_HEX);
  if (!match) return null;
  const g1 = parseInt(match[1], 16);
  const g2 = parseInt(match[2], 16);
  return [(g1 >> 8) & 0xff, g1 & 0xff, (g2 >> 8) & 0xff, g2 & 0xff];
}

export interface UrlGuardPolicy {
  allowLoopback: boolean;
  allowPrivate: boolean;
}

function isBlockedIPv4(octets: IPv4Octets, policy: UrlGuardPolicy): boolean {
  if (isLinkLocalOrSharedNatIPv4(octets)) return true;
  if (!policy.allowLoopback && isLoopbackIPv4(octets)) return true;
  if (!policy.allowPrivate && isPrivateIPv4(octets)) return true;
  return false;
}

function isBlockedIPv6(hostname: string, policy: UrlGuardPolicy): boolean {
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return false;
  const addr = hostname.slice(1, -1).toLowerCase();
  if (IPV6_LINK_LOCAL.test(addr) || IPV6_IMDS_FORMS.has(addr)) return true;
  if (!policy.allowLoopback && (addr === "::1" || addr === "::")) return true;
  if (!policy.allowPrivate && IPV6_UNIQUE_LOCAL.test(addr)) return true;
  const embeddedV4 = ipv6EmbeddedIPv4Octets(addr);
  if (embeddedV4 && isBlockedIPv4(embeddedV4, policy)) return true;
  return false;
}

// Deliberately IP-literal-only, same as the check this was extracted from:
// a hostname like "internal.corp" that *resolves* to a private/loopback
// address isn't caught here (no DNS resolution happens at validation time),
// and neither is DNS rebinding after this check passes. Both are the same
// known, documented gap as remote-host-client.ts's own — closing it
// properly needs connection-time IP pinning (a custom fetch dispatcher), out
// of scope for this registration-time check. `redirect: "manual"` at the
// callers (hosts.ts's RemoteHostClient, preview-proxy.ts) is the mitigation
// for the redirect-based variant of the same gap.
export function isAllowedHttpUrl(value: string, policy: UrlGuardPolicy): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const octets = ipv4Octets(url.hostname);
    if (octets && isBlockedIPv4(octets, policy)) return false;
    if (isBlockedIPv6(url.hostname, policy)) return false;
    return true;
  } catch {
    return false;
  }
}
