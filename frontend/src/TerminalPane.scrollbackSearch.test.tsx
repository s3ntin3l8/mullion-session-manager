// @vitest-environment jsdom
// The scrollback find bar: the Ctrl+Shift+F chord, the incremental
// search, the match count, and the 'View scrollback as text' entry point.
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

import { screen, fireEvent } from "@testing-library/react";
import { act } from "react";
import {
  renderPane,
  stubFakeWebSocket,
  getLatestTermInstance,
  getLatestSearchAddonInstance,
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

describe("TerminalPane scrollback search (U1)", () => {
  // Simulates the Ctrl+Shift+F chord attachKeyConflictHandler listens for,
  // the same way triggerPasteChord/triggerCtrlCChord above simulate theirs —
  // by invoking whatever callback the (mocked) term.attachCustomKeyEventHandler
  // was last registered with.
  function triggerFindChord() {
    const term = getLatestTermInstance();
    const calls = term.attachCustomKeyEventHandler.mock.calls;
    const handler = calls[calls.length - 1]![0] as (event: unknown) => boolean;
    return act(() => {
      handler({
        type: "keydown",
        key: "f",
        ctrlKey: true,
        shiftKey: true,
        metaKey: false,
        altKey: false,
        preventDefault: vi.fn(),
      });
    });
  }

  it("opens the find bar on Ctrl+Shift+F and closes it on Escape", () => {
    stubFakeWebSocket(true);
    const { getByPlaceholderText, queryByPlaceholderText } = renderPane();

    expect(queryByPlaceholderText("Find in scrollback…")).toBeNull();

    triggerFindChord();

    const input = getByPlaceholderText("Find in scrollback…");
    expect(input).toBeTruthy();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(queryByPlaceholderText("Find in scrollback…")).toBeNull();
    // Closing hands focus back to the terminal (see TerminalPane.tsx's
    // findOpen-transition effect) so typing resumes immediately instead of
    // landing wherever the browser defaults to once the input unmounts.
    expect(getLatestTermInstance().focus).toHaveBeenCalledTimes(1);
  });

  // The find bar's "View scrollback as text" button (sibling of Prev/Next/
  // Close) is the desktop entry to the same scrollback viewer the mobile
  // key bar's Copy button opens. While the program is on the alt screen
  // (Codex question dialog, vim, tmux copy mode, ...) the only path to
  // history is reading term.buffer.normal — verified here by switching
  // `buffer.active.type` to "alternate" before the click.
  it("the find bar's 'View scrollback' button opens the scrollback viewer", () => {
    stubFakeWebSocket(true);
    renderPane();
    const term = getLatestTermInstance();
    stubAlternateScreen(term, ["$ echo hi", "hi"]);

    triggerFindChord();

    // The find bar should be open and the new button should be in it.
    const button = screen.getByRole("button", { name: "View scrollback as text" });
    fireEvent.click(button);

    // The scrollback viewer is mounted with the alt-screen title (because
    // buffer.active.type is "alternate") and the normal-buffer text — the
    // whole point of routing through term.buffer.normal in
    // scrollbackToText().
    expect(screen.getByText("Scrollback")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Terminal text" })).toHaveValue("$ echo hi\nhi");
    // And the find bar closed, so the two UI surfaces never overlap.
    expect(screen.queryByPlaceholderText("Find in scrollback…")).toBeNull();
  });

  it("does not open the find bar on plain Ctrl+F (left to the browser's own find)", () => {
    stubFakeWebSocket(true);
    const { queryByPlaceholderText } = renderPane();
    const term = getLatestTermInstance();
    const calls = term.attachCustomKeyEventHandler.mock.calls;
    const handler = calls[calls.length - 1]![0] as (event: unknown) => boolean;
    const preventDefault = vi.fn();

    act(() => {
      handler({
        type: "keydown",
        key: "f",
        ctrlKey: true,
        shiftKey: false,
        metaKey: false,
        altKey: false,
        preventDefault,
      });
    });

    expect(queryByPlaceholderText("Find in scrollback…")).toBeNull();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("does not steal focus into the terminal on a plain mount (find bar never opened)", () => {
    stubFakeWebSocket(true);
    renderPane();

    expect(getLatestTermInstance().focus).not.toHaveBeenCalled();
  });

  it("refocuses the find input on a repeat Ctrl+Shift+F while the bar is already open (Hermes review, PR #578)", () => {
    stubFakeWebSocket(true);
    const { getByPlaceholderText } = renderPane();

    triggerFindChord();
    const input = getByPlaceholderText("Find in scrollback…") as HTMLInputElement;
    const focusSpy = vi.spyOn(input, "focus");

    // Second chord while the bar is already open — setFindOpen(true) alone
    // is a no-op here (same value), so without openFind's explicit
    // focus()/select() call this would be a dead keypress (jsdom doesn't
    // auto-move focus off the input just because the assertion above didn't
    // call .focus() on it, so this specifically exercises the "already
    // open" branch, not the initial-open one).
    triggerFindChord();

    expect(focusSpy).toHaveBeenCalled();
  });

  it("calls findNext on the addon when Next is clicked or Enter is pressed", () => {
    stubFakeWebSocket(true);
    const { getByPlaceholderText, getByTitle } = renderPane();
    triggerFindChord();
    const input = getByPlaceholderText("Find in scrollback…");
    const searchAddon = getLatestSearchAddonInstance();

    fireEvent.change(input, { target: { value: "migration failed" } });
    searchAddon.findNext.mockClear();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(searchAddon.findNext).toHaveBeenCalledWith(
      "migration failed",
      expect.objectContaining({ decorations: expect.any(Object) }),
    );

    searchAddon.findNext.mockClear();
    fireEvent.click(getByTitle("Next match (Enter)"));
    expect(searchAddon.findNext).toHaveBeenCalledTimes(1);
  });

  it("calls findPrevious on the addon when Previous is clicked or Shift+Enter is pressed", () => {
    stubFakeWebSocket(true);
    const { getByPlaceholderText, getByTitle } = renderPane();
    triggerFindChord();
    const input = getByPlaceholderText("Find in scrollback…");
    const searchAddon = getLatestSearchAddonInstance();

    fireEvent.change(input, { target: { value: "abc" } });
    searchAddon.findPrevious.mockClear();

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(searchAddon.findPrevious).toHaveBeenCalledWith("abc", expect.any(Object));

    searchAddon.findPrevious.mockClear();
    fireEvent.click(getByTitle("Previous match (Shift+Enter)"));
    expect(searchAddon.findPrevious).toHaveBeenCalledTimes(1);
  });

  it("live-searches as the query changes (incremental findNext) and clears decorations once emptied", () => {
    stubFakeWebSocket(true);
    const { getByPlaceholderText } = renderPane();
    triggerFindChord();
    const input = getByPlaceholderText("Find in scrollback…");
    const searchAddon = getLatestSearchAddonInstance();

    fireEvent.change(input, { target: { value: "err" } });
    expect(searchAddon.findNext).toHaveBeenCalledWith(
      "err",
      expect.objectContaining({ incremental: true }),
    );

    // Opening the find bar with an empty query already clears decorations
    // once (see the assertion below is on a fresh count) — reset the mock so
    // this only asserts the *emptying* triggers its own clear, not just the
    // one from the bar opening on an empty query above.
    searchAddon.clearDecorations.mockClear();
    fireEvent.change(input, { target: { value: "" } });
    expect(searchAddon.clearDecorations).toHaveBeenCalledTimes(1);
  });

  it("shows a match count from the addon's onDidChangeResults event", () => {
    stubFakeWebSocket(true);
    const { getByPlaceholderText, getByText } = renderPane();
    triggerFindChord();
    const input = getByPlaceholderText("Find in scrollback…");
    const searchAddon = getLatestSearchAddonInstance();

    fireEvent.change(input, { target: { value: "foo" } });

    act(() => {
      searchAddon.__fireResults({ resultIndex: 2, resultCount: 5 });
    });

    expect(getByText("3/5")).toBeTruthy();
  });

  it("appends '+' to the count once the addon's highlightLimit is reached (Hermes review, PR #578)", () => {
    stubFakeWebSocket(true);
    const { getByPlaceholderText, getByText } = renderPane();
    triggerFindChord();
    const input = getByPlaceholderText("Find in scrollback…");
    const searchAddon = getLatestSearchAddonInstance();

    fireEvent.change(input, { target: { value: "x" } });

    // resultCount is the *decorated* count (capped at SEARCH_HIGHLIGHT_LIMIT,
    // 1000) — at the cap it may not be the true total, so the UI marks it as
    // a lower bound rather than an exact count.
    act(() => {
      searchAddon.__fireResults({ resultIndex: 4, resultCount: 1000 });
    });

    expect(getByText("5/1000+")).toBeTruthy();
  });

  it("shows just the count (no index) when resultIndex is -1 — the addon's own highlight-limit-exceeded case", () => {
    stubFakeWebSocket(true);
    const { getByPlaceholderText, getByText } = renderPane();
    triggerFindChord();
    const input = getByPlaceholderText("Find in scrollback…");
    const searchAddon = getLatestSearchAddonInstance();

    fireEvent.change(input, { target: { value: "x" } });

    act(() => {
      searchAddon.__fireResults({ resultIndex: -1, resultCount: 1000 });
    });

    // Not "0/1000+" — resultIndex -1 means the selected match is beyond the
    // decorated set, not that it's the first match.
    expect(getByText("1000+")).toBeTruthy();
  });

  it("disposes the search addon (and its result subscription) on unmount", () => {
    stubFakeWebSocket(true);
    const { unmount } = renderPane();
    const searchAddon = getLatestSearchAddonInstance();

    unmount();

    expect(searchAddon.dispose).toHaveBeenCalledTimes(1);
  });
});
