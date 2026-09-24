import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ChevronDownIcon, OverflowIcon } from "./ui/icons.js";
import { getTerminalInputHandle, useTerminalInputHandle } from "./terminalInputRegistry.js";
import type { CtrlModifierMode, TerminalInputHandle } from "./terminalInputRegistry.js";
import { nextCtrlMode } from "./lib/ctrlModifier.js";
import { useVoiceControls } from "./lib/terminalVoiceRegistry.js";
import { VoiceMicButton } from "./terminal-pane/VoiceMicButton.js";
import { readBool, STORAGE_KEYS, writeBool } from "./lib/persistedState.js";

// Mobile UI/UX overhaul, item C.2/C.3 — a phone's on-screen keyboard has no
// Esc, Tab, Ctrl or arrow keys, so there'd be no way to reach the mode
// switcher a TUI like Claude Code binds to Shift+Tab (or send a bare
// Esc/Tab/Ctrl+C) from a soft keyboard at all.
//
// Layout (mobile UI overhaul, phase 3): fixed rows of equal-width keys that
// always fit the screen — never a horizontally scrolling strip whose tail
// keys end up off-screen. Row 1 holds the everyday keys plus the dictation
// mic and a ⋯ toggle; ⋯ reveals row 2 with the rest (remembered per device).
//
// Rendered by App.tsx only when the active mobile pane is a terminal
// session; `sessionId` is that session's id, used to look up its live
// TerminalPane instance via terminalInputRegistry.ts (nothing else can reach
// a session's `Terminal`/WebSocket from outside TerminalPane.tsx itself).
export interface MobileKeyBarProps {
  sessionId: number;
}

interface KeyBarKey {
  label: ReactNode;
  ariaLabel: string;
  // A fixed sequence (Esc/Tab/Shift+Tab/newline) sent via sendInput; an arrow
  // direction resolved through sendArrow (DECCKM makes the actual bytes
  // context-dependent — see terminalInputRegistry.ts's own comment); or
  // Ctrl+C through its own sendCtrlC, which — unlike sendInput — has to
  // replicate TerminalPane's own key-conflict handling (dock-monitor
  // copy-not-kill, opt-in selection-aware copy) rather than just forwarding
  // a raw byte, since `term.input()` bypasses that handler entirely.
  send: (handle: TerminalInputHandle) => void;
}

const up = <ChevronDownIcon size={15} style={{ transform: "rotate(180deg)" }} />;
const down = <ChevronDownIcon size={15} />;
const left = <ChevronDownIcon size={15} style={{ transform: "rotate(90deg)" }} />;
const right = <ChevronDownIcon size={15} style={{ transform: "rotate(-90deg)" }} />;

// "\x1b\r" (ESC+CR) is deliberately not "\n": it's the exact byte sequence
// Claude Code's own `/terminal-setup` binds to Shift+Enter (VS Code's
// `workbench.action.terminal.sendSequence` with args.text: "\x1B\r") to mean
// "newline, don't submit" — verified against the installed `claude` binary.
// A soft keyboard has no Shift, so this button exists to reach that same
// meaning. Enter itself stays untouched (still submits) everywhere else —
// remapping Enter would break bash, git commit, y/n prompts, and TUI menus,
// which all need it to keep meaning "\r".
const ROW1_BEFORE_CTRL: KeyBarKey[] = [
  { label: "Esc", ariaLabel: "Escape", send: (h) => h.sendInput("\x1b") },
  { label: "Tab", ariaLabel: "Tab", send: (h) => h.sendInput("\t") },
  { label: "⇧Tab", ariaLabel: "Shift+Tab", send: (h) => h.sendInput("\x1b[Z") },
];
const ROW1_AFTER_CTRL: KeyBarKey[] = [
  { label: up, ariaLabel: "Arrow up", send: (h) => h.sendArrow("up") },
  { label: down, ariaLabel: "Arrow down", send: (h) => h.sendArrow("down") },
];
const ROW2: KeyBarKey[] = [
  { label: "^C", ariaLabel: "Ctrl+C", send: (h) => h.sendCtrlC() },
  { label: left, ariaLabel: "Arrow left", send: (h) => h.sendArrow("left") },
  { label: right, ariaLabel: "Arrow right", send: (h) => h.sendArrow("right") },
  { label: "↵+", ariaLabel: "Newline (no submit)", send: (h) => h.sendInput("\x1b\r") },
  { label: "Paste", ariaLabel: "Paste", send: (h) => h.paste() },
  { label: "Copy", ariaLabel: "Copy text", send: (h) => h.openCopyMode() },
];

