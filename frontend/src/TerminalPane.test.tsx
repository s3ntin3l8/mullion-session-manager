// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, fireEvent } from "@testing-library/react";
import { act } from "react";
import { Terminal } from "@xterm/xterm";
import type { Theme } from "./store.js";
import { useDashboardStore } from "./store.js";
import { TerminalPane } from "./TerminalPane.js";
import { api } from "./api.js";
import type * as ApiModule from "./api.js";
import { registerTerminalRepaint, unregisterTerminalRepaint } from "./terminalRepaintRegistry.js";

vi.mock("./api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: { ...actual.api, uploadSessionImage: vi.fn() } };
});

vi.mock("./terminalRepaintRegistry.js", () => ({
  registerTerminalRepaint: vi.fn(),
  unregisterTerminalRepaint: vi.fn(),
  repaintAllTerminals: vi.fn(),
}));

// Keyed by OSC ident (10/11/12) — populated by the mocked Terminal's
// `parser.registerOscHandler` below so tests can simulate the running
// program sending an OSC query/set payload without a real xterm.js parser.
// Declared via vi.hoisted so the vi.mock("@xterm/xterm", ...) factory below
// (itself hoisted above this file's imports) can close over it safely.
const { oscHandlers } = vi.hoisted(() => ({
  oscHandlers: new Map<number, (data: string) => boolean>(),
}));

interface FakeSocket {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  binaryType: string;
  _openHandlers: Array<() => void>;
}

let fakeSocket: FakeSocket;
let fakeWsSend: ReturnType<typeof vi.fn>;

function oscRegex() {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  return new RegExp(`^${ESC}\\]10;#[\\da-f]{6}${BEL}${ESC}\\]11;#[\\da-f]{6}${BEL}$`, "i");
}

// Once the fake socket reports OPEN, the component's own "open" handler also
// fires a resize JSON send (see TerminalPane.tsx's sendResizeIfOpen) — so the
// OSC push is not reliably `mock.calls[0]`. Scan every send for the one that
// decodes to the OSC 10/11 format instead of assuming call order.
//
// Uses ArrayBuffer.isView rather than `instanceof Uint8Array`: vitest's jsdom
// environment runs the test file in a separate vm-context realm, but the
// source's `new TextEncoder().encode(...)` (TextEncoder is native, tied to
// Node's outer realm) produces a Uint8Array that fails a raw cross-realm
// `instanceof` check against this file's own Uint8Array global even though it
// really is one — `ArrayBuffer.isView` doesn't rely on prototype identity, so
// it's realm-agnostic.
function decodedOscSends(): string[] {
  return fakeWsSend.mock.calls
    .map((call) => call[0] as unknown)
    .filter((arg): arg is ArrayBufferView => ArrayBuffer.isView(arg))
    .map((bytes) => new TextDecoder().decode(bytes))
    .filter((decoded) => oscRegex().test(decoded));
}

vi.mock("@xterm/xterm", () => {
  function createDisposable() {
    return { dispose: vi.fn() };
  }
  const Terminal = vi.fn(function () {
    return {
      options: {} as Record<string, unknown>,
      unicode: {
        _v: "",
        set activeVersion(v: string) {
          this._v = v;
        },
        get activeVersion() {
          return this._v;
        },
      },
      cols: 80,
      rows: 24,
      open: vi.fn(),
      loadAddon: vi.fn(),
      dispose: vi.fn(),
      write: vi.fn(),
      // jsdom has no `document.fonts`, so the settings-sync effect's
      // font-load path (TerminalPane.tsx) takes its synchronous fallback
      // branch on every render, which calls `repaint()` -> `term.refresh()`
      // (issue #107) unconditionally — needed or every existing test throws.
      refresh: vi.fn(),
      hasSelection: vi.fn(() => false),
      getSelection: vi.fn(() => ""),
      paste: vi.fn(),
      onData: vi.fn(() => createDisposable()),
      onTitleChange: vi.fn(() => createDisposable()),
      onSelectionChange: vi.fn(() => createDisposable()),
      attachCustomKeyEventHandler: vi.fn(),
      parser: {
        registerOscHandler: vi.fn((ident: number, cb: (data: string) => boolean) => {
          oscHandlers.set(ident, cb);
          return createDisposable();
        }),
      },
    };
  });
  return { Terminal };
});

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn(function () {
    return { fit: vi.fn() };
  }),
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn(function () {
    return { clearTextureAtlas: vi.fn() };
  }),
}));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: vi.fn() }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: vi.fn() }));

