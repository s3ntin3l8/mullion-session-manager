import type { ReactNode } from "react";
import { useDashboardStore } from "../store/index.js";
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

export interface RightRailProps {
  projectId: number | null;
  /** #3010 — the right half's sessions, listed below the views. */
  children?: ReactNode;
}

// Icon column on the right edge — always visible (desktop + tablet); clicking
// a view's icon opens/closes its drawer.
export function RightRail({ projectId, children }: RightRailProps) {
  const openView = useDashboardStore((s) => (s.rightSidebarOpen ? s.rightSidebarView : null));
  const toggleView = useDashboardStore((s) => s.toggleRightSidebarView);
  return (
    <nav className="right-rail" aria-label="Right sidebar">
      {RIGHT_SIDEBAR_VIEWS.map((view) => (
        <RailButton
          key={view.id}
          view={view}
          projectId={projectId}
          active={openView === view.id}
          onClick={() => toggleView(view.id)}
        />
      ))}
      {children}
    </nav>
  );
}
