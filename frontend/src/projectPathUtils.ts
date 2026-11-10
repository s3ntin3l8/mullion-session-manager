/** The non-empty, trimmed entries of an editable per-host path map. */
export function normalizeHostPaths(paths: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [hostKey, value] of Object.entries(paths)) {
    const trimmed = value.trim();
    if (trimmed !== "") out[hostKey] = trimmed;
  }
  return out;
}

export function sameHostPaths(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  return ak.length === Object.keys(b).length && ak.every((k) => a[k] === b[k]);
}
