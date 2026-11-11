import { useEffect } from "react";
import { useDashboardStore } from "../store/index.js";

// Extracted from App.tsx (issue #2407) — the second of the two mount-once
// settings effects (see useHydrateSettings). Starts watching the OS
// color-scheme preference while Theme is "System". Called immediately
// after useHydrateSettings, where this effect was. Body and dependency
// array are unchanged.

export function useThemeWatch(): void {
  useEffect(() => useDashboardStore.getState().startThemeWatch(), []);
}
