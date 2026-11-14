import type { ReactNode } from "react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useDragResize } from "../hooks/useDragResize.js";
import { useClearTaskSelectionOnProjectChange } from "../hooks/useClearTaskSelectionOnProjectChange.js";
import { useFollowedProject } from "../hooks/useFollowedProject.js";
import { usePhoneBackStack } from "../hooks/usePhoneBackStack.js";
import {
  RIGHT_SIDEBAR_FULL_WIDTH_QUERY,
  isCompactTier,
  useCoarsePointer,
} from "../lib/layoutTier.js";
import type { LayoutTier } from "../lib/layoutTier.js";
import { useDashboardStore } from "../store/index.js";
import { RIGHT_SIDEBAR_MAX_WIDTH, RIGHT_SIDEBAR_MIN_WIDTH } from "../store/constants.js";
import { RightRail } from "./RightRail.js";
import { RightSidebarPanel } from "./RightSidebarPanel.js";
import { RIGHT_SIDEBAR_VIEWS } from "./views-registry.js";
import type { RightSidebarActions } from "./views.js";

export interface RightSidebarProps {
  tier: LayoutTier;
  actions: RightSidebarActions;
  // Issue #1877 — the workspace's project ids (App's scopedWorkspaceProjectIds);
  // the project picker offers only these. null/absent = every project.
  workspaceProjectIds?: number[] | null;
  /** #3010 — the two halves (800-1099px): the panel is exactly the right
   *  half (equal to the left, no stored width, no resize handle). */
  halves?: boolean;
  /** The right half's session, shown while no sidebar view covers it. */
  rightHalf?: ReactNode;
  /** The right half's sessions, listed in the rail below the views. */
  railSessions?: ReactNode;
}

