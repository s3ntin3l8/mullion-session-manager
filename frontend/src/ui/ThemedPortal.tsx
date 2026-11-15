import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDashboardStore } from "../store/index.js";
import { themeClassName } from "../store/theme.js";

// Renders a modal opened from inside another surface (the rail, a sheet, the
// launcher) at <body>, so no ancestor's transform, clipping or stacking
// context confines its fixed backdrop (#3048). Portaling leaves `.cmux-root`,
// where every theme custom property is defined, so the wrapper reapplies it
// (as KebabMenu's and BottomSheet's portals do); `display: contents` keeps the
// wrapper out of layout.
//
// React still bubbles events through a portal to the component tree it came
// from. Key presses stop here, so an Escape or a Tab meant for this modal does
// not also reach an enclosing dialog's own handlers.
export function ThemedPortal({ children }: { children: ReactNode }) {
  const theme = useDashboardStore((s) => s.theme);
  return createPortal(
    <div
      className={themeClassName(theme)}
      // Text colour comes from `.app` in the tree it left.
      style={{ display: "contents", color: "var(--fg)" }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
