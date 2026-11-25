// IPv4-only CIDR matching, deliberately failing closed on anything it cannot
// parse (including IPv6 peer addresses). Used as an optional additional
// narrowing on top of enrollment secrets (routes/enrollment.ts) and automation
// tokens (routes/host-pairing.ts).

export function parseIpv4(ip: string): number | null {
  const match = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return null;
  const octets = match.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255)) return null;
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

export function isValidCidrsCsv(cidrsCsv: string): boolean {
  const ranges = cidrsCsv
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  if (ranges.length === 0) return false;
  for (const range of ranges) {
    const parts = range.split("/");
    if (parts.length !== 2) return false;
    const [base, bitsStr] = parts;
    if (parseIpv4(base) === null) return false;
    if (!bitsStr || !/^\d{1,2}$/.test(bitsStr)) return false;
    const bits = Number(bitsStr);
    if (bits > 32) return false;
  }
  return true;
}

export function isIpAllowed(ip: string, cidrsCsv: string): boolean {
  const value = parseIpv4(ip);
  if (value === null) return false;
  for (const range of cidrsCsv
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)) {
    const [base, bitsStr] = range.split("/");
    const baseValue = parseIpv4(base);
    // bitsStr must be present and purely digits — Number("") is 0, which
    // would otherwise turn a trailing-slash typo like "10.0.0.0/" into a
    // /0 mask that matches every IP, exactly the opposite of fail-closed.
    if (!bitsStr || !/^\d{1,2}$/.test(bitsStr)) continue;
    const bits = Number(bitsStr);
    if (baseValue === null || bits > 32) continue;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((value & mask) === (baseValue & mask)) return true;
  }
  return false;
}
