import { useEffect, useRef, useState } from "react";
import {
  WebCodecsVideoDecoder,
  BitmapVideoFrameRenderer,
  WebGLVideoFrameRenderer,
} from "@yume-chan/scrcpy-decoder-webcodecs";
import type { ScrcpyMediaStreamPacket } from "@yume-chan/scrcpy";
import { ScrcpyVideoCodecId } from "@yume-chan/scrcpy";
import { PlayIcon, RefreshIcon, StopIcon, WifiOffIcon } from "./ui/icons.js";
import { useDashboardStore } from "./store/index.js";
import { Spinner } from "./ui/Spinner.js";
import { devicesApi } from "./api/device.js";

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
interface ErrorMessage {
  type: "error";
  message: string;
}
type ControlMessage = ExitedMessage | ErrorMessage;

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
  if (v.type === "error" && typeof v.message === "string") {
    return { type: "error", message: v.message };
  }
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
// isSupported probes a throwaway canvas, so it can disagree with the pane's
// real one — the WebGL constructor still throws if that canvas yields no
// context or a shader fails to compile. An error thrown from a useEffect
// isn't caught by the root ErrorBoundary and would unmount the whole
// dashboard, so fall back to the bitmap renderer (which can't throw here).
// Ordering assumption: the fallback is only sound if the throw happens BEFORE
// the canvas has acquired a WebGL context (the "no context" case). A later
// failure (shader compile/link) would leave the canvas bound to `webgl`, and
// getContext("bitmaprenderer") would return null — failing per frame instead.
// Near-unreachable: isSupported probes with the same context attributes and
// the shaders are trivial.
function createRenderer(canvas: HTMLCanvasElement) {
  if (WebGLVideoFrameRenderer.isSupported) {
    try {
      return new WebGLVideoFrameRenderer(canvas);
    } catch {
      // fall through to the bitmap renderer
    }
  }
  return new BitmapVideoFrameRenderer(canvas);
}

