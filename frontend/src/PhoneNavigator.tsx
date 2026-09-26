import { Fragment } from "react";
import { CloseIcon, ChevronRightIcon } from "./ui/icons.js";
import { SECTIONS } from "./settings/settingsSections.js";
import type { SettingsSection } from "./settings/settingsSections.js";

// Phone-only chrome for the full-screen navigator (App.tsx renders it inside
// `.sidebar-wrapper`, which mobile.css stretches to the whole viewport below
// the toolbar on phone). The drawer's sections become tabs so each gets a
// full-height list instead of one long scroll: Projects and Devices swap the
// Sidebar's `phoneSection`; Settings shows the section list below. Tasks is a
// destination, not a list — its "tab" enters the board (which closes the
// navigator) rather than becoming the selected tab.
export type PhoneNavTab = "projects" | "devices" | "settings";

export function PhoneNavigatorHeader({
  tab,
  onTab,
  onOpenTasks,
  tasksActive,
  onClose,
}: {
  tab: PhoneNavTab;
  onTab: (tab: PhoneNavTab) => void;
  onOpenTasks: () => void;
  tasksActive: boolean;
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
        <button className="phone-nav-tab" aria-pressed={tasksActive} onClick={onOpenTasks}>
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
  return (
    <div className="phone-nav-settings">
      {SECTIONS.map((s, i) => (
        <Fragment key={s.id}>
          {SECTIONS[i - 1]?.group !== s.group && (
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
