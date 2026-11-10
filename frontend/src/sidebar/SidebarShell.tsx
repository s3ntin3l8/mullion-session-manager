import type { SidebarProps } from "../Sidebar.js";
import { Sidebar } from "../Sidebar.js";

// Extracted from App.tsx (issue #2407) — the `<Sidebar>` element the shell
// used to build inline (`const sidebar = <Sidebar .../>`). The issue's
// 500-line sidebar range (around the old 1602-2103) is stale; this is that
// element and nothing else. Props and expressions stay at the call site.
// Spread rather than naming each field: SidebarShell's props ARE Sidebar's
// props, so a future optional Sidebar prop the call site passes is forwarded
// instead of being dropped while typecheck stays green.
export function SidebarShell(props: SidebarProps) {
  return <Sidebar {...props} />;
}
