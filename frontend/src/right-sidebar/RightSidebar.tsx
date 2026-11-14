import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useDragResize } from "../hooks/useDragResize.js";
import { useClearTaskSelectionOnProjectChange } from "../hooks/useClearTaskSelectionOnProjectChange.js";
import { useFollowedProject } from "../hooks/useFollowedProject.js";
import { useFocusTrap } from "../hooks/useFocusTrap.js";
import { usePhoneBackStack } from "../hooks/usePhoneBackStack.js";
import {
  RIGHT_SIDEBAR_FULL_WIDTH_QUERY,
  isCompactTier,
  useCoarsePointer,
} from "../lib/layoutTier.js";
import type { LayoutTier } from "../lib/layoutTier.js";
import { useShallow } from "zustand/react/shallow";
import { goSidebarBack } from "../sidebarBack.js";
import { useDashboardStore } from "../store/index.js";
import type { DashboardState, SidebarBack } from "../store/types.js";
import { RIGHT_SIDEBAR_MAX_WIDTH, RIGHT_SIDEBAR_MIN_WIDTH } from "../store/constants.js";
import { RightRail } from "./RightRail.js";
import { RightSidebarPanel } from "./RightSidebarPanel.js";
import { RIGHT_SIDEBAR_VIEWS } from "./views-registry.js";
import { VIEW_TITLES } from "./viewTitles.js";
import type { RightSidebarActions } from "./views.js";

export interface RightSidebarProps {
  tier: LayoutTier;
  actions: RightSidebarActions;
  // Issue #1877 — the workspace's project ids (App's scopedWorkspaceProjectIds);
  // the project picker offers only these. null/absent = every project.
  workspaceProjectIds?: number[] | null;
}

