import type { Terminal } from "@xterm/xterm";
import type { AppSettings } from "../api/index.js";

// Extracted verbatim from TerminalPane.tsx (PR 35, Wave 6 of
// .claude/plans/can-we-do-a-warm-cocke.md) — the key-conflict handler,
// reserved-keys/match-count helpers, and clipboard-availability helpers are
// self-contained (no closures over the mount effect's local state), unlike
// the ~580-line mount effect itself, which stays in TerminalPane.tsx
// untouched (see that file's own comment on why). Nothing about the logic
// below changed — only where it lives.

// Ceiling on how many scrollback matches @xterm/addon-search decorates
// (terminal scrollback search, U1) — matches the addon's own default
// (`Constants.DEFAULT_HIGHLIGHT_LIMIT` in its source), passed explicitly
// here rather than left implicit so this same value can also gate the
// match-count display below ("1000+" instead of a bare "1000", since
// `resultCount` is the *decorated* count — `SearchResultTracker.
// updateResults` slices to this limit — not necessarily the true total).
// findNext/findPrevious themselves keep working past this limit regardless;
// it only bounds how many get a paint-time decoration.
export const SEARCH_HIGHLIGHT_LIMIT = 1000;

// Ctrl+R (readline reverse-search, extremely common) collides with page
// refresh, Ctrl+L (clear screen) and Ctrl+K (kill-line) collide with
// address-bar-focus in some browsers — Settings -> Terminal behavior's
// "Key-conflict handling" list (settings.terminal.keyCapture) makes each of
// the three independently toggleable. Browsers reserve some other combos
// (Ctrl+W/T/N — close/open tab, new window) at a level JS categorically
// cannot override; deliberately not attempted here since preventDefault()
// on those is a silent no-op anyway.
export function reservedKeysFromSettings(
  keyCapture: AppSettings["terminal"]["keyCapture"],
): Set<string> {
  const keys = new Set<string>();
  if (keyCapture.ctrlR) keys.add("r");
  if (keyCapture.ctrlL) keys.add("l");
  if (keyCapture.ctrlK) keys.add("k");
  return keys;
}

// Terminal scrollback search (U1) match-counter text. A pure function of
// the addon's own onDidChangeResults payload — no component state needed —
// so it's declared at module scope rather than inside TerminalPane.
export function formatMatchCount(matchState: { index: number; count: number } | null): string {
  if (!matchState) return "";
  if (matchState.count === 0) return "No results";
  // `resultCount` is the *decorated* count (SearchResultTracker.
  // updateResults slices to SEARCH_HIGHLIGHT_LIMIT), not necessarily the
  // true total — append "+" so a truncated count at the ceiling isn't
  // misread as exact (Hermes review, PR #578).
  const countText =
    matchState.count >= SEARCH_HIGHLIGHT_LIMIT ? `${matchState.count}+` : `${matchState.count}`;
  // resultIndex is -1 when the selected match sits beyond highlightLimit
  // (per the addon's own typings) — show just the count rather than a
  // misleading "0/N" in that edge case.
  if (matchState.index < 0) return countText;
  return `${matchState.index + 1}/${countText}`;
}

// Shared by every clipboard entry point below — e.g. absent on a plain-http
// LAN deploy (no secure context), where the Clipboard API doesn't exist at
// all rather than merely rejecting.
export function hasClipboardApi(): boolean {
  return !!navigator.clipboard;
}

export function readClipboard(): Promise<string | null> {
  if (!hasClipboardApi()) {
    console.warn("[terminal] clipboard API not available (not a secure context)");
    return Promise.resolve(null);
  }
  return navigator.clipboard.readText().catch(() => {
    console.warn("[terminal] clipboard read denied");
    return null;
  });
}

