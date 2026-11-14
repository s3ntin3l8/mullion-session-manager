import { useLayoutEffect, useState } from "react";
import { Dropdown } from "../ui/primitives.js";
import { ChevronLeftIcon, CloseIcon, FollowIcon, PinIcon } from "../ui/icons.js";
import type { FollowedProject } from "../hooks/useFollowedProject.js";
import { useCheckoutTarget } from "../hooks/useCheckoutTarget.js";
import { useDashboardStore } from "../store/index.js";
import { DEFAULT_RIGHT_SIDEBAR_VIEW } from "../store/constants.js";
import { SidebarDetailSlotContext } from "../ui/sidebar/detailSlot.js";
import {
  SidebarRepoTitleContext,
  SidebarStripSlotContext,
  SidebarToolbarSlotContext,
} from "./sidebarToolbarSlot.js";
import { useCurrentLayoutBand, viewInBand } from "./viewBands.js";
import type { RightSidebarActions, RightSidebarView } from "./views.js";

export interface RightSidebarPanelProps {
  view: RightSidebarView;
  followed: FollowedProject;
  actions: RightSidebarActions;
  onClose: () => void;
  /** Phone (#3014): the view is a full screen with a header row that names it
   * and a back control, in place of the close button. Back closes the view. */
  phone?: boolean;
  /** With `phone`: the name the header row shows. */
  title?: string;
}

export function RightSidebarPanel({
  view,
  followed,
  actions,
  onClose,
  phone = false,
  title,
}: RightSidebarPanelProps) {
  const projectId = followed.effectiveProjectId;
  const hostGlobal = view.hostGlobal === true;
  // A view that does not exist in this band (Browser and Dock from 1100px)
  // can still be the persisted one, or stay open across a resize. Its rail
  // button is gone, so nothing could close it: close it here instead of
  // rendering a view the layout has no place for, and move the stored view
  // back to the default, or the sidebar toggle would reopen on it.
  const inBand = viewInBand(view, useCurrentLayoutBand());
  // A layout effect, so the close lands before the browser paints: no frame
  // of the out-of-band view's header, no visible open-then-close.
  useLayoutEffect(() => {
    if (inBand) return;
    useDashboardStore.getState().openRightSidebarView(DEFAULT_RIGHT_SIDEBAR_VIEW);
    onClose();
  }, [inBand, onClose]);
  const { checkoutSessionId, choice } = useCheckoutTarget(projectId);
  const [toolbarSlot, setToolbarSlot] = useState<HTMLElement | null>(null);
  const [stripSlot, setStripSlot] = useState<HTMLElement | null>(null);
  const [detailSlot, setDetailSlot] = useState<HTMLElement | null>(null);
  const [repoTitle, setRepoTitle] = useState<string | null>(null);
  const following = followed.pinnedProjectId == null;
  const projectName = followed.dropdownOptions.find(
    (o) => o.value === followed.dropdownValue,
  )?.label;
  return (
    <>
      {phone && (
        // Steps aside while a detail fills the header's detail slot: the
        // detail's own header carries the back control then (right-sidebar.css).
        <div className="right-sidebar-phone-head">
          <button
            type="button"
            className="right-sidebar-phone-back"
            aria-label="Back"
            title="Back"
            onClick={onClose}
          >
            <ChevronLeftIcon size={18} />
          </button>
          <h2 className="right-sidebar-phone-title">{title ?? view.label}</h2>
        </div>
      )}
      {/* One header row for every view: the project picker is the title, then
          the view's toolbar, pin and close. The strip below names the view and
          its context. A pushed detail view fills the detail slot instead, and
          the picker, toolbar and strip step aside (right-sidebar.css). */}
      <div className="right-sidebar-header">
        {projectId != null && !hostGlobal && (
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
        <div className="right-sidebar-detail-slot" ref={setDetailSlot} />
        {!phone && (
          <span className="right-sidebar-header-actions">
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
        )}
      </div>
      <div className="right-sidebar-strip-slot" ref={setStripSlot} />
      {!inBand ? null : projectId == null && !hostGlobal ? (
        <div className="github-panel-empty-row">No projects yet.</div>
      ) : (
        // Keyed by the view (#3015): a view arriving, or one view replacing
        // another, mounts a fresh body that fades and settles in
        // (styles/motion.css, .motion-arrive). Only the content moves; the
        // sidebar itself, and any terminal in it, is at its final size at once.
        <div key={view.id} className="right-sidebar-body cmux-scroll motion-arrive">
          <SidebarToolbarSlotContext.Provider value={toolbarSlot}>
            <SidebarStripSlotContext.Provider value={stripSlot}>
              <SidebarDetailSlotContext.Provider value={detailSlot}>
                <SidebarRepoTitleContext.Provider value={setRepoTitle}>
                  {view.hostGlobal ? (
                    <view.Component actions={actions} />
                  ) : (
                    projectId != null && (
                      <view.Component
                        projectId={projectId}
                        checkoutSessionId={checkoutSessionId}
                        checkoutChoice={choice}
                        actions={actions}
                      />
                    )
                  )}
                </SidebarRepoTitleContext.Provider>
              </SidebarDetailSlotContext.Provider>
            </SidebarStripSlotContext.Provider>
          </SidebarToolbarSlotContext.Provider>
        </div>
      )}
    </>
  );
}
