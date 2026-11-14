import { Fragment, useState } from "react";

import { CloseIcon, ChevronRightIcon, SearchIcon } from "./ui/icons.js";
import { filterSettingsSections, phoneSections } from "./settings/settingsSections.js";
import type { SettingsSection } from "./settings/settingsSections.js";
import type { ReactNode } from "react";
import { SearchInput } from "./ui/primitives.js";

// Chrome for the navigator drawer from 700 to 1279px (App.tsx renders it
// inside `.sidebar-wrapper`, which compact.css makes a ~440px slide-over; the
// phone has no drawer since #3014). The drawer's sections become tabs so each
// gets a full-height list instead of one long scroll: Projects is the
// Sidebar's project tree (`phoneSection`); Settings shows the section list
// below; Tasks switches to Tasks mode, the board over the grid (#3009).
// Devices are a right-sidebar view (#3012), not a tab here.
export type PhoneNavTab = "projects" | "tasks" | "settings";

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
//
// The list is filterable (issue #1880): the phone showed every section
// unfiltered, so finding one of the 18 meant scrolling past all of them.
// The filter is the desktop rail's own — filterSettingsSections, shared with
// Settings.tsx so the two agree on what a query finds.
export function PhoneSettingsList({ onSelect }: { onSelect: (section: SettingsSection) => void }) {
  const [query, setQuery] = useState("");
  const sections = filterSettingsSections(phoneSections(), query);
  return (
    <div className="phone-nav-settings">
      <div className="phone-nav-settings-search ui-input-wrap">
        <SearchIcon size={15} strokeWidth={1.9} />
        <SearchInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search settings…"
          aria-label="Search settings"
        />
      </div>
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
      {sections.length === 0 && (
        <div className="phone-nav-settings-empty">No matching settings.</div>
      )}
    </div>
  );
}

// Header + body of the navigator.
export function PhoneNavigatorPanel({
  navTab,
  setNavTab,
  onOpenTasks,
  onClose,
  onSelectSetting,
  sidebar,
  workspaces,
}: {
  // The workspace switcher, shown at the top of the Projects tab.
  workspaces?: ReactNode;
  navTab: PhoneNavTab;
  setNavTab: (tab: PhoneNavTab) => void;
  onOpenTasks: () => void;
  onClose: () => void;
  onSelectSetting: (section: SettingsSection) => void;
  sidebar: ReactNode;
}) {
  return (
    <>
      <PhoneNavigatorHeader
        tab={navTab}
        onTab={(t) => {
          if (t === "tasks") {
            onOpenTasks();
            return;
          }
          setNavTab(t);
        }}
        onClose={onClose}
      />
      {navTab === "settings" ? (
        <PhoneSettingsList onSelect={onSelectSetting} />
      ) : (
        <>
          {workspaces}
          {sidebar}
        </>
      )}
    </>
  );
}
