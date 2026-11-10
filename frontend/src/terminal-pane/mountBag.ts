// Shared mutable locals of TerminalPane's mount effect (issue #2406).
//
// These are the effect's own `let`s — `ws`, `destroyed`, `reconnectAttempt`,
// `sessionExited`, the replay generations, the clamped cols/rows, the copy
// timers — gathered into one plain object so the extracted closure bodies can
// read and write them without turning them into refs. The effect creates the
// object where those locals were declared. Every remaining read and write in
// the effect uses `bag.*`. The settings-sync effect's refs (`termRef`,
// `prefsRef`, `wsRef`) are a different channel and are not this object.

export interface MountBag {
  destroyed: boolean;
  ws: WebSocket | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempt: number;
  /** P13 — set when an `{type:"exited"}` frame arrives; survives reconnects. */
  sessionExited: boolean;
  connectionGeneration: number;
  replayCompleteGeneration: number;
  lastCols: number;
  lastRows: number;
  cappedBelowFloor: boolean;
  copyToastTimer: ReturnType<typeof setTimeout> | null;
  copyFailedToastTimer: ReturnType<typeof setTimeout> | null;
}
