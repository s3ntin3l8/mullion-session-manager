import { useEffect, useRef, useState } from "react";
import {
  WebCodecsVideoDecoder,
  BitmapVideoFrameRenderer,
} from "@yume-chan/scrcpy-decoder-webcodecs";
import type { ScrcpyMediaStreamPacket } from "@yume-chan/scrcpy";
import { ScrcpyVideoCodecId } from "@yume-chan/scrcpy";
import { RefreshIcon, WifiOffIcon } from "./ui/icons.js";
import { Spinner } from "./ui/Spinner.js";

export interface DevicePaneParams {
  deviceId: number;
}

type ConnectionStatus = "connecting" | "open" | "reconnecting" | "failed" | "unsupported";

// Wire framing routes/device.ts's own header documents: [1 byte type][1 byte
// flags][payload]. type 0 = configuration (SPS/PPS), 1 = data; flags bit0 =
// keyframe. Reconstructed here into the exact ScrcpyMediaStreamPacket shape
// @yume-chan/scrcpy-decoder-webcodecs' WebCodecsVideoDecoder.writable
// expects — see that package's own decoder.d.ts. No `pts` on the wire (the
// route's own comment explains why receive-time pacing is enough for a
// live, audio-less stream).
function decodeVideoFrame(data: ArrayBuffer): ScrcpyMediaStreamPacket | null {
  const bytes = new Uint8Array(data);
  if (bytes.length < 2) return null;
  const typeByte = bytes[0];
  const flagsByte = bytes[1];
  const payload = bytes.subarray(2);
  if (typeByte === 0) return { type: "configuration", data: payload };
  return { type: "data", keyframe: (flagsByte & 1) === 1, data: payload };
}

interface ExitedMessage {
  type: "exited";
}
type ControlMessage = ExitedMessage;

function parseControlMessage(raw: string): ControlMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const v = parsed as Record<string, unknown>;
  if (v.type === "exited") return { type: "exited" };
  return null;
}

