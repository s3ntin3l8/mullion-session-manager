// Hover preview for the wrap-aware link provider (lib/terminalLinks.ts) —
// extracted alongside TerminalToasts.tsx (same pure-render pattern: the
// state itself is owned by TerminalPane, set from inside the mount effect's
// `hover`/`leave` closures passed to `term.registerLinkProvider()` and the
// `linkHandler` constructor option).
//
// This is not a decoration. A hard-wrapped link's destination is
// reconstructed by heuristic (see that module's own header for why "no
// join" is always the safe fallback and never "join to the wrong place"),
// and showing the full URL before the user commits to clicking it is the
// thing that makes an imperfect heuristic safe to ship — the user sees
// exactly where a click will go, including when it was stitched together
// from more than one terminal row.
export interface LinkTooltipState {
  text: string;
  rowCount: number;
  /** Pane-relative coordinates from the triggering MouseEvent — see
   * TerminalPane.tsx's `hoverLink` closure for how these are computed. */
  x: number;
  y: number;
}

export interface TerminalLinkTooltipProps {
  tooltip: LinkTooltipState | null;
}

// Keeps the tooltip from being clipped by the pane edge it renders nearest
// to. Not exact — it doesn't measure the tooltip's own rendered width —
// but comfortably wide enough for a scheme + host + a long path, and the
// `left`/`top` clamps below only need to keep its ANCHOR point on-pane; the
// CSS transform below does the rest by pulling it back on-screen from
// whichever corner it's anchored to.
const HORIZONTAL_MARGIN = 12;
const VERTICAL_FLIP_THRESHOLD = 40;

export function TerminalLinkTooltip({ tooltip }: TerminalLinkTooltipProps) {
  if (!tooltip) return null;

  // Prefer floating above the cursor (out of the way of the row being
  // read); flip below when too close to the pane's own top edge.
  const showBelow = tooltip.y < VERTICAL_FLIP_THRESHOLD;

  return (
    <div
      className={`terminal-link-tooltip ${showBelow ? "terminal-link-tooltip-below" : "terminal-link-tooltip-above"}`}
      style={{
        left: `clamp(${HORIZONTAL_MARGIN}px, ${tooltip.x}px, calc(100% - ${HORIZONTAL_MARGIN}px))`,
        top: tooltip.y,
      }}
    >
      <span className="terminal-link-tooltip-url">{tooltip.text}</span>
      {tooltip.rowCount > 1 && (
        <span className="terminal-link-tooltip-meta">joined across {tooltip.rowCount} rows</span>
      )}
    </div>
  );
}
