import { Dropdown } from "../ui/primitives.js";
import { CloseIcon, PinIcon } from "../ui/icons.js";
import type { FollowedProject } from "../hooks/useFollowedProject.js";
import type { RightSidebarActions, RightSidebarView } from "./views.js";

export interface RightSidebarPanelProps {
  view: RightSidebarView;
  followed: FollowedProject;
  actions: RightSidebarActions;
  // Pinning only exists on desktop — below that the drawer is overlay-only.
  canPin: boolean;
  pinned: boolean;
  onTogglePin: () => void;
  onClose: () => void;
}

export function RightSidebarPanel({
  view,
  followed,
  actions,
  canPin,
  pinned,
  onTogglePin,
  onClose,
}: RightSidebarPanelProps) {
  const View = view.Component;
  const projectId = followed.effectiveProjectId;
  return (
    <>
      <div className="right-sidebar-header">
        <span className="right-sidebar-title">{view.label}</span>
        <span className="right-sidebar-header-actions">
          {canPin && (
            <button
              type="button"
              className={`right-sidebar-icon-btn${pinned ? " active" : ""}`}
              aria-label={pinned ? "Unpin sidebar" : "Pin sidebar"}
              aria-pressed={pinned}
              title={pinned ? "Unpin (float over the grid)" : "Pin (dock beside the grid)"}
              onClick={onTogglePin}
            >
              <PinIcon size={14} />
            </button>
          )}
          <button
            type="button"
            className="right-sidebar-icon-btn"
            aria-label="Close sidebar"
            title="Close"
            onClick={onClose}
          >
            <CloseIcon size={14} />
          </button>
        </span>
      </div>
      {projectId == null ? (
        <div className="github-panel-empty-row">No projects yet.</div>
      ) : (
        <>
          <div className="right-sidebar-project">
            <Dropdown
              small
              options={followed.dropdownOptions}
              value={followed.dropdownValue}
              onChange={followed.onDropdownChange}
            />
          </div>
          <div className="right-sidebar-body cmux-scroll">
            <View projectId={projectId} actions={actions} />
          </div>
        </>
      )}
    </>
  );
}
