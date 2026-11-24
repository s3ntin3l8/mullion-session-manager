// @vitest-environment jsdom
// The mobile key bar's handle: the arrow sequences, the sticky Ctrl
// modifier, paste, and the copy view.
//
// Split out of the former frontend/src/TerminalPane.test.tsx, which had grown
// past the file-size ceiling (scripts/max-file-lines.baseline.json). The mock
// preamble and the shared helpers now live in ./test/terminal-pane-mocks.ts
// and ./test/terminal-pane-harness.tsx.

import { describe, it, expect, vi } from "vitest";

// IMPORT ORDER MATTERS: the mocks module is imported BEFORE the harness.
// Vitest evaluates a test file's imports in order, and the harness pulls in
// the mocked modules (TerminalPane -> @xterm/xterm), whose vi.mock factories
// call back into the mocks module — so the mocks module has to be evaluated
// (and its exports initialized) first. See
// frontend/src/test/terminal-pane-mocks.ts's own header comment.
import {
  mockApiFactory,
  mockRepaintRegistryFactory,
  mockInputRegistryFactory,
  mockXtermFactory,
  mockFitAddonFactory,
  mockWebglAddonFactory,
  mockUnicode11AddonFactory,
  mockSearchAddonFactory,
} from "./test/terminal-pane-mocks.js";

import { screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { registerTerminalInput } from "./terminalInputRegistry.js";
import userEvent from "@testing-library/user-event";
import {
  renderPane,
  stubFakeWebSocket,
  fakeSocket,
  fakeWsSend,
  getLatestTermInstance,
  stubAlternateScreen,
  setupTerminalPaneTestLifecycle,
} from "./test/terminal-pane-harness.js";

vi.mock("./api/index.js", () => mockApiFactory());
vi.mock("./terminalRepaintRegistry.js", () => mockRepaintRegistryFactory());
vi.mock("./terminalInputRegistry.js", () => mockInputRegistryFactory());
vi.mock("@xterm/xterm", () => mockXtermFactory());
vi.mock("@xterm/addon-fit", () => mockFitAddonFactory());
vi.mock("@xterm/addon-webgl", () => mockWebglAddonFactory());
vi.mock("@xterm/addon-unicode11", () => mockUnicode11AddonFactory());
vi.mock("@xterm/addon-search", () => mockSearchAddonFactory());

setupTerminalPaneTestLifecycle();

describe("TerminalPane key-bar handle: arrows, sticky Ctrl, paste, copy view", () => {
  function handleAndTerm() {
    const [, handle] = vi.mocked(registerTerminalInput).mock.calls.at(-1)!;
    const term = getLatestTermInstance() as ReturnType<typeof getLatestTermInstance> & {
      onData: ReturnType<typeof vi.fn>;
    };
    const onData = term.onData.mock.calls[0]![0] as (data: string) => void;
    return { handle, term, onData };
  }

  function sentText(): string[] {
    return vi
      .mocked(fakeWsSend)
      .mock.calls.map((call) => call[0] as unknown)
      .filter((arg): arg is ArrayBufferView => ArrayBuffer.isView(arg))
      .map((bytes) => new TextDecoder().decode(bytes));
  }

  it("sendArrow emits left/right as CSI D/C", () => {
    stubFakeWebSocket(true);
    renderPane();
    const { handle, term } = handleAndTerm();
    term.modes.applicationCursorKeysMode = false;
    handle.sendArrow("left");
    handle.sendArrow("right");
    expect(term.input).toHaveBeenNthCalledWith(1, "\x1b[D");
    expect(term.input).toHaveBeenNthCalledWith(2, "\x1b[C");
  });

  it("a one-shot Ctrl turns the next typed character into its control code, then releases", async () => {
    stubFakeWebSocket(true);
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    const { handle, term, onData } = handleAndTerm();
    const onConsumed = vi.fn();
    handle.setCtrlModifier("once", onConsumed);
    expect(term.focus).toHaveBeenCalled();

    onData("c");
    onData("c");
    expect(sentText().slice(-2)).toEqual(["\x03", "c"]);
    expect(onConsumed).toHaveBeenCalledTimes(1);
  });

  it("a locked Ctrl stays armed, and leaves keys without a control code alone", async () => {
    stubFakeWebSocket(true);
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    const { handle, onData } = handleAndTerm();
    const onConsumed = vi.fn();
    handle.setCtrlModifier("locked", onConsumed);

    onData("a");
    onData("1");
    onData("d");
    handle.setCtrlModifier("off", () => {});
    onData("d");
    expect(sentText().slice(-4)).toEqual(["\x01", "1", "\x04", "d"]);
    expect(onConsumed).not.toHaveBeenCalled();
  });

  it("paste focuses the terminal and pastes the clipboard text", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { readText: vi.fn(async () => "echo hi\n") },
      configurable: true,
    });
    stubFakeWebSocket(true);
    renderPane();
    const { handle, term } = handleAndTerm();
    handle.paste();
    expect(term.focus).toHaveBeenCalled();
    await waitFor(() => expect(term.paste).toHaveBeenCalledWith("echo hi"));
  });

  it("openCopyMode shows the copy view; closing it doesn't refocus (no keyboard pop-up)", async () => {
    stubFakeWebSocket(true);
    renderPane();
    const { handle, term } = handleAndTerm();
    act(() => handle.openCopyMode());
    expect(screen.getByRole("dialog", { name: "Copy terminal text" })).toBeInTheDocument();
    term.focus.mockClear();
    await userEvent.setup().click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: "Copy terminal text" })).toBeNull();
    expect(term.focus).not.toHaveBeenCalled();
  });

  // #3019 — closing clears `open` and keeps the snapshot, so the sheet stays
  // mounted (and keeps its text) while it leaves on the spring. Frames are
  // held, so the exit is caught mid-way.
  it("closing the copy view flips it closed and lets it leave, instead of unmounting it", async () => {
    const held = new Map<number, FrameRequestCallback>();
    let next = 1;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      held.set(next, cb);
      return next++;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => void held.delete(id));
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockReturnValue(400);
    try {
      stubFakeWebSocket(true);
      renderPane();
      const { handle } = handleAndTerm();
      act(() => handle.openCopyMode());
      // Let it arrive, so the close has somewhere to travel from.
      let now = 0;
      for (let i = 0; i < 1000 && held.size > 0; i++) {
        now += 16;
        const callbacks = [...held.values()];
        held.clear();
        act(() => {
          for (const cb of callbacks) cb(now);
        });
      }
      const text = (screen.getByRole("textbox", { name: "Terminal text" }) as HTMLTextAreaElement)
        .value;
      await userEvent.setup().click(screen.getByRole("button", { name: "Done" }));
      expect(screen.queryByRole("dialog", { name: "Copy terminal text" })).toBeNull();
      const leaving = document.querySelector(".copy-mode-sheet");
      expect(leaving).not.toBeNull();
      expect(leaving?.querySelector(".copy-mode-text")).toHaveValue(text);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("the copy view closes when the pane is unmounted/switched away", () => {
    stubFakeWebSocket(true);
    const { unmount } = renderPane();
    const { handle } = handleAndTerm();
    act(() => handle.openCopyMode());
    unmount();
    expect(screen.queryByRole("dialog", { name: "Copy terminal text" })).toBeNull();
  });

  // The mobile key-bar Copy button's entry: while a TUI owns the alternate
  // screen the sheet is titled "Scrollback" (telling the user they're
  // reading the history the program is parked on, not the live screen) and
  // the text comes from term.buffer.normal, not the dialog itself. Same
  // copySheetSnapshot the long-press and the find bar use — pinned here
  // because this is the branch the Copy button takes, and the title is the
  // only thing distinguishing the two intents the button covers.
  it("openCopyMode on the alt screen is titled 'Scrollback' and reads term.buffer.normal", () => {
    stubFakeWebSocket(true);
    renderPane();
    const { handle, term } = handleAndTerm();
    stubAlternateScreen(term, ["$ echo hi", "hi"]);
    act(() => handle.openCopyMode());
    expect(screen.getByText("Scrollback")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Terminal text" })).toHaveValue("$ echo hi\nhi");
  });

  it("an IME word-commit chunk gets Ctrl on its first letter and loses the committing space", async () => {
    stubFakeWebSocket(true);
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    const { handle, onData } = handleAndTerm();
    const onConsumed = vi.fn();
    handle.setCtrlModifier("once", onConsumed);
    onData("c ");
    expect(sentText().at(-1)).toBe("\x03");
    expect(onConsumed).toHaveBeenCalledTimes(1);
  });

  it("key-bar keys, Ctrl+C and pastes are never modified by an armed Ctrl", async () => {
    stubFakeWebSocket(true);
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    const { handle, term, onData } = handleAndTerm();
    // Real xterm reports input()/paste() through onData synchronously.
    term.input.mockImplementation((d: string) => onData(d));
    term.paste.mockImplementation((d: string) => onData(d));
    const onConsumed = vi.fn();
    handle.setCtrlModifier("once", onConsumed);

    handle.sendInput("a");
    Object.defineProperty(navigator, "clipboard", {
      value: { readText: vi.fn(async () => "b") },
      configurable: true,
    });
    handle.paste();
    await waitFor(() => expect(term.paste).toHaveBeenCalledWith("b"));
    expect(sentText().slice(-2)).toEqual(["a", "b"]);
    expect(onConsumed).not.toHaveBeenCalled();

    onData("c");
    expect(sentText().at(-1)).toBe("\x03");
  });
});
