// Opt-ins for aggressive-cleanup sources that are not a directory under the
// home folder (those are `cache-storage.ts`'s allowlist). The ids themselves
// live in src/shared/constants.ts, shared with the frontend (#2412).
import { OPT_IN_IDS, type OptInId } from "../shared/constants.js";
export { OPT_IN_IDS, type OptInId };

/** Keeps only known ids, once each, in allowlist order. */
export function sanitizeOptInIds(value: unknown): OptInId[] {
  const wanted = new Set(Array.isArray(value) ? value : []);
  return OPT_IN_IDS.filter((id) => wanted.has(id));
}