// preventDefault on pointerdown, not just onClick, is what keeps the
// on-screen keyboard up WHILE it's already showing: a plain click's own
// default mousedown behavior shifts focus to the button itself first, which
// would blur the terminal's hidden input and dismiss the keyboard before the
// click (and this send) even fires. It only ever *preserves* focus the
// terminal already had, though — if the keyboard was already dismissed (or
// focus was elsewhere) before the tap, TerminalPane.tsx's own registered
// handle explicitly (re)focuses the terminal itself (Hermes review, PR #616
// round 2), so a tap's effect is never silently invisible.
const keepFocus = (e: { preventDefault: () => void }) => e.preventDefault();

export function MobileKeyBar({ sessionId }: MobileKeyBarProps) {
  const [moreOpen, setMoreOpen] = useState(() => readBool(STORAGE_KEYS.mobileKeyBarMore, false));
  const [ctrlMode, setCtrlMode] = useState<CtrlModifierMode>("off");
  const voice = useVoiceControls(sessionId);

  // Push the sticky-Ctrl state to the terminal; a one-shot modifier reports
  // back through onConsumed once the next key has used it. Keyed on the live
  // handle, so a remounted TerminalPane gets the current state re-applied;
  // switching session (or unmounting) disarms it on the terminal it was
  // armed on.
  const inputHandle = useTerminalInputHandle(sessionId);
  useEffect(() => {
    inputHandle?.setCtrlModifier(ctrlMode, () => setCtrlMode("off"));
    return () => inputHandle?.setCtrlModifier("off", () => {});
  }, [inputHandle, ctrlMode]);

  // A different session never inherits an armed Ctrl.
  const [prevSessionId, setPrevSessionId] = useState(sessionId);
  if (prevSessionId !== sessionId) {
    setPrevSessionId(sessionId);
    setCtrlMode("off");
  }

  const toggleMore = () => {
    const next = !moreOpen;
    setMoreOpen(next);
    writeBool(STORAGE_KEYS.mobileKeyBarMore, next);
  };

  const renderKey = ({ label, ariaLabel, send }: KeyBarKey) => (
    <button
      key={ariaLabel}
      type="button"
      className="mobile-key-bar-btn"
      aria-label={ariaLabel}
      onPointerDown={keepFocus}
      onClick={() => {
        const handle = getTerminalInputHandle(sessionId);
        if (handle) send(handle);
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="mobile-key-bar" role="toolbar" aria-label="Terminal keys">
      <div className="mobile-key-bar-row">
        {ROW1_BEFORE_CTRL.map(renderKey)}
        <button
          type="button"
          className={`mobile-key-bar-btn mobile-key-bar-ctrl${ctrlMode !== "off" ? ` ${ctrlMode}` : ""}`}
          aria-label={
            ctrlMode === "locked"
              ? "Ctrl (locked)"
              : ctrlMode === "once"
                ? "Ctrl (next key)"
                : "Ctrl"
          }
          aria-pressed={ctrlMode !== "off"}
          title="Ctrl for the next key; tap again to lock, again to release"
          onPointerDown={keepFocus}
          onClick={() => setCtrlMode(nextCtrlMode)}
        >
          Ctrl
        </button>
        {ROW1_AFTER_CTRL.map(renderKey)}
        {voice && (
          <VoiceMicButton
            variant="keyBar"
            phase={voice.phase}
            interimText={voice.interimText}
            disabled={voice.disabled}
            onPress={voice.press}
            onRelease={voice.release}
            onCancel={voice.cancel}
          />
        )}
        <button
          type="button"
          className={`mobile-key-bar-btn${moreOpen ? " active" : ""}`}
          aria-label={moreOpen ? "Fewer keys" : "More keys"}
          aria-expanded={moreOpen}
          onPointerDown={keepFocus}
          onClick={toggleMore}
        >
          <OverflowIcon size={15} />
        </button>
      </div>
      {moreOpen && <div className="mobile-key-bar-row">{ROW2.map(renderKey)}</div>}
    </div>
  );
}
