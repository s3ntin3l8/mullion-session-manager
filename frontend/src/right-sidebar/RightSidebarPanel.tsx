import { useState } from "react";
import { Dropdown } from "../ui/primitives.js";
import { CloseIcon, FollowIcon, PinIcon } from "../ui/icons.js";
import type { FollowedProject } from "../hooks/useFollowedProject.js";
import { useFollowedCheckoutSession } from "../hooks/useFollowedCheckoutSession.js";
import { SidebarRepoTitleContext, SidebarToolbarSlotContext } from "./sidebarToolbarSlot.js";
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
  const checkoutSessionId = useFollowedCheckoutSession(projectId);
  const [toolbarSlot, setToolbarSlot] = useState<HTMLElement | null>(null);
  const [repoTitle, setRepoTitle] = useState<string | null>(null);
  const following = followed.pinnedProjectId == null;
  const projectName = followed.dropdownOptions.find(
    (o) => o.value === followed.dropdownValue,
  )?.label;
  return (
    <>
      {/* One header row for every view: the project picker is the title (the
          rail already shows which view is open; view.label stays as the
          panel's aria-label), then the view's toolbar, pin and close. */}
      <div className="right-sidebar-header">
        {projectId != null && (
          <>
            <span
              className="right-sidebar-follow-glyph"
              role="img"
              aria-label={following ? "Following the active panel" : "Pinned to this project"}
              title={following ? "Following the active panel" : "Pinned to this project"}
            >
              {following ? <FollowIcon size={12} /> : <PinIcon size={12} />}
            </span>
            <Dropdown
              small
              ariaLabel="Project"
              title={repoTitle ?? projectName}
              options={followed.dropdownOptions}
              value={followed.dropdownValue}
              onChange={followed.onDropdownChange}
            />
          </>
        )}
        <div className="right-sidebar-toolbar-slot" ref={setToolbarSlot} />
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
        <div className="right-sidebar-body cmux-scroll">
          <SidebarToolbarSlotContext.Provider value={toolbarSlot}>
            <SidebarRepoTitleContext.Provider value={setRepoTitle}>
              <View projectId={projectId} checkoutSessionId={checkoutSessionId} actions={actions} />
            </SidebarRepoTitleContext.Provider>
          </SidebarToolbarSlotContext.Provider>
        </div>
      )}
    </>
  );
}
