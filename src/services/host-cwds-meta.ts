import { parseHostCwds } from "./placement.js";

// Issue #2090 — `projects.hostCwdsMeta`: which `hostCwds` entries were filled
// in by the opt-in auto-detect sweep, and which hosts an operator declined.
// The column is JSON `{ auto: string[], declined: string[] }`. Everything in
// here is defensive about what it parses: the value is operator-adjacent
// state in a TEXT column, and a malformed one must read as "empty", never
// throw into a request.

/** Most declined hosts remembered per project; the oldest are forgotten first. */
export const MAX_DECLINED_HOSTS = 64;

export interface HostCwdsMeta {
  auto: string[];
  declined: string[];
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === "string" && v !== ""))];
}

/** Parses the stored column; anything unreadable is the empty meta. */
export function parseHostCwdsMeta(raw: string | null | undefined): HostCwdsMeta {
  if (!raw) return { auto: [], declined: [] };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { auto: [], declined: [] };
    }
    const o = parsed as Record<string, unknown>;
    return { auto: strings(o.auto), declined: strings(o.declined) };
  } catch {
    return { auto: [], declined: [] };
  }
}

/** The column value for `meta`: null when both lists are empty. */
export function serializeHostCwdsMeta(meta: HostCwdsMeta): string | null {
  if (meta.auto.length === 0 && meta.declined.length === 0) return null;
  return JSON.stringify({ auto: meta.auto, declined: meta.declined });
}

/**
 * The meta after an operator SAVES `hostCwds` (a PATCH replaces the whole map),
 * given what was there before.
 *
 * - A host whose entry was REMOVED is declined: the operator cleared it, so
 *   auto-detect must never put it back.
 * - A host whose entry is set (new or kept) leaves `declined`: the operator
 *   chose it.
 * - A decline for a host that no longer exists is dropped (`knownHostIds`), and
 *   the list is capped at MAX_DECLINED_HOSTS, so it cannot grow without bound.
 * - `auto` ends EMPTY: every entry is now operator-saved (so no longer
 *   "auto-detected"), and an auto-filled one that was removed is just gone.
 *
 * Known edge: the PATCH is whole-map, so an entry the sweep added after the
 * dialog was opened (and so is missing from the posted map) reads as removed.
 * The dialog loads the project when it opens, which keeps the window small.
 */
export function metaAfterOperatorSave(
  before: { hostCwds: string | null; meta: string | null },
  afterMap: Record<string, string>,
  knownHostIds?: ReadonlySet<string>,
): HostCwdsMeta {
  const prev = parseHostCwdsMeta(before.meta);
  const beforeMap = parseHostCwds(before.hostCwds);
  const after = new Set(Object.keys(afterMap));
  const declined = new Set(prev.declined);
  for (const hostId of Object.keys(beforeMap)) {
    if (!after.has(hostId)) declined.add(hostId);
  }
  for (const hostId of after) declined.delete(hostId);
  const kept = [...declined].filter((hostId) => !knownHostIds || knownHostIds.has(hostId));
  return { auto: [], declined: kept.slice(-MAX_DECLINED_HOSTS) };
}
