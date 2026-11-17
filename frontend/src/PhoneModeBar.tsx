import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "./api/index.js";
import { needsYouTasks } from "./github/taskMasterSummary.js";
import { useKeyboardUp } from "./hooks/useVisualViewportInset.js";
import { NotificationBell } from "./NotificationBell.js";
import { RIGHT_SIDEBAR_VIEWS } from "./right-sidebar/views-registry.js";
import type { RightSidebarView } from "./right-sidebar/views.js";
import { useDashboardStore } from "./store/index.js";
import { BottomSheet } from "./ui/BottomSheet.js";
import {
  ChevronRightIcon,
  GearIcon,
  GridIcon,
  LayersIcon,
  OverflowIcon,
  PlusIcon,
} from "./ui/icons.js";

// The phone's tab bar (#3014, #3288): a full-width bar at the bottom of the
// screen, under the terminal's key bar, with five entries, each an icon over a
// short label: Workspace · Tasks · New · Inbox · More. It hides while the
// on-screen keyboard is up, so typing keeps the terminal's height and the key
// bar stays right above the keys; useVisualViewportInset is the detector. It
// owns the bottom safe-area inset while it shows (mobile.css).
//
// It replaces the phone's navigator drawer: Projects is the session picker in
// the top bar, Tasks is this bar's Tasks mode, and Devices and Settings are in
// the "more" sheet, which lists what the right rail lists on larger screens.
// New is the mode's primary action (the new-session launcher, or the Tasks
// board's new-task form), and Inbox is the one NotificationBell on the phone:
// the top bar has none (#3288).
//
// A right-sidebar view opened from the sheet ends above this bar (#3216), and
// the bar is the way out of it: while one is open, "more" is the active entry,
// and Workspace or Tasks closes the view and shows that mode, the current one
// included.
export function PhoneModeBar({
  onOpenSettings,
  onNewSession,
  onOpenSession,
  onOpenTimeline,
  onOpenBrowser,
}: {
  onOpenSettings: () => void;
  /** The new-session launcher: the session picker's New session row's action. */
  onNewSession: () => void;
  // Passed straight through to NotificationBell (see its own prop docs).
  onOpenSession: (session: Session) => void;
  onOpenTimeline?: (session: Session) => void;
  onOpenBrowser: (projectId: number) => void;
}) {
  const keyboardUp = useKeyboardUp();
  const tasksMode = useDashboardStore((s) => s.viewMode === "kanban");
  const viewOpen = useDashboardStore((s) => s.rightSidebarOpen);
  const tasks = useDashboardStore((s) => s.tasks);
  const newTaskFormOpen = useDashboardStore((s) => s.newTaskFormOpen);
  // The rail's count (LeftRail.tsx): the one "needs you" definition, install-wide.
  const needsYou = useMemo(() => needsYouTasks(tasks).length, [tasks]);
  const [moreOpen, setMoreOpen] = useState(false);
  const newRef = useRef<HTMLButtonElement>(null);
  // Set when New opened the task form; focus comes back to New once the form
  // closes and the bar shows again (the form's title field raises the
  // keyboard, which hides the bar, so the return waits for it).
  const returnFocusToNew = useRef(false);
  useEffect(() => {
    if (newTaskFormOpen || keyboardUp || !returnFocusToNew.current) return;
    returnFocusToNew.current = false;
    newRef.current?.focus();
  }, [newTaskFormOpen, keyboardUp]);

  const showMode = (mode: "list" | "kanban", button: HTMLButtonElement) => {
    const store = useDashboardStore.getState();
    // Focus stays on the tapped button (RightSidebar leaves it there rather
    // than returning it to the view's opener). iOS does not focus a tapped
    // button by itself, so it is done here.
    button.focus();
    // Closed explicitly: RightSidebar closes the view on a mode change, but a
    // tap on the current mode changes nothing.
    store.closeRightSidebar();
    store.setViewMode(mode);
  };
  const onNew = (button: HTMLButtonElement) => {
    const store = useDashboardStore.getState();
    // The launcher and the form return focus to what was focused when they
    // opened; iOS does not focus a tapped button, so it is done here.
    button.focus();
    // What New makes shows in the mode, not under a sidebar view.
    store.closeRightSidebar();
    if (tasksMode) {
      const open = !store.newTaskFormOpen;
      returnFocusToNew.current = open;
      store.setNewTaskFormOpen(open);
    } else {
      onNewSession();
    }
  };
  const workspaceActive = !viewOpen && !tasksMode;
  const tasksActive = !viewOpen && tasksMode;

  return (
    <>
      {/* Hidden rather than unmounted while the keyboard is up: Inbox's
          NotificationBell owns the feed's sheet, which must stay open while
          a field in it raises the keyboard. */}
      <nav className="phone-mode-bar" aria-label="Mode" hidden={keyboardUp}>
        <button
          type="button"
          className={`phone-mode-btn${workspaceActive ? " active" : ""}`}
          aria-pressed={workspaceActive}
          onClick={(e) => showMode("list", e.currentTarget)}
        >
          <GridIcon size={20} aria-hidden="true" />
          <span className="phone-mode-label">Workspace</span>
        </button>
        <button
          type="button"
          className={`phone-mode-btn${tasksActive ? " active" : ""}`}
          aria-pressed={tasksActive}
          aria-label={
            needsYou > 0 ? `Tasks, ${needsYou} need${needsYou === 1 ? "s" : ""} you` : "Tasks"
          }
          onClick={(e) => showMode("kanban", e.currentTarget)}
        >
          <LayersIcon size={20} aria-hidden="true" />
          <span className="phone-mode-label">Tasks</span>{" "}
          {/* After the label, so "Tasks 2" reads in the name's order (#2886);
              drawn on the icon's corner. */}
          {needsYou > 0 && (
            <span className="phone-mode-badge" aria-hidden="true">
              {needsYou > 99 ? "99+" : needsYou}
            </span>
          )}
        </button>
        <button
          ref={newRef}
          type="button"
          className="phone-mode-btn phone-mode-new"
          aria-label={tasksMode ? "New task" : "New session"}
          // The task form is inline on the board; the launcher is a dialog.
          {...(tasksMode
            ? { "aria-expanded": newTaskFormOpen }
            : { "aria-haspopup": "dialog" as const })}
          onClick={(e) => onNew(e.currentTarget)}
        >
          <span className="phone-mode-new-icon" aria-hidden="true">
            <PlusIcon size={20} strokeLinecap="round" strokeWidth={2.2} />
          </span>
          <span className="phone-mode-label">New</span>
        </button>
        <NotificationBell
          onOpenSession={onOpenSession}
          onOpenTimeline={onOpenTimeline}
          onOpenBrowser={onOpenBrowser}
          sheet
          triggerClassName="phone-mode-btn phone-mode-inbox"
          label="Inbox"
          iconSize={20}
        />
        <button
          type="button"
          className={`phone-mode-btn phone-mode-more${viewOpen ? " active" : ""}`}
          aria-label="More"
          // The open view is one of the sheet's entries, so "more" is the
          // current item (the generic token: it opens a sheet, not a page).
          aria-current={viewOpen ? "true" : undefined}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          onClick={(e) => {
            // The sheet returns focus to its opener; iOS does not focus a tap.
            e.currentTarget.focus();
            setMoreOpen(true);
          }}
        >
          <OverflowIcon size={20} aria-hidden="true" />
          <span className="phone-mode-label">More</span>
        </button>
      </nav>
      <PhoneMoreSheet
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        onOpenSettings={onOpenSettings}
      />
    </>
  );
}

