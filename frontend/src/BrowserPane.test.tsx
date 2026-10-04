// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { BrowserPane } from "./BrowserPane.js";

// Same fake-WebSocket shape as TerminalPane.test.tsx, extended to also track
// message/close handlers (that file only ever needed "open"). BrowserPane
// has no xterm/dockview dependency, so this is otherwise a much simpler
// component test.
interface FakeSocket {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  binaryType: string;
  _openHandlers: Array<() => void>;
  _messageHandlers: Array<(event: { data: unknown }) => void>;
  _closeHandlers: Array<() => void>;
}

let fakeSocket: FakeSocket;

function makeFakeSocket(): FakeSocket {
  const openHandlers: Array<() => void> = [];
  const messageHandlers: Array<(event: { data: unknown }) => void> = [];
  const closeHandlers: Array<() => void> = [];
  return {
    readyState: 0,
    send: vi.fn(),
    addEventListener: vi.fn((event: string, handler: (arg?: unknown) => void) => {
      if (event === "open") openHandlers.push(handler as () => void);
      else if (event === "message")
        messageHandlers.push(handler as (event: { data: unknown }) => void);
      else if (event === "close") closeHandlers.push(handler as () => void);
    }),
    close: vi.fn(),
    binaryType: "",
    _openHandlers: openHandlers,
    _messageHandlers: messageHandlers,
    _closeHandlers: closeHandlers,
  };
}

