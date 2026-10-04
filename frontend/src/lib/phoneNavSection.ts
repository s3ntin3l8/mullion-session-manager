import type { PhoneNavTab } from "../PhoneNavigator.js";

// The Sidebar only has Projects/Devices sections; Tasks and Settings replace
// its body entirely, so they pass no section.
export function sidebarPhoneSection(tab: PhoneNavTab): "projects" | "devices" | undefined {
  return tab === "projects" || tab === "devices" ? tab : undefined;
}
