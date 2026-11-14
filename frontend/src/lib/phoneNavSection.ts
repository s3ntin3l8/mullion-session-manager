import type { PhoneNavTab } from "../PhoneNavigator.js";

// The Sidebar's one section is its project tree; Tasks and Settings replace
// its body entirely, so they pass no section.
export function sidebarPhoneSection(tab: PhoneNavTab): "projects" | undefined {
  return tab === "projects" ? tab : undefined;
}
