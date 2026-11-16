/**
 * The per-host cwd map, parsed.
 *
 * `projects.hostCwds` is a JSON object `{ "<hostId>": "<absolute path>" }`.
 *
 * Parsed into a NULL-PROTOTYPE object and written with
 * `Object.defineProperty`, so a key of `__proto__` stays an ordinary own
 * property: the map's KEYS are operator-supplied and become property names,
 * and `__proto__`'s setter must never see one. A malformed or non-object
 * value yields an EMPTY map — no host is a candidate, which is the same
 * answer as "the project lives on its own host and nowhere else".
 */
export function parseHostCwds(raw: string | null | undefined): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  if (raw === null || raw === undefined || raw.trim() === "") return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const [hostId, cwd] of Object.entries(parsed)) {
    if (typeof cwd !== "string" || cwd.trim() === "") continue;
    Object.defineProperty(out, hostId, {
      value: cwd,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * The per-host cwd map, serialized for the column.
 *
 * The map's KEYS are operator-supplied and become property names when the
 * map is parsed back, so it is written as JSON and read back into a
 * null-prototype object (see parseHostCwds). Empty paths are dropped, and
 * an empty map serializes to null — "this project lives on its own host and
 * nowhere else", which is what an absent map means.
 */
export function serializeHostCwds(map: Record<string, string> | null | undefined): string | null {
  if (map === null || map === undefined) return null;
  const entries = Object.entries(map).filter(
    ([, cwd]) => typeof cwd === "string" && cwd.trim() !== "",
  );
  if (entries.length === 0) return null;
  // Object.fromEntries defines own properties, so a key of "__proto__" stays
  // an ordinary property — it is never handed to a prototype setter.
  return JSON.stringify(Object.fromEntries(entries));
}
