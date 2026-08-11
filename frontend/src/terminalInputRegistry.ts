// Split out of TerminalPane.tsx for the same reason terminalRepaintRegistry.ts
// is (see that file's own header comment) — a plain module-level registry
// keyed by sessionId, so react-refresh/only-export-components doesn't apply
// (that rule only governs component files).
//
// Mobile UI/UX overhaul, item C.1 — the mobile key bar (MobileKeyBar.tsx)
// needs to inject a fixed key sequence (Esc/Tab/Shift+Tab/Ctrl+C/`/`) into
// whichever session is the currently active terminal pane, but nothing
// outside TerminalPane.tsx can otherwise reach a session's `Terminal`
// instance or its WebSocket — both are component-private refs. Registering
// a small per-session handle here, the same way terminalRepaintRegistry.ts
// already does for its own cross-terminal repaint dispatch, avoids adding a
// new prop-drilling path or a store slice for something that's pure
// DOM/xterm plumbing, not app state.
//
// Arrow keys need DECCKM awareness (`\x1b[A` normal vs `\x1bOA` application
// cursor-keys mode — TUIs like Claude Code toggle this), which only
// TerminalPane's own mount effect can resolve correctly (it's the one place
// with a live reference to `term.modes`) — so `sendArrow` takes a direction,
// not a raw sequence, and the registered closure decides the actual bytes.
// `sendInput` is a raw passthrough for the bar's other, unambiguous keys.
export interface TerminalInputHandle {
  sendInput: (data: string) => void;
  sendArrow: (direction: "up" | "down") => void;
}

const terminalInputRegistry = new Map<number, TerminalInputHandle>();

export function registerTerminalInput(sessionId: number, handle: TerminalInputHandle): void {
  terminalInputRegistry.set(sessionId, handle);
}

export function unregisterTerminalInput(sessionId: number): void {
  terminalInputRegistry.delete(sessionId);
}

export function getTerminalInputHandle(sessionId: number): TerminalInputHandle | undefined {
  return terminalInputRegistry.get(sessionId);
}
