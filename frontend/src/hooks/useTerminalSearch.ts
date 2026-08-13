import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { SearchAddon } from "@xterm/addon-search";
import { buildSearchDecorations } from "../terminalTheme.js";
import type { Theme } from "../store/index.js";

// Terminal scrollback search (U1) — find-bar open/query/match state and the
// addon plumbing that drives it. Extracted verbatim from TerminalPane.tsx
// (PR 35, Wave 6 of .claude/plans/can-we-do-a-warm-cocke.md): this state and
// its two effects are genuinely independent of the ~580-line mount effect
// (which stays in TerminalPane.tsx untouched — see that file's own comment),
// EXCEPT for `searchAddonRef` itself, which the mount effect still populates
// (`searchAddonRef.current = searchAddon`) the instant it constructs the
// SearchAddon, and still disposes on unmount — this hook only owns the ref's
// *declaration*, not the addon's lifecycle, which is tied to the terminal
// instance the mount effect owns. `termRef` is the same story: owned and
// populated by the mount effect, passed in here only so the close-transition
// effect can hand focus back to the terminal. Nothing about the search logic
// itself changed — only where it lives.
export interface UseTerminalSearchResult {
  findOpen: boolean;
  setFindOpen: (open: boolean) => void;
  findQuery: string;
  setFindQuery: (query: string) => void;
  matchState: { index: number; count: number } | null;
  // Exposed (not just internal) because TerminalPane's mount effect still
  // owns the SearchAddon's `onDidChangeResults` subscription — that's the
  // addon's only way to report match count/position, and the subscription
  // lives inside the untouched mount effect (see this file's own header
  // comment) alongside the addon's own construction/disposal, so it needs a
  // way to push updates back into this hook's state directly.
  setMatchState: (state: { index: number; count: number } | null) => void;
  findInputRef: RefObject<HTMLInputElement | null>;
  // Populated by TerminalPane's mount effect once the addon exists (see this
  // hook's own header comment) — the render's find-bar buttons reach in
  // through this ref rather than closing over the mount effect's own local.
  searchAddonRef: RefObject<SearchAddon | null>;
  // Exposes `findOpen`'s current value to TerminalPane's pane-activation
  // focus effect (U7) without that effect depending on `findOpen` itself —
  // it must fire ONLY on `props.active`'s own false->true transition, not
  // additionally re-fire every time the find bar opens/closes while a pane
  // stays active. See that effect's own comment in TerminalPane.tsx.
  findOpenRef: RefObject<boolean>;
  // Opens (or refocuses) the find bar — wired to Ctrl+Shift+F via
  // attachKeyConflictHandler's onToggleFind in TerminalPane.tsx.
  openFind: () => void;
  runSearch: (direction: "next" | "previous") => void;
}

