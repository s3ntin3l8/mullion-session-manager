// Split out of TerminalPane.tsx (same rationale as paneTitle.ts/attention.ts)
// so this plain module-level registry doesn't trip react-refresh/only-export-
// components — that rule requires a component file to export components only.

// Registry of every mounted terminal's `repaint` (keyed by sessionId) — lets
// App.tsx force every OTHER live terminal to fully re-raster whenever dockview
// adds a new panel/floating group (issue #107: opening a new terminal/TUI
// session corrupts the already-rendered WebGL canvas pixels of existing
// terminals — confirmed by scrolling only healing the rows it touches, while
// the static input band stays garbled until a full repaint/resize). Module-
// level rather than store/context state because TerminalPane is deliberately
// dockview-agnostic (see its own header comment) and must stay mountable
// outside a real dockview panel too (Dock.tsx).
const terminalRepaintRegistry = new Map<number, () => void>();

export function registerTerminalRepaint(sessionId: number, repaint: () => void): void {
  terminalRepaintRegistry.set(sessionId, repaint);
}

export function unregisterTerminalRepaint(sessionId: number): void {
  terminalRepaintRegistry.delete(sessionId);
}

/** Force every currently-mounted terminal to fully re-raster (see registry
 * comment above). `exceptSessionId` skips the panel that just triggered this
 * (e.g. the newly-added one), which has nothing to heal yet. */
export function repaintAllTerminals(exceptSessionId?: number): void {
  for (const [sessionId, repaint] of terminalRepaintRegistry) {
    if (sessionId === exceptSessionId) continue;
    repaint();
  }
}
