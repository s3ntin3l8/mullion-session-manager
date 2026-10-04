import { Fragment } from "react";

import { CloseIcon, ChevronRightIcon } from "./ui/icons.js";
import { phoneSections } from "./settings/settingsSections.js";
import type { SettingsSection } from "./settings/settingsSections.js";
import { useDashboardStore } from "./store/index.js";
import { KanbanBoardOverlay } from "./panels/registry.js";
import type { Session } from "./api/index.js";
import type { ReactNode } from "react";

// Phone-only chrome for the full-screen navigator (App.tsx renders it inside
// `.sidebar-wrapper`, which mobile.css stretches to the whole viewport below
// the toolbar on phone). The drawer's sections become tabs so each gets a
// full-height list instead of one long scroll: Projects and Devices swap the
// Sidebar's `phoneSection`; Settings shows the section list below; Tasks
// shows the task board in place (App.tsx keeps the navigator open for it).
export type PhoneNavTab = "projects" | "tasks" | "devices" | "settings";

export function PhoneNavigatorHeader({
  tab,
  onTab,
  onClose,
}: {
  tab: PhoneNavTab;
  onTab: (tab: PhoneNavTab) => void;
  onClose: () => void;
}) {
  return (
    <div className="phone-nav-header">
      <div className="phone-nav-title-row">
        <span className="phone-nav-title">Navigator</span>
        <button className="mobile-tab-btn" aria-label="Close navigator" onClick={onClose}>
          <CloseIcon size={14} />
        </button>
      </div>
      <div className="phone-nav-tabs" role="group" aria-label="Navigator sections">
        <button
          className="phone-nav-tab"
          aria-pressed={tab === "projects"}
          onClick={() => onTab("projects")}
        >
          Projects
        </button>
        <button
          className="phone-nav-tab"
          aria-pressed={tab === "tasks"}
          onClick={() => onTab("tasks")}
        >
          Tasks
        </button>
        <button
          className="phone-nav-tab"
          aria-pressed={tab === "devices"}
          onClick={() => onTab("devices")}
        >
          Devices
        </button>
        <button
          className="phone-nav-tab"
          aria-pressed={tab === "settings"}
          onClick={() => onTab("settings")}
        >
          Settings
        </button>
      </div>
    </div>
  );
}

// The Settings tab: the same grouped section list Settings.tsx's own nav
// rail is built from (SECTIONS), as full-width 44px rows. Picking one opens
// Settings straight into that section.
export function PhoneSettingsList({ onSelect }: { onSelect: (section: SettingsSection) => void }) {
  const sections = phoneSections();
  return (
    <div className="phone-nav-settings">
      {sections.map((s, i) => (
        <Fragment key={s.id}>
          {sections[i - 1]?.group !== s.group && (
            <div className="phone-nav-settings-group">{s.group}</div>
          )}
          <button className="phone-nav-settings-row" onClick={() => onSelect(s.id)}>
            <span className="phone-nav-settings-icon">{s.icon(16)}</span>
            <span className="phone-nav-settings-title">{s.title}</span>
            <ChevronRightIcon size={14} />
          </button>
        </Fragment>
      ))}
    </div>
  );
}

// Header + body of the phone navigator. viewMode === "kanban" wins over the
// local tab, so Tasks can also be entered from outside (palette).
export function PhoneNavigatorPanel({
  navTab,
  setNavTab,
  onOpenTasks,
  onClose,
  onSelectSetting,
  sidebar,
  onOpenSession,
  onSessionEnded,
}: {
  navTab: PhoneNavTab;
  setNavTab: (tab: PhoneNavTab) => void;
  onOpenTasks: () => void;
  onClose: () => void;
  onSelectSetting: (section: SettingsSection) => void;
  sidebar: ReactNode;
  onOpenSession: (session: Session) => void;
  onSessionEnded: (session: Session) => void;
}) {
  const tasksOpen = useDashboardStore((st) => st.viewMode === "kanban");
  return (
    <>
      <PhoneNavigatorHeader
        tab={tasksOpen ? "tasks" : navTab}
        onTab={(t) => {
          if (t === "tasks") {
            onOpenTasks();
            return;
          }
          setNavTab(t);
          if (tasksOpen) useDashboardStore.getState().setViewMode("list");
        }}
        onClose={onClose}
      />
      {tasksOpen ? (
        <KanbanBoardOverlay
          inline
          phone
          onOpenSession={onOpenSession}
          onSessionEnded={onSessionEnded}
        />
      ) : navTab === "settings" ? (
        <PhoneSettingsList onSelect={onSelectSetting} />
      ) : (
        sidebar
      )}
    </>
  );
}
