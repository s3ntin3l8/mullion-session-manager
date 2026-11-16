/**
 * Opt-ins for aggressive-cleanup sources that are not a directory under the
 * home folder (those are `cache-storage.ts`'s allowlist). Same two-sided rule:
 * an id only runs when the request AND the stored settings both carry it.
 * Adding a source means adding its id here and nothing else widens the set.
 */
export const OPT_IN_IDS = ["docker-volumes"] as const;

export type OptInId = (typeof OPT_IN_IDS)[number];

/** Keeps only known ids, once each, in allowlist order. */
export function sanitizeOptInIds(value: unknown): OptInId[] {
  const wanted = new Set(Array.isArray(value) ? value : []);
  return OPT_IN_IDS.filter((id) => wanted.has(id));
}
