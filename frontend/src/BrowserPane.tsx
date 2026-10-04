import { useEffect, useRef, useState } from "react";
import { RefreshIcon, WifiOffIcon } from "./ui/icons.js";
import { Spinner } from "./ui/Spinner.js";
import { isMacPlatform, macChordPress } from "./browserKeyMap.js";

export interface BrowserPaneParams {
  sessionId: number;
}

type ConnectionStatus = "connecting" | "open" | "reconnecting" | "failed";

interface UrlMessage {
  type: "url";
  url: string;
}
interface TitleMessage {
  type: "title";
  title: string;
}
interface ExitedMessage {
  type: "exited";
}
interface ErrorMessage {
  type: "error";
  message: string;
}
// Page -> host clipboard, sent by the server only in reply to this pane's
// own `{type:"copy"}`/`{type:"cut"}` request (see the onKeyDown Ctrl/Cmd+C/X
// handling below) — never unprompted. That asymmetry is deliberate: see
// DevicePane.tsx's matching `clipboard` message for the same host-write
// posture, and issue #1478 for why a page-initiated clipboard write (e.g.
// the page's own navigator.clipboard.writeText()) must never reach here.
interface ClipboardMessage {
  type: "clipboard";
  text: string;
}
type ControlMessage = UrlMessage | TitleMessage | ExitedMessage | ErrorMessage | ClipboardMessage;

function parseControlMessage(raw: string): ControlMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const v = parsed as Record<string, unknown>;
  if (v.type === "url" && typeof v.url === "string") return { type: "url", url: v.url };
  if (v.type === "title" && typeof v.title === "string") return { type: "title", title: v.title };
  if (v.type === "exited") return { type: "exited" };
  if (v.type === "error" && typeof v.message === "string") {
    return { type: "error", message: v.message };
  }
  if (v.type === "clipboard" && typeof v.text === "string") {
    return { type: "clipboard", text: v.text };
  }
  return null;
}

function mouseButtonName(button: number): "left" | "right" | "middle" {
  if (button === 2) return "right";
  if (button === 1) return "middle";
  return "left";
}

