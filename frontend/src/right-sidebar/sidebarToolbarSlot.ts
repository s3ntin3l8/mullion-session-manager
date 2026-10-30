import { createContext } from "react";

// The element in the drawer's sub-bar (next to the project picker) that view
// toolbars render into. Null outside the drawer, where the toolbar renders
// inline.
export const SidebarToolbarSlotContext = createContext<HTMLElement | null>(null);

// Lets a view tell the drawer header which `owner/repo` it is showing, for the
// project picker's tooltip. Null outside the drawer.
export const SidebarRepoTitleContext = createContext<((title: string | null) => void) | null>(null);