function MoreRow({
  view,
  projectId,
  onOpen,
}: {
  view: RightSidebarView;
  projectId: number | null;
  onOpen: () => void;
}) {
  // One component per view so each view's hooks run unconditionally, as the
  // right rail's buttons do.
  const enabled = view.useEnabled();
  const badge = view.useBadge(projectId);
  if (!enabled) return null;
  const Icon = view.icon;
  return (
    <button type="button" className="phone-more-row" onClick={onOpen}>
      <Icon size={17} aria-hidden="true" />
      <span className="phone-more-label">{view.label}</span>
      {badge?.kind === "count" && (
        <span className="phone-more-badge" title={badge.title}>
          {badge.value > 99 ? "99+" : badge.value}
        </span>
      )}
      {badge?.kind === "alert" && (
        <span className="phone-more-badge alert" title={badge.title} aria-label={badge.title} />
      )}
      <ChevronRightIcon size={14} aria-hidden="true" />
    </button>
  );
}

// The phone's right rail (design 9.4): the right sidebar's views, from its own
// registry so the two cannot drift, each opening full screen for the project
// the sidebar follows (RightSidebar.tsx's phone branch), then Settings.
export function PhoneMoreSheet({
  open,
  onClose,
  onOpenSettings,
}: {
  open: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const projectId = useDashboardStore((s) => s.followedProjectId);
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      label="More"
      closeLabel="Close"
      title="More"
      sheetClassName="phone-more-sheet"
      backStack
    >
      <div className="phone-more-list">
        {RIGHT_SIDEBAR_VIEWS.map((view) => (
          <MoreRow
            key={view.id}
            view={view}
            projectId={projectId}
            onOpen={() => {
              onClose();
              useDashboardStore.getState().openRightSidebarView(view.id);
            }}
          />
        ))}
        <button
          type="button"
          className="phone-more-row"
          onClick={() => {
            onClose();
            onOpenSettings();
          }}
        >
          <GearIcon size={17} aria-hidden="true" />
          <span className="phone-more-label">Settings</span>
          <ChevronRightIcon size={14} aria-hidden="true" />
        </button>
      </div>
    </BottomSheet>
  );
}
