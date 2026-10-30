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
  /** Hosts whose `hostCwds` entry is a Mullion-created clone (written by the
   * materialization step, not by the clone endpoint itself). */
  managed: string[];
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === "string" && v !== ""))];
}

/** Parses the stored column; anything unreadable is the empty meta. */
export function parseHostCwdsMeta(raw: string | null | undefined): HostCwdsMeta {
  if (!raw) return { auto: [], declined: [], managed: [] };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { auto: [], declined: [], managed: [] };
    }
    const o = parsed as Record<string, unknown>;
    return { auto: strings(o.auto), declined: strings(o.declined), managed: strings(o.managed) };
  } catch {
    return { auto: [], declined: [], managed: [] };
  }
}

/** The column value for `meta`: null when all three lists are empty. */
export function serializeHostCwdsMeta(meta: HostCwdsMeta): string | null {
  if (meta.auto.length === 0 && meta.declined.length === 0 && meta.managed.length === 0) {
    return null;
  }
  return JSON.stringify({ auto: meta.auto, declined: meta.declined, managed: meta.managed });
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
 * - `managed` keeps a host only while its entry still exists AND still holds
 *   the same path: an operator re-mapping a host to another path means the
 *   checkout is theirs now, not a Mullion-created clone.
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
  const managed = prev.managed.filter(
    (hostId) => afterMap[hostId] !== undefined && afterMap[hostId] === beforeMap[hostId],
  );
  return { auto: [], declined: kept.slice(-MAX_DECLINED_HOSTS), managed };
}