function makeFakeSocket(): FakeSocket {
  const openHandlers: Array<() => void> = [];
  const socket = {
    readyState: 0,
    send: vi.fn(),
    addEventListener: vi.fn((event: string, handler: () => void) => {
      if (event === "open") openHandlers.push(handler);
    }),
    close: vi.fn(),
    binaryType: "",
    _openHandlers: openHandlers,
  };
  return socket;
}

function stubFakeWebSocket(openImmediately: boolean) {
  fakeSocket = makeFakeSocket();
  fakeWsSend = fakeSocket.send;
  if (openImmediately) {
    fakeSocket.readyState = 1;
  }
  // The component gates every send on `ws.readyState === WebSocket.OPEN`, so
  // the stub constructor needs the standard readyState statics too — without
  // these, WebSocket.OPEN is undefined and that comparison is always false,
  // silently swallowing every send this test is trying to observe. Built via
  // Object.assign (typed `object`) since `typeof WebSocket`'s statics are
  // declared read-only — assigning to them directly only type-checks after
  // the fact, via the final cast below.
  const fakeWebSocketCtor: object = Object.assign(
    function () {
      return fakeSocket;
    },
    { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
  );
  vi.stubGlobal("WebSocket", fakeWebSocketCtor as unknown as typeof WebSocket);
}

// The mocked Terminal constructor returns a fresh object literal per call
// (see the @xterm/xterm mock above) — this reaches into vitest's own call-
// tracking to grab whichever instance the most recent renderPane() created,
// the same way fakeSocket/fakeWsSend track the most recent fake WebSocket.
function getLatestTermInstance() {
  const results = (Terminal as unknown as ReturnType<typeof vi.fn>).mock.results;
  return results[results.length - 1]!.value as {
    paste: ReturnType<typeof vi.fn>;
    attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  oscHandlers.clear();
  localStorage.clear();
  vi.stubGlobal(
    "ResizeObserver",
    vi.fn(function () {
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    }),
  );
  vi.mocked(api.uploadSessionImage).mockReset();
  vi.mocked(registerTerminalRepaint).mockClear();
  vi.mocked(unregisterTerminalRepaint).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  Reflect.deleteProperty(navigator, "clipboard");
});

function renderPane() {
  useDashboardStore.setState({
    settings: {
      theme: "dark",
      terminal: {
        fontFamily: "Geist Mono",
        fontSize: 14,
        colorScheme: "default",
        cursorStyle: "block",
        cursorBlink: true,
        scrollback: 1000,
        copyOnSelect: false,
        pasteOnRightClick: false,
        reconnect: { enabled: false, maxAttempts: 0 },
        keyCapture: { ctrlR: true, ctrlL: true, ctrlK: true },
      },
      sidebarDensity: "comfortable",
      projectRoots: [],
      launchers: { defaultShell: "bash", defaultAgent: "claude" },
      notifications: {
        attentionAlerts: false,
        channels: { browser: false, sound: false },
        soundName: "blip" as const,
        idleThresholdSeconds: 300,
        exitedAlerts: false,
      },
      sessions: {
        namePattern: "",
        confirmBeforeKill: false,
        hideEndedSessions: false,
        reconcileIntervalSeconds: 30,
      },
    },
    theme: "dark" as Theme,
    settingsLoaded: true,
    projects: [],
    sessions: [],
    hosts: [],
    workspaces: [],
    groups: [],
  });
  return render(<TerminalPane params={{ sessionId: 1 }} />);
}

describe("TerminalPane repaint registry (issue #107)", () => {
  it("registers this session's repaint on mount and unregisters it on unmount", () => {
    stubFakeWebSocket(true);
    const { unmount } = renderPane();

    expect(registerTerminalRepaint).toHaveBeenCalledTimes(1);
    const [sessionId, repaint] = vi.mocked(registerTerminalRepaint).mock.calls[0]!;
    expect(sessionId).toBe(1);
    expect(repaint).toBeInstanceOf(Function);
    expect(unregisterTerminalRepaint).not.toHaveBeenCalled();

    unmount();

    expect(unregisterTerminalRepaint).toHaveBeenCalledExactlyOnceWith(1);
  });
});

describe("TerminalPane OSC push", () => {
  it("sends OSC 10/11 bytes on theme toggle when socket is OPEN", async () => {
    stubFakeWebSocket(true);
    renderPane();

    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    useDashboardStore.setState({ theme: "light" as Theme });

    await waitFor(() => {
      expect(decodedOscSends().length).toBeGreaterThan(0);
    });
  });

  it("does NOT send when socket is CLOSED, but sends on open", async () => {
    stubFakeWebSocket(false);
    renderPane();

    // act() here (rather than a bare setState) forces the settings-sync
    // effect to flush before the next line — without it, the effect that
    // queues the OSC bytes into pendingOscRef hasn't necessarily run yet by
    // the time the socket's "open" handler is fired manually below, so the
    // drain would find nothing queued and silently no-op.
    act(() => {
      useDashboardStore.setState({ theme: "light" as Theme });
    });

    expect(fakeWsSend).not.toHaveBeenCalled();

    act(() => {
      fakeSocket.readyState = 1;
      for (const handler of fakeSocket._openHandlers) handler();
    });

    // The open handler also fires a resize send (component's own
    // sendResizeIfOpen), so the OSC push isn't necessarily the first call —
    // scan every send for the one matching the OSC 10/11 format.
    await waitFor(() => {
      expect(decodedOscSends().length).toBeGreaterThan(0);
    });

    // Toggle back to dark — prevThemeRef was advanced when the queued bytes
    // were stored, so this correctly detects a new change and sends again.
    fakeWsSend.mockClear();
    act(() => {
      useDashboardStore.setState({ theme: "dark" as Theme });
    });

    await waitFor(() => {
      expect(decodedOscSends().length).toBeGreaterThan(0);
    });
  });

  it("does not send on unrelated pref changes (cursor blink)", async () => {
    stubFakeWebSocket(true);
    renderPane();

    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    useDashboardStore.setState((s) => ({
      settings: { ...s.settings, terminal: { ...s.settings.terminal, cursorBlink: false } },
    }));

    await vi.waitFor(() => {
      expect(fakeWsSend).not.toHaveBeenCalled();
    });
  });
});

describe("TerminalPane OSC 10/11/12 query responder (issue #91)", () => {
  // Every send is a raw byte payload here (unlike decodedOscSends() above,
  // which filters for the `#rrggbb` SET-push format) — decode all of them.
  function decodedSends(): string[] {
    return fakeWsSend.mock.calls
      .map((call) => call[0] as unknown)
      .filter((arg): arg is ArrayBufferView => ArrayBuffer.isView(arg))
      .map((bytes) => new TextDecoder().decode(bytes));
  }

  it("answers an OSC 11 background query with the live scheme's background, rgb: doubled-hex form", async () => {
    stubFakeWebSocket(true);
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    fakeWsSend.mockClear();

    const handled = oscHandlers.get(11)!("?");

    expect(handled).toBe(true);
    // Tessera Dark's dark background is #0d0d0d (terminalSchemes.ts).
    expect(decodedSends()).toContain("\x1b]11;rgb:0d0d/0d0d/0d0d\x07");
  });

  it("answers OSC 10 (foreground) and OSC 12 (cursor) queries too", async () => {
    stubFakeWebSocket(true);
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    fakeWsSend.mockClear();

    oscHandlers.get(10)!("?");
    oscHandlers.get(12)!("?");

    // Tessera Dark's dark foreground/cursor is #ededed.
    expect(decodedSends()).toContain("\x1b]10;rgb:eded/eded/eded\x07");
    expect(decodedSends()).toContain("\x1b]12;rgb:eded/eded/eded\x07");
  });

  it("does not answer (and reports unhandled) a non-query OSC 11 payload, leaving it for xterm's own SET handling", async () => {
    stubFakeWebSocket(true);
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    fakeWsSend.mockClear();

    const handled = oscHandlers.get(11)!("#112233");

    expect(handled).toBe(false);
    expect(fakeWsSend).not.toHaveBeenCalled();
  });

  it("swallows the query without sending when the socket isn't open", async () => {
    stubFakeWebSocket(false);
    renderPane();

    const handled = oscHandlers.get(11)!("?");

    expect(handled).toBe(true);
    expect(fakeWsSend).not.toHaveBeenCalled();
  });
});

describe("TerminalPane image paste/upload (issue #68)", () => {
  // Simulates the Cmd+V chord attachKeyConflictHandler listens for, by
  // invoking whatever callback the (mocked) term.attachCustomKeyEventHandler
  // was last registered with — the mount effect and the settings-sync effect
  // that runs right after it both register one, and both close over the same
  // pasteHandlerRef, so the most recent registration is equivalent to either.
  function triggerPasteChord() {
    const term = getLatestTermInstance();
    const calls = term.attachCustomKeyEventHandler.mock.calls;
    const handler = calls[calls.length - 1]![0] as (event: unknown) => boolean;
    act(() => {
      handler({
        type: "keydown",
        key: "v",
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        preventDefault: vi.fn(),
      });
    });
  }

  it("uploads a clipboard image and injects its path instead of pasting text", async () => {
    stubFakeWebSocket(true);
    const blob = new Blob(["fake"], { type: "image/png" });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: vi
          .fn()
          .mockResolvedValue([{ types: ["image/png"], getType: vi.fn().mockResolvedValue(blob) }]),
        readText: vi.fn().mockResolvedValue("should not be used"),
      },
    });
    vi.mocked(api.uploadSessionImage).mockResolvedValue({ path: "/cwd/.tessera-uploads/x.png" });

    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    triggerPasteChord();

    await waitFor(() => expect(api.uploadSessionImage).toHaveBeenCalledWith(1, blob));
    await waitFor(() => {
      expect(getLatestTermInstance().paste).toHaveBeenCalledWith("/cwd/.tessera-uploads/x.png ");
    });
    expect(navigator.clipboard.readText).not.toHaveBeenCalled();
  });

  it("falls back to a text paste when the clipboard has no image entry", async () => {
    stubFakeWebSocket(true);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: vi.fn().mockResolvedValue([{ types: ["text/plain"], getType: vi.fn() }]),
        readText: vi.fn().mockResolvedValue("hello"),
      },
    });

    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    triggerPasteChord();

    await waitFor(() => expect(getLatestTermInstance().paste).toHaveBeenCalledWith("hello"));
    expect(api.uploadSessionImage).not.toHaveBeenCalled();
  });

  it("falls back to a text paste when navigator.clipboard.read is unavailable", async () => {
    stubFakeWebSocket(true);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: vi.fn().mockResolvedValue("plain text") },
    });

    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    triggerPasteChord();

    await waitFor(() => expect(getLatestTermInstance().paste).toHaveBeenCalledWith("plain text"));
    expect(api.uploadSessionImage).not.toHaveBeenCalled();
  });

  it("uploads a file selected via the attach-image button and injects its path", async () => {
    stubFakeWebSocket(true);
    vi.mocked(api.uploadSessionImage).mockResolvedValue({ path: "/cwd/.tessera-uploads/y.jpg" });

    const { container } = renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["fake"], "photo.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(api.uploadSessionImage).toHaveBeenCalledWith(1, file));
    await waitFor(() => {
      expect(getLatestTermInstance().paste).toHaveBeenCalledWith("/cwd/.tessera-uploads/y.jpg ");
    });
  });

  it("shows an error toast when the upload fails", async () => {
    stubFakeWebSocket(true);
    vi.mocked(api.uploadSessionImage).mockRejectedValue(new Error("network error"));

    const { container, getByText } = renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["fake"], "photo.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(getByText("Image upload failed")).toBeTruthy());
  });
});
