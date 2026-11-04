import type { Host, Project, Session } from "../api/index.js";
import { LOCAL_HOST_ID } from "../../../src/shared/constants.js";
import { baseName } from "./fileTreeMove.js";
import { sessionCheckoutRoot } from "./sessionCheckout.js";

// The execution context a Files / Source Control surface is bound to: which
// project, which session's checkout (null = the project's default checkout) and
// the host that checkout lives on. The same path or port can exist on two
// hosts, so every request, cache entry and in-flight guard keys on all three.

/** The host a session actually runs on — the server-resolved one when it has one. */
export function sessionHostId(
  session: Pick<Session, "resolvedHostId">,
  project: Pick<Project, "hostId">,
): string {
  return session.resolvedHostId || project.hostId;
}

/** Whether a session works somewhere other than the project's default checkout:
 * another host (even at an identical path) or a separate worktree on its host. */
export function hasOwnCheckout(
  session: Pick<Session, "cwd" | "resolvedHostId">,
  project: Pick<Project, "cwd" | "hostId">,
): boolean {
  return (
    sessionHostId(session, project) !== project.hostId ||
    sessionCheckoutRoot(session, project) !== null
  );
}

/** A stable key for one execution context. */
export function contextKey(
  projectId: number,
  sessionId: number | null | undefined,
  hostId: string,
): string {
  return `${projectId}:${hostId}:${sessionId ?? ""}`;
}

export interface CheckoutDescription {
  hostId: string;
  hostName: string;
  isRemote: boolean;
  /** The checkout's directory name, or "Project default". */
  checkout: string;
  branch: string | null;
  /** "<host> · <checkout> · <branch>" for chips and tooltips. */
  label: string;
  /** The checkout's absolute path on its host. */
  cwd: string | null;
}

export function describeCheckout(
  project: Pick<Project, "cwd" | "hostId" | "currentBranch">,
  session: Pick<Session, "cwd" | "resolvedHostId" | "liveBranch"> | null,
  hosts: readonly Pick<Host, "id" | "name">[],
  statusBranch?: string | null,
): CheckoutDescription {
  const hostId = session ? sessionHostId(session, project) : project.hostId;
  const hostName = hosts.find((h) => h.id === hostId)?.name ?? hostId;
  const cwd = (session ? session.cwd : project.cwd) || null;
  const checkout = session ? (cwd ? baseName(cwd) : "session checkout") : "Project default";
  const branch = statusBranch ?? (session ? session.liveBranch : project.currentBranch) ?? null;
  const label = [hostName, checkout, branch].filter(Boolean).join(" · ");
  return { hostId, hostName, isRemote: hostId !== LOCAL_HOST_ID, checkout, branch, label, cwd };
}
