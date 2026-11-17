import { useEffect, useState } from "react";
import { useDashboardStore } from "../store/index.js";
import { api, ApiError, LOCAL_HOST_ID } from "../api/index.js";
import type { DiscoveredProject, Host, Project } from "../api/index.js";

// The discovery scan and the per-candidate add actions, shared by the
// sidebar's Discover section (DiscoverProjects.tsx) and the launcher's Discovered
// repositories view (launchers/LauncherProjects.tsx, #3244), which reads one
// scan for both its count row and its list.
//
// `candidates` distinguishes "not yet fetched" (null) from "fetched, zero
// results" ([]) — the design's empty state 1C ("discovery ran · nothing
// found / roots unconfigured") only applies to the latter; rendering
// nothing while the very first fetch is still in flight avoids a state
// flash on load.
export function useDiscoveredProjects({
  hosts,
  onAdded,
}: {
  hosts: Host[];
  // A candidate was added as a new project (the launcher selects it, #3048).
  onAdded?: (project: Project) => void;
}) {
  // P1 perf fix — both fields here are pure actions (never read reactively),
  // same reasoning as ProjectSection's header comment in Sidebar.tsx.
  const [candidates, setCandidates] = useState<DiscoveredProject[] | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  // Keyed by cwd — a discovered candidate's own create can fail (e.g. it
  // vanished from disk between scan and click) and previously failed
  // silently (an unhandled rejection, no UI feedback at all).
  const [addErrors, setAddErrors] = useState<Map<string, string>>(new Map());
  const [hostId, setHostId] = useState(LOCAL_HOST_ID);
  // Distinguishes "discovery ran, found nothing" from "discovery failed" —
  // both otherwise render as an identical "0 found" empty state, which
  // reads a genuinely unreachable host the same as an empty search root
  // (Hermes review, PR #35).
  const [discoverError, setDiscoverError] = useState(false);
  const remoteHosts = hosts.filter((h) => h.id !== LOCAL_HOST_ID);
  // The selected host can be deleted (Settings -> Hosts) while this panel
  // is open — `hostId` itself only ever changes via the picker's onChange,
  // so falling back here (derived at render time, not an effect writing
  // state back) is what actually keeps discovery from targeting an id that
  // no longer exists, without an extra render/effect round-trip (Hermes
  // review, PR #35). "This machine" is always present, so this is a no-op
  // for the common single-host case.
  const selectedHostId =
    hostId === LOCAL_HOST_ID || remoteHosts.some((h) => h.id === hostId) ? hostId : LOCAL_HOST_ID;

  // Deliberately doesn't reset `candidates` to null up front — switching
  // hosts would otherwise flash the "0 found" empty state on every change
  // instead of just replacing the list once the new host's results land.
  // `added` resets alongside it (inside the same async callback, not
  // synchronously in the effect body — react-hooks/set-state-in-effect):
  // a cwd match is per-(hostId, cwd), same as the backend's own
  // registeredCwds query in routes/projects.ts, so the previous host's
  // "just added" set is meaningless once `forHostId` changes.
  const load = (forHostId: string) => {
    api
      .discoverProjects(forHostId)
      .then((found) => {
        setCandidates(found);
        setAdded(new Set());
        setDiscoverError(false);
      })
      .catch(() => {
        setCandidates([]);
        setAdded(new Set());
        setDiscoverError(true);
      });
  };

  useEffect(() => {
    load(selectedHostId);
  }, [selectedHostId]);

  // Not yet registered and not added here: what is left to offer.
  const remaining =
    candidates === null ? null : candidates.filter((c) => !c.isRegistered && !added.has(c.cwd));

  const clearAddError = (cwd: string) =>
    setAddErrors((prev) => {
      if (!prev.has(cwd)) return prev;
      const next = new Map(prev);
      next.delete(cwd);
      return next;
    });

  // Issue #2231 — a candidate that is a checkout of an existing project is
  // attached to it (its path goes into that project's hostCwds) rather than
  // added as a second project.
  const attach = (c: DiscoveredProject) => {
    if (!c.matchedProject) return;
    clearAddError(c.cwd);
    api
      .attachHostCheckout(c.matchedProject.id, selectedHostId, c.cwd)
      .then(() => {
        setAdded((prev) => new Set(prev).add(c.cwd));
        void useDashboardStore
          .getState()
          .refreshProjects()
          .catch(() => {});
      })
      .catch((err: unknown) => {
        setAddErrors((prev) =>
          new Map(prev).set(
            c.cwd,
            err instanceof ApiError ? err.message : "Could not add checkout",
          ),
        );
      });
  };

  const addAsProject = (c: DiscoveredProject, allowDuplicate = false) => {
    const store = useDashboardStore.getState();
    clearAddError(c.cwd);
    store
      .createProject(c.name, c.cwd, selectedHostId, allowDuplicate ? { allowDuplicate } : undefined)
      .then((project) => {
        setAdded((prev) => new Set(prev).add(c.cwd));
        void store.refreshProjects();
        onAdded?.(project);
      })
      .catch((err: unknown) => {
        // Discover only lists directories a scan already found on disk, so
        // a missing-directory 400 here is near-impossible — but this used
        // to be a silent unhandled rejection either way (issue: same bug
        // as CreateProjectModal's own pre-fix confirm()).
        setAddErrors((prev) =>
          new Map(prev).set(c.cwd, err instanceof ApiError ? err.message : "Could not add project"),
        );
      });
  };

  return {
    remaining,
    discoverError,
    selectedHostId,
    setHostId,
    remoteHosts,
    rescan: () => load(selectedHostId),
    attach,
    addAsProject,
    addErrors,
  };
}

export type DiscoveredProjects = ReturnType<typeof useDiscoveredProjects>;
