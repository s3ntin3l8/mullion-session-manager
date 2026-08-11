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
//
// Ctrl+C is its own method, not routed through `sendInput`, for the same
// reason arrows aren't a raw sequence: `term.input()` fires `onData`
// directly, bypassing TerminalPane's own `attachCustomKeyEventHandler`
// entirely (that handler intercepts the *keydown*, upstream of `onData` —
// injecting bytes through `term.input()` skips it). A raw `sendInput("\x03")`
// would silently reintroduce exactly what that handler exists to prevent: a
// captureCtrlC dock-monitor session getting a real SIGINT instead of its
// copy-not-kill behavior, or a user's selection being discarded instead of
// copied when the opt-in "Ctrl+C copies" setting is on. `sendCtrlC` mirrors
// that same decision inside TerminalPane instead (see its own comment at the
// registration call site).
//
// `sendInput` is a raw passthrough for the bar's other, genuinely
// unambiguous keys (Esc/Tab/Shift+Tab/`/`), none of which
// attachCustomKeyEventHandler intercepts at all.
export interface TerminalInputHandle {
  sendInput: (data: string) => void;
  sendArrow: (direction: "up" | "down") => void;
  sendCtrlC: () => void;
}

// Hermes review, PR #616 round 3 — a stack per sessionId, not a single
// value: Dock.tsx mounts its own `<TerminalPane params={{ sessionId:
// running.id }} captureCtrlC={true} />` for a session that's ALSO open as a
// normal dockview pane, i.e. the same sessionId can have two live
// TerminalPane mounts (and two registrations) at once. A single-value Map
// (register = unconditional overwrite, unregister = unconditional delete)
// meant whichever mounted second silently owned every key-bar tap for that
// session — including, worse, that the LATER one's unmount would delete the
// entry outright even if the OTHER instance was still alive, leaving the
// key bar a silent no-op for a session whose main pane never went away.
// Registering/unregistering push/remove-by-identity onto a small stack (the
// common case is exactly one entry, so this never actually behaves
// differently from a single value there) means an unmount only ever removes
// its OWN registration, restoring whichever one was registered before it —
// so the main pane's handle correctly reappears once a dock monitor for the
// same session closes, rather than staying wiped out.
//
// getTerminalInputHandle still resolves to whichever registration is most
// recent (the top of the stack) when more than one is live at once — e.g. a
// dock monitor open at the same time as its own session's main pane — which
// is a real, known limitation (a key-bar tap could target the dock's own
// mobile-hidden terminal instead of the visible one during that overlap).
// Left as a follow-up rather than fixed here: doing better means either
// preferring the non-dock registration specifically, or keying by
// (sessionId, pane) and having the caller resolve the visible one — a
// larger change than this fix's actual scope (stopping the silent-no-op
// case, not perfecting the disambiguation).
const terminalInputRegistry = new Map<number, TerminalInputHandle[]>();

export function registerTerminalInput(sessionId: number, handle: TerminalInputHandle): void {
  const stack = terminalInputRegistry.get(sessionId);
  if (stack) stack.push(handle);
  else terminalInputRegistry.set(sessionId, [handle]);
}

// Takes the same handle reference passed to registerTerminalInput — not
// just the sessionId — specifically so this can remove only its OWN
// registration by identity, not whichever one happens to be current.
export function unregisterTerminalInput(sessionId: number, handle: TerminalInputHandle): void {
  const stack = terminalInputRegistry.get(sessionId);
  if (!stack) return;
  const index = stack.indexOf(handle);
  if (index !== -1) stack.splice(index, 1);
  if (stack.length === 0) terminalInputRegistry.delete(sessionId);
}

export function getTerminalInputHandle(sessionId: number): TerminalInputHandle | undefined {
  const stack = terminalInputRegistry.get(sessionId);
  return stack?.[stack.length - 1];
}
