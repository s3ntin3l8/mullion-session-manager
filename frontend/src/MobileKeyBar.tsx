import { ChevronDownIcon } from "./icons.js";
import { getTerminalInputHandle } from "./terminalInputRegistry.js";
import type { TerminalInputHandle } from "./terminalInputRegistry.js";

// Mobile UI/UX overhaul, item C.2/C.3 (see .claude/plans/we-need-to-work-
// iterative-planet.md) — a phone's on-screen keyboard has no Esc, Tab, or
// Ctrl key, so there is no way to reach the mode switcher a TUI like Claude
// Code binds to Shift+Tab (or send a bare Esc/Tab/Ctrl+C) from a soft
// keyboard at all. A single fixed 44px row, not a configurable/extensible
// one — the plan deliberately scoped this to the everyday chords rather than
// a fuller key-remapping surface.
//
// Rendered by App.tsx only when the active mobile pane is a terminal
// session; `sessionId` is that session's id, used to look up its live
// TerminalPane instance via terminalInputRegistry.ts (nothing else can reach
// a session's `Terminal`/WebSocket from outside TerminalPane.tsx itself).
export interface MobileKeyBarProps {
  sessionId: number;
}

interface KeyBarButton {
  label: string;
  ariaLabel: string;
  // A fixed sequence (Esc/Tab/Shift+Tab/`/`) sent via sendInput; an arrow
  // direction resolved through sendArrow (DECCKM makes the actual bytes
  // context-dependent — see terminalInputRegistry.ts's own comment); or
  // Ctrl+C through its own sendCtrlC, which — unlike sendInput — has to
  // replicate TerminalPane's own key-conflict handling (dock-monitor
  // copy-not-kill, opt-in selection-aware copy) rather than just forwarding
  // a raw byte, since `term.input()` bypasses that handler entirely.
  send: (handle: TerminalInputHandle) => void;
}

const KEYS: KeyBarButton[] = [
  { label: "Esc", ariaLabel: "Escape", send: (h) => h.sendInput("\x1b") },
  { label: "Tab", ariaLabel: "Tab", send: (h) => h.sendInput("\t") },
  { label: "⇧Tab", ariaLabel: "Shift+Tab", send: (h) => h.sendInput("\x1b[Z") },
  { label: "^C", ariaLabel: "Ctrl+C", send: (h) => h.sendCtrlC() },
  { label: "↑", ariaLabel: "Arrow up", send: (h) => h.sendArrow("up") },
  { label: "↓", ariaLabel: "Arrow down", send: (h) => h.sendArrow("down") },
  { label: "/", ariaLabel: "Slash", send: (h) => h.sendInput("/") },
];

export function MobileKeyBar({ sessionId }: MobileKeyBarProps) {
  return (
    <div className="mobile-key-bar" role="toolbar" aria-label="Terminal keys">
      {KEYS.map(({ label, ariaLabel, send }) => (
        <button
          key={ariaLabel}
          type="button"
          className="mobile-key-bar-btn"
          aria-label={ariaLabel}
          // preventDefault on pointerdown, not just onClick, is the whole
          // point of this button: a plain click's own default mousedown
          // behavior shifts focus to the button itself first, which blurs
          // the terminal's hidden input and dismisses the on-screen
          // keyboard before the click (and this send) even fires. Blocking
          // that default here is what keeps the keyboard up between taps —
          // the whole reason this bar can sit right above it. (Independent
          // code review, PR #616 — corrected: it isn't term.input()'s own
          // `wasUserInput` default doing any (re)focusing here, verified
          // against the installed @xterm/xterm source; that flag only
          // affects scroll-to-bottom and clearing an active selection.
          // preventDefault() on this pointerdown, alone, is the entire
          // mechanism.)
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => {
            const handle = getTerminalInputHandle(sessionId);
            if (handle) send(handle);
          }}
        >
          {label === "↑" ? (
            <ChevronDownIcon size={15} style={{ transform: "rotate(180deg)" }} />
          ) : label === "↓" ? (
            <ChevronDownIcon size={15} />
          ) : (
            label
          )}
        </button>
      ))}
    </div>
  );
}
