import { useEffect } from "react";
import { useDashboardStore } from "../store/index.js";

// Extracted from App.tsx (issue #2407). The hook is called at the effect's
// original position so its order among App's other effects is unchanged.
// The effect body, dependency array, and any eslint-disable inside it are
// the original text.
// The theme-watch effect that this comment also describes is useThemeWatch,
// called immediately after this hook.

export function useHydrateSettings(): void {
  // Fetches the server-persisted Settings blob once on mount (store.ts seeds
  // sane defaults synchronously so nothing blocks on this) and starts
  // watching the OS color-scheme preference for as long as the user's Theme
  // setting is "System".
  useEffect(() => void useDashboardStore.getState().hydrateSettings(), []);
}
