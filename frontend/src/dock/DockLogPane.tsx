import { TerminalPane } from "../TerminalPane.js";
import type { DockEndedReport } from "./useDockProject.js";

// Dock master-detail rework — ONE terminal per dock column, rendered here
// instead of once per `.dock-monitor` row (see DockMonitor.tsx's own header
// comment). DockColumn selects which row's session this shows; this
// component is deliberately presentational and knows nothing about rows,
// controls, or how selection is decided — it only knows a session id (or
// the absence of one) and the floors it must never render below.
//
// Keyed by `sessionId` at the call site (`<DockLogPane key={sessionId} ...>`
// in Dock.tsx), not internally — that forces a clean TerminalPane remount on
// a genuine session change (a different stream selected, or the same row's
// underlying session recreated) while leaving React free to reuse this
// component's own instance whenever the id is unchanged (e.g. a `held`
// row's session survives a brief recreate gap untouched — see
// dockRowKey's own doc comment, dockHelpers.ts, for why selection itself
// stays stable across that same gap).
export function DockLogPane({
  sessionId,
  minWidthPx,
  minHeightPx,
  flex,
  ended,
}: {
  sessionId: number | null;
  // #3557 — with no live session: the last run's report, when it ended right
  // after it started (its exit code and last output, read from the host it
  // ran on), instead of the bare "select a row" hint.
  ended?: DockEndedReport;
  // Both required, not optional the way DockMonitor's old minWidthPx/
  // minHeightPx were — this is now the ONLY place either floor applies, so
  // there is no longer a caller-without-settings fallback case to make
  // optional for (dockHelpers.ts's dockMonitorMinWidthPx/
  // dockMonitorMinHeightPx doc comments carry the full derivations).
  minWidthPx: number;
  minHeightPx: number;
  // Issue #1244 — inline flex-basis override for the PRIMARY pane, set only
  // while a second (pinned) pane renders alongside it, so the draggable
  // divider between them can give each pane its own share of the two-pane
  // area. `undefined` otherwise, falling back to `.dock-log-pane`'s own
  // `flex: 1 1 0` CSS default (the pinned pane never gets this prop at all —
  // it always uses that same default to absorb whatever the primary
  // doesn't take). Always a PIXEL value (`0 0 ${px}px`), deliberately never
  // a percentage: a percentage flex-basis resolves against `.dock-split`'s
  // full width — rail and both dividers included — not just the two-pane
  // area, so `50%` would size this pane against the wrong denominator and
  // could push the pinned sibling below its own floor even at a legal ratio.
  flex?: string;
}) {
  return (
    <div
      className="dock-log-pane"
      style={{
        minWidth: minWidthPx,
        minHeight: minHeightPx,
        ...(flex !== undefined ? { flex } : {}),
      }}
    >
      {sessionId === null && ended ? (
        <div className="dock-log-pane-ended" role="status">
          <div className="dock-log-pane-ended-title">
            {ended.title} exited right after starting on {ended.hostLabel}
            {ended.exitCode !== null ? ` (exit code ${ended.exitCode})` : ""}.
          </div>
          {ended.lines.length > 0 ? (
            <pre className="dock-log-pane-ended-output">{ended.lines.join("\n")}</pre>
          ) : (
            <div className="dock-log-pane-hint">
              The host kept no output for it. Start it again to watch its log.
            </div>
          )}
        </div>
      ) : sessionId === null ? (
        <div className="dock-log-pane-hint">Select a row to view its log</div>
      ) : (
        <div className="dock-log-pane-body">
          <TerminalPane
            params={{ sessionId }}
            captureCtrlC={true}
            // Same rationale as the old .dock-monitor-body's TerminalPane —
            // no attach-image or mic button over a log stream; see
            // TerminalPane's own doc comment on this prop.
            inputAffordances={false}
          />
        </div>
      )}
    </div>
  );
}