function subscribeFullWidth(onChange: () => void): () => void {
  const mq = window.matchMedia(RIGHT_SIDEBAR_FULL_WIDTH_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
const readFullWidth = (): boolean => window.matchMedia(RIGHT_SIDEBAR_FULL_WIDTH_QUERY).matches;

// One slot in the phone's back stack. Keyed by the caller, so a new key (a
// drill-in that moved to another detail) registers a fresh entry: the stack
// pops an entry when back is pressed, and an entry that stayed active would
// not register itself again.
function PhoneBackEntry({ onBack }: { onBack: () => void }) {
  usePhoneBackStack(true, onBack);
  return null;
}

// The drill-in a view is showing (a task's detail, a PR or an issue), as the
// sidebar history's own location type; null on a view's list.
type DrillState = Pick<
  DashboardState,
  "rightSidebarView" | "selectedTaskId" | "githubOpenPrByProject" | "githubOpenIssueByProject"
>;
function drillOf(s: DrillState, projectId: number | null): SidebarBack | null {
  if (s.rightSidebarView === "tasks" && s.selectedTaskId !== null) {
    return { kind: "task", taskId: s.selectedTaskId };
  }
  if (s.rightSidebarView === "github" && projectId !== null) {
    const pr = s.githubOpenPrByProject[projectId] ?? null;
    if (pr !== null) return { kind: "pr", projectId, number: pr };
    const issue = s.githubOpenIssueByProject[projectId] ?? null;
    if (issue !== null) return { kind: "issue", projectId, number: issue };
  }
  return null;
}

function drillKey(drill: SidebarBack | null): string | null {
  if (!drill) return null;
  return drill.kind === "task"
    ? `task:${drill.taskId}`
    : `${drill.kind}:${drill.projectId}:${drill.number}`;
}

// Back from a drill-in: the sidebar history's step back, else the view's list.
function leaveDrillIn(drill: SidebarBack): void {
  goSidebarBack(drill, () => {
    const store = useDashboardStore.getState();
    if (drill.kind === "task") store.selectTask(null);
    else if (drill.kind === "pr") store.setGithubOpenPr(drill.projectId, null);
    else store.setGithubOpenIssue(drill.projectId, null);
  });
}

// Right sidebar: an icon rail plus a view panel. The panel is always docked
// beside the grid and pushes it; it never floats, has no scrim and is not
// dismissed by a swipe or a click elsewhere (#3006). A rail tab opens its
// view, and the open view's tab closes the panel. Only where the window is
// too narrow to dock does an open view cover the workspace. Rendered as
// siblings of `.grid-area` inside `.app-body`.
//
// On the phone (#3014) there is no rail: the "more" sheet (PhoneMoreSheet)
// opens a view, and an open view is a full screen with a back control. The
// back gesture closes a drill-in inside it first (a task's detail, a PR), then
// the view. A view opened straight at a detail (a task from the board) has no
// list behind it, so back from that detail closes the view.
export function RightSidebar({ tier, actions, workspaceProjectIds }: RightSidebarProps) {
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
  // nothing here until a view opens, but the project a focused panel puts here is
  // the one the phone follows; the board words the option for it (#2864). With
  // nothing focused the hook only falls back to the first project, which
  // nothing made "active", so phone publishes null then (a visible sidebar does show that fallback project, so it still publishes it). The
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

  // Landing on the phone, at start or from a tier change (rotate, fold),
  // closes the panel: `open` is persisted for the docked sidebar, and on the
  // phone an open view is a full screen nobody asked for.
  const lastTier = useRef<LayoutTier | null>(null);
  useEffect(() => {
    const prev = lastTier.current;
    lastTier.current = tier;
    if (prev !== tier && open && tier === "phone") close();
  }, [tier, open, close]);

  const view = RIGHT_SIDEBAR_VIEWS.find((v) => v.id === viewId) ?? RIGHT_SIDEBAR_VIEWS[0];
  const phone = tier === "phone";
  const phoneOpen = phone && open;
  const drill = useDashboardStore(useShallow((s) => drillOf(s, followedProjectId)));
  const key = drillKey(drill);
  // What the view opened at: its list (null) or a detail (its key). Read from
  // the store's own transitions, not from renders: a closed-then-reopened view
  // in one flush (a ?task= link on a cold start, the cross-link's return) never
  // renders the closed state in between.
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const followedRef = useRef(followedProjectId);
  useEffect(() => {
    followedRef.current = followedProjectId;
  });
  useEffect(() => {
    if (!phone) return;
    return useDashboardStore.subscribe((s, prev) => {
      if (!s.rightSidebarOpen) return;
      // Opened, or moved to another view with no way back (no sidebar history
      // entry, unlike a task's PR link): either way a fresh entry point.
      if (
        !prev.rightSidebarOpen ||
        (s.rightSidebarView !== prev.rightSidebarView && s.sidebarHistory.length === 0)
      ) {
        setOpenedAt(drillKey(drillOf(s, followedRef.current)));
        return;
      }
      // A mode change while the view is open (a cross-link to a session,
      // "Open task board") leaves the full screen, which would otherwise cover
      // the mode it switched to.
      if (s.viewMode !== prev.viewMode) s.closeRightSidebar();
    });
  }, [phone]);
  const enteredAtDetail = openedAt !== null;
  useEffect(() => {
    // The detail it opened at was left for the list (its own Back, or the
    // gesture): there is no list to show, so close.
    if (phoneOpen && enteredAtDetail && key === null) close();
  }, [phoneOpen, enteredAtDetail, key, close]);

  // The full screen covers everything else, so it is a modal dialog: focus
  // moves into it as it opens (its first control, the back arrow), Tab wraps
  // inside it, and closing it returns focus to where it was (useFocusTrap).
  const phoneRef = useRef<HTMLElement>(null);
  const { onKeyDown: onPhoneKeyDown, suppressRestore } = useFocusTrap({
    active: phoneOpen,
    containerRef: phoneRef,
  });
  // suppressRestore is a fresh closure each render; the actions below read it
  // through a ref so they are not rebuilt every render.
  const suppressRestoreRef = useRef(suppressRestore);
  useEffect(() => {
    suppressRestoreRef.current = suppressRestore;
  });

  // An action that opens a pane (a device, a file, the full Git panel) leaves
  // the phone's full screen first, or the pane would open behind it. Focus is
  // not restored on that close: it belongs to the pane being opened.
  const phoneActions = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(actions).map(([name, fn]) => [
          name,
          (...args: unknown[]) => {
            suppressRestoreRef.current();
            close();
            (fn as (...a: unknown[]) => void)(...args);
          },
        ]),
      ) as unknown as RightSidebarActions,
    [actions, close],
  );

  // A drill-in swaps the header: the view's back row steps aside for the
  // detail's own header (mobile.css), so focus would fall to <body>. Move it to
  // the back control that is showing now. The first run is the trap's.
  const focusedKey = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!phoneOpen) {
      focusedKey.current = undefined;
      return;
    }
    if (focusedKey.current === undefined) {
      focusedKey.current = key;
      return;
    }
    if (focusedKey.current === key) return;
    focusedKey.current = key;
    const root = phoneRef.current;
    const target =
      key !== null
        ? root?.querySelector<HTMLElement>(".right-sidebar-detail-slot button")
        : root?.querySelector<HTMLElement>(".right-sidebar-phone-back");
    target?.focus();
  }, [phoneOpen, key]);

  if (phone) {
    if (!phoneOpen) return null;
    return (
      <section
        ref={phoneRef}
        className="right-sidebar-panel phone"
        role="dialog"
        aria-modal="true"
        aria-label={`${view.label} view`}
        onKeyDown={onPhoneKeyDown}
      >
        {/* Registered before the drill-in below, so a view opened straight at
            a detail is under it on the stack. */}
        <PhoneBackEntry onBack={close} />
        {drill !== null && key !== openedAt && (
          <PhoneBackEntry key={key} onBack={() => leaveDrillIn(drill)} />
        )}
        <RightSidebarPanel
          view={view}
          followed={followed}
          actions={phoneActions}
          onClose={close}
          phone
          title={VIEW_TITLES[view.id as keyof typeof VIEW_TITLES] ?? view.label}
        />
      </section>
    );
  }

  return (
    <>
      {open && (
        <aside
          className={`right-sidebar-panel docked${full ? " full" : ""}${dragging ? " resizing" : ""}`}
          style={full ? undefined : { width }}
          aria-label={`${view.label} sidebar`}
        >
          {!full && !coarse && (
            <div className="right-sidebar-resize-handle" onMouseDown={onMouseDown} />
          )}
          <RightSidebarPanel view={view} followed={followed} actions={actions} onClose={close} />
        </aside>
      )}
      <RightRail projectId={followed.effectiveProjectId} />
    </>
  );
}
