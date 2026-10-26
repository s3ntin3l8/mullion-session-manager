// LOCAL_HOST_ID from its shared home rather than from ../api/index.js —
// this module is imported by PaneTab.tsx, whose own test mocks that module
// wholesale (only `api` is provided), and TerminalPane.tsx already imports
// shared constants the same way.
import { LOCAL_HOST_ID } from "../../../src/shared/constants.js";
import type { Host } from "../api/index.js";

/**
 * The per-session host badge — issue #1852.
 *
 * Two things, both about the same question ("which host is this session on,
 * and why?"):
 *
 *   - the host's DISPLAY NAME, which the badge shows; and
 *   - the placement decision's OWN WORDS, which the tooltip shows — the
 *     reason the session is on that host at all.
 *
 * The two are computed together, in one place, because they disagree in a
 * way a reader would notice: the decision names the host by its **id** (the
 * policy knows ids, and a remote host's id is a UUID), while the badge
 * shows its **name** ("mac-mini"). So the name replaces the id in the
 * reason — the operator knows "mac-mini", not "3f2a9c1e-…".
 */

export interface HostBadge {
  /** The host's display name (its id, if the fleet list has no name for it). */
  name: string;
  /** The tooltip: the decision's own words, or the bare "which host". */
  title: string;
}

/**
 * @param hosts A LAZY getter for the fleet's host list. It is called only
 *   for a session that is NOT on the local host — a local session has no
 *   badge, and reading the store for every row of the sidebar (to answer a
 *   question that has already been answered) is work for nothing.
 */
export function describeHostBadge(
  session: { resolvedHostId: string; placementReason: string | null } | null | undefined,
  hosts: () => Host[],
): HostBadge | null {
  const hostId = session?.resolvedHostId;
  // A LOCAL session carries no badge: the sidebar already shows a
  // per-PROJECT host badge, and the per-session one is for the case that
  // matters — one project's sessions on different hosts.
  if (!hostId || hostId === LOCAL_HOST_ID) return null;
  const name = hosts().find((h) => h.id === hostId)?.name ?? hostId;
  const reason = session?.placementReason;
  return {
    name,
    // The reason names the host by its id. Replacing it is a blind
    // substring replace, and that is safe because the id being replaced is
    // a REMOTE host's — a UUID (host-registry.ts's createHost mints one),
    // which cannot be a substring of anything else in the sentence. (The
    // local host's id IS a short slug, "local" — but a local session never
    // gets a badge, so its id is never substituted.)
    title: reason ? reason.replaceAll(hostId, name) : `Runs on host: ${name}`,
  };
}

/**
 * The remote host a session row or pane tab subscribes to (issue #1892).
 *
 * Null for a local session, or one with no resolved host — the selector
 * then does not read a host object, so a fleet health refresh does not
 * re-render that row. The badge's NAME stays describeHostBadge's
 * non-reactive read; this is only the object whose health the status
 * words follow.
 */
export function selectRemoteHost(
  hosts: readonly Host[],
  hostId: string | null | undefined,
): Host | null {
  if (!hostId || hostId === LOCAL_HOST_ID) return null;
  return hosts.find((h) => h.id === hostId) ?? null;
}
