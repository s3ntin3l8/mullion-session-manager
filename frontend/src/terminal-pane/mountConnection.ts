// Closure body moved out of TerminalPane's mount effect (issue #2406).
// The effect calls this factory at the declaration site and binds the
// returned functions to the same local names. Construction, the WebGL
// atlas sequence, OSC 10/11/12 registration, and the cleanup list stayed
// in the effect. Shared mutable locals are the explicit MountBag, not refs.

import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import type { Dispatch, SetStateAction } from "react";
import type { GeometryMessage } from "../../../src/shared/ws-protocol.js";
import type { AppSettings } from "../api/types.js";
import { clampTerminalGridSize } from "../lib/terminalGridSize.js";
import { useDashboardStore } from "../store/index.js";
import type { MountBag } from "./mountBag.js";

/** Mirrors TerminalPane's ConnectionStatus. Kept here to avoid an import cycle. */
type ConnectionStatus = "connecting" | "open" | "reconnecting" | "failed" | "ended";

export interface MountConnectionDeps {
  term: Terminal;
  fitAddon: FitAddon;
  sendResizeIfOpen: () => void;
  setStatus: Dispatch<SetStateAction<ConnectionStatus>>;
  setReconnectAttempt: Dispatch<SetStateAction<number>>;
  setAttachIncompatible: Dispatch<SetStateAction<boolean>>;
  setPaneTooSmall: Dispatch<SetStateAction<boolean>>;
  setFitRetryTick: Dispatch<SetStateAction<number>>;
  wsRef: { current: WebSocket | null };
  pendingOscRef: { current: string | null };
  fitFloorRef: { current: { cols: number; rows: number } | null };
  prefsRef: { readonly current: AppSettings["terminal"] };
  props: { params: { sessionId: number } };
  isGeometryMessage: (value: unknown) => value is GeometryMessage;
}