function stubFakeWebSocket() {
  fakeSocket = makeFakeSocket();
  const fakeWebSocketCtor: object = Object.assign(
    function () {
      return fakeSocket;
    },
    { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
  );
  vi.stubGlobal("WebSocket", fakeWebSocketCtor as unknown as typeof WebSocket);
}

function openSocket() {
  fakeSocket.readyState = 1;
  act(() => {
    fakeSocket._openHandlers.forEach((h) => h());
  });
}

function emitControlMessage(payload: Record<string, unknown>) {
  act(() => {
    fakeSocket._messageHandlers.forEach((h) => h({ data: JSON.stringify(payload) }));
  });
}

async function emitBinaryFrame(bytes = 4) {
  await act(async () => {
    fakeSocket._messageHandlers.forEach((h) => h({ data: new ArrayBuffer(bytes) }));
    // paintFrame chains through createImageBitmap's promise before drawing.
    await Promise.resolve();
    await Promise.resolve();
  });
}

let fakeCtx: { drawImage: ReturnType<typeof vi.fn> };

beforeEach(() => {
  stubFakeWebSocket();
  fakeCtx = { drawImage: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    fakeCtx as unknown as CanvasRenderingContext2D,
  );
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 10, height: 10, close: vi.fn() })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("BrowserPane", () => {
  it("connects to /ws/browser/:sessionId on mount", () => {
    render(<BrowserPane params={{ sessionId: 42 }} />);
    expect(fakeSocket.binaryType).toBe("arraybuffer");
  });

  it("shows a connecting overlay before the socket opens, then clears it", () => {
    const { container } = render(<BrowserPane params={{ sessionId: 1 }} />);
    expect(container.querySelector(".terminal-status-overlay.connecting")).not.toBeNull();

    openSocket();
    expect(container.querySelector(".terminal-status-overlay")).toBeNull();
  });

  it("updates the address bar from a url control message", () => {
    const { container } = render(<BrowserPane params={{ sessionId: 1 }} />);
    openSocket();
    emitControlMessage({ type: "url", url: "https://example.com/page" });

    const input = container.querySelector<HTMLInputElement>(".browser-panel-address")!;
    expect(input.value).toBe("https://example.com/page");
  });

  it("calls onTitleChange on a title control message", () => {
    const onTitleChange = vi.fn();
    render(<BrowserPane params={{ sessionId: 1 }} onTitleChange={onTitleChange} />);
    openSocket();
    emitControlMessage({ type: "title", title: "My Page" });

    expect(onTitleChange).toHaveBeenCalledWith("My Page");
  });

  it("shows a disconnected overlay with retry on an exited control message", () => {
    const { container } = render(<BrowserPane params={{ sessionId: 1 }} />);
    openSocket();
    emitControlMessage({ type: "exited" });

    const overlay = container.querySelector(".terminal-status-overlay.failed");
    expect(overlay).not.toBeNull();
    expect(overlay!.textContent).toContain("Disconnected");
  });

  it("shows an error toast on an error control message", () => {
    const { container } = render(<BrowserPane params={{ sessionId: 1 }} />);
    openSocket();
    emitControlMessage({ type: "error", message: "Refusing to navigate to file://" });

    expect(container.querySelector(".browser-pane-error-toast")?.textContent).toBe(
      "Refusing to navigate to file://",
    );
  });

  it("ignores malformed and unrecognized control messages", () => {
    const onTitleChange = vi.fn();
    const { container } = render(
      <BrowserPane params={{ sessionId: 1 }} onTitleChange={onTitleChange} />,
    );
    openSocket();

    emitControlMessage({ type: "something-unknown" });
    act(() => {
      fakeSocket._messageHandlers.forEach((h) => h({ data: "not json{{{" }));
    });

    expect(onTitleChange).not.toHaveBeenCalled();
    expect(container.querySelector(".terminal-status-overlay")).toBeNull();
  });

  it("paints a binary frame via createImageBitmap + drawImage", async () => {
    render(<BrowserPane params={{ sessionId: 1 }} />);
    openSocket();
    await emitBinaryFrame();

    expect(vi.mocked(createImageBitmap)).toHaveBeenCalled();
    expect(fakeCtx.drawImage).toHaveBeenCalled();
  });

  it("sends a navigate control message when Go is clicked", () => {
    const { container } = render(<BrowserPane params={{ sessionId: 1 }} />);
    openSocket();

    const input = container.querySelector<HTMLInputElement>(".browser-panel-address")!;
    fireEvent.change(input, { target: { value: "https://example.com" } });
    fireEvent.click(container.querySelector(".browser-panel-go")!);

    expect(fakeSocket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "navigate", url: "https://example.com" }),
    );
  });

  it("does not send navigate for an empty address", () => {
    const { container } = render(<BrowserPane params={{ sessionId: 1 }} />);
    openSocket();
    fireEvent.click(container.querySelector(".browser-panel-go")!);
    expect(fakeSocket.send).not.toHaveBeenCalled();
  });

  it("sends back/forward/reload control messages from the toolbar", () => {
    const { container } = render(<BrowserPane params={{ sessionId: 1 }} />);
    openSocket();

    fireEvent.click(container.querySelector('[title="Back"]')!);
    fireEvent.click(container.querySelector('[title="Forward"]')!);
    fireEvent.click(container.querySelector('[title="Reload"]')!);

    expect(fakeSocket.send).toHaveBeenCalledWith(JSON.stringify({ type: "back" }));
    expect(fakeSocket.send).toHaveBeenCalledWith(JSON.stringify({ type: "forward" }));
    expect(fakeSocket.send).toHaveBeenCalledWith(JSON.stringify({ type: "reload" }));
  });

  it("forwards mouse click/move/wheel events from the canvas", () => {
    const { container } = render(<BrowserPane params={{ sessionId: 1 }} />);
    openSocket();
    const canvas = container.querySelector("canvas")!;
    // Canvas defaults to 300x150 (the HTML spec default, not 0) — pin both
    // the backing-buffer size and the mocked CSS rect to the same 100x100 so
    // the scale factor is a clean 1:1 and expected coordinates below aren't
    // scaled.
    canvas.width = 100;
    canvas.height = 100;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      right: 100,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.mouseMove(canvas, { clientX: 10, clientY: 20 });
    fireEvent.mouseDown(canvas, { clientX: 10, clientY: 20, button: 0 });
    fireEvent.mouseUp(canvas, { button: 0 });
    fireEvent.wheel(canvas, { deltaX: 1, deltaY: 2 });

    const sentTypes = fakeSocket.send.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(sentTypes).toContainEqual({ type: "mouse", action: "move", x: 10, y: 20 });
    expect(sentTypes).toContainEqual({
      type: "mouse",
      action: "down",
      x: 10,
      y: 20,
      button: "left",
    });
    expect(sentTypes).toContainEqual({ type: "mouse", action: "up", button: "left" });
    expect(sentTypes).toContainEqual({ type: "mouse", action: "wheel", deltaX: 1, deltaY: 2 });
  });

  it("forwards keydown/keyup from the canvas", () => {
    const { container } = render(<BrowserPane params={{ sessionId: 1 }} />);
    openSocket();
    const canvas = container.querySelector("canvas")!;

    fireEvent.keyDown(canvas, { key: "Enter" });
    fireEvent.keyUp(canvas, { key: "Enter" });

    const sentTypes = fakeSocket.send.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(sentTypes).toContainEqual({ type: "key", action: "down", key: "Enter" });
    expect(sentTypes).toContainEqual({ type: "key", action: "up", key: "Enter" });
  });

  describe("macOS Cmd mapping (#1503)", () => {
    function sent() {
      return fakeSocket.send.mock.calls.map((c) => JSON.parse(c[0] as string));
    }
    function setup(platform: string) {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      const { container } = render(<BrowserPane params={{ sessionId: 1 }} />);
      openSocket();
      return container.querySelector("canvas")!;
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("sends Cmd+A as one Control+a press and never forwards Meta", () => {
      const canvas = setup("MacIntel");

      fireEvent.keyDown(canvas, { key: "Meta", code: "MetaLeft", metaKey: true });
      fireEvent.keyDown(canvas, { key: "a", code: "KeyA", metaKey: true });
      fireEvent.keyUp(canvas, { key: "a", code: "KeyA", metaKey: true });
      fireEvent.keyUp(canvas, { key: "Meta", code: "MetaLeft" });

      expect(sent()).toEqual([{ type: "key", action: "press", key: "Control+a" }]);
    });

    it("maps Cmd+Left/Right to Home/End and Cmd+Up/Down to Control+Home/End", () => {
      const canvas = setup("MacIntel");

      for (const [key, code] of [
        ["ArrowLeft", "ArrowLeft"],
        ["ArrowRight", "ArrowRight"],
        ["ArrowUp", "ArrowUp"],
        ["ArrowDown", "ArrowDown"],
      ]) {
        fireEvent.keyDown(canvas, { key, code, metaKey: true });
        fireEvent.keyUp(canvas, { key, code, metaKey: true });
      }
      fireEvent.keyDown(canvas, { key: "Backspace", code: "Backspace", metaKey: true });

      expect(sent()).toEqual([
        { type: "key", action: "press", key: "Home" },
        { type: "key", action: "press", key: "End" },
        { type: "key", action: "press", key: "Control+Home" },
        { type: "key", action: "press", key: "Control+End" },
        { type: "key", action: "press", key: "Control+Backspace" },
      ]);
    });

    it("keeps the real Shift down and leaves it out of the chord (Cmd+Shift+Z)", () => {
      const canvas = setup("MacIntel");

      fireEvent.keyDown(canvas, { key: "Shift", code: "ShiftLeft", shiftKey: true });
      fireEvent.keyDown(canvas, { key: "Meta", code: "MetaLeft", metaKey: true, shiftKey: true });
      fireEvent.keyDown(canvas, { key: "Z", code: "KeyZ", metaKey: true, shiftKey: true });

      expect(sent()).toEqual([
        { type: "key", action: "down", key: "Shift" },
        { type: "key", action: "press", key: "Control+z" },
      ]);
    });

    it("suppresses the chord key's keyup even when Shift was released first", () => {
      const canvas = setup("MacIntel");

      fireEvent.keyDown(canvas, { key: "Z", code: "KeyZ", metaKey: true, shiftKey: true });
      // Shift released before z, so the keyup's event.key is now lowercase.
      fireEvent.keyUp(canvas, { key: "z", code: "KeyZ", metaKey: true });

      expect(sent()).toEqual([{ type: "key", action: "press", key: "Control+z" }]);
    });

    it("keeps Cmd+C/V/X on the clipboard path", () => {
      const canvas = setup("MacIntel");

      fireEvent.keyDown(canvas, { key: "c", code: "KeyC", metaKey: true });
      fireEvent.keyDown(canvas, { key: "x", code: "KeyX", metaKey: true });
      fireEvent.keyDown(canvas, { key: "v", code: "KeyV", metaKey: true });

      expect(sent()).toEqual([{ type: "copy" }, { type: "cut" }]);
    });

    it("forwards a real Ctrl chord and Cmd+Alt unchanged on a Mac", () => {
      const canvas = setup("MacIntel");

      fireEvent.keyDown(canvas, { key: "a", code: "KeyA", ctrlKey: true });
      fireEvent.keyDown(canvas, { key: "a", code: "KeyA", metaKey: true, altKey: true });

      expect(sent()).toEqual([
        { type: "key", action: "down", key: "a" },
        { type: "key", action: "down", key: "a" },
      ]);
    });

    it("leaves Meta untouched on a non-Mac client", () => {
      const canvas = setup("Linux x86_64");

      fireEvent.keyDown(canvas, { key: "Meta", code: "MetaLeft", metaKey: true });
      fireEvent.keyDown(canvas, { key: "a", code: "KeyA", metaKey: true });
      fireEvent.keyUp(canvas, { key: "Meta", code: "MetaLeft" });

      expect(sent()).toEqual([
        { type: "key", action: "down", key: "Meta" },
        { type: "key", action: "down", key: "a" },
        { type: "key", action: "up", key: "Meta" },
      ]);
    });

    it("prefers userAgentData.platform over navigator.platform", () => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
      Object.defineProperty(navigator, "userAgentData", {
        value: { platform: "macOS" },
        configurable: true,
      });
      try {
        const { container } = render(<BrowserPane params={{ sessionId: 1 }} />);
        openSocket();
        fireEvent.keyDown(container.querySelector("canvas")!, {
          key: "a",
          code: "KeyA",
          metaKey: true,
        });
        expect(sent()).toEqual([{ type: "key", action: "press", key: "Control+a" }]);
      } finally {
        delete (navigator as { userAgentData?: unknown }).userAgentData;
      }
    });
  });

  describe("clipboard", () => {
    it("does not prevent or forward a Ctrl+V keydown, leaving it to the native paste event", () => {
      const { container } = render(<BrowserPane params={{ sessionId: 1 }} />);
      openSocket();
      const canvas = container.querySelector("canvas")!;

      const event = fireEvent.keyDown(canvas, { key: "v", ctrlKey: true });
      // testing-library's fireEvent returns false when preventDefault() was
      // called during dispatch.
      expect(event).toBe(true);
      expect(fakeSocket.send).not.toHaveBeenCalled();

      // Cmd+V (macOS) behaves the same.
      const metaEvent = fireEvent.keyDown(canvas, { key: "v", metaKey: true });
      expect(metaEvent).toBe(true);
      expect(fakeSocket.send).not.toHaveBeenCalled();
    });

    it("does not forward the matching Ctrl+V keyup either, since the keydown was never sent", () => {
      const { container } = render(<BrowserPane params={{ sessionId: 1 }} />);
      openSocket();
      const canvas = container.querySelector("canvas")!;

      fireEvent.keyDown(canvas, { key: "v", ctrlKey: true });
      fireEvent.keyUp(canvas, { key: "v", ctrlKey: true });

      // A raw "up" with no matching "down" would be an orphaned keyup on
      // the page — the keydown above was deliberately never forwarded (see
      // the previous test), so the keyup must be suppressed too.
      expect(fakeSocket.send).not.toHaveBeenCalled();
    });

    it("forwards Ctrl+Shift+V/C/X as ordinary keys, not as the clipboard gesture", () => {
      const { container } = render(<BrowserPane params={{ sessionId: 1 }} />);
      openSocket();
      const canvas = container.querySelector("canvas")!;

      fireEvent.keyDown(canvas, { key: "v", ctrlKey: true, shiftKey: true });
      fireEvent.keyDown(canvas, { key: "c", ctrlKey: true, shiftKey: true });
      fireEvent.keyDown(canvas, { key: "x", ctrlKey: true, shiftKey: true });

      const sentTypes = fakeSocket.send.mock.calls.map((c) => JSON.parse(c[0] as string));
      expect(sentTypes).toContainEqual({ type: "key", action: "down", key: "v" });
      expect(sentTypes).toContainEqual({ type: "key", action: "down", key: "c" });
      expect(sentTypes).toContainEqual({ type: "key", action: "down", key: "x" });
      expect(sentTypes).not.toContainEqual({ type: "copy" });
      expect(sentTypes).not.toContainEqual({ type: "cut" });
    });

    it("sends a paste's clipboard text as a clipboard control message", () => {
      const { container } = render(<BrowserPane params={{ sessionId: 1 }} />);
      openSocket();
      const canvas = container.querySelector("canvas")!;

      const paste = new Event("paste", { bubbles: true, cancelable: true });
      Object.assign(paste, { clipboardData: { getData: () => "hällö \u{1F600}" } });
      canvas.dispatchEvent(paste);

      expect(paste.defaultPrevented).toBe(true);
      expect(fakeSocket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "clipboard", text: "hällö \u{1F600}" }),
      );
    });

    it("sends nothing on paste when the clipboard text is empty", () => {
      const { container } = render(<BrowserPane params={{ sessionId: 1 }} />);
      openSocket();
      const canvas = container.querySelector("canvas")!;

      const paste = new Event("paste", { bubbles: true, cancelable: true });
      Object.assign(paste, { clipboardData: { getData: () => "" } });
      canvas.dispatchEvent(paste);

      expect(fakeSocket.send).not.toHaveBeenCalled();
    });

    it("sends a copy control message on Ctrl+C and does not forward the raw key", () => {
      const { container } = render(<BrowserPane params={{ sessionId: 1 }} />);
      openSocket();
      const canvas = container.querySelector("canvas")!;

      const event = fireEvent.keyDown(canvas, { key: "c", ctrlKey: true });
      expect(event).toBe(false); // preventDefault() was called
      expect(fakeSocket.send).toHaveBeenCalledWith(JSON.stringify({ type: "copy" }));
      expect(fakeSocket.send).not.toHaveBeenCalledWith(
        JSON.stringify({ type: "key", action: "down", key: "c" }),
      );

      // The matching keyup for the intercepted key must also not forward.
      fireEvent.keyUp(canvas, { key: "c", ctrlKey: true });
      expect(fakeSocket.send).not.toHaveBeenCalledWith(
        JSON.stringify({ type: "key", action: "up", key: "c" }),
      );
    });

    it("sends a cut control message on Cmd+X", () => {
      const { container } = render(<BrowserPane params={{ sessionId: 1 }} />);
      openSocket();
      const canvas = container.querySelector("canvas")!;

      fireEvent.keyDown(canvas, { key: "x", metaKey: true });
      expect(fakeSocket.send).toHaveBeenCalledWith(JSON.stringify({ type: "cut" }));
    });

    it("still forwards other Ctrl chords (e.g. Ctrl+A) as a raw key", () => {
      const { container } = render(<BrowserPane params={{ sessionId: 1 }} />);
      openSocket();
      const canvas = container.querySelector("canvas")!;

      fireEvent.keyDown(canvas, { key: "a", ctrlKey: true });
      expect(fakeSocket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "key", action: "down", key: "a" }),
      );
    });

    it("writes an inbound clipboard message to the host clipboard only while focused", () => {
      const writeText = vi.fn(() => Promise.resolve());
      vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
      render(<BrowserPane params={{ sessionId: 1 }} />);
      openSocket();

      const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
      emitControlMessage({ type: "clipboard", text: "from page" });
      expect(writeText).not.toHaveBeenCalled();

      hasFocus.mockReturnValue(true);
      emitControlMessage({ type: "clipboard", text: "from page" });
      expect(writeText).toHaveBeenCalledWith("from page");
      hasFocus.mockRestore();
    });

    it("swallows a rejected host clipboard write silently", async () => {
      const writeText = vi.fn(() => Promise.reject(new Error("denied")));
      vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
      render(<BrowserPane params={{ sessionId: 1 }} />);
      openSocket();
      vi.spyOn(document, "hasFocus").mockReturnValue(true);

      expect(() => {
        emitControlMessage({ type: "clipboard", text: "x" });
      }).not.toThrow();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(writeText).toHaveBeenCalled();
    });
  });

  it("closes the socket on unmount", () => {
    const { unmount } = render(<BrowserPane params={{ sessionId: 1 }} />);
    openSocket();
    unmount();
    expect(fakeSocket.close).toHaveBeenCalled();
  });

  it("reconnects to a new session id when params.sessionId changes", () => {
    const { rerender } = render(<BrowserPane params={{ sessionId: 1 }} />);
    const firstSocket = fakeSocket;
    rerender(<BrowserPane params={{ sessionId: 2 }} />);
    expect(firstSocket.close).toHaveBeenCalled();
  });
});
