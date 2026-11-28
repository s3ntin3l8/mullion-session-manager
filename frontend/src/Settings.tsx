import { useMemo, useState } from "react";
import { SearchIcon } from "./ui/icons.js";
import { SettingsShell } from "./settings/SettingsShell.js";
import {
  SECTIONS,
  filterSettingsSections,
  phoneSections,
  resolveSettingsSection,
  type SettingsSection,
  type SettingsSectionLink,
} from "./settings/settingsSections.js";
import { AppearanceSection } from "./settings/sections/AppearanceSection.js";
import { TerminalSection } from "./settings/sections/TerminalSection.js";
import { ProjectsSection } from "./settings/sections/ProjectsSection.js";
import { HostsSection } from "./settings/sections/HostsSection.js";
import { LaunchersSection } from "./settings/sections/LaunchersSection.js";
import { ModelsSection } from "./settings/sections/ModelsSection.js";
import { NotificationsSection } from "./settings/sections/NotificationsSection.js";
import { DockSection } from "./settings/sections/DockSection.js";
import { SessionsSection } from "./settings/sections/SessionsSection.js";
import { TaskMasterSection } from "./settings/sections/TaskMasterSection.js";
import { ReviewRelaySection } from "./settings/sections/ReviewRelaySection.js";
import { RunwaySection } from "./settings/sections/RunwaySection.js";
import { GitHubSection } from "./settings/sections/GitHubSection.js";
import { ServerInfoSection } from "./settings/sections/ServerInfoSection.js";
import { StorageSection } from "./settings/sections/StorageSection.js";
import { AccountSection } from "./settings/sections/AccountSection.js";
import { DevicesSection } from "./settings/sections/DevicesSection.js";
import { InputSection } from "./settings/sections/InputSection.js";
import { AgentContextSection } from "./settings/sections/AgentContextSection.js";
import { BrowserSection } from "./settings/sections/BrowserSection.js";
import { SearchInput } from "./ui/primitives.js";

export type { SettingsSection, SettingsSectionLink } from "./settings/settingsSections.js";

// The app's Settings modal. The frame (nav rail, focus trap, phone
// drill-down) is SettingsShell, shared with Project settings (#3406). No `open` prop — App.tsx only mounts this while open, so
// `initialSection` is read once via a lazy useState initializer.
export function Settings({
  onClose,
  initialSection: initialSectionLink = "appearance",
  phone = false,
  backStack = false,
}: {
  onClose: () => void;
  initialSection?: SettingsSectionLink;
  // Phone tier: back from a section's content returns to the list before it
  // closes Settings (usePhoneBackStack).
  phone?: boolean;
  // Compact tiers (phone or tablet): Android back closes Settings. Separate
  // from `phone` because the section drill-down is phone-only UI — tablet
  // keeps the side-by-side nav rail but still wants the back gesture.
  backStack?: boolean;
}) {
  const initialSection = resolveSettingsSection(initialSectionLink);
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [query, setQuery] = useState("");
  const meta = SECTIONS.find((s) => s.id === section)!;

  const visibleSections = useMemo(() => {
    const base = phone ? phoneSections() : SECTIONS;
    return filterSettingsSections(base, query);
  }, [query, phone]);

  return (
    <SettingsShell
      title="Settings"
      closeLabel="Close settings"
      listLabel="settings list"
      sections={visibleSections}
      active={meta}
      onSelect={setSection}
      onClose={onClose}
      // A deep link (e.g. the server-status pill's `openSettings("server")`)
      // starts on its content; a generic open (⌘, / the toolbar gear, both
      // defaulting to "appearance") starts on the phone's nav list. A deep
      // link that targets Appearance itself starts on the list: one extra tap.
      startOnContent={initialSection !== "appearance"}
      // The phone's tab bar stays on screen and usable under Settings.
      modal={!phone}
      phone={phone}
      backStack={backStack}
      navTop={
        <div className="settings-nav-search ui-input-wrap">
          <SearchIcon size={15} strokeWidth={1.9} />
          <SearchInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search settings…"
          />
        </div>
      }
      navEmpty={<div className="settings-nav-empty">No matching settings.</div>}
    >
      {section === "account" && <AccountSection />}
      {section === "appearance" && <AppearanceSection />}
      {section === "terminal" && <TerminalSection />}
      {section === "input" && <InputSection />}
      {section === "notifications" && <NotificationsSection />}
      {section === "sessions" && <SessionsSection />}
      {section === "launchers" && <LaunchersSection />}
      {section === "models" && <ModelsSection />}
      {section === "agent-context" && <AgentContextSection />}
      {section === "tasks" && <TaskMasterSection />}
      {section === "projects" && <ProjectsSection />}
      {section === "dock" && <DockSection />}
      {section === "browser" && <BrowserSection />}
      {section === "devices" && <DevicesSection />}
      {section === "hosts" && <HostsSection />}
      {section === "github" && <GitHubSection />}
      {section === "review-relay" && <ReviewRelaySection />}
      {section === "runway" && <RunwaySection />}
      {section === "storage" && <StorageSection />}
      {section === "server" && <ServerInfoSection />}
    </SettingsShell>
  );
}
