import { createContext } from "react";

// A pushed detail view (a PR, an issue, a branch) renders its own header here:
// the right-sidebar drawer's header row. While the slot has content the drawer
// swaps the picker, toolbar and strip for it (right-sidebar.css), so a detail
// never stacks a second header bar. Null outside the drawer, where DetailHeader
// renders inline.
export const SidebarDetailSlotContext = createContext<HTMLElement | null>(null);
