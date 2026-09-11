import { TerminalPane } from "../TerminalPane.js";

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
}: {
  sessionId: number | null;
  // Both required, not optional the way DockMonitor's old minWidthPx/
  // minHeightPx were — this is now the ONLY place either floor applies, so
  // there is no longer a caller-without-settings fallback case to make
  // optional for (dockHelpers.ts's dockMonitorMinWidthPx/
  // dockMonitorMinHeightPx doc comments carry the full derivations).
  minWidthPx: number;
  minHeightPx: number;
}) {
  return (
    <div className="dock-log-pane" style={{ minWidth: minWidthPx, minHeight: minHeightPx }}>
      {sessionId === null ? (
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
