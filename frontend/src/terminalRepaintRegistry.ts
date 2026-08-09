// Split out of TerminalPane.tsx (same rationale as paneTitle.ts/attention.ts)
// so this plain module-level registry doesn't trip react-refresh/only-export-
// components — that rule requires a component file to export components only.

// Registry of every mounted terminal's `repaint` (keyed by sessionId) — lets
// every OTHER live terminal be forced to fully re-raster whenever something
// could have corrupted their already-rendered WebGL canvas pixels: dockview
// adding a new panel/floating group (App.tsx's onDidAddPanel hook), or any
// terminal itself mounting or wiping the shared WebGL glyph texture atlas
// (TerminalPane.tsx's own mount effect and settings-sync effect) — the atlas
// is module-global (see @xterm/addon-webgl's acquireTextureAtlas), so a wipe
// by any one terminal corrupts every other sharing terminal's stale texture
// coordinates until they're all forced through this same repaint (issue
// #107: confirmed by scrolling only healing the rows it touches, while the
// static input band stays garbled until a full repaint/resize). Module-level
// rather than store/context state because TerminalPane is deliberately
// dockview-agnostic (see its own header comment) and must stay mountable
// outside a real dockview panel too (Dock.tsx).
const terminalRepaintRegistry = new Map<number, () => void>();

export function registerTerminalRepaint(sessionId: number, repaint: () => void): void {
  terminalRepaintRegistry.set(sessionId, repaint);
}

export function unregisterTerminalRepaint(sessionId: number): void {
  terminalRepaintRegistry.delete(sessionId);
}

// P5 perf fix (issue #107's own mitigation had no coalescing) — restoring a
// workspace with N panes mounts N terminals in the same synchronous React
// commit; each mount's own effect calls repaintAllTerminals(ownId), and
// dockview's onDidAddPanel (App.tsx) calls it again per panel. Before this,
// every one of those calls independently looped over the WHOLE registry
// (already-registered siblings included), so a burst of N calls landing in
// the same frame did O(N) work each = O(N²) total. This coalesces every call
// that arrives before the next animation frame into exactly one sweep.
//
// `exceptSessionIds` accumulates across the coalescing window rather than
// tracking just the most recent caller's argument, but it's ONLY consulted
// when the whole window contained a single call — see the reasoning in
// scheduleRepaint below for why unioning excepts across multiple callers
// would be a correctness regression (it can zero out the sweep entirely),
// not just a missed optimization.
let pendingRepaint: {
  exceptSessionIds: Set<number>;
  callCount: number;
} | null = null;

/** Force every currently-mounted terminal to fully re-raster (see registry
 * comment above), coalesced to at most one sweep per animation frame.
 * `exceptSessionId` skips the panel that just triggered this (e.g. the
 * newly-added one, which has nothing to heal yet) — but ONLY when this is
 * the sole call scheduled for the upcoming frame. When multiple callers
 * coalesce into the same frame (the O(N²) case this exists to fix — e.g. a
 * 3-pane restore where panes A, B, and C each call this with their own id in
 * the same tick), skipping each caller's own id would skip every registered
 * terminal at once and heal nothing, since A's call is what's supposed to
 * repaint B and C and vice versa. In that case every registered terminal is
 * repainted regardless of any exceptSessionId — a few redundant repaints for
 * panels that didn't strictly need one, which App.tsx's own onDidAddPanel
 * comment already establishes is cheap and the safe default, versus silently
 * healing nothing. */
export function repaintAllTerminals(exceptSessionId?: number): void {
  if (pendingRepaint) {
    pendingRepaint.callCount += 1;
    if (exceptSessionId !== undefined) pendingRepaint.exceptSessionIds.add(exceptSessionId);
    return;
  }

  const pending = { exceptSessionIds: new Set<number>(), callCount: 1 };
  if (exceptSessionId !== undefined) pending.exceptSessionIds.add(exceptSessionId);
  pendingRepaint = pending;

  requestAnimationFrame(() => {
    pendingRepaint = null;
    // Only a single caller scheduled this sweep — safe to skip its own
    // (newly-mounted/newly-added) session, same as the pre-coalescing
    // behavior for the common single-mount case.
    const except = pending.callCount === 1 ? pending.exceptSessionIds : null;
    for (const [sessionId, repaint] of terminalRepaintRegistry) {
      if (except?.has(sessionId)) continue;
      repaint();
    }
  });
}
