import { useDashboardStore } from "../store/index.js";
import { RIGHT_SIDEBAR_VIEWS, type RightSidebarView } from "./views.js";

interface RailButtonProps {
  view: RightSidebarView;
  projectId: number | null;
  active: boolean;
  onClick: () => void;
}

function RailButton({ view, projectId, active, onClick }: RailButtonProps) {
  const badge = view.useBadge(projectId);
  const Icon = view.icon;
  const prefetchGithubProject = useDashboardStore((st) => st.prefetchGithubProject);
  // Warm the GitHub data before the click lands (issue #1970).
  const warm = () => {
    if (view.id === "github" && projectId != null) prefetchGithubProject(projectId);
  };
  return (
    <button
      type="button"
      className={`right-rail-btn${active ? " active" : ""}`}
      aria-label={view.label}
      aria-pressed={active}
      title={badge ? `${view.label} — ${badge.title}` : view.label}
      onClick={onClick}
      onMouseEnter={warm}
      onFocus={warm}
    >
      <Icon size={17} />
      {badge?.kind === "count" && (
        <span className="right-rail-badge" aria-hidden="true">
          {badge.value > 99 ? "99+" : badge.value}
        </span>
      )}
      {badge?.kind === "alert" && <span className="right-rail-badge alert" aria-hidden="true" />}
    </button>
  );
}

export interface RightRailProps {
  projectId: number | null;
}

// Icon column on the right edge — always visible (desktop + tablet); clicking
// a view's icon opens/closes its drawer.
export function RightRail({ projectId }: RightRailProps) {
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
    </nav>
  );
}