// Streams a device's screen from /ws/device/:deviceId (routes/device.ts) to
// a <canvas> via WebCodecs H.264 decode, and proxies touch/key/scroll input
// back — the device analogue of BrowserPane.tsx (canvas, not iframe: video
// packets are frames, not DOM), but push- rather than poll-based (see that
// route's own header) and using @yume-chan/scrcpy-decoder-webcodecs rather
// than a hand-rolled VideoDecoder, so codec-string derivation, canvas
// resizing on a mid-stream size change, and frame pacing are the library's
// problem, not this component's.
//
// End-to-end decode against a real device was NOT verified visually in the
// environment this shipped from (no live device/KVM available there — see
// the PR description); the wire framing and coordinate math are believed
// correct from the protocol docs and library types, not confirmed against a
// running emulator.
export function DevicePane(props: {
  params: DevicePaneParams;
  onTitleChange?: (title: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Lazy initializer, not a synchronous setState() inside the effect below
  // (which the react-hooks lint rule flags) — isSupported is a pure,
  // environment-only check with no dependency on props, so there's nothing
  // to "effect" here at all.
  const [status, setStatus] = useState<ConnectionStatus>(() =>
    WebCodecsVideoDecoder.isSupported ? "connecting" : "unsupported",
  );
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const sendControlRef = useRef<(message: Record<string, unknown>) => void>(() => {});
  const retryRef = useRef<() => void>(() => {});

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!WebCodecsVideoDecoder.isSupported) return;

    let destroyed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    let videoWidth = 0;
    let videoHeight = 0;

    const renderer = new BitmapVideoFrameRenderer(canvas);
    const decoder = new WebCodecsVideoDecoder({ codec: ScrcpyVideoCodecId.H264, renderer });
    decoder.sizeChanged(({ width, height }) => {
      videoWidth = width;
      videoHeight = height;
    });
    const writer = decoder.writable.getWriter();

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
        `${protocol}//${location.host}/ws/device/${props.params.deviceId}`,
      );
      socket.binaryType = "arraybuffer";
      ws = socket;

      socket.addEventListener("open", () => {
        reconnectAttempt = 0;
        setStatus("open");
      });

      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          const message = parseControlMessage(event.data);
          if (message?.type === "exited") setStatus("failed");
          return;
        }
        const packet = decodeVideoFrame(event.data as ArrayBuffer);
        if (!packet) return;
        writer.write(packet).catch(() => {
          // A decode error on a single packet — the next keyframe (the
          // backend requests one via resetVideo() after any backpressure
          // drop, see routes/device.ts) recovers the stream; nothing to
          // surface to the user for one bad packet.
        });
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

    // Touch/scroll/key forwarding — coordinates are rescaled from CSS
    // pixels to the DECODED VIDEO's own pixel dimensions (videoWidth/
    // videoHeight, updated by decoder.sizeChanged above), not the canvas
    // element's backing-store size, since injectTouch/injectScroll
    // (routes/device.ts) need the video frame's own coordinate space.
    function canvasPoint(event: MouseEvent | Touch): { x: number; y: number } {
      const rect = canvas!.getBoundingClientRect();
      const width = videoWidth || canvas!.width;
      const height = videoHeight || canvas!.height;
      const scaleX = rect.width > 0 ? width / rect.width : 1;
      const scaleY = rect.height > 0 ? height / rect.height : 1;
      return { x: (event.clientX - rect.left) * scaleX, y: (event.clientY - rect.top) * scaleY };
    }

    const onMouseDown = (event: MouseEvent) => {
      canvas!.focus();
      const { x, y } = canvasPoint(event);
      sendControl({ type: "tap", x, y, videoWidth, videoHeight });
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const { x, y } = canvasPoint(event);
      sendControl({
        type: "scroll",
        x,
        y,
        videoWidth,
        videoHeight,
        // Normalized the same way scrcpy's own injectScroll expects
        // (float, not raw pixel deltas) — a fixed divisor is a reasonable
        // default absent a real device to tune it against.
        scrollX: -event.deltaX / 100,
        scrollY: -event.deltaY / 100,
      });
    };
    const onContextMenu = (event: MouseEvent) => event.preventDefault();
    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onContextMenu);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Backspace") {
        event.preventDefault();
        // AOSP KEYCODE_DEL — the one key worth a dedicated, ergonomic
        // mapping here; a full browser-key-to-AOSP-keycode table is out of
        // scope for this component (use the `text` action for everything
        // else typeable, and the MCP/CLI `key` action for anything needing
        // a specific KEYCODE_*).
        sendControl({ type: "keyEvent", androidKeyCode: 67, action: "down" });
        sendControl({ type: "keyEvent", androidKeyCode: 67, action: "up" });
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        // AOSP KEYCODE_ENTER
        sendControl({ type: "keyEvent", androidKeyCode: 66, action: "down" });
        sendControl({ type: "keyEvent", androidKeyCode: 66, action: "up" });
        return;
      }
      if (event.key.length === 1) {
        event.preventDefault();
        sendControl({ type: "text", text: event.key });
      }
    };
    canvas.addEventListener("keydown", onKeyDown);

    return () => {
      destroyed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContextMenu);
      canvas.removeEventListener("keydown", onKeyDown);
      ws?.close();
      writer.close().catch(() => {});
      decoder.dispose();
      sendControlRef.current = () => {};
      retryRef.current = () => {};
    };
    // Bound to the device id, not this panel's own lifetime — same posture
    // as BrowserPane.tsx/TerminalPane.tsx.
  }, [props.params.deviceId]);

  return (
    <div className="browser-pane">
      <div className="browser-pane-canvas-wrap">
        <canvas ref={canvasRef} className="browser-pane-canvas" tabIndex={0} />
        {status !== "open" && status !== "unsupported" && (
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
        {status === "unsupported" && (
          <div className="terminal-status-overlay failed">
            <WifiOffIcon size={22} style={{ color: "var(--r)" }} />
            <span className="terminal-status-text">
              This browser doesn't support WebCodecs — the device panel needs a current
              Chromium-based browser.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
