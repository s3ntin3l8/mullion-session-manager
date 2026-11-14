// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { Terminal } from "@xterm/xterm";
import { useDashboardStore } from "./store/index.js";
import { TerminalPane } from "./TerminalPane.js";
import { api } from "./api/index.js";
import type * as ApiModule from "./api/index.js";
import type { Session } from "./api/index.js";
import { makeProject, makeSession as makeStoreSession } from "./test/fixtures.js";
import { resetStore } from "./test/resetStore.js";
import { registerTerminalInput, unregisterTerminalInput } from "./terminalInputRegistry.js";
import { DockSidebarView } from "./right-sidebar/DockSidebarView.js";
import type { RightSidebarActions } from "./right-sidebar/views.js";
import { DockLogPane } from "./dock/DockLogPane.js";

// TerminalPane's `readOnly` (#3012), with the real component over a small
// xterm stand-in. Kept apart from TerminalPane.test.tsx, which is at its size
// ceiling; the stand-in here is only what mounting needs.

vi.mock("./api/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: { ...actual.api, uploadSessionFile: vi.fn() } };
});
vi.mock("./terminalRepaintRegistry.js", () => ({
  registerTerminalRepaint: vi.fn(),
  unregisterTerminalRepaint: vi.fn(),
  repaintAllTerminals: vi.fn(),
}));
vi.mock("./terminalInputRegistry.js", () => ({
  registerTerminalInput: vi.fn(),
  unregisterTerminalInput: vi.fn(),
}));

vi.mock("@xterm/xterm", () => {
  const disposable = () => ({ dispose: vi.fn() });
  const Terminal = vi.fn(function () {
    const buffer = { type: "normal", getLine: vi.fn(() => undefined), length: 0 };
    return {
      options: {} as Record<string, unknown>,
      unicode: { activeVersion: "" },
      cols: 80,
      rows: 24,
      element: undefined,
      textarea: document.createElement("textarea"),
      modes: { applicationCursorKeysMode: false, mouseTrackingMode: "none" },
      buffer: { active: buffer, normal: buffer },
      resize: vi.fn(),
      reset: vi.fn(),
      open: vi.fn(),
      loadAddon: vi.fn(),
      dispose: vi.fn(),
      write: vi.fn((_data: unknown, cb?: () => void) => cb?.()),
      refresh: vi.fn(),
      hasSelection: vi.fn(() => false),
      getSelection: vi.fn(() => ""),
      clearSelection: vi.fn(),
      paste: vi.fn(),
      focus: vi.fn(),
      input: vi.fn(),
      scrollLines: vi.fn(),
      onData: vi.fn(disposable),
      onTitleChange: vi.fn(disposable),
      onSelectionChange: vi.fn(disposable),
      attachCustomKeyEventHandler: vi.fn(),
      registerLinkProvider: vi.fn(disposable),
      parser: {
        registerOscHandler: vi.fn(disposable),
        registerCsiHandler: vi.fn(disposable),
        registerDcsHandler: vi.fn(disposable),
      },
    };
  });
  return { Terminal };
});
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn(function () {
    return { fit: vi.fn(), proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 })) };
  }),
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn(function () {
    return {
      clearTextureAtlas: vi.fn(),
      dispose: vi.fn(),
      onContextLoss: vi.fn(() => ({ dispose: vi.fn() })),
    };
  }),
}));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: vi.fn() }));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: vi.fn(function () {
    return {
      dispose: vi.fn(),
      findNext: vi.fn(() => true),
      findPrevious: vi.fn(() => true),
      clearDecorations: vi.fn(),
      clearActiveDecoration: vi.fn(),
      onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })),
    };
  }),
}));

type MockTerm = {
  onData: ReturnType<typeof vi.fn>;
  attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
  paste: ReturnType<typeof vi.fn>;
  textarea: HTMLTextAreaElement;
};
function latestTerm(): MockTerm {
  const results = vi.mocked(Terminal).mock.results;
  return results[results.length - 1]!.value as MockTerm;
}

let wsSend: ReturnType<typeof vi.fn>;
let openHandlers: Array<() => void>;
function stubSocket() {
  wsSend = vi.fn();
  openHandlers = [];
  const socket = {
    readyState: 1,
    binaryType: "",
    send: wsSend,
    close: vi.fn(),
    addEventListener: vi.fn((type: string, handler: () => void) => {
      if (type === "open") openHandlers.push(handler);
    }),
  };
  vi.stubGlobal(
    "WebSocket",
    Object.assign(
      function () {
        return socket;
      },
      { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
    ),
  );
}

beforeEach(() => {
  localStorage.clear();
  resetStore({});
  stubSocket();
  vi.stubGlobal(
    "ResizeObserver",
    vi.fn(function (this: unknown, callback: ResizeObserverCallback) {
      return {
        observe: vi.fn(() => callback([], this as ResizeObserver)),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
      };
    }),
  );
  vi.mocked(registerTerminalInput).mockClear();
  vi.mocked(unregisterTerminalInput).mockClear();
  vi.mocked(Terminal).mockClear();
  vi.mocked(api.uploadSessionFile).mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "clipboard");
});

const renderPane = (extra: { readOnly?: boolean } = {}) =>
  render(<TerminalPane params={{ sessionId: 1 }} {...extra} />);