export function DevicePane(props: {
  params: DevicePaneParams;
  onTitleChange?: (title: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // One renderer per <canvas> for the pane's whole life (see the effect below).
  const rendererRef = useRef<WebGLVideoFrameRenderer | BitmapVideoFrameRenderer | null>(null);
  // Lazy initializer, not a synchronous setState() inside the effect below
  // (which the react-hooks lint rule flags) — isSupported is a pure,
  // environment-only check with no dependency on props, so there's nothing
  // to "effect" here at all.
  const [status, setStatus] = useState<ConnectionStatus>(() =>
    WebCodecsVideoDecoder.isSupported ? "connecting" : "unsupported",
  );
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);
  // True once a keyframe has been decoded on the current connection. Until
  // then the canvas has nothing on it (and sits on --term, plain white in the
  // light theme), so an "open" socket alone must not read as "streaming".
  const [hasFrame, setHasFrame] = useState(false);
  // This panel's own row, by status only. Primitive on purpose: the devices
  // poll replaces the whole array with fresh objects every tick, so
  // selecting the row itself would re-render (and re-measure nothing but
  // this overlay) every DEVICES_POLL_MS for as long as the pane is open.
  const deviceStatus = useDashboardStore(
    (s) => s.devices.find((d) => d.id === props.params.deviceId)?.status,
  );
  const devicesLoaded = useDashboardStore((s) => s.devicesLoaded);
  const [starting, setStarting] = useState(false);
  const [showFrame, setShowFrame] = useState(
    () => localStorage.getItem("mullion-device-frame") !== "off",
  );
  const [takingScreenshot, setTakingScreenshot] = useState(false);
  // Two states the socket can never recover from on its own: the row is
  // STOPPED (status "killed" — routes/device.ts 404s every connect) or
  // GONE (hard-deleted, same 404 with no row left to restart). Without
  // these the pane would burn its six reconnect attempts and then sit on a
  // generic "Disconnected / Retry now" that no amount of retrying fixes.
  const stopped = deviceStatus === "killed";
  const removed = devicesLoaded && deviceStatus === undefined;

  const handleStart = () => {
    if (starting) return;
    setStarting(true);
    useDashboardStore
      .getState()
      .startDevice(props.params.deviceId)
      // Start already re-read the row; reconnect once the process is back
      // rather than waiting out the failed state's backoff.
      .then(() => retryRef.current())
      .catch((err: unknown) => setLastError(err instanceof Error ? err.message : String(err)))
      .finally(() => setStarting(false));
  };
  const sendControlRef = useRef<(message: Record<string, unknown>) => void>(() => {});
  const retryRef = useRef<() => void>(() => {});
  const pressKey = (androidKeyCode: number) => {
    sendControlRef.current({ type: "keyEvent", androidKeyCode, action: "down" });
    sendControlRef.current({ type: "keyEvent", androidKeyCode, action: "up" });
  };
  const takeScreenshot = async () => {
    if (takingScreenshot) return;
    setTakingScreenshot(true);
    setLastError(null);
    try {
      const result = await devicesApi.takeScreenshot(props.params.deviceId);
      const bytes = Uint8Array.from(atob(result.screenshot), (char) => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `device-${props.params.deviceId}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
    } finally {
      setTakingScreenshot(false);
    }
  };
  const toggleFrame = () =>
    setShowFrame((current) => {
      const next = !current;
      localStorage.setItem("mullion-device-frame", next ? "on" : "off");
      return next;
    });

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

    // A WebCodecsVideoDecoder whose writable has errored (e.g. it was handed
    // a delta frame before its first keyframe) stays errored for good —
    // every later write rejects, keyframes included — so recovery means a
    // brand-new decoder, not waiting for the next keyframe. `decoderDead`
    // marks that state; connect() swaps in a fresh decoder before the next
    // socket opens. `decoderFailures` counts failures that never produced a
    // frame (reconnectAttempt can't: it resets on every "open").
    const MAX_DECODER_FAILURES = 3;
    let decoder: WebCodecsVideoDecoder;
    let writer: WritableStreamDefaultWriter<ScrcpyMediaStreamPacket>;
    let decoderDead = false;
    let decoderFailures = 0;
    // Failures only forgive after this many packets decode cleanly — a
    // decoder that eats one keyframe and then errors must still hit the cap.
    const HEALTHY_PACKETS_TO_FORGIVE = 120;
    let healthyPackets = 0;

    // Created ONCE per canvas (rendererRef survives effect re-runs, e.g. a
    // deviceId change) and shared by every rebuilt decoder: a canvas is
    // bound to one context type for life, decoder.dispose() doesn't dispose
    // its renderer, and a second WebGL renderer would recompile its
    // program/texture on the same context and leak the first. WebGL draws
    // the decoded VideoFrame directly on the GPU; the bitmap renderer does a
    // createImageBitmap copy per frame, so it is only the fallback.
    // enableCapture stays off (faster) — nothing reads canvas pixels back.
    rendererRef.current ??= createRenderer(canvas);
    const renderer = rendererRef.current;

    function createDecoder(): void {
      decoder = new WebCodecsVideoDecoder({ codec: ScrcpyVideoCodecId.H264, renderer });
      decoder.sizeChanged(({ width, height }) => {
        if ((videoWidth !== width || videoHeight !== height) && activePointer !== null) {
          activePointer = null;
          sendControl({ type: "touchUp", x: 0, y: 0, videoWidth, videoHeight, pointerId: 0 });
        }
        videoWidth = width;
        videoHeight = height;
      });
      writer = decoder.writable.getWriter();
    }
    function disposeDecoder(): void {
      writer.close().catch(() => {});
      decoder.dispose();
    }
    createDecoder();

    function sendControl(message: Record<string, unknown>) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    }
    sendControlRef.current = sendControl;

    const RECONNECT_BASE_DELAY_MS = 500;
    const RECONNECT_MAX_DELAY_MS = 8000;
    const MAX_RECONNECT_ATTEMPTS = 6;

    function connect(): void {
      if (destroyed) return;
      // Defensive: never let a still-open previous socket keep running
      // once a new one is about to be created — see the "exited" handler's
      // own comment on why this matters (a stray socket stays registered
      // server-side as a live viewer until the OS times it out).
      if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
      if (decoderDead) {
        disposeDecoder();
        createDecoder();
        decoderDead = false;
      }
      setHasFrame(false);
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
        setLastError(null);
      });

      socket.addEventListener("message", (event) => {
        // A replaced socket must not feed the (possibly fresh) decoder.
        if (socket !== ws) return;
        if (typeof event.data === "string") {
          const message = parseControlMessage(event.data);
          if (message?.type === "exited") {
            setStatus("failed");
            // The server closes its own end right after sending this (see
            // routes/device.ts), but close() here too rather than relying
            // on that round trip — Retry/reconnect must never race a
            // still-open previous socket into existing alongside a new
            // one (connect() below would otherwise overwrite `ws` and
            // leave this one to linger as a phantom, still-subscribed
            // viewer until the OS eventually times it out).
            socket.close();
          } else if (message?.type === "error") {
            // getOrCreate() failed right after the upgrade (routes/
            // device.ts) — most likely a scope left running from before a
            // restart (device-manager.ts's own isScopeAlive comment).
            // Shown, not silently dropped: this is actionable (the message
            // names the exact `systemctl --user stop` command), unlike a
            // one-bad-packet decode error.
            setLastError(message.message);
            setStatus("failed");
            socket.close();
          }
          return;
        }
        const packet = decodeVideoFrame(event.data as ArrayBuffer);
        if (!packet || decoderDead) return;
        const activeWriter = writer;
        activeWriter.write(packet).then(
          () => {
            if (destroyed || socket !== ws || activeWriter !== writer || decoderDead) return;
            if (++healthyPackets >= HEALTHY_PACKETS_TO_FORGIVE) {
              decoderFailures = 0;
              healthyPackets = 0;
            }
            if (packet.type === "data" && packet.keyframe) setHasFrame(true);
          },
          (err: unknown) => {
            if (destroyed || activeWriter !== writer || decoderDead) return;
            // The stream is permanently errored (see decoderDead above).
            decoderDead = true;
            healthyPackets = 0;
            decoderFailures += 1;
            setHasFrame(false);
            if (decoderFailures >= MAX_DECODER_FAILURES) {
              // Reconnecting hasn't helped — surface it rather than loop.
              // Detaching `ws` first makes this socket's own "close" a
              // no-op, so no reconnect is scheduled; Retry starts over.
              ws = null;
              socket.close();
              setLastError(
                `Video decoder failed: ${err instanceof Error ? err.message : String(err)}`,
              );
              setStatus("failed");
              return;
            }
            // Let the close handler's existing backoff do the reconnect;
            // connect() rebuilds the decoder. The server replays config and
            // sends a keyframe first (routes/device.ts).
            socket.close();
          },
        );
      });

      socket.addEventListener("close", () => {
        if (socket !== ws) return;
        activePointer = null;
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
      decoderFailures = 0;
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
      return {
        x: Math.max(0, Math.min(width - 1, (event.clientX - rect.left) * scaleX)),
        y: Math.max(0, Math.min(height - 1, (event.clientY - rect.top) * scaleY)),
      };
    }

    let activePointer: number | null = null;
    const onPointerDown = (event: PointerEvent) => {
      if (activePointer !== null || (event.pointerType === "mouse" && event.button !== 0)) return;
      event.preventDefault();
      activePointer = event.pointerId;
      canvas!.setPointerCapture(event.pointerId);
      canvas!.focus();
      const { x, y } = canvasPoint(event);
      sendControl({ type: "touchDown", x, y, videoWidth, videoHeight, pointerId: 0 });
    };
    const onPointerMove = (event: PointerEvent) => {
      if (activePointer !== event.pointerId) return;
      const { x, y } = canvasPoint(event);
      sendControl({ type: "touchMove", x, y, videoWidth, videoHeight, pointerId: 0 });
    };
    const onPointerUp = (event: PointerEvent) => {
      if (activePointer !== event.pointerId) return;
      activePointer = null;
      const { x, y } = canvasPoint(event);
      sendControl({ type: "touchUp", x, y, videoWidth, videoHeight, pointerId: 0 });
      if (canvas!.hasPointerCapture(event.pointerId))
        canvas!.releasePointerCapture(event.pointerId);
    };
    const onPointerCancel = (event: PointerEvent) => {
      if (activePointer !== event.pointerId) return;
      activePointer = null;
      sendControl({ type: "touchUp", x: 0, y: 0, videoWidth, videoHeight, pointerId: 0 });
    };
    const onWindowBlur = () => {
      if (activePointer === null) return;
      activePointer = null;
      sendControl({ type: "touchUp", x: 0, y: 0, videoWidth, videoHeight, pointerId: 0 });
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
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);
    canvas.addEventListener("lostpointercapture", onPointerCancel);
    window.addEventListener("blur", onWindowBlur);
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
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("lostpointercapture", onPointerCancel);
      window.removeEventListener("blur", onWindowBlur);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContextMenu);
      canvas.removeEventListener("keydown", onKeyDown);
      if (activePointer !== null) {
        sendControl({ type: "touchUp", x: 0, y: 0, videoWidth, videoHeight, pointerId: 0 });
      }
      ws?.close();
      disposeDecoder();
      sendControlRef.current = () => {};
      retryRef.current = () => {};
    };
    // Bound to the device id, not this panel's own lifetime — same posture
    // as BrowserPane.tsx/TerminalPane.tsx.
  }, [props.params.deviceId]);

  const controlsDisabled = status !== "open" || stopped || removed;
  return (
    <div className="browser-pane">
      <div className="device-toolbar" role="toolbar" aria-label="Android device controls">
        <div className="device-toolbar-group" aria-label="Navigation">
          <button
            title="Back"
            aria-label="Back"
            disabled={controlsDisabled}
            onClick={() => sendControlRef.current({ type: "back" })}
          >
            ‹
          </button>
          <button
            title="Home"
            aria-label="Home"
            disabled={controlsDisabled}
            onClick={() => pressKey(3)}
          >
            ⌂
          </button>
          <button
            title="Recent apps"
            aria-label="Recent apps"
            disabled={controlsDisabled}
            onClick={() => pressKey(187)}
          >
            ▢
          </button>
        </div>
        <div className="device-toolbar-group" aria-label="Device buttons">
          <button
            title="Power"
            aria-label="Power"
            disabled={controlsDisabled}
            onClick={() => pressKey(26)}
          >
            ⏻
          </button>
          <button
            title="Volume down"
            aria-label="Volume down"
            disabled={controlsDisabled}
            onClick={() => pressKey(25)}
          >
            −
          </button>
          <button
            title="Volume up"
            aria-label="Volume up"
            disabled={controlsDisabled}
            onClick={() => pressKey(24)}
          >
            +
          </button>
        </div>
        <div className="device-toolbar-group" aria-label="Display">
          <button
            title="Rotate device"
            aria-label="Rotate device"
            disabled={controlsDisabled}
            onClick={() => sendControlRef.current({ type: "rotate" })}
          >
            ↻
          </button>
          <button
            title="Take screenshot"
            aria-label="Take screenshot"
            disabled={controlsDisabled || takingScreenshot}
            onClick={() => void takeScreenshot()}
          >
            {takingScreenshot ? "…" : "⇩"}
          </button>
          <button
            title={showFrame ? "Hide device frame" : "Show device frame"}
            aria-label={showFrame ? "Hide device frame" : "Show device frame"}
            aria-pressed={showFrame}
            onClick={toggleFrame}
          >
            ▯
          </button>
        </div>
      </div>
      <div className="browser-pane-canvas-wrap">
        <div className={`device-frame${showFrame ? " visible" : ""}`}>
          <canvas ref={canvasRef} className="browser-pane-canvas" tabIndex={0} />
        </div>
        {lastError && <div className="browser-pane-error-toast">{lastError}</div>}
        {status !== "unsupported" && (status !== "open" || stopped || removed || !hasFrame) && (
          <div
            // While merely waiting for the first frame, let taps/keys through
            // to the canvas — poking the screen is how you wake an idle one.
            style={
              status === "open" && !stopped && !removed ? { pointerEvents: "none" } : undefined
            }
            className={`terminal-status-overlay ${
              stopped || removed ? "failed" : status === "open" ? "connecting" : status
            }`}
          >
            {removed ? (
              <>
                <WifiOffIcon size={22} style={{ color: "var(--dim)" }} />
                <span className="terminal-status-text">
                  This device was deleted — its row is gone, so there is nothing to reconnect to.
                </span>
              </>
            ) : stopped ? (
              <>
                <StopIcon size={22} style={{ color: "var(--dim)" }} />
                <span className="terminal-status-text">Device stopped</span>
                <button className="terminal-status-retry" onClick={handleStart} disabled={starting}>
                  <PlayIcon size={13} />
                  {starting ? "Starting…" : "Start device"}
                </button>
              </>
            ) : (
              (status === "connecting" || status === "open") && (
                <>
                  <Spinner variant="connecting" />
                  <span className="terminal-status-text">
                    {status === "open" ? "Waiting for video…" : "Connecting…"}
                  </span>
                </>
              )
            )}
            {status === "reconnecting" && !stopped && !removed && (
              <>
                <Spinner variant="reconnecting" />
                <span className="terminal-status-text">
                  Reconnecting… <span style={{ color: "var(--muted)" }}>({reconnectAttempt})</span>
                </span>
              </>
            )}
            {status === "failed" && !stopped && !removed && (
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
