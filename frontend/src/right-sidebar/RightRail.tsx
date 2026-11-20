import type { ReactNode } from "react";
import type { Session } from "../api/index.js";
import { useFollowedSession } from "../hooks/useFollowedSession.js";
import { useServerInfo } from "../settings/useServerInfo.js";
import { useDashboardStore } from "../store/index.js";
import { useCurrentLayoutBand, viewInBand } from "./viewBands.js";
import { RIGHT_SIDEBAR_VIEWS } from "./views-registry.js";
import type { RightSidebarView } from "./views.js";

interface RailButtonProps {
  view: RightSidebarView;
  projectId: number | null;
  active: boolean;
  onClick: () => void;
}

function RailButton({ view, projectId, active, onClick }: RailButtonProps) {
  const badge = view.useBadge(projectId);
  const enabled = view.useEnabled();
  const Icon = view.icon;
  const prefetchGithubProject = useDashboardStore((st) => st.prefetchGithubProject);
  // Warm the GitHub data before the click lands (issue #1970).
  const warm = () => {
    if (view.id === "github" && projectId != null) prefetchGithubProject(projectId);
  };
  if (!enabled) return null;
  const count = badge?.kind === "count" ? (badge.value > 99 ? "99+" : String(badge.value)) : null;
  return (
    <button
      type="button"
      className={`right-rail-btn${active ? " active" : ""}`}
      // The count badge is the button's only visible text, so the name has to
      // contain it (WCAG 2.5.3, axe `label-content-name-mismatch`, #2886).
      aria-label={count === null ? view.label : `${view.label}, ${count}`}
      aria-pressed={active}
      title={badge ? `${view.label} — ${badge.title}` : view.label}
      onClick={onClick}
      onMouseEnter={warm}
      onFocus={warm}
    >
      <Icon size={17} />
      {count !== null && (
        <span className="right-rail-badge" aria-hidden="true">
          {count}
        </span>
      )}
      {badge?.kind === "alert" && <span className="right-rail-badge alert" aria-hidden="true" />}
    </button>
  );
}

// A view's icon outside the bands it is a view in (#3403): the Browser icon
// from 1100px. No rail view is showing, so the button is not a toggle and is
// never "active"; it opens the grid Browser pane, through the same opener the
// pane kebab and the palette use.
function OutOfBandButton({
  view,
  projectId,
  onOpen,
}: {
  view: RightSidebarView;
  projectId: number | null;
  onOpen?: (projectId: number, session: Session | null) => void;
}) {
  const Icon = view.icon;
  // No project in the rail: nothing to open, so the icon is disabled.
  const session = useFollowedSession(projectId ?? -1);
  // BROWSER_ENABLED: off, there is no agent's browser to open, so the
  // project's preview is. Only an answer that says off counts: until the
  // server answers (or if it never does) the session's browser is opened,
  // and the pane itself falls back to Preview on an explicit off.
  const serverInfo = useServerInfo();
  const featureOff = serverInfo != null && serverInfo.features?.browser !== true;
  return (
    <button
      type="button"
      className="right-rail-btn"
      aria-label={view.label}
      title={`Open ${view.label.toLowerCase()}`}
      disabled={projectId == null || !onOpen}
      onClick={() => {
        if (projectId != null) onOpen?.(projectId, featureOff ? null : session);
      }}
    >
      <Icon size={17} />
    </button>
  );
}

export interface RightRailProps {
  projectId: number | null;
  /** The Browser icon's opener from 1100px (#3403). */
  onOpenBrowser?: (projectId: number, session: Session | null) => void;
  /** #3010 — the right half's sessions, listed below the views. */
  children?: ReactNode;
}

// Icon column on the right edge — always visible (desktop + tablet); clicking
// a view's icon opens/closes its drawer.
export function RightRail({ projectId, onOpenBrowser, children }: RightRailProps) {
  const openView = useDashboardStore((s) => (s.rightSidebarOpen ? s.rightSidebarView : null));
  const toggleView = useDashboardStore((s) => s.toggleRightSidebarView);
  const band = useCurrentLayoutBand();
  return (
    <nav className="right-rail" aria-label="Right sidebar">
      {RIGHT_SIDEBAR_VIEWS.map((view) =>
        view.railButtonOutsideBands && !viewInBand(view, band) ? (
          <OutOfBandButton key={view.id} view={view} projectId={projectId} onOpen={onOpenBrowser} />
        ) : (
          <RailButton
            key={view.id}
            view={view}
            projectId={projectId}
            active={openView === view.id}
            onClick={() => toggleView(view.id)}
          />
        ),
      )}
      {children}
    </nav>
  );
}