function subscribeFullWidth(onChange: () => void): () => void {
  const mq = window.matchMedia(RIGHT_SIDEBAR_FULL_WIDTH_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
const readFullWidth = (): boolean => window.matchMedia(RIGHT_SIDEBAR_FULL_WIDTH_QUERY).matches;

// Right sidebar: an icon rail plus a view panel. The panel is always docked
// beside the grid and pushes it; it never floats, has no scrim and is not
// dismissed by a swipe or a click elsewhere (#3006). A rail tab opens its
// view, and the open view's tab closes the panel. Only where the window is
// too narrow to dock does an open view cover the workspace. Rendered as
// siblings of `.grid-area` inside `.app-body`. Not rendered on phone, where
// the navigator panel already carries Source Control.
export function RightSidebar({
  tier,
  actions,
  workspaceProjectIds,
  halves = false,
  rightHalf,
  railSessions,
}: RightSidebarProps) {
  const viewId = useDashboardStore((s) => s.rightSidebarView);
  const open = useDashboardStore((s) => s.rightSidebarOpen);
  const storedWidth = useDashboardStore((s) => s.rightSidebarWidth);
  const setStoredWidth = useDashboardStore((s) => s.setRightSidebarWidth);
  const close = useDashboardStore((s) => s.closeRightSidebar);
  const followed = useFollowedProject(workspaceProjectIds ?? null);
  // Project select and app start: warm the GitHub data for the project the
  // sidebar follows, so the panel's first paint is already cached (#1970).
  const prefetchGithubProject = useDashboardStore((s) => s.prefetchGithubProject);
  const followedProjectId = followed.effectiveProjectId;
  // Here, not in the panel or a view: the panel is only mounted while the drawer is open,
  // and the followed project usually changes while it is collapsed.
  useClearTaskSelectionOnProjectChange(followedProjectId);
  // Publish the followed project for the Task Master board's "follow" option (#2858). This
  // is the only place useFollowedProject is resolved for the shell, so the board reads this
  // instead of deriving it a second time. App mounts this on every tier. Phone renders
  // nothing here, but the project a focused panel puts here is the one the phone follows;
  // the board words the option for it (#2864). With nothing focused the hook only falls
  // back to the first project, which nothing made "active", so phone publishes null then
  // (a visible sidebar does show that fallback project, so it still publishes it). The
  // phone navigator's own Source Control section is only mounted on its projects tab, so
  // it cannot be the producer while the Tasks board is showing.
  const setFollowedProjectId = useDashboardStore((s) => s.setFollowedProjectId);
  const publishedProjectId = tier === "phone" ? followed.followSourceId : followedProjectId;
  useEffect(() => {
    setFollowedProjectId(publishedProjectId);
  }, [publishedProjectId, setFollowedProjectId]);
  // Clear it on unmount only, so a project switch is one store write, not null then id.
  useEffect(() => () => setFollowedProjectId(null), [setFollowedProjectId]);
  useEffect(() => {
    if (followedProjectId != null) prefetchGithubProject(followedProjectId);
  }, [followedProjectId, prefetchGithubProject]);
  // A request to show a specific project (palette "Edit project files") pins
  // the picker to it — render-phase adjustment keyed on the request's nonce.
  // The request is deliberately never cleared: the nonce is the only dedupe,
  // and resetting it to null would let a later request reuse an already-handled
  // nonce and be skipped.
  const projectRequest = useDashboardStore((s) => s.rightSidebarProjectRequest);
  const [handledNonce, setHandledNonce] = useState(projectRequest?.nonce ?? 0);
  if (projectRequest && projectRequest.nonce !== handledNonce) {
    setHandledNonce(projectRequest.nonce);
    followed.setPinnedProjectId(projectRequest.projectId);
  }

  const [width, setWidth] = useState(storedWidth);
  // Follow the store if it changes from outside this component's own drag
  // (another action, a future "reset width") — render-phase adjustment, not
  // an effect (react-hooks/set-state-in-effect).
  const [lastStoredWidth, setLastStoredWidth] = useState(storedWidth);
  if (storedWidth !== lastStoredWidth) {
    setLastStoredWidth(storedWidth);
    setWidth(storedWidth);
  }
  const { dragging, onMouseDown } = useDragResize({
    axis: "x",
    invert: true,
    min: RIGHT_SIDEBAR_MIN_WIDTH,
    getMax: () => RIGHT_SIDEBAR_MAX_WIDTH,
    value: width,
    onChange: setWidth,
    onCommit: setStoredWidth,
    cursor: "col-resize",
  });

  const full = useSyncExternalStore(subscribeFullWidth, readFullWidth);
  // The resize handle is a 6px mouse target; a touch pointer cannot drag it.
  const coarse = useCoarsePointer();
  // Covering the workspace is the one state the panel can be "in the way":
  // only then do Escape and the back gesture close it.
  const covering = open && full && tier !== "phone";

  // A docked panel is part of the layout, so Escape (which terminals need)
  // leaves it alone. Even when it covers the workspace, an Escape that
  // something already handled (defaultPrevented) or that came from inside a
  // terminal belongs to that terminal (vim, an agent TUI), not to the panel.
  useEffect(() => {
    if (!covering) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (e.target instanceof Element && e.target.closest(".xterm")) return;
      close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [covering, close]);
  // The back stack is for the compact tiers only (its own contract): a
  // forced desktop tier on a narrow window keeps Escape but not back.
  usePhoneBackStack(covering && isCompactTier(tier), close);

  // #3010 — a tier change that lands on phone (folding, a narrowed window)
  // leaves an open view open. It used to close it, since phone renders
  // nothing here; design 9.2 keeps it instead: the phone layout shows the view
  // full screen if it was used last, and unfolding brings it back on the
  // right half. `open` is persisted state, so nothing else is needed.

  if (tier === "phone") return null;

  const view = RIGHT_SIDEBAR_VIEWS.find((v) => v.id === viewId) ?? RIGHT_SIDEBAR_VIEWS[0];

  return (
    <>
      {open && (
        <aside
          className={`right-sidebar-panel docked${full ? " full" : ""}${dragging ? " resizing" : ""}${halves ? " half" : ""}`}
          style={full || halves ? undefined : { width }}
          aria-label={`${view.label} sidebar`}
        >
          {!full && !coarse && !halves && (
            <div className="right-sidebar-resize-handle" onMouseDown={onMouseDown} />
          )}
          <RightSidebarPanel view={view} followed={followed} actions={actions} onClose={close} />
        </aside>
      )}
      {/* #3010 — the right half's session, while no view covers it. */}
      {!open && halves && rightHalf && (
        <aside className="right-sidebar-panel docked half" aria-label="Right half">
          {rightHalf}
        </aside>
      )}
      <RightRail projectId={followed.effectiveProjectId}>{railSessions}</RightRail>
    </>
  );
}
