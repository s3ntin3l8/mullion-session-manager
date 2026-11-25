import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { KeyboardIcon, RefreshIcon, WifiOffIcon } from "./ui/icons.js";
import { Spinner } from "./ui/Spinner.js";
import { isMacPlatform, macChordPress } from "./browserKeyMap.js";
import { TextInput } from "./ui/primitives.js";
import { browserApi } from "./api/browser.js";
import { useCoarsePointer } from "./lib/layoutTier.js";
import type { ExitedMessage } from "../../src/shared/ws-protocol.js";

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
interface ErrorMessage {
  type: "error";
  message: string;
  /** `binding_unavailable`: the session's recorded browser target is gone. */
  code?: string;
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
type BrowserControlMessage =
  UrlMessage | TitleMessage | ExitedMessage | ErrorMessage | ClipboardMessage;

function parseControlMessage(raw: string): BrowserControlMessage | null {
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
    return {
      type: "error",
      message: v.message,
      ...(typeof v.code === "string" ? { code: v.code } : {}),
    };
  }
  if (v.type === "clipboard" && typeof v.text === "string") {
    return { type: "clipboard", text: v.text };
  }
  return null;
}

// A page with nothing loaded yet reports `about:blank` (Chromium's start
// page). The address bar shows that as empty, its placeholder in view, and
// never sends it back as a navigation: the server refuses any non-http(s)
// target (routes/browser.ts), so a Go or Enter on a fresh pane would
// otherwise raise a "Refusing to navigate" error toast (#3215).
function isBlankAddress(url: string): boolean {
  const trimmed = url.trim();
  return trimmed === "" || trimmed.toLowerCase() === "about:blank";
}

// #3030 — keys the touch keyboard's hidden textarea forwards from `keydown`
// as one `press` each. Text never goes this way: a soft keyboard reports most
// printable keys as `Unidentified`/229 (or reports them here AND again as
// `beforeinput`), so text has exactly one owner, `beforeinput` and
// `compositionend`, and these keys have exactly one owner, this list.
const TOUCH_KEYBOARD_KEYS = new Set([
  "Enter",
  "Backspace",
  "Delete",
  "Tab",
  "Escape",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
]);