// #3012 — the right sidebar's Dock view shows a monitor's log through a
// read-only pane. The key bar routes by session id and cannot tell this mount
// from the session's own pane, so a read-only pane must never register.
describe("TerminalPane readOnly (#3012)", () => {
  it("registers as a key-bar target without readOnly (the control)", () => {
    renderPane();
    expect(registerTerminalInput).toHaveBeenCalledTimes(1);
  });

  it("does not register or unregister a terminal input handle", () => {
    const { unmount } = renderPane({ readOnly: true });
    expect(Terminal).toHaveBeenCalled();
    expect(registerTerminalInput).not.toHaveBeenCalled();
    unmount();
    expect(unregisterTerminalInput).not.toHaveBeenCalled();
  });

  it("disables stdin and sends nothing typed to the PTY", () => {
    renderPane({ readOnly: true });
    const ctorOptions = vi.mocked(Terminal).mock.calls.at(-1)![0] as { disableStdin?: boolean };
    expect(ctorOptions.disableStdin).toBe(true);
    const onData = latestTerm().onData.mock.calls[0]![0] as (data: string) => void;
    wsSend.mockClear();
    onData("rm -rf /\r");
    expect(wsSend).not.toHaveBeenCalled();
  });

  it("writes nothing but resizes to the PTY: no theme push, no colour reply", () => {
    useDashboardStore.setState({ theme: "dark" });
    renderPane({ readOnly: true });
    act(() => openHandlers.forEach((open) => open()));
    act(() => useDashboardStore.setState({ theme: "light" }));
    const term = latestTerm() as MockTerm & {
      parser: { registerOscHandler: ReturnType<typeof vi.fn> };
    };
    // A program asking for the background colour gets no answer.
    const osc11 = term.parser.registerOscHandler.mock.calls.find((c) => c[0] === 11)!;
    expect((osc11[1] as (data: string) => boolean)("?")).toBe(true);
    // Every frame sent since mount is a JSON control message (a resize),
    // never bytes for the PTY.
    const frames = wsSend.mock.calls.map((c) => c[0] as unknown);
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(typeof frame).toBe("string");
      expect(JSON.parse(frame as string)).toMatchObject({ type: "resize" });
    }
  });

  it("pushes the theme to the PTY without readOnly (the control)", () => {
    useDashboardStore.setState({ theme: "dark" });
    renderPane();
    act(() => openHandlers.forEach((open) => open()));
    act(() => useDashboardStore.setState({ theme: "light" }));
    expect(wsSend.mock.calls.some((c) => typeof c[0] !== "string")).toBe(true);
  });

  it("asks for no on-screen keyboard and accepts no text", () => {
    renderPane({ readOnly: true });
    const { textarea } = latestTerm();
    expect(textarea.getAttribute("inputmode")).toBe("none");
    expect(textarea.hasAttribute("readonly")).toBe(true);
  });

  it("shows no attach button and ignores the paste chord", async () => {
    const blob = new Blob(["fake"], { type: "image/png" });
    const read = vi
      .fn()
      .mockResolvedValue([{ types: ["image/png"], getType: vi.fn().mockResolvedValue(blob) }]);
    const readText = vi.fn().mockResolvedValue("pasted");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { read, readText },
    });
    renderPane({ readOnly: true });
    expect(screen.queryByRole("button", { name: "Attach files" })).toBeNull();
    const term = latestTerm();
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
    await new Promise((r) => setTimeout(r, 0));
    // Not even the image upload a paste would start before onData drops it.
    expect(read).not.toHaveBeenCalled();
    expect(readText).not.toHaveBeenCalled();
    expect(api.uploadSessionFile).not.toHaveBeenCalled();
    expect(term.paste).not.toHaveBeenCalled();
  });
});

// #3012 — the proof for the right sidebar's Dock view itself, with the REAL
// TerminalPane mounted inside it: showing a running monitor's log there does
// not register a terminal input target. The control in the same harness is
// the bottom Dock's own log pane for the same session, which does.
describe("Dock view log is not a terminal input target (#3012)", () => {
  const monitor = makeStoreSession({
    id: 7,
    projectId: 1,
    kind: "dock",
    status: "active",
    command: "npm run dev",
  } as Partial<Session>);

  it("the bottom Dock's log pane registers (the control)", () => {
    render(<DockLogPane sessionId={7} minWidthPx={100} minHeightPx={100} />);
    expect(registerTerminalInput).toHaveBeenCalledWith(7, expect.anything());
  });

  it("the Dock view mounts the real terminal for the log and never registers it", async () => {
    useDashboardStore.setState({
      projects: [makeProject({ id: 1, name: "aurora-web" })],
      sessions: [monitor],
      sessionsLoaded: true,
    });
    const listDock = vi
      .spyOn(api, "listProjectDock")
      .mockResolvedValue([{ id: "dev", title: "dev", command: "npm run dev" }]);
    const actions = { onOpenDockConfig: vi.fn() } as unknown as RightSidebarActions;
    const { unmount } = render(<DockSidebarView projectId={1} actions={actions} />);
    await screen.findByRole("button", { name: /^dev, running/ });
    // The log is a real TerminalPane: an xterm Terminal was constructed for it.
    await waitFor(() => expect(Terminal).toHaveBeenCalled());
    expect(registerTerminalInput).not.toHaveBeenCalled();
    unmount();
    expect(unregisterTerminalInput).not.toHaveBeenCalled();
    listDock.mockRestore();
  });
});