// CDP-controlled browser pane (Phase 3, issue #181) — renders binary JPEG
// frames streamed from /ws/browser/:sessionId (routes/browser.ts, #180) to a
// <canvas>, not an iframe: CDP screenshot frames are images, not DOM, so
// there's nothing for an iframe to host. Distinct from the existing
// iframe-based BrowserPanel.tsx (the `browser` dockview component), which
// stays as the lightweight, non-agent-controlled preview — both coexist.
// One WebSocket + one canvas per session id (not per panel lifetime), same
// "bound to the id, not the panel" posture as TerminalPane.tsx.
export function BrowserPane(props: {
  params: BrowserPaneParams;
  onTitleChange?: (title: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [addressInput, setAddressInput] = useState("");
  const [lastError, setLastError] = useState<string | null>(null);
  // Exposes the mount effect's live `sendControl` (closed over the current
  // WebSocket) to the toolbar's back/forward/reload/navigate buttons,
  // rendered outside the effect — same ref-bridge pattern as TerminalPane's
  // retryRef/refitRef.
  const sendControlRef = useRef<(message: Record<string, unknown>) => void>(() => {});
  const retryRef = useRef<() => void>(() => {});
  const onTitleChangeRef = useRef(props.onTitleChange);
  useEffect(() => {
    onTitleChangeRef.current = props.onTitleChange;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    let destroyed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;

    function paintFrame(data: ArrayBuffer) {
      if (!ctx) return;
      createImageBitmap(new Blob([data], { type: "image/jpeg" }))
        .then((bitmap) => {
          if (destroyed) return;
          if (canvas!.width !== bitmap.width) canvas!.width = bitmap.width;
          if (canvas!.height !== bitmap.height) canvas!.height = bitmap.height;
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
        })
        .catch(() => {
          // A corrupt/partial frame — the next tick's frame replaces it, no
          // need to surface this to the user.
        });
    }

    function sendControl(message: Record<string, unknown>) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    }
    sendControlRef.current = sendControl;

    const RECONNECT_BASE_DELAY_MS = 500;
    const RECONNECT_MAX_DELAY_MS = 8000;
    const MAX_RECONNECT_ATTEMPTS = 6;

    function connect(): void {
      if (destroyed) return;
      setStatus(reconnectAttempt === 0 ? "connecting" : "reconnecting");
      setReconnectAttempt(reconnectAttempt);

      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(
        `${protocol}//${location.host}/ws/browser/${props.params.sessionId}`,
      );
      socket.binaryType = "arraybuffer";
      ws = socket;

      socket.addEventListener("open", () => {
        reconnectAttempt = 0;
        setStatus("open");
        setLastError(null);
      });

      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          const message = parseControlMessage(event.data);
          if (!message) return;
          if (message.type === "url") setAddressInput(message.url);
          else if (message.type === "title") onTitleChangeRef.current?.(message.title);
          else if (message.type === "exited") setStatus("failed");
          else if (message.type === "error") setLastError(message.message);
          else if (message.type === "clipboard") {
            // Page -> host clipboard, only ever in reply to our own
            // copy/cut request (see onKeyDown below) — never a page-
            // initiated write (issue #1478). Unlike DevicePane.tsx's
            // device->host clipboard stream (fanned out to every attached
            // socket for that device), the server replies only on the same
            // socket that sent the copy/cut request (routes/browser.ts's
            // dispatchInput), and panelUtils.ts's openBrowserPanePanel keys
            // panels by session id, focusing an existing one rather than
            // opening a second — so there's normally only one recipient
            // anyway. The document.hasFocus() gate is still the right call
            // (a background browser tab/window must not silently steal
            // clipboard focus) and matches DevicePane.tsx's own posture; a
            // permission/insecure-context write failure stays silent too.
            if (document.hasFocus()) {
              void navigator.clipboard?.writeText(message.text).catch(() => {});
            }
          }
          return;
        }
        paintFrame(event.data as ArrayBuffer);
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

    retryRef.current = () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectAttempt = 0;
      connect();
    };

    connect();

    // Mouse/keyboard forwarding — the canvas shows a scaled bitmap of the
    // remote page, so pointer coordinates are rescaled from CSS pixels to
    // the frame's own pixel dimensions before being sent.
    function canvasPoint(event: MouseEvent): { x: number; y: number } {
      const rect = canvas!.getBoundingClientRect();
      // `|| 1` alone doesn't catch a zero-width/height rect (e.g. before
      // layout, or in a headless test) when canvas.width is non-zero — that
      // divides out to Infinity, which is truthy and survives `||`.
      const scaleX = rect.width > 0 ? canvas!.width / rect.width : 1;
      const scaleY = rect.height > 0 ? canvas!.height / rect.height : 1;
      return { x: (event.clientX - rect.left) * scaleX, y: (event.clientY - rect.top) * scaleY };
    }
    const onMouseMove = (event: MouseEvent) => {
      const { x, y } = canvasPoint(event);
      sendControl({ type: "mouse", action: "move", x, y });
    };
    const onMouseDown = (event: MouseEvent) => {
      canvas!.focus();
      const { x, y } = canvasPoint(event);
      sendControl({ type: "mouse", action: "down", x, y, button: mouseButtonName(event.button) });
    };
    const onMouseUp = (event: MouseEvent) => {
      sendControl({ type: "mouse", action: "up", button: mouseButtonName(event.button) });
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      sendControl({ type: "mouse", action: "wheel", deltaX: event.deltaX, deltaY: event.deltaY });
    };
    // The canvas has its own right-click semantics in the remote page — the
    // browser's native context menu over it would just be confusing noise.
    const onContextMenu = (event: MouseEvent) => event.preventDefault();
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onContextMenu);

    // Keys whose keydown was intercepted by onKeyDown below for a clipboard
    // chord (not forwarded as a `key` message) — the matching keyup must
    // also be suppressed, or the page would see a keyup for a key it never
    // got the keydown for. The set is keyed by the physical key
    // (event.code, falling back to event.key) rather than re-checking
    // ctrlKey/metaKey at keyup time: the boundary condition that matters is
    // "was THIS key's own keydown intercepted", not "is the modifier still
    // held" — the user may release Ctrl/Cmd before releasing v/c/x, so the
    // modifier state at keyup can't be trusted to tell the two cases apart.
    // (event.code, not event.key, so a Cmd chord's keyup is still matched
    // after the user releases Shift first and event.key changes "Z" → "z".)
    const interceptedKeys = new Set<string>();
    const physicalKey = (event: KeyboardEvent) => event.code || event.key;
    // macOS client: Cmd is mapped to Ctrl in the remote Linux page (#1503,
    // see browserKeyMap.ts). Evaluated once per mount, like the rest of the
    // listener wiring.
    const mac = isMacPlatform();
    const onKeyDown = (event: KeyboardEvent) => {
      if (mac && event.key === "Meta") {
        // Never forwarded: Playwright must not hold Meta (a no-op in Linux
        // Chromium) or Control (it would turn Cmd+Left's Home into
        // Ctrl+Home). Each Cmd chord goes out below as one atomic `press`.
        // Swallowed here, and the matching keyup is swallowed via
        // interceptedKeys so the page never sees an orphaned "up".
        event.preventDefault();
        interceptedKeys.add(physicalKey(event));
        return;
      }
      // AltGr reports as ctrl+alt on Windows, so a chord excludes
      // Alt/AltGraph — otherwise "@ { [ \ €" on European layouts (and
      // Ctrl+Alt+C-style combos) could not be typed. Also excludes Shift,
      // unlike DevicePane.tsx's own chord check: Ctrl/Cmd+Shift+C/V/X are
      // real, distinct browser/app shortcuts in their own right (e.g.
      // "paste without formatting"), not this pane's copy/cut/paste
      // gesture — swallowing them here would silently drop them instead of
      // forwarding them to the page like any other chord.
      const chord =
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        !event.getModifierState("AltGraph");
      if (chord) {
        const key = event.key.toLowerCase();
        if (key === "v") {
          // Do NOT preventDefault and do NOT forward the raw key: forwarding
          // it would make headless Chromium try to paste its own separate,
          // likely-empty clipboard, and preventing default would cancel the
          // native `paste` DOM event the onPaste listener below relies on.
          // Still tracked in interceptedKeys so the matching keyup (which
          // DOES still fire, even though this keydown was never forwarded)
          // isn't sent as an orphaned "up" for a key the page never saw
          // go down.
          interceptedKeys.add(physicalKey(event));
          return;
        }
        if (key === "c" || key === "x") {
          // Do NOT forward the raw key either — the server reads the page's
          // own selection and replies (see routes/browser.ts's "copy"/"cut"
          // handling), then presses the real key itself so the page's own
          // copy/cut handlers still run normally.
          event.preventDefault();
          interceptedKeys.add(physicalKey(event));
          sendControl({ type: key === "c" ? "copy" : "cut" });
          return;
        }
        // Any other Ctrl chord (Ctrl+A, Ctrl+Z, ...) forwards normally below.
      }
      if (mac) {
        const press = macChordPress(event);
        if (press) {
          // A Cmd chord, sent as one self-contained press; the keyup is
          // swallowed (the press already released everything it pressed).
          event.preventDefault();
          interceptedKeys.add(physicalKey(event));
          sendControl({ type: "key", action: "press", key: press });
          return;
        }
      }
      event.preventDefault();
      sendControl({ type: "key", action: "down", key: event.key });
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (interceptedKeys.delete(physicalKey(event))) return;
      sendControl({ type: "key", action: "up", key: event.key });
    };
    canvas.addEventListener("keydown", onKeyDown);
    canvas.addEventListener("keyup", onKeyUp);

    // Host -> page paste. The native paste event is the single read path
    // (no readText(): no permission prompt, works over plain HTTP, and no
    // double paste) — mirrors DevicePane.tsx's own onPaste. Do NOT
    // preventDefault on the Ctrl/Cmd+V keydown above: cancelling it would
    // cancel this native `paste` event before it ever fires.
    const onPaste = (event: ClipboardEvent) => {
      event.preventDefault();
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (text) sendControl({ type: "clipboard", text });
    };
    canvas.addEventListener("paste", onPaste);

    return () => {
      destroyed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContextMenu);
      canvas.removeEventListener("keydown", onKeyDown);
      canvas.removeEventListener("keyup", onKeyUp);
      canvas.removeEventListener("paste", onPaste);
      ws?.close();
      sendControlRef.current = () => {};
      retryRef.current = () => {};
    };
    // Bound to the session id, not this panel's own lifetime — matches
    // TerminalPane.tsx's own mount-effect dependency.
  }, [props.params.sessionId]);

  const navigate = () => {
    const trimmed = addressInput.trim();
    if (trimmed) sendControlRef.current({ type: "navigate", url: trimmed });
  };

  return (
    <div className="browser-pane">
      <div className="browser-panel-toolbar">
        <button
          className="browser-panel-reload"
          title="Back"
          onClick={() => sendControlRef.current({ type: "back" })}
        >
          ‹
        </button>
        <button
          className="browser-panel-reload"
          title="Forward"
          onClick={() => sendControlRef.current({ type: "forward" })}
        >
          ›
        </button>
        <input
          className="browser-panel-address mono"
          value={addressInput}
          onChange={(event) => setAddressInput(event.target.value)}
          placeholder="https://example.com"
          onKeyDown={(event) => {
            if (event.key === "Enter") navigate();
          }}
        />
        <button className="browser-panel-go" onClick={navigate} title="Go">
          Go
        </button>
        <button
          className="browser-panel-reload"
          title="Reload"
          onClick={() => sendControlRef.current({ type: "reload" })}
        >
          <RefreshIcon size={13} />
        </button>
      </div>
      <div className="browser-pane-canvas-wrap">
        <canvas ref={canvasRef} className="browser-pane-canvas" tabIndex={0} />
        {lastError && <div className="browser-pane-error-toast">{lastError}</div>}
        {status !== "open" && (
          <div className={`terminal-status-overlay ${status}`}>
            {status === "connecting" && (
              <>
                <Spinner variant="connecting" />
                <span className="terminal-status-text">Connecting…</span>
              </>
            )}
            {status === "reconnecting" && (
              <>
                <Spinner variant="reconnecting" />
                <span className="terminal-status-text">
                  Reconnecting… <span style={{ color: "var(--muted)" }}>({reconnectAttempt})</span>
                </span>
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
    </div>
  );
}
