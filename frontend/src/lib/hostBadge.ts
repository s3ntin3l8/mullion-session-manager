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

/** A host's display name: "this machine" for the local host, the id if the fleet list has no name. */
export function hostDisplayName(hostId: string, hosts: readonly Host[]): string {
  if (hostId === LOCAL_HOST_ID) return "this machine";
  return hosts.find((h) => h.id === hostId)?.name ?? hostId;
}

export interface HostBadge {
  /** The host's display name (its id, if the fleet list has no name for it). */
  name: string;
  /** The tooltip: the decision's own words, or the bare "which host". */
  title: string;
}

/**
 * The distinct hosts a project reaches (issue #2238): the host it lives on
 * (`hostId`, "local" unless it is remote-hosted), its other-host checkouts (`hostCwds`) and the hosts its sessions resolved to.
 *
 * `sessions` is the FULL store list, not a display-filtered one — the
 * sidebar, the pane tab and the launch picker all pass it, so they cannot
 * disagree about the same project. Killed sessions are ignored (they no
 * longer run anywhere); an exited session still counts, deliberately — it
 * did run there, and the project's reach does not shrink with it. Everything
 * else counts too, whatever the sidebar's
 * hide-ended / task-session settings currently show.
 */
export function projectHostCount(
  project: { id: number; hostId: string; hostCwds?: Record<string, string> | null },
  sessions: readonly { projectId: number; status: string; resolvedHostId: string }[],
): number {
  const ids = new Set<string>([project.hostId, ...Object.keys(project.hostCwds ?? {})]);
  for (const s of sessions) {
    if (s.projectId === project.id && s.status !== "killed" && s.resolvedHostId) {
      ids.add(s.resolvedHostId);
    }
  }
  return ids.size;
}

/** Whether a project reaches more than one host: a local row then needs a badge too. */
export function projectSpansHosts(
  project:
    { id: number; hostId: string; hostCwds?: Record<string, string> | null } | null | undefined,
  sessions: readonly { projectId: number; status: string; resolvedHostId: string }[],
): boolean {
  return !!project && projectHostCount(project, sessions) > 1;
}

/**
 * @param hosts A LAZY getter for the fleet's host list. It is called only
 *   for a session that is NOT on the local host — a local session's name is
 *   fixed, and reading the store for every row of the sidebar (to answer a
 *   question that has already been answered) is work for nothing.
 * @param options.spansHosts The session's project reaches more than one
 *   host (issue #2238). Without it a LOCAL session has no badge.
 */
export function describeHostBadge(
  session: { resolvedHostId: string; placementReason: string | null } | null | undefined,
  hosts: () => Host[],
  options: { spansHosts?: boolean } = {},
): HostBadge | null {
  const hostId = session?.resolvedHostId;
  if (!hostId) return null;
  // A LOCAL session carries no badge in a single-host project (the common
  // case). Once the project spans hosts (issue #2238) it gets one, so the
  // unbadged rows stop reading as "unknown". It returns BEFORE the
  // replaceAll below on purpose: "local" is a short slug that could be a
  // substring of the reason, so it must never be substituted.
  if (hostId === LOCAL_HOST_ID) {
    if (!options.spansHosts) return null;
    const name = hostDisplayName(hostId, []);
    return { name, title: session?.placementReason ?? `Runs on host: ${name}` };
  }
  const name = hostDisplayName(hostId, hosts());
  const reason = session?.placementReason;
  return {
    name,
    // The reason names the host by its id. Replacing it is a blind
    // substring replace, and that is safe because the id being replaced is
    // a REMOTE host's — a UUID (host-registry.ts's createHost mints one),
    // which cannot be a substring of anything else in the sentence. (The
    // local host's id IS a short slug, "local" — handled above, never here.)
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

/** Whether any host besides this machine is registered. A local-only install
 * has nothing to say about "where", so callers show no host chip then. */
export function hasRemoteHosts(hosts: readonly Host[]): boolean {
  return hosts.some((h) => h.id !== LOCAL_HOST_ID);
}

export interface TaskHostChip {
  /** Visible text. */
  label: string;
  title: string;
}

/**
 * Where a task will run, from data already on the task, its worker session and
 * its project — never the placement-preview endpoint (per-card calls, and it
 * ignores the task's `Platform:`/`Host:` requirement). #2236.
 *
 * Null on an install with no remote hosts.
 */
export function describeTaskHost(
  task: { placementRequirement: string | null },
  workerSession: { resolvedHostId: string; placementReason: string | null } | null | undefined,
  projectHostId: string | null | undefined,
  hosts: readonly Host[],
): TaskHostChip | null {
  if (!hasRemoteHosts(hosts)) return null;
  const nameOf = (id: string) => hosts.find((h) => h.id === id)?.name ?? id;

  // A session that already exists is the truth, whatever was planned.
  if (workerSession) {
    const badge = describeHostBadge(workerSession, () => [...hosts]);
    // A local worker has no per-session badge (describeHostBadge), but on an
    // install with remote hosts "it ran here" is worth saying after claim.
    return badge
      ? { label: `on ${badge.name}`, title: badge.title }
      : { label: "on this machine", title: "Runs on this machine" };
  }

  const req = parseRequirement(task.placementRequirement);
  if (req) {
    const parts: string[] = [];
    if (req.platform) parts.push(req.platform);
    if (req.hostId) parts.push(nameOf(req.hostId));
    return {
      label: `needs ${parts.join(" · ")}`,
      title: "This task's issue requires this placement (Platform:/Host: line)",
    };
  }

  if (projectHostId && projectHostId !== LOCAL_HOST_ID) {
    return {
      label: `pinned · ${nameOf(projectHostId)}`,
      title: `Runs on the project's host, ${nameOf(projectHostId)}`,
    };
  }
  return { label: "auto", title: "Placed automatically when the task is claimed" };
}

function parseRequirement(raw: string | null): { platform?: string; hostId?: string } | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return null;
    const { platform, hostId } = v as Record<string, unknown>;
    const out = {
      ...(typeof platform === "string" && { platform }),
      ...(typeof hostId === "string" && { hostId }),
    };
    return out.platform || out.hostId ? out : null;
  } catch {
    return null;
  }
}
