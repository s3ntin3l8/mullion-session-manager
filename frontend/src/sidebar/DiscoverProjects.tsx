import { useEffect, useState } from "react";
import { useDashboardStore } from "../store/index.js";
import { api, ApiError, LOCAL_HOST_ID } from "../api/index.js";
import type { DiscoveredProject, Host } from "../api/index.js";
import { Dropdown } from "../ui/primitives.js";
import {
  EmptyState,
  EmptyStateActions,
  EmptyStateBody,
  EmptyStateIcon,
  EmptyStateTitle,
} from "../ui/EmptyState.js";
import { ChevronDownIcon, FolderIcon, SearchAlertIcon } from "../ui/icons.js";

// Vision item #1 — suggests candidates from PROJECTS_ROOTS, never
// auto-inserts. Read-only until the user clicks Add, which is just the
// existing POST /api/projects the manual form above already uses.
//
// `candidates` distinguishes "not yet fetched" (null) from "fetched, zero
// results" ([]) — the design's empty state 1C ("discovery ran · nothing
// found / roots unconfigured") only applies to the latter; rendering
// nothing while the very first fetch is still in flight avoids a state
// flash on load.
export function DiscoverProjects({
  collapsed,
  onToggleCollapsed,
  onOpenSettingsProjects,
  hosts,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenSettingsProjects: () => void;
  hosts: Host[];
}) {
  // P1 perf fix — both fields here are pure actions (never read reactively),
  // same reasoning as ProjectSection's own header comment above.
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

  if (candidates === null) return null;

  const remaining = candidates.filter((c) => !c.isRegistered && !added.has(c.cwd));

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
      .then(() => {
        setAdded((prev) => new Set(prev).add(c.cwd));
        void store.refreshProjects();
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

  // Only rendered once a remote host actually exists — same "no extra UI
  // for a single-host deployment" rule CreateProjectModal's own selector
  // follows.
  //
  // The picker needs no click-suppression wrapper: it is the header ROW's
  // sibling, not a descendant of the toggle, so a click on it never
  // reaches the toggle's handler in the first place (issue #1893). It is
  // also not inside the empty-state branch's own tree, which has no click
  // handler either.
  const hostPicker = remoteHosts.length > 0 && (
    <Dropdown
      small
      value={selectedHostId}
      onChange={setHostId}
      options={[
        { value: LOCAL_HOST_ID, label: "This machine" },
        ...remoteHosts.map((h) => ({ value: h.id, label: h.name })),
      ]}
    />
  );

  if (remaining.length === 0) {
    return (
      <div className="discover-block">
        <EmptyState>
          <EmptyStateIcon variant="warn">
            <SearchAlertIcon size={18} />
          </EmptyStateIcon>
          <EmptyStateTitle>
            {discoverError ? "Discovery failed" : "No repositories found"}
          </EmptyStateTitle>
          <EmptyStateBody>
            {discoverError
              ? "Couldn't reach the selected host to scan for repositories. Check that it's online and try again."
              : "Mullion scanned your search roots but found no git projects. Point it at a folder that contains your repos."}
          </EmptyStateBody>
          {hostPicker && <div style={{ marginTop: 8 }}>{hostPicker}</div>}
          <EmptyStateActions>
            {!discoverError && (
              <button className="ui-empty-state-btn-primary" onClick={onOpenSettingsProjects}>
                Configure search roots
              </button>
            )}
            <button className="ui-empty-state-btn-secondary" onClick={() => load(selectedHostId)}>
              {discoverError ? "Retry" : "Rescan"}
            </button>
          </EmptyStateActions>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="discover-block">
      <div className="discover-header">
        {/* Issue #1893 — this header was a plain <div onClick>: a keyboard
          user could not reach it at all, and a screen reader announced it
          as unlabelled text. It now uses the disclosure pattern the
          codebase had already established in three sibling sites (the
          project header, the workspace group's header and the task board's
          lane header): role="button", tabIndex, aria-expanded,
          aria-controls, and Enter/Space to toggle.

          The toggle is this INNER element, not the header row itself, and
          that is deliberate: `role="button"` makes its descendants
          presentational (ARIA 1.2), so a `<select>` nested inside the
          button would lose its combobox role entirely and stop being
          exposed as a control at all — the host picker used to be a
          perfectly good combobox here. Keeping the toggle and the picker
          as SIBLINGS inside the header row preserves both: the picker
          stays a combobox, and the header stays a button.

          The `e.target !== e.currentTarget` guard the siblings use is
          kept: only treat Enter/Space as "toggle" when the KEYDOWN's own
          target is the toggle itself, so a key event that bubbles up from
          a descendant cannot toggle the section a second time. */}
        <div
          className="discover-header-toggle"
          role="button"
          tabIndex={0}
          aria-expanded={!collapsed}
          aria-controls="discover-projects-body"
          onClick={onToggleCollapsed}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggleCollapsed();
            }
          }}
        >
          <ChevronDownIcon
            size={14}
            className={collapsed ? "ws-group-chevron collapsed" : "ws-group-chevron"}
          />
          <span className="discover-title">Discover projects</span>
          <span className="discover-count">{remaining.length} found</span>
        </div>
        {hostPicker}
      </div>
      {!collapsed && (
        <div id="discover-projects-body" className="discover-body">
          {remaining.map((c) => (
            <div key={c.cwd} className="discover-item">
              <FolderIcon size={14} style={{ color: "var(--muted)" }} />
              <span className="discover-item-name">{c.name}</span>
              {c.isGitRepo && <span className="discover-git-badge">git</span>}
              {c.matchedProject ? (
                <>
                  {/* A second clone on the project's own host cannot be
                      attached (only created separately). */}
                  {c.matchedProject.hostId !== selectedHostId && (
                    <button
                      className="discover-add"
                      title={
                        c.matchedProject.reason === "origin"
                          ? "Same git remote as this project"
                          : "This path is already part of this project"
                      }
                      onClick={() => attach(c)}
                    >
                      Add as checkout of {c.matchedProject.name}
                    </button>
                  )}
                  <button className="discover-add secondary" onClick={() => addAsProject(c, true)}>
                    Create a separate project anyway
                  </button>
                </>
              ) : (
                <button className="discover-add" onClick={() => addAsProject(c)}>
                  Add
                </button>
              )}
              {addErrors.has(c.cwd) && (
                <div className="project-row-error" title={addErrors.get(c.cwd)}>
                  {addErrors.get(c.cwd)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