// #3030 — `beforeinput` types a soft keyboard raises without a usable
// keydown (its keydown a 229 placeholder), and the key presses that do the
// same in the remote page (Linux Chromium's bindings).
const BEFOREINPUT_KEYS: Record<string, string[]> = {
  deleteContentBackward: ["Backspace"],
  deleteContentForward: ["Delete"],
  deleteWordBackward: ["Control+Backspace"],
  deleteWordForward: ["Control+Delete"],
  deleteSoftLineBackward: ["Shift+Home", "Backspace"],
  deleteHardLineBackward: ["Shift+Home", "Backspace"],
  deleteSoftLineForward: ["Shift+End", "Delete"],
  deleteHardLineForward: ["Shift+End", "Delete"],
  insertLineBreak: ["Enter"],
  insertParagraph: ["Enter"],
  historyUndo: ["Control+z"],
  historyRedo: ["Control+Shift+z"],
};

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
  /** Rendered first in the toolbar: the Browser pane's mode switch (#3371). */
  toolbarStart?: ReactNode;
  /** Rendered last in the toolbar, after reload. */
  toolbarEnd?: ReactNode;
  /** #3003 — rendered right after the address: the Browser pane's quick pick. */
  addressEnd?: ReactNode;
  /** #3373 — the page's own address, as the server reports it. */
  onUrlChange?: (url: string) => void;
  /** #3373 — an address to load, once per `rev`. Held until the socket is
   * open, so a first attach still gets it; only http(s) is ever sent. */
  navigateTo?: { url: string; rev: number };
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [addressInput, setAddressInput] = useState("");
  const [lastError, setLastError] = useState<string | null>(null);
  // Set when the server refuses the attach because the session's recorded
  // browser target is gone (its worktree was deleted, its host was removed):
  // retrying cannot help, only unbinding can.
  const [bindingError, setBindingError] = useState<string | null>(null);
  const [unbinding, setUnbinding] = useState(false);
  // Exposes the mount effect's live `sendControl` (closed over the current
  // WebSocket) to the toolbar's back/forward/reload/navigate buttons,
  // rendered outside the effect — same ref-bridge pattern as TerminalPane's
  // retryRef/refitRef.
  const sendControlRef = useRef<(message: Record<string, unknown>) => void>(() => {});
  const retryRef = useRef<() => void>(() => {});
  // #3030 — on a coarse pointer the canvas cannot raise the on-screen
  // keyboard, so a hidden textarea does: the toolbar's keyboard button
  // focuses it, and what is typed into it goes to the page (see the typing
  // effect below). "Open" means that textarea has focus.
  const coarsePointer = useCoarsePointer();
  const typingInputRef = useRef<HTMLTextAreaElement>(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  // The textarea unmounts without a blur when the pointer turns fine, so
  // the open state would otherwise outlive it.
  if (!coarsePointer && keyboardOpen) setKeyboardOpen(false);
  // The typing effect's commitComposition, for the canvas tap handler.
  const commitTypingRef = useRef<() => void>(() => {});
  const onTitleChangeRef = useRef(props.onTitleChange);
  const onUrlChangeRef = useRef(props.onUrlChange);
  useEffect(() => {
    onTitleChangeRef.current = props.onTitleChange;
    onUrlChangeRef.current = props.onUrlChange;
  });
  // #3373 — a navigation asked for before the socket opened, and the mount
  // effect's way to send it once it can.
  const pendingNavigateRef = useRef<string | null>(null);
  const flushNavigateRef = useRef<() => void>(() => {});

  // "Re-bind" drops the dead binding and attaches again, which resolves the
  // session's current host and checkout; "Unbind" only drops it (the next
  // attach — a Retry, or reopening the pane — re-binds).
  async function unbind(reattach: boolean): Promise<void> {
    setUnbinding(true);
    try {
      await browserApi.unbindSessionBrowser(props.params.sessionId);
      setBindingError(null);
      if (reattach) retryRef.current();
      else setLastError("Browser unbound. Retry to bind it to the session's current checkout.");
    } catch (err) {
      setLastError(`Could not unbind: ${(err as Error).message}`);
    } finally {
      setUnbinding(false);
    }
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    let destroyed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    let bindingBlocked = false;

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
    flushNavigateRef.current = () => {
      const url = pendingNavigateRef.current;
      if (url == null || ws?.readyState !== WebSocket.OPEN) return;
      pendingNavigateRef.current = null;
      sendControl({ type: "navigate", url });
    };

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
        bindingBlocked = false;
        setStatus("open");
        setLastError(null);
        setBindingError(null);
        flushNavigateRef.current();
      });

      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          const message = parseControlMessage(event.data);
          if (!message) return;
          if (message.type === "url") {
            setAddressInput(isBlankAddress(message.url) ? "" : message.url);
            onUrlChangeRef.current?.(message.url);
          } else if (message.type === "title") onTitleChangeRef.current?.(message.title);
          else if (message.type === "exited") setStatus("failed");
          else if (message.type === "error") {
            if (message.code === "binding_unavailable") {
              bindingBlocked = true;
              setBindingError(message.message);
            } else {
              setLastError(message.message);
            }
          } else if (message.type === "clipboard") {
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
        // The server refused the attach with a reason only an unbind clears;
        // reconnecting would just hit it again.
        if (bindingBlocked) {
          setStatus("failed");
          return;
        }
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
      bindingBlocked = false;
      connect();
    };

    connect();

    // Mouse/keyboard forwarding — the canvas shows a scaled bitmap of the
    // remote page, so pointer coordinates are rescaled from CSS pixels to
    // the frame's own pixel dimensions before being sent.
    function canvasPoint(event: { clientX: number; clientY: number }): { x: number; y: number } {
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
      // With the touch keyboard open, a tap on the page (say, on the next
      // form field) must not move focus to the canvas: that would close the
      // keyboard the user is about to type with. preventDefault keeps focus
      // where it is; the click itself still goes to the page.
      const typingInput = typingInputRef.current;
      // A word still being composed is sent first, so it lands in the field
      // it was typed for, not the one this tap moves to.
      if (typingInput && document.activeElement === typingInput) {
        event.preventDefault();
        commitTypingRef.current();
      } else canvas!.focus();
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
    // Touch (the fold's Browser view, a tablet's grid pane): a one-finger
    // drag scrolls the page. Without this a finger could only tap, through
    // the browser's compatibility mouse events, and never scroll. The finger's
    // start point is sent as a mouse move first, because the remote wheel
    // scrolls whatever is under the remote pointer. A tap never moves, so
    // it still arrives as the compatibility click.
    let lastTouch: { x: number; y: number } | null = null;
    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches.length === 1 ? event.touches[0] : undefined;
      if (!touch) {
        lastTouch = null;
        return;
      }
      lastTouch = { x: touch.clientX, y: touch.clientY };
      const { x, y } = canvasPoint(touch);
      sendControl({ type: "mouse", action: "move", x, y });
    };
    const onTouchMove = (event: TouchEvent) => {
      const touch = event.touches.length === 1 ? event.touches[0] : undefined;
      if (!touch) {
        // A second finger (a pinch): forget the drag, so lifting one finger
        // does not scroll by the distance from a stale point.
        lastTouch = null;
        return;
      }
      if (!lastTouch) return;
      const rect = canvas!.getBoundingClientRect();
      const scale = rect.height > 0 ? canvas!.height / rect.height : 1;
      const deltaX = (lastTouch.x - touch.clientX) * scale;
      const deltaY = (lastTouch.y - touch.clientY) * scale;
      lastTouch = { x: touch.clientX, y: touch.clientY };
      if (deltaX === 0 && deltaY === 0) return;
      event.preventDefault();
      sendControl({ type: "mouse", action: "wheel", deltaX, deltaY });
    };
    const onTouchEnd = () => {
      lastTouch = null;
    };
    canvas.addEventListener("touchstart", onTouchStart, { passive: true });
    canvas.addEventListener("touchmove", onTouchMove, { passive: false });
    canvas.addEventListener("touchend", onTouchEnd);
    canvas.addEventListener("touchcancel", onTouchEnd);
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
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
      canvas.removeEventListener("touchcancel", onTouchEnd);
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
      flushNavigateRef.current = () => {};
      retryRef.current = () => {};
    };
    // Bound to the session id, not this panel's own lifetime — matches
    // TerminalPane.tsx's own mount-effect dependency.
  }, [props.params.sessionId]);

  // #3030 — typing into the page from the touch keyboard's hidden textarea.
  // The hard part is that each typed character must reach the page exactly
  // once, whatever mix of events the soft keyboard raises, so each kind of
  // input has one owner:
  // - `keydown` owns only TOUCH_KEYBOARD_KEYS and Ctrl/Cmd chords (a tablet's
  //   hardware keyboard), sent as a `press` with their modifiers, and only
  //   when the key is real: a 229/`Unidentified`/composing keydown is the
  //   soft keyboard's placeholder for something `beforeinput` reports next.
  // - `beforeinput` owns text (`insertText`, `insertReplacementText`, a
  //   paste), sent as one `clipboard` message, which the server types with
  //   insertText; plus the soft keyboard's own deletes, line breaks and
  //   undo, as the matching key. It is cancelled, so the textarea stays empty.
  // - `compositionend` owns IME and autocomplete text (Android keyboards
  //   compose every word): nothing is sent while a composition is open, then
  //   its final text once. The composition's own `beforeinput`s are skipped.
  //   A tap on the page or closing the keyboard mid-word sends the word so
  //   far first (commitComposition), so it lands in the field it was typed
  //   for; compositionend then sends only what came after.
  // - `input` never sends; it only empties the textarea of anything a
  //   non-cancellable event left behind.
  // Keeping the textarea empty outside a composition is what makes "once"
  // hold: the keyboard never sees (so can never rewrite) text already sent.
  useEffect(() => {
    const input = typingInputRef.current;
    if (!coarsePointer || !input) return;
    const send = (message: Record<string, unknown>) => sendControlRef.current(message);
    const press = (key: string) => send({ type: "key", action: "press", key });
    const isOpen = () => document.activeElement === input;
    let composing = false;
    // The open composition's text already sent by commitComposition.
    let composedSent = "";

    // The textarea is empty when a composition starts, so its value is the
    // composition (plus what an early commit already sent, still in it).
    const commitComposition = () => {
      if (!composing) return;
      const text = input.value;
      if (text.startsWith(composedSent) && text.length > composedSent.length) {
        send({ type: "clipboard", text: text.slice(composedSent.length) });
        composedSent = text;
      }
    };
    commitTypingRef.current = commitComposition;

    const withModifiers = (event: KeyboardEvent, key: string) =>
      [
        event.ctrlKey || event.metaKey ? "Control" : null,
        event.altKey ? "Alt" : null,
        event.shiftKey ? "Shift" : null,
        key,
      ]
        .filter(Boolean)
        .join("+");

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isOpen() || composing || event.isComposing || event.keyCode === 229) return;
      // A hardware keyboard's Ctrl/Cmd chord (Cmd maps to Ctrl, as on the
      // canvas): the empty textarea would swallow it. Same clipboard split
      // as the canvas: Ctrl+V is left to the textarea's own paste (which
      // beforeinput sends), Ctrl+C/X ask the server for the page's selection.
      const chord =
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.getModifierState("AltGraph") &&
        event.key.length === 1;
      if (chord) {
        const key = event.key.toLowerCase();
        if (!event.shiftKey && key === "v") return;
        event.preventDefault();
        if (!event.shiftKey && (key === "c" || key === "x")) {
          send({ type: key === "c" ? "copy" : "cut" });
          return;
        }
        press(`Control+${event.shiftKey ? "Shift+" : ""}${key}`);
        return;
      }
      if (!TOUCH_KEYBOARD_KEYS.has(event.key)) return;
      event.preventDefault();
      press(withModifiers(event, event.key));
    };
    const onBeforeInput = (event: InputEvent) => {
      if (!isOpen() || composing || event.isComposing) return;
      const keys = BEFOREINPUT_KEYS[event.inputType];
      if (keys) {
        event.preventDefault();
        keys.forEach(press);
        return;
      }
      switch (event.inputType) {
        case "insertText":
        case "insertReplacementText":
        case "insertFromPaste":
        case "insertFromDrop": {
          const text = event.data ?? event.dataTransfer?.getData("text/plain") ?? "";
          // Not cancelled when there is nothing to send, so a browser that
          // carries the text some other way still inserts it into the
          // textarea (the `input` handler then empties it).
          if (!text) return;
          event.preventDefault();
          send({ type: "clipboard", text });
          return;
        }
        default:
          // Composition steps (insertCompositionText, insertFromComposition,
          // deleteCompositionText) belong to compositionend.
          return;
      }
    };
    const onCompositionStart = () => {
      composing = true;
      composedSent = "";
    };
    const onCompositionEnd = (event: CompositionEvent) => {
      const data = event.data ?? "";
      // After an early commit only the rest is new. A composition the user
      // edited back past what was sent sends nothing more: that part is
      // already in an earlier field.
      const rest = data.startsWith(composedSent) ? data.slice(composedSent.length) : "";
      if (isOpen() && rest) send({ type: "clipboard", text: rest });
      composing = false;
      composedSent = "";
      input.value = "";
    };
    const onInput = () => {
      if (!composing) input.value = "";
    };
    const onBlur = () => {
      // Closing the keyboard mid-word sends the word: on Android every word
      // is a composition until a space, so dropping it would lose it. A
      // compositionend after this one is not sent (the input is not open).
      commitComposition();
      composing = false;
      composedSent = "";
      input.value = "";
    };
    input.addEventListener("keydown", onKeyDown);
    input.addEventListener("beforeinput", onBeforeInput);
    input.addEventListener("compositionstart", onCompositionStart);
    input.addEventListener("compositionend", onCompositionEnd);
    input.addEventListener("input", onInput);
    input.addEventListener("blur", onBlur);
    return () => {
      commitTypingRef.current = () => {};
      input.removeEventListener("keydown", onKeyDown);
      input.removeEventListener("beforeinput", onBeforeInput);
      input.removeEventListener("compositionstart", onCompositionStart);
      input.removeEventListener("compositionend", onCompositionEnd);
      input.removeEventListener("input", onInput);
      input.removeEventListener("blur", onBlur);
    };
  }, [coarsePointer]);

  // Focus is moved inside the tap's own click handler: iOS raises the
  // keyboard only for a focus() made synchronously in a user gesture.
  const toggleKeyboard = () => {
    const input = typingInputRef.current;
    if (!input) return;
    if (document.activeElement === input) input.blur();
    else input.focus({ preventScroll: true });
  };

  const navigateRev = props.navigateTo?.rev;
  const navigateUrl = props.navigateTo?.url;
  useEffect(() => {
    if (navigateRev == null || navigateUrl == null) return;
    // The server refuses anything else too (routes/browser.ts); never send it.
    if (!/^https?:\/\//i.test(navigateUrl)) return;
    pendingNavigateRef.current = navigateUrl;
    flushNavigateRef.current();
  }, [navigateRev, navigateUrl]);

  const navigate = () => {
    const trimmed = addressInput.trim();
    if (!isBlankAddress(trimmed)) sendControlRef.current({ type: "navigate", url: trimmed });
  };

  return (
    <div className="browser-pane">
      <div className="browser-panel-toolbar">
        {props.toolbarStart}
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
        <TextInput
          small
          className="browser-panel-address mono"
          value={addressInput}
          onChange={(event) => setAddressInput(event.target.value)}
          placeholder="https://example.com"
          onKeyDown={(event) => {
            if (event.key === "Enter") navigate();
          }}
        />
        {props.addressEnd}
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
        {coarsePointer && (
          <button
            className="browser-panel-reload browser-pane-keyboard-toggle"
            title={keyboardOpen ? "Hide keyboard" : "Type into the page"}
            aria-label={keyboardOpen ? "Hide keyboard" : "Type into the page"}
            aria-pressed={keyboardOpen}
            // Keeps focus on the open textarea, so a tap to close it is not
            // first a blur (closing it) and then a click (opening it again).
            onMouseDown={(event) => event.preventDefault()}
            onClick={toggleKeyboard}
          >
            <KeyboardIcon size={13} />
          </button>
        )}
        {props.toolbarEnd}
      </div>
      <div className="browser-pane-canvas-wrap">
        <canvas ref={canvasRef} className="browser-pane-canvas" tabIndex={0} />
        {coarsePointer && (
          <textarea
            ref={typingInputRef}
            className="browser-pane-typing-input"
            aria-label="Text to type into the page"
            rows={1}
            // Only ever focused by the keyboard button, never a tab stop: a
            // hardware keyboard would otherwise tab onto an invisible box.
            tabIndex={-1}
            // Empty between words, so the keyboard would otherwise treat
            // every word as a sentence start and capitalize it.
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
            onFocus={() => setKeyboardOpen(true)}
            onBlur={() => setKeyboardOpen(false)}
          />
        )}
        {lastError && <div className="browser-pane-error-toast">{lastError}</div>}
        {bindingError && (
          <div className="terminal-status-overlay failed" role="alert">
            <WifiOffIcon size={22} style={{ color: "var(--r)" }} />
            <span className="terminal-status-text">{bindingError}</span>
            <div>
              <button
                className="terminal-status-retry"
                disabled={unbinding}
                onClick={() => void unbind(true)}
              >
                Re-bind
              </button>{" "}
              <button
                className="terminal-status-retry"
                disabled={unbinding}
                onClick={() => void unbind(false)}
              >
                Unbind
              </button>
            </div>
          </div>
        )}
        {status !== "open" && !bindingError && (
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
