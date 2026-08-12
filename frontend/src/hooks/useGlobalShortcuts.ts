import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import { handleGlobalEscape } from "../panelUtils.js";
import { useDashboardStore } from "../store/index.js";

// Structurally identical to App.tsx's own (unexported) `PaletteState` —
// deliberately re-declared here rather than imported from App.tsx: this
// hook is a leaf module under `hooks/`, and every other hook in this
// directory only ever imports types from `api/`, `store/`, or third-party
// packages, never back from App.tsx itself (which would make App.tsx and
// this hook mutually dependent, if only at the type level). TypeScript's
// structural typing means App.tsx's real `Dispatch<SetStateAction<PaletteState>>`
// setter satisfies this parameter type with no cast needed at the call site.
interface GlobalShortcutsPaletteState {
  open: boolean;
  scope: "global" | "project";
  projectId: number | null;
}

export interface UseGlobalShortcutsParams {
  // Must be the raw `useState` setter (stable identity forever) — same
  // requirement as `useWorkspacePersistence`'s `setPanelsVersion` and
  // `useMobileLayout`'s `setIsMobile` (see those hooks' own param comments).
  // Listed in this hook's own effect dependency array below purely to
  // satisfy eslint's exhaustive-deps rule (see that array's own comment) —
  // its stable identity means that listing never causes an actual
  // re-subscription.
  setPalette: Dispatch<SetStateAction<GlobalShortcutsPaletteState>>;
  // Same "raw `useState` setter" requirement as `setPalette` above — used
  // only inside the Escape branch's `handleGlobalEscape` call, to close the
  // Settings modal.
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  // Must be referentially stable across renders (App.tsx defines it via
  // `useCallback` with an empty dependency array) — same reasoning as
  // `setPalette`/`setSettingsOpen` above.
  openSettings: () => void;
}

// Extracted from App.tsx (PR 34d of the hook-extraction series) — the single
// effect registering app-wide keyboard shortcuts: ⌘K/Ctrl+K opens the
// command-palette launcher, ⌘,/Ctrl+, opens Settings, and Escape closes
// whichever overlay (palette, Settings, or a pending split request) is open.
// A single `window`-level `keydown` listener, independent of DOM focus — see
// handleGlobalEscape's (panelUtils.ts) own doc comment for why Escape in
// particular has to be handled here rather than by each overlay's own local
// handler.
//
// Ordering/coupling analysis: this is the ONLY `keydown`/`keyup` listener in
// App.tsx (confirmed via a full-file grep before this extraction — every
// other `addEventListener` call in App.tsx is either dockview's own API, a
// `matchMedia` "change" subscription, or the push service-worker's
// "message" listener, none of which are keyboard-related). Its effect reads
// no shared ref and no piece of state also written by another effect in
// this file: `setPalette`/`openSettings`/`clearSplitRequest` are setters/
// stable callbacks passed in, not values this effect derives from anything
// else's output, and nothing else in App.tsx depends on THIS effect having
// already run (unlike `useWorkspacePersistence`/`useMobileLayout`, whose
// call-site position is load-bearing for `restoringRef`/`isMobile`). Every
// entry in its dependency array (`openSettings`, `setPalette`,
// `setSettingsOpen`) has a stable identity that never changes across
// renders, so this effect mounts its `window` listener exactly once and
// never re-subscribes. App.tsx therefore calls this hook at the exact
// position this effect previously occupied purely to keep the diff minimal
// and the file's effect ordering easy to audit — not because doing so is
// required for correct behavior (same conclusion, and same reasoning shape,
// as `useDockviewDrop` reached for its own three effects in PR 34c).
//
// No input/textarea-focus guard exists here (unlike a per-terminal keydown
// handler might need) — confirmed absent in the pre-extraction code, and
// preserved as absent here: this is a pure code-motion PR, not a behavior
// change. ⌘K/⌘,/Escape are deliberately meant to fire regardless of what
// currently has DOM focus (e.g. Escape must close Settings even while focus
// sits inside one of its form fields).
export function useGlobalShortcuts({
  setPalette,
  setSettingsOpen,
  openSettings,
}: UseGlobalShortcutsParams): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => ({ ...p, open: true, scope: "global" }));
      } else if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        openSettings();
      } else if (e.key === "Escape") {
        // U9 — see handleGlobalEscape's own doc comment for why
        // clearSplitRequest belongs here: the palette also renders for a
        // pending split-right/split-down splitRequest (App.tsx's own
        // `palette.open || (splitRequest !== null && ...)` computation),
        // and the palette's OWN Escape handler only fires while focus is
        // actually inside its search input — moving focus to the
        // project picker, a launcher row, the worktree checkbox, or the
        // base-ref dropdown (all still inside the palette) leaves this
        // global, window-level handler as the only one that still sees the
        // keypress.
        handleGlobalEscape({
          clearPalette: () => setPalette((p) => ({ ...p, open: false })),
          closeSettings: () => setSettingsOpen(false),
          clearSplitRequest: () => useDashboardStore.getState().clearSplitRequest(),
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // setPalette/setSettingsOpen are raw `useState` setters (stable identity
    // forever per their own param comments above) — listed here, alongside
    // openSettings, purely to satisfy eslint's exhaustive-deps rule, which
    // (unlike for a `useState` destructured directly in the SAME component)
    // can no longer statically prove a plain hook parameter's identity is
    // stable. Same "list it for the linter, not because it changes
    // anything" pattern as `useMobileLayout`'s `[dockviewApi, setIsMobile]`
    // and `useWorkspacePersistence`'s equivalent params.
  }, [openSettings, setPalette, setSettingsOpen]);
}
