import { LOCAL_HOST_ID } from "../api/index.js";
import type { DiscoveredProject, Host, Project } from "../api/index.js";
import { useDiscoveredProjects } from "./useDiscoveredProjects.js";
import type { DiscoveredProjects } from "./useDiscoveredProjects.js";
import { Dropdown } from "../ui/primitives.js";
import {
  EmptyState,
  EmptyStateActions,
  EmptyStateBody,
  EmptyStateIcon,
  EmptyStateTitle,
} from "../ui/EmptyState.js";
import { ChevronDownIcon, FolderIcon, SearchAlertIcon } from "../ui/icons.js";

// Only rendered once a remote host actually exists — same "no extra UI
// for a single-host deployment" rule CreateProjectModal's own selector
// follows.
export function DiscoverHostPicker({ discovery }: { discovery: DiscoveredProjects }) {
  const { remoteHosts, selectedHostId, setHostId } = discovery;
  if (remoteHosts.length === 0) return null;
  return (
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
}

// Discovery found nothing to offer (or failed): the hint that points at
// Settings → Projects, with a rescan.
export function DiscoverEmptyState({
  discovery,
  onOpenSettingsProjects,
}: {
  discovery: DiscoveredProjects;
  onOpenSettingsProjects: () => void;
}) {
  const { discoverError, remoteHosts, rescan } = discovery;
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
        {remoteHosts.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <DiscoverHostPicker discovery={discovery} />
          </div>
        )}
        <EmptyStateActions>
          {!discoverError && (
            <button className="ui-empty-state-btn-primary" onClick={onOpenSettingsProjects}>
              Configure search roots
            </button>
          )}
          <button className="ui-empty-state-btn-secondary" onClick={rescan}>
            {discoverError ? "Retry" : "Rescan"}
          </button>
        </EmptyStateActions>
      </EmptyState>
    </div>
  );
}

// One discovered repository: its name, the git badge and its Add action(s).
export function DiscoverItem({
  candidate: c,
  discovery,
}: {
  candidate: DiscoveredProject;
  discovery: DiscoveredProjects;
}) {
  const { selectedHostId, attach, addAsProject, addErrors } = discovery;
  return (
    <div className="discover-item">
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
  );
}

// Vision item #1 — suggests candidates from PROJECTS_ROOTS, never
// auto-inserts. Read-only until the user clicks Add, which is just the
// existing POST /api/projects the manual add-project form in Sidebar.tsx already uses.
export function DiscoverProjects({
  collapsed,
  onToggleCollapsed,
  onOpenSettingsProjects,
  hosts,
  onAdded,
  bodyId = "discover-projects-body",
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenSettingsProjects: () => void;
  hosts: Host[];
  onAdded?: (project: Project) => void;
  // The disclosure body's id, kept unique per mounted copy.
  bodyId?: string;
}) {
  const discovery = useDiscoveredProjects({ hosts, onAdded });
  const { remaining } = discovery;
  if (remaining === null) return null;
  const hostPicker = <DiscoverHostPicker discovery={discovery} />;

  if (remaining.length === 0) {
    return (
      <DiscoverEmptyState discovery={discovery} onOpenSettingsProjects={onOpenSettingsProjects} />
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
          aria-controls={bodyId}
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
        <div id={bodyId} className="discover-body">
          {remaining.map((c) => (
            <DiscoverItem key={c.cwd} candidate={c} discovery={discovery} />
          ))}
        </div>
      )}
    </div>
  );
}
