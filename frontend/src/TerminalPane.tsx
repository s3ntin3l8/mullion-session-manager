import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { RefreshIcon, SpinnerIcon, WifiOffIcon } from "./icons.js";
import { useDashboardStore } from "./store.js";
import { buildXtermTheme } from "./terminalTheme.js";

export interface TerminalPaneParams {
  sessionId: number;
}

interface ResizeMessage {
  type: "resize";
  cols: number;
  rows: number;
}

type ConnectionStatus = "connecting" | "open" | "reconnecting" | "failed";

const MAX_RECONNECT_ATTEMPTS = 6;
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 8000;

// Terminal-relevant Ctrl combos that browsers would otherwise intercept
// before they ever reach xterm — Ctrl+R (readline reverse-search, extremely
// common) collides with page refresh, Ctrl+L (clear screen) and Ctrl+K
// (kill-line) collide with address-bar-focus in some browsers. Browsers
// reserve some other combos (Ctrl+W/T/N — close/open tab, new window) at a
// level JS categorically cannot override; deliberately not attempted here
// since preventDefault() on those is a silent no-op anyway.
const TERMINAL_RESERVED_KEYS = new Set(["r", "l", "k"]);

// Read directly from localStorage (same self-contained pattern as
// store.ts's own persisted prefs) rather than threading a prop down from
// App.tsx through dockview's params — Settings' Terminal tab writes this key
// via store.ts's setTerminalPrefs, and a running pane only needs its value
// once, at construction.
const TERMINAL_PREFS_KEY = "crs.terminalPrefs";
function readTerminalPrefs(): {
  fontSize: number;
  cursorStyle: "block" | "bar" | "underline";
  scrollback: number;
} {
  const defaults = { fontSize: 14, cursorStyle: "block" as const, scrollback: 1000 };
  try {
    const raw = localStorage.getItem(TERMINAL_PREFS_KEY);
    if (!raw) return defaults;
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}

function attachKeyConflictHandler(term: Terminal): void {
  term.attachCustomKeyEventHandler((event) => {
    if (
      event.type === "keydown" &&
      event.ctrlKey &&
      TERMINAL_RESERVED_KEYS.has(event.key.toLowerCase())
    ) {
      event.preventDefault();
    }
    return true;
  });
}

// One xterm.js instance + one WebSocket per session, bound to a session id
// (not to the panel's own lifetime) — closing this panel only tears down the
// browser-side view; the WS close handler in terminal.ts explicitly does not
// kill the session, matching the "browser tab close never kills the session"
// premise from the plan. Deliberately typed on just `params` (not the full
// IDockviewPanelProps) — this component never touches `api`/`containerApi`,
// so it can be reused outside a dockview panel too (see Dock.tsx, which
// renders a dock monitor's terminal without a real dockview panel at all).
export function TerminalPane(props: { params: TerminalPaneParams }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  // Exposes a manual "Retry now" (design's Disconnected state) without
  // remounting the terminal/xterm instance itself — `connect`/backoff live
  // inside the effect below (closed over the real WS + timer), so this ref
  // is how the render's button reaches in and calls them directly.
  const retryRef = useRef<() => void>(() => {});
  // Reactive: drives the live-recolor effect below on every toggle. The
  // mount effect intentionally reads the theme via getState() instead (see
  // there) so the terminal isn't torn down and rebuilt on a theme change.
  const theme = useDashboardStore((s) => s.theme);
  // Populated by the mount effect once the terminal/WebGL addon exist, so
  // the separate theme-subscription effect below can recolor the *same*
  // live instance instead of only ever seeing the value captured at
  // construction.
  const termRef = useRef<Terminal | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const prefs = readTerminalPrefs();
    // Resolved from getState() (not the reactive `theme` above) so this
    // mount effect — keyed only on sessionId — doesn't need `theme` in its
    // deps and doesn't rebuild the terminal on every toggle; the live
    // theme-subscription effect further down handles recoloring afterward.
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: prefs.cursorStyle,
      fontSize: prefs.fontSize,
      scrollback: prefs.scrollback,
      fontFamily: "Menlo, Consolas, monospace",
      // Resolves the design's CSS tokens to literal colors at construction
      // time — xterm's `theme` option is passed straight to the renderer
      // (canvas fillStyle / WebGL texture atlas), which (unlike CSS)
      // doesn't resolve custom properties on its own.
      theme: buildXtermTheme(container, useDashboardStore.getState().theme),
      // Unicode11Addon reads term.unicode, which xterm gates behind this
      // flag as a "proposed" (not yet stabilized) API.
      allowProposedApi: true,
    });
    termRef.current = term;
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.loadAddon(new WebLinksAddon());
    attachKeyConflictHandler(term);

    try {
      const webglAddon = new WebglAddon();
      term.loadAddon(webglAddon);
      webglAddonRef.current = webglAddon;
    } catch (err) {
      // Not every environment has a usable WebGL context (e.g. some headless
      // or GPU-restricted setups) — xterm falls back to its default DOM
      // renderer automatically, so this is a soft failure, not a blocker.
      console.warn("[terminal] WebGL renderer unavailable, using default renderer", err);
    }

    term.open(container);
    fitAddon.fit();

    let destroyed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;

    const dataSub = term.onData((data) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data));
      }
    });

    let lastCols = term.cols;
    let lastRows = term.rows;
    const sendResizeIfOpen = () => {
      if (ws?.readyState === WebSocket.OPEN) {
        const message: ResizeMessage = { type: "resize", cols: term.cols, rows: term.rows };
        ws.send(JSON.stringify(message));
      }
    };
    const refit = () => {
      fitAddon.fit();
      if (term.cols === lastCols && term.rows === lastRows) return;
      lastCols = term.cols;
      lastRows = term.rows;
      sendResizeIfOpen();
    };
    const resizeObserver = new ResizeObserver(refit);
    resizeObserver.observe(container);
    // Redundant on top of the ResizeObserver above — Chromium doesn't
    // always fire a ResizeObserver notification for every viewport change
    // that shrinks/grows this element (observed missing the transition when
    // DevTools docks/undocks, which resizes the viewport without a plain
    // window resize). A plain `resize` listener catches those misses.
    window.addEventListener("resize", refit);

    // Reconnects on any drop (network blip, backend redeploy, laptop sleep)
    // with capped exponential backoff — up to MAX_RECONNECT_ATTEMPTS, then
    // gives up and shows a "failed" state rather than retrying forever
    // against a session that may genuinely be gone. A successful reconnect
    // needs no special handling to restore output: the server always
    // replays its scrollback buffer to a newly-attaching client (see
    // terminal.ts), so the same catch-up path used for "reopen a detached
    // panel" also covers "the WS silently dropped and came back."
    function connect(): void {
      if (destroyed) return;
      setStatus(reconnectAttempt === 0 ? "connecting" : "reconnecting");
      setReconnectAttempt(reconnectAttempt);

      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${location.host}/ws/terminal?sessionId=${props.params.sessionId}&cols=${term.cols}&rows=${term.rows}`;
      const socket = new WebSocket(wsUrl);
      socket.binaryType = "arraybuffer";
      ws = socket;

      socket.addEventListener("open", () => {
        reconnectAttempt = 0;
        setStatus("open");
        // The URL's cols/rows were captured when this connect() call was
        // made, which can be stale if a deferred refit (below) corrected
        // the terminal's size in the meantime — send whatever the terminal's
        // current size actually is now that the socket is open, rather than
        // waiting for the next real resize to reach the backend PTY.
        sendResizeIfOpen();
      });

      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") return;
        term.write(new Uint8Array(event.data as ArrayBuffer));
      });

      socket.addEventListener("close", () => {
        if (destroyed) return;
        if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
          setStatus("failed");
          return;
        }
        const delay = Math.min(
          RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt,
          RECONNECT_MAX_DELAY_MS,
        );
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      });
    }

    // "Retry now" (design's Disconnected state) — reset backoff to attempt
    // 0 and reconnect immediately, without remounting the terminal itself.
    retryRef.current = () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectAttempt = 0;
      connect();
    };

    connect();

    return () => {
      destroyed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      resizeObserver.disconnect();
      window.removeEventListener("resize", refit);
      dataSub.dispose();
      ws?.close();
      term.dispose();
      termRef.current = null;
      webglAddonRef.current = null;
    };
  }, [props.params.sessionId]);

  // Live recolor on theme toggle — without this, an already-open terminal
  // keeps whatever theme it was constructed with until the whole pane is
  // remounted (e.g. a page refresh), which is the bug this effect fixes.
  // Also runs once right after the mount effect above (re-applying the same
  // theme it just built) — harmless and simpler than guarding against it.
  useEffect(() => {
    const container = containerRef.current;
    const term = termRef.current;
    if (!container || !term) return;
    term.options.theme = buildXtermTheme(container, theme);
    // The WebGL renderer caches glyphs (colors included) in a texture atlas;
    // reassigning `theme` alone leaves already-rendered glyphs showing their
    // old colors until the atlas is rebuilt.
    webglAddonRef.current?.clearTextureAtlas();
  }, [theme]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      {status !== "open" && (
        <div className={`terminal-status-overlay ${status}`}>
          {status === "connecting" && (
            <>
              <SpinnerIcon size={22} className="terminal-status-spinner connecting" />
              <span className="terminal-status-text">Connecting…</span>
              <span className="terminal-status-subtext">attaching to host</span>
            </>
          )}
          {status === "reconnecting" && (
            <>
              <SpinnerIcon size={22} className="terminal-status-spinner reconnecting" />
              <span className="terminal-status-text">
                Reconnecting… <span style={{ color: "var(--muted)" }}>({reconnectAttempt})</span>
              </span>
              <span className="terminal-status-subtext">connection dropped · retrying</span>
            </>
          )}
          {status === "failed" && (
            <>
              <WifiOffIcon size={22} style={{ color: "var(--r)" }} />
              <span className="terminal-status-text">Disconnected</span>
              <button className="terminal-status-retry" onClick={() => retryRef.current()}>
                <RefreshIcon size={13} />
                Retry now
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
