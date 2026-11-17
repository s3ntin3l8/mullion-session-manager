import { useMemo, useState } from "react";
import { needsYouTasks } from "./github/taskMasterSummary.js";
import { useKeyboardUp } from "./hooks/useVisualViewportInset.js";
import { RIGHT_SIDEBAR_VIEWS } from "./right-sidebar/views-registry.js";
import type { RightSidebarView } from "./right-sidebar/views.js";
import { useDashboardStore } from "./store/index.js";
import { BottomSheet } from "./ui/BottomSheet.js";
import { ChevronRightIcon, GearIcon, GridIcon, LayersIcon, OverflowIcon } from "./ui/icons.js";

// The phone's mode bar (#3014, design section 4, option B): a full-width bar
// at the bottom of the screen, under the terminal's key bar, with the two
// modes and a narrow "more" entry at its end. It hides while the on-screen
// keyboard is up, so typing keeps the terminal's height and the key bar stays
// right above the keys; useVisualViewportInset is the detector. It owns the
// bottom safe-area inset while it shows (mobile.css).
//
// It replaces the phone's navigator drawer: Projects is the session picker in
// the top bar, Tasks is this bar's Tasks mode, and Devices and Settings are in
// the "more" sheet, which lists what the right rail lists on larger screens.
//
// A right-sidebar view opened from the sheet ends above this bar (#3216), and
// the bar is the way out of it: while one is open, "more" is the active entry,
// and Workspace or Tasks closes the view and shows that mode, the current one
// included.
export function PhoneModeBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const keyboardUp = useKeyboardUp();
  const tasksMode = useDashboardStore((s) => s.viewMode === "kanban");
  const viewOpen = useDashboardStore((s) => s.rightSidebarOpen);
  const tasks = useDashboardStore((s) => s.tasks);
  // The rail's count (LeftRail.tsx): the one "needs you" definition, install-wide.
  const needsYou = useMemo(() => needsYouTasks(tasks).length, [tasks]);
  const [moreOpen, setMoreOpen] = useState(false);
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
  const workspaceActive = !viewOpen && !tasksMode;
  const tasksActive = !viewOpen && tasksMode;

  return (
    <>
      {!keyboardUp && (
        <nav className="phone-mode-bar" aria-label="Mode">
          <button
            type="button"
            className={`phone-mode-btn${workspaceActive ? " active" : ""}`}
            aria-pressed={workspaceActive}
            onClick={(e) => showMode("list", e.currentTarget)}
          >
            <GridIcon size={17} aria-hidden="true" />
            Workspace
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
            <LayersIcon size={17} aria-hidden="true" />
            Tasks{" "}
            {needsYou > 0 && (
              <span className="phone-mode-badge" aria-hidden="true">
                {needsYou > 99 ? "99+" : needsYou}
              </span>
            )}
          </button>
          <button
            type="button"
            className={`phone-mode-btn phone-mode-more${viewOpen ? " active" : ""}`}
            aria-label="More"
            // The open view is one of the sheet's entries, so "more" is the
            // current item (the generic token: it opens a sheet, not a page).
            aria-current={viewOpen ? "true" : undefined}
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen(true)}
          >
            <OverflowIcon size={18} aria-hidden="true" />
          </button>
        </nav>
      )}
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