export function useTerminalSearch(params: {
  colorScheme: string;
  theme: Theme;
  // Owned by TerminalPane's mount effect (see header comment above) — only
  // read here (never mutated) to hand focus back to the terminal when the
  // find bar closes.
  termRef: RefObject<Terminal | null>;
}): UseTerminalSearchResult {
  const { colorScheme, theme, termRef } = params;

  // `matchState` is null rather than {index:-1,count:0} whenever there's no
  // active search (bar closed, or query cleared) so the counter can tell
  // "haven't searched yet" apart from "searched and found nothing" in the
  // render below.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [matchState, setMatchState] = useState<{ index: number; count: number } | null>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  // Tracks the previous findOpen value so the findOpen-transition effect
  // below can tell "just closed" (clear decorations, hand focus back to the
  // terminal) apart from "still closed, first mount" — this component is
  // otherwise deliberately free of unconditional `.focus()` calls (a pane
  // never auto-steals focus just by mounting/rendering), and an unguarded
  // `term.focus()` here would quietly break that.
  const prevFindOpenRef = useRef(false);
  const findOpenRef = useRef(findOpen);

  // Opens the find bar on Ctrl+Shift+F — and also handles the "already
  // open" case (Hermes review, PR #578): `setFindOpen(true)` alone is a
  // no-op when findOpen is already true (same value, React bails without a
  // re-render), so the findOpen-transition effect below — which is what
  // normally focuses the input — never re-fires, leaving a second
  // Ctrl+Shift+F while the *terminal* has focus (bar open, input not
  // focused) a dead keypress. Calling focus()/select() directly here covers
  // both cases without extra state: on a fresh open, findInputRef.current
  // is still null (the bar hasn't rendered yet), so this is a harmless
  // no-op and the transition effect does the real focus once it mounts; on
  // a repeat press with the bar already open, the ref is already populated,
  // so this refocuses/reselects immediately — Ctrl+Shift+F now behaves like
  // "open or refocus" rather than only ever opening.
  function openFind(): void {
    setFindOpen(true);
    findInputRef.current?.focus();
    findInputRef.current?.select();
  }

  // A plain function (not ref-wired) — this one only needs values that are
  // already fresh every render (findQuery, colorScheme, theme, the addon
  // ref), unlike TerminalPane's retryRef/refitRef, which have to reach into
  // a mount-effect closure that only runs once.
  function runSearch(direction: "next" | "previous"): void {
    const addon = searchAddonRef.current;
    if (!addon || !findQuery) return;
    const options = { decorations: buildSearchDecorations(colorScheme, theme) };
    if (direction === "next") addon.findNext(findQuery, options);
    else addon.findPrevious(findQuery, options);
  }

  // Live-updates highlights as the query changes, the way every other find
  // bar (browser Ctrl+F included) behaves — without this, typing would do
  // nothing until Enter/Next was pressed, which reads as broken rather than
  // just less convenient. `incremental: true` only affects findNext (per the
  // addon's own docs) — it expands/refines the current match as the query
  // grows instead of jumping to a new one on every keystroke, so backspacing
  // a character doesn't lose your place in the scrollback. Also re-runs on a
  // color-scheme/theme change so an open find bar's highlight colors stay
  // correct if the user switches schemes or toggles dark/light mid-search,
  // and clears out cleanly when the query is emptied rather than leaving
  // stale decorations/count on screen.
  useEffect(() => {
    if (!findOpen) return;
    const addon = searchAddonRef.current;
    if (!addon) return;
    if (!findQuery) {
      addon.clearDecorations();
      // clearDecorations() only clears the addon's own internal result
      // array — per its source (SearchResultTracker.clearResults()), it
      // never fires onDidChangeResults, so nothing else will reset the
      // match counter for an emptied query. Direct setState is genuinely
      // needed here, not just convenient (this repo's react-hooks/
      // set-state-in-effect rule rejects it as a cascading-render risk).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMatchState(null);
      return;
    }
    addon.findNext(findQuery, {
      incremental: true,
      decorations: buildSearchDecorations(colorScheme, theme),
    });
  }, [findQuery, findOpen, colorScheme, theme]);

  // Focuses the find input the moment the bar opens (Ctrl+Shift+F, handled
  // inside attachKeyConflictHandler, fires while the *terminal* has focus,
  // not this input, so it needs an explicit focus() here). On the reverse
  // transition — bar was open, now closed — clears the addon's decorations/
  // selection and hands focus back to the terminal so typing resumes
  // immediately instead of landing on whatever the browser defaults to once
  // the input unmounts. Gated on `prevFindOpenRef` so this never fires on a
  // plain mount (findOpen starts false, prevFindOpenRef starts false too) —
  // this component is deliberately free of unconditional `.focus()` calls
  // elsewhere, and a mount-time `term.focus()` here would quietly
  // reintroduce one.
  useEffect(() => {
    if (findOpen) {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    } else if (prevFindOpenRef.current) {
      searchAddonRef.current?.clearDecorations();
      setMatchState(null);
      termRef.current?.focus();
    }
    prevFindOpenRef.current = findOpen;
    findOpenRef.current = findOpen;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen]);

  return {
    findOpen,
    setFindOpen,
    findQuery,
    setFindQuery,
    matchState,
    setMatchState,
    findInputRef,
    searchAddonRef,
    findOpenRef,
    openFind,
    runSearch,
  };
}