export function attachMountConnection(bag: MountBag, deps: MountConnectionDeps) {
  const {
    term,
    fitAddon,
    sendResizeIfOpen,
    setStatus,
    setReconnectAttempt,
    setAttachIncompatible,
    setPaneTooSmall,
    setFitRetryTick,
    wsRef,
    pendingOscRef,
    fitFloorRef,
    prefsRef,
    props,
    isGeometryMessage,
  } = deps;

  // Reconnects on any drop (network blip, backend redeploy, laptop sleep)
  // with capped exponential backoff — up to prefs.reconnect.maxAttempts,
  // unless auto-reconnect is disabled entirely — then gives up and shows a
  // "failed" state rather than retrying forever against a session that may
  // genuinely be gone. A successful reconnect needs no special handling to
  // restore output: the server always replays its scrollback buffer to a
  // newly-attaching client (see terminal.ts), so the same catch-up path
  // used for "reopen a detached panel" also covers "the WS silently
  // dropped and came back."
  const RECONNECT_BASE_DELAY_MS = 500;
  const RECONNECT_MAX_DELAY_MS = 8000;
  function connect(): void {
    if (bag.destroyed) return;
    setStatus(bag.reconnectAttempt === 0 ? "connecting" : "reconnecting");
    setReconnectAttempt(bag.reconnectAttempt);
    setAttachIncompatible(false);
    // This connection's own identity for the replay guard above — see
    // connectionGeneration's own comment for why generation comparison
    // (rather than a shared boolean reset at some point in time) is what
    // makes the guard correct regardless of xterm's write-queue timing.
    // `sawGeometry` is deliberately a plain local here, not hoisted to
    // effect scope: closing over one fresh copy per connect() call is
    // exactly "has THIS connection seen its own first geometry frame yet",
    // with no manual reset needed.
    bag.connectionGeneration += 1;
    const myGeneration = bag.connectionGeneration;
    let sawGeometry = false;

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${location.host}/ws/terminal?sessionId=${props.params.sessionId}&cols=${term.cols}&rows=${term.rows}`;
    const socket = new WebSocket(wsUrl);
    socket.binaryType = "arraybuffer";
    bag.ws = socket;
    wsRef.current = socket;

    socket.addEventListener("open", () => {
      bag.reconnectAttempt = 0;
      setStatus("open");
      // The URL's cols/rows were captured when this connect() call was
      // made, which can be stale if a deferred refit (below) corrected
      // the terminal's size in the meantime — send whatever the terminal's
      // current size actually is now that the socket is open, rather than
      // waiting for the next real resize to reach the backend PTY.
      sendResizeIfOpen();
      // Drain any OSC color push that was queued while the socket was
      // not OPEN (theme toggle during a reconnect).  The running program
      // always sees the latest theme once the connection is restored.
      const pending = pendingOscRef.current;
      if (pending) {
        socket.send(new TextEncoder().encode(pending));
        pendingOscRef.current = null;
      }
    });

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        term.write(new Uint8Array(event.data as ArrayBuffer));
        return;
      }
      // Two JSON control frames can arrive here — see TerminalWSMessage
      // (ws-protocol.ts) for the full union. "exited": P13 —
      // terminal.ts's onExit handler sends this the instant the PTY
      // process exits, independent of whether the underlying WS connection
      // itself ever closes (killing a session doesn't force-close an
      // already-open browser socket — see that route's own "kept alive"
      // comment). This is the earliest, most direct "this session is
      // genuinely gone" signal available — well before any close event
      // might eventually follow, possibly never for an already-open
      // connection. "geometry": see its own comment below. Previously
      // dropped outright (a bare `return` for any string message); now
      // both string frames this protocol actually sends are read.
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if ((parsed as { type?: unknown } | null)?.type === "exited") {
        // Issue #2168: a live session this build cannot attach to (started
        // by a release with an incompatible pty-host protocol) - say so,
        // rather than letting it read as the program having exited.
        setAttachIncompatible((parsed as { reason?: unknown }).reason === "incompatible");
        bag.sessionExited = true;
        if (bag.reconnectTimer) clearTimeout(bag.reconnectTimer);
        setStatus("ended");
        return;
      }
      // Issue: small panes/floating windows ignoring input — the server
      // floors a too-small resize (pty-manager.ts's MIN_TERMINAL_COLS/
      // ROWS) and echoes back whatever it actually applied (see
      // GeometryMessage's own doc comment). If that differs from this
      // terminal's current grid, resize xterm to match — otherwise the
      // program keeps drawing to columns/rows this viewport never shows,
      // and typed input appears to do nothing even though it's reaching
      // the pty. Also mirrored into lastCols/lastRows so the next refit()
      // (ResizeObserver-driven) computes its own delta against reality
      // instead of immediately trying to fight this back down.
      // Issue #1520 — the server dropped output for this connection under
      // backpressure; what's on screen may be garbled. Reset xterm and
      // re-arm the replay guards: the next binary frame is a fresh full
      // replay followed by a geometry frame, same as the initial attach.
      if ((parsed as { type?: unknown } | null)?.type === "resync") {
        term.reset();
        sawGeometry = false;
        bag.replayCompleteGeneration = 0;
        return;
      }
      if (isGeometryMessage(parsed)) {
        const geo = parsed;
        // The first "geometry" frame on this connection is sent
        // unconditionally right after the (optional) scrollback backlog —
        // see connectionGeneration's own comment above — so it's a
        // reliable end-of-replay sentinel even for a fresh spawn with no
        // backlog at all. term.write() queues in FIFO order and only
        // invokes its callback once that write is fully parsed, so queuing
        // a no-op write here guarantees this fires only once any OSC 52
        // earlier in the backlog has already been (harmlessly) swallowed
        // by the handler below — advancing replayCompleteGeneration
        // synchronously here instead would race an unparsed backlog still
        // sitting in xterm's write queue. The `myGeneration ===
        // connectionGeneration` check discards this callback if a later
        // connect() has since superseded it (see connectionGeneration's
        // own comment for why that can happen even though this callback
        // was queued first).
        if (!sawGeometry) {
          sawGeometry = true;
          term.write(new Uint8Array(0), () => {
            if (myGeneration === bag.connectionGeneration)
              bag.replayCompleteGeneration = myGeneration;
          });
        }
        // Narrow-pane font auto-fit — fitFloorRef holds the server's
        // constant MIN_TERMINAL_COLS/ROWS floor (see that ref's own
        // comment for why this must be the floor, not `geo.cols`/
        // `geo.rows` themselves — those are this session's CURRENT
        // applied geometry, which the client's own resizes below keep
        // changing, and targeting a moving value like that is what fed
        // the pre-fix feedback loop). `typeof` guards degrade a stale
        // browser tab talking to a pre-floor-echo server safely: the
        // fields are simply absent, fitFloorRef stays null, and the
        // narrow-pane fit is inert rather than throwing.
        if (typeof geo.minCols === "number" && typeof geo.minRows === "number") {
          fitFloorRef.current = { cols: geo.minCols, rows: geo.minRows };
        }
        if (geo.cols !== term.cols || geo.rows !== term.rows) {
          // Hermes review — geo.cols/rows come straight off the wire (an
          // untyped GeometryMessage routes/terminal.ts forwards verbatim)
          // and are trusted as already within MAX_TERMINAL_COLS/ROWS
          // because the SAME-version backend's own clampTerminalSize()
          // bounds session.size before ever echoing it. A remote-hosted
          // session (this frame's own comment above) could be talking to a
          // different-version host whose echo predates that ceiling —
          // clamp here too so this path can't reintroduce the exact
          // runaway the rest of this file guards against. A no-op in the
          // aligned case (geo is already within bounds by construction).
          const clampedGeo = clampTerminalGridSize(geo.cols, geo.rows);
          term.resize(clampedGeo.cols, clampedGeo.rows);
          bag.lastCols = clampedGeo.cols;
          bag.lastRows = clampedGeo.rows;
          // A genuine floor override (as opposed to an echo merely
          // confirming a resize this client initiated) is the signal that
          // the settings-sync effect's font-fit check should (re-)run —
          // this is the trigger for ENTERING a shrunk state; `refit()`
          // above handles the trigger for LEAVING one.
          setFitRetryTick((tick) => tick + 1);
        }
        // Hermes review, PR #708 — proposeDimensions() returns undefined
        // when the container can't fit even one full character cell (a
        // near-collapsed pane, or the brief zero-height layout state
        // during a drag). Treating that as "not too small" hid the hint
        // exactly when the pane was most unusable; undefined now counts
        // as too small, same as a proposed size that's genuinely smaller
        // than the floor.
        const proposed = fitAddon.proposeDimensions();
        const floorCols =
          fitFloorRef.current?.cols ?? (typeof geo.minCols === "number" ? geo.minCols : geo.cols);
        const floorRows =
          fitFloorRef.current?.rows ?? (typeof geo.minRows === "number" ? geo.minRows : geo.rows);
        const tooSmall =
          proposed === undefined || proposed.cols < floorCols || proposed.rows < floorRows;
        bag.cappedBelowFloor = tooSmall;
        setPaneTooSmall(tooSmall);
      }
    });

    socket.addEventListener("close", () => {
      if (bag.destroyed) return;
      // P13 — distinguishes "this session is genuinely gone" (no retry;
      // show "Session ended") from an ordinary network blip (keep the
      // existing backoff-and-retry behavior). The close event's own
      // code/reason carry no usable signal for the specific case this
      // exists to catch: a reconnect attempt against an already-killed
      // session fails at the WS opening handshake itself
      // (routes/terminal.ts's preValidation returns 400 for a killed/
      // exited row before the upgrade ever completes), and per the
      // WebSocket spec every browser reports a failed opening handshake as
      // code 1006 with an empty reason — indistinguishable from a genuine
      // abnormal closure (verified by reading terminal.ts; there is no
      // custom close code anywhere in this backend). The two signals that
      // DO work: (a) `sessionExited`, set above the moment an "exited"
      // control message arrives on a connection that was already open,
      // and (b) cross-checking `store.sessions` — a reconnect attempt only
      // lands here because a PRIOR attempt already failed, so by the time
      // this fires, whatever kill/exit caused that has normally long since
      // reached the store (an explicit kill's own store.deleteSession
      // awaits refreshSessions() before resolving; a session killed from
      // elsewhere reaches this store within one 4s live-refresh tick).
      //
      // `!stored` is only trustworthy as "gone" once the store has loaded
      // at least once (`sessionsLoaded`) — the "prior attempt" premise
      // above assumes this is a RECONNECT, but a pane can also hit its
      // very first close before `refreshSessions()`'s first response ever
      // lands (e.g. restored by dockview racing a backend restart), where
      // `sessions` is still `[]` for every live session, not just dead
      // ones. Gating on `sessionsLoaded` keeps that initial-load race from
      // being misread as "ended" for a session that's actually still
      // live (Hermes review, PR #592).
      const { sessions: liveSessions, sessionsLoaded } = useDashboardStore.getState();
      const stored = liveSessions.find((s) => s.id === props.params.sessionId);
      const sessionGone =
        bag.sessionExited ||
        (sessionsLoaded && !stored) ||
        stored?.status === "killed" ||
        stored?.status === "exited";
      if (sessionGone) {
        setStatus("ended");
        return;
      }
      const reconnectPrefs = prefsRef.current.reconnect;
      if (!reconnectPrefs.enabled || bag.reconnectAttempt >= reconnectPrefs.maxAttempts) {
        setStatus("failed");
        return;
      }
      const delay = Math.min(
        RECONNECT_BASE_DELAY_MS * 2 ** bag.reconnectAttempt,
        RECONNECT_MAX_DELAY_MS,
      );
      bag.reconnectAttempt += 1;
      bag.reconnectTimer = setTimeout(connect, delay);
    });
  }

  return { connect };
}
