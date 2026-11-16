import { useSyncExternalStore } from "react";

// The auto-attach half of what every mounted useDockProject for a project
// shares (#3031); the poll half is dockProjectShared.ts. Kept apart, with no
// api import, so testSetup.ts can reset it without loading the real api
// module ahead of a test file's own vi.mock of it.
//
// - The "Auto-attach Docker logs" bookkeeping, so the surface that takes the
//   effect over from another one knows a container was already attached (or
//   is being attached) and does not start a second log session for it. It
//   lives for the page: a view that unmounts and comes back (another rail
//   view, another project and back) must not re-attach a stream the user
//   ended with "Stop log".
// - Whether the bottom Dock is mounted for the project, which decides which
//   surface runs auto-attach (useDockProject, where `autoAttach` is derived
//   from its `surface` option).

export interface AutoAttachEntry {
  eligible: boolean;
  failedAt: number | null;
}

// Kept for the page's lifetime, per project. The effect prunes a project's
// identities that leave its poll, so each map stays the size of the
// project's running containers.
const autoAttachByProject = new Map<number, Map<string, AutoAttachEntry>>();

/** The project's auto-attach bookkeeping, shared by every surface. */
export function sharedAutoAttachState(projectId: number): Map<string, AutoAttachEntry> {
  let state = autoAttachByProject.get(projectId);
  if (!state) {
    state = new Map();
    autoAttachByProject.set(projectId, state);
  }
  return state;
}

/** Test-only: forget every project's auto-attach bookkeeping. */
export function __resetDockAutoAttachStateForTests() {
  autoAttachByProject.clear();
}

// ---- Which surface runs auto-attach (#3031) ----
//
// The bottom Dock registers here while its DockProjectGroup is mounted for a
// project (a layout effect, so the registration is in place before any
// passive effect of the same commit, the view's auto-attach effect
// included). A collapsed or unavailable bottom Dock does not mount
// DockProjectGroup, so it counts as absent.

const bottomDockMounts = new Map<number, number>();
const bottomDockListeners = new Set<() => void>();

function notifyBottomDock() {
  for (const listener of bottomDockListeners) listener();
}

export function registerBottomDock(projectId: number): () => void {
  bottomDockMounts.set(projectId, (bottomDockMounts.get(projectId) ?? 0) + 1);
  notifyBottomDock();
  return () => {
    const left = (bottomDockMounts.get(projectId) ?? 1) - 1;
    if (left > 0) bottomDockMounts.set(projectId, left);
    else bottomDockMounts.delete(projectId);
    notifyBottomDock();
  };
}

export function isBottomDockMounted(projectId: number): boolean {
  return bottomDockMounts.has(projectId);
}

function subscribeBottomDock(listener: () => void): () => void {
  bottomDockListeners.add(listener);
  return () => bottomDockListeners.delete(listener);
}

export function useBottomDockMounted(projectId: number): boolean {
  return useSyncExternalStore(subscribeBottomDock, () => isBottomDockMounted(projectId));
}