export function attachKeyConflictHandler(opts: {
  term: Terminal;
  reservedKeys: Set<string>;
  onPaste?: () => void;
  // Returns whether the copy actually landed (used by the opt-in Ctrl+C
  // branch below to decide whether it's safe to clear the selection); the
  // other two callers (Ctrl+Insert, dock capture) ignore the return value.
  onCopy?: () => Promise<boolean> | void;
  captureCtrlC?: boolean;
  // Opt-in clipboard chords (settings.terminal.clipboardKeys — issue #67
  // follow-up). A live getter, not a captured value: this handler is
  // (re-)attached from three different effects (mount, captureCtrlC sync,
  // settings sync), and a getter means whichever attach happens to be
  // "latest" always reads the current setting instead of whatever was true
  // at attach time.
  getClipboardKeys: () => AppSettings["terminal"]["clipboardKeys"];
  // Opens (and focuses) the scrollback find bar on Ctrl+Shift+F — see the
  // handler branch below for why that chord and not bare Ctrl+F.
  onToggleFind?: () => void;
}): void {
  const { term, reservedKeys, onPaste, onCopy, captureCtrlC, getClipboardKeys, onToggleFind } =
    opts;
  term.attachCustomKeyEventHandler((event) => {
    if (event.type === "keydown") {
      const key = event.key.toLowerCase();
      // Paste: Cmd+V (macOS) or Shift+Insert (Linux/Windows) always work —
      // neither collides with anything, so there's no reason to gate them.
      // Plain Ctrl+V is opt-in only (settings.terminal.clipboardKeys.ctrlV,
      // default off): it's vim's Visual Block mode and readline's
      // quoted-insert (both bound to raw 0x16), so claiming it
      // unconditionally would silently break both for every user. Shift+
      // Insert is the classic X11/Linux terminal convention (xterm, PuTTY,
      // ...) chosen specifically because it collides with nothing.
      // Ctrl+Shift+V, the more "modern" alternative, was rejected: it's
      // Chrome/Firefox's own "paste as plain text" combo in some contexts.
      // Cmd+V doesn't collide with anything on macOS since vim/readline
      // bind the *Ctrl* form, not Cmd.
      const isPasteChord =
        (event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && key === "v") ||
        (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && key === "insert") ||
        (getClipboardKeys().ctrlV &&
          event.ctrlKey &&
          !event.shiftKey &&
          !event.metaKey &&
          !event.altKey &&
          key === "v");
      if (isPasteChord) {
        event.preventDefault();
        onPaste?.();
        return false;
      }
      // Terminal scrollback search (U1) — deliberately NOT bare Ctrl+F: that
      // chord is the browser's own "Find in page," reserved at the browser-
      // chrome level the same way Ctrl+W/T/N are above (preventDefault() on
      // it is a silent no-op), so claiming it here would just fail invisibly
      // while also shadowing the shortcut a user reasonably expects still
      // finds text *outside* this terminal (other panes, page chrome).
      // Ctrl+Shift+F sidesteps that collision and isn't reserved by any
      // major browser at the page level (Chrome/Firefox DevTools bind it,
      // but only while DevTools itself has focus — this app's page never
      // does). Always active, unlike Ctrl+R/L/K above: no shell or TUI binds
      // Ctrl+Shift+F, so there's no existing terminal-program convention for
      // it to shadow, and thus no need to gate it behind a
      // settings.terminal.keyCapture toggle.
      if (event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey && key === "f") {
        event.preventDefault();
        onToggleFind?.();
        return false;
      }
      // Copy: Ctrl+Insert (Linux/Windows) always works, the Shift+Insert
      // paste convention's copy counterpart. Ctrl+Shift+C (the more
      // "modern" alternative) was rejected: it's Chrome/Firefox's native
      // "Inspect Element" DevTools shortcut, handled by the browser chrome
      // above the page — preventDefault() in page JS can't reliably stop
      // it, the same class of un-overridable combo as Ctrl+W/T/N above.
      // Cmd+C (macOS) needs no handling here: meta-only chords are never
      // translated to PTY control bytes by xterm, so it already only
      // triggers the browser's native copy.
      if (event.ctrlKey && !event.shiftKey && !event.metaKey && !event.altKey && key === "insert") {
        event.preventDefault();
        onCopy?.();
        return false;
      }
      // Plain Ctrl+C: SIGINT by default (xterm forwards the raw ETX byte
      // regardless of selection). Two ways this branch instead swallows it:
      if (event.ctrlKey && !event.shiftKey && !event.metaKey && !event.altKey && key === "c") {
        // Dock monitors — where SIGINT would kill the monitored process
        // (issue #332). Unconditional: dock sessions pass captureCtrlC=true
        // so users can copy text without killing the dev server (the dock
        // toggle button handles stop/kill instead). onCopy already guards on
        // term.hasSelection() so no-selection is a silent no-op. This wins
        // over the opt-in setting below — a dock monitor is never a shell a
        // user expects to interrupt via Ctrl+C.
        if (captureCtrlC) {
          event.preventDefault();
          onCopy?.();
          return false;
        }
        // Opt-in selection-aware copy (settings.terminal.clipboardKeys.ctrlC,
        // default off — Windows Terminal / VS Code convention). hasSelection()
        // is false for a collapsed/zero-width selection, so a stray click
        // can't eat an interrupt. If there's no Clipboard API at all (e.g. a
        // plain-http LAN deploy — no secure context), there's nothing to copy
        // to, so don't swallow the chord at all: fall through and let it
        // reach the shell as SIGINT like normal, rather than silently eating
        // a keypress that accomplishes nothing.
        if (getClipboardKeys().ctrlC && term.hasSelection() && hasClipboardApi()) {
          event.preventDefault();
          // The write itself is still async and can fail after we've already
          // committed to swallowing this keypress (permission denied, etc.) —
          // clearSelection() only runs if it actually landed. Clearing
          // unconditionally would wipe the selection with nothing copied and
          // no way to retry; clears the selection so a *second* Ctrl+C reaches
          // the shell as SIGINT instead of copying (or re-copying) it again.
          // clearSelection() fires onSelectionChange, whose own "copy on
          // select" listener already no-ops on an empty selection, so this
          // can't double-fire the copy that was just made.
          const copyResult = onCopy?.();
          if (copyResult) {
            void copyResult.then((copied) => {
              if (copied) term.clearSelection();
            });
          }
          return false;
        }
      }
      // Browser-reserved combos the user opted into this app
      if (event.ctrlKey && !event.altKey && !event.metaKey && reservedKeys.has(key)) {
        event.preventDefault();
      }
    }
    return true;
  });
}
