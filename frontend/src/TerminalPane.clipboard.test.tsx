// @vitest-environment jsdom
// The clipboard paths: the copy failure toast, the dock monitor's
// captureCtrlC, and the opt-in Ctrl+V / Ctrl+C chords.
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
import { useDashboardStore } from "./store/index.js";
import { TerminalPane } from "./TerminalPane.js";
import { api } from "./api/index.js";
import {
  renderPane,
  stubFakeWebSocket,
  fakeSocket,
  getLatestTermInstance,
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

describe("TerminalPane copy failure toast", () => {
  // Hermes review — copyToClipboard's failure toast is deliberately NOT
  // shown for "copy on select": that listener fires on every selection
  // change, including an accidental drag, so in a non-secure-context deploy
  // it would otherwise flash "Clipboard unavailable" on every incidental
  // selection instead of a real, intentional copy. Distinct from the opt-in
  // Ctrl+C chord's "no Clipboard API" test above, which never reaches
  // copyToClipboard at all (terminalKeys.ts gates on hasClipboardApi()
  // before calling onCopy()) — this one DOES reach copyToClipboard's own
  // !hasClipboardApi() branch and confirms it stays silent anyway.
  it("does not surface a failure toast when copy-on-select has no Clipboard API to write to", async () => {
    stubFakeWebSocket(true);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    act(() => {
      useDashboardStore.setState((s) => ({
        settings: { ...s.settings, terminal: { ...s.settings.terminal, copyOnSelect: true } },
      }));
    });

    const term = getLatestTermInstance() as unknown as {
      getSelection: ReturnType<typeof vi.fn>;
      onSelectionChange: ReturnType<typeof vi.fn>;
    };
    term.getSelection.mockReturnValue("selected text");
    const calls = term.onSelectionChange.mock.calls;
    const selectionChangeHandler = calls[calls.length - 1]![0] as () => void;

    act(() => {
      selectionChangeHandler();
    });

    expect(screen.queryByText("Clipboard unavailable")).not.toBeInTheDocument();
    expect(screen.queryByText("Copy failed")).not.toBeInTheDocument();
  });

  // The explicit-copy counterpart to the test above: Ctrl+Insert IS a
  // deliberate "copy this" action (unlike copy-on-select), so the same "no
  // Clipboard API" situation must surface here — with the message that
  // distinguishes it from a genuinely rejected write (see the next test).
  it("surfaces 'Clipboard unavailable' when Ctrl+Insert has no Clipboard API to write to", async () => {
    stubFakeWebSocket(true);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    const term = getLatestTermInstance() as unknown as {
      hasSelection: ReturnType<typeof vi.fn>;
      getSelection: ReturnType<typeof vi.fn>;
      attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
    };
    term.hasSelection.mockReturnValue(true);
    term.getSelection.mockReturnValue("selected text");
    const calls = term.attachCustomKeyEventHandler.mock.calls;
    const handler = calls[calls.length - 1]![0] as (event: unknown) => boolean;

    act(() => {
      handler({
        type: "keydown",
        key: "Insert",
        ctrlKey: true,
        shiftKey: false,
        metaKey: false,
        altKey: false,
        preventDefault: vi.fn(),
      });
    });

    expect(screen.getByText("Clipboard unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Copy failed")).not.toBeInTheDocument();
  });

  // A genuinely rejected write (permission denied, no transient user
  // activation) is a different situation from "no API at all" and must read
  // as one — this is the Ctrl+Insert counterpart to the opt-in Ctrl+C
  // "clipboard write rejects" test above, confirming the message this time
  // rather than just the absence of clearSelection().
  it("surfaces 'Copy failed' (not 'Clipboard unavailable') when Ctrl+Insert's write is rejected", async () => {
    stubFakeWebSocket(true);
    const writeText = vi.fn().mockRejectedValue(new Error("permission denied"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    const term = getLatestTermInstance() as unknown as {
      hasSelection: ReturnType<typeof vi.fn>;
      getSelection: ReturnType<typeof vi.fn>;
      attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
    };
    term.hasSelection.mockReturnValue(true);
    term.getSelection.mockReturnValue("selected text");
    const calls = term.attachCustomKeyEventHandler.mock.calls;
    const handler = calls[calls.length - 1]![0] as (event: unknown) => boolean;

    act(() => {
      handler({
        type: "keydown",
        key: "Insert",
        ctrlKey: true,
        shiftKey: false,
        metaKey: false,
        altKey: false,
        preventDefault: vi.fn(),
      });
    });

    await waitFor(() => expect(screen.getByText("Copy failed")).toBeInTheDocument());
    expect(screen.queryByText("Clipboard unavailable")).not.toBeInTheDocument();
  });
});

describe("TerminalPane captureCtrlC for dock monitors (issue #332)", () => {
  function triggerCtrlCChord() {
    const term = getLatestTermInstance();
    const calls = term.attachCustomKeyEventHandler.mock.calls;
    const handler = calls[calls.length - 1]![0] as (event: unknown) => boolean;
    return handler({
      type: "keydown",
      key: "c",
      ctrlKey: true,
      shiftKey: false,
      metaKey: false,
      altKey: false,
      preventDefault: () => {},
    }) as boolean;
  }

  function stubClipboardWrite() {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    return writeText;
  }

  it("captureCtrlC=true with selection copies text and returns false (no ETX)", async () => {
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    const { rerender } = renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    rerender(<TerminalPane params={{ sessionId: 1 }} captureCtrlC={true} />);

    const term = getLatestTermInstance() as {
      paste: ReturnType<typeof vi.fn>;
      attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
      hasSelection: ReturnType<typeof vi.fn>;
      getSelection: ReturnType<typeof vi.fn>;
    };
    term.hasSelection.mockReturnValue(true);
    term.getSelection.mockReturnValue("hello from dock monitor");

    const result = triggerCtrlCChord();

    expect(result).toBe(false);
    expect(writeText).toHaveBeenCalledWith("hello from dock monitor");
  });

  it("captureCtrlC=true without selection is a silent no-op", async () => {
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    const { rerender } = renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    rerender(<TerminalPane params={{ sessionId: 1 }} captureCtrlC={true} />);

    const result = triggerCtrlCChord();

    expect(result).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("captureCtrlC=false (default) passes Ctrl+C through to PTY", async () => {
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    const result = triggerCtrlCChord();

    expect(result).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("TerminalPane opt-in Ctrl+V / Ctrl+C clipboard chords (issue #67 follow-up)", () => {
  function triggerCtrlVChord() {
    const term = getLatestTermInstance();
    const calls = term.attachCustomKeyEventHandler.mock.calls;
    const handler = calls[calls.length - 1]![0] as (event: unknown) => boolean;
    let result = true;
    act(() => {
      result = handler({
        type: "keydown",
        key: "v",
        ctrlKey: true,
        shiftKey: false,
        metaKey: false,
        altKey: false,
        preventDefault: vi.fn(),
      }) as boolean;
    });
    return result;
  }

  function triggerCtrlCChord() {
    const term = getLatestTermInstance();
    const calls = term.attachCustomKeyEventHandler.mock.calls;
    const handler = calls[calls.length - 1]![0] as (event: unknown) => boolean;
    let result = true;
    act(() => {
      result = handler({
        type: "keydown",
        key: "c",
        ctrlKey: true,
        shiftKey: false,
        metaKey: false,
        altKey: false,
        preventDefault: vi.fn(),
      }) as boolean;
    });
    return result;
  }

  function enableClipboardKeys(ctrlV: boolean, ctrlC: boolean) {
    act(() => {
      useDashboardStore.setState((s) => ({
        settings: {
          ...s.settings,
          terminal: { ...s.settings.terminal, clipboardKeys: { ctrlV, ctrlC } },
        },
      }));
    });
  }

  function stubClipboardReadText(text: string) {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: vi.fn().mockResolvedValue(text) },
    });
  }

  function stubClipboardWrite() {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    return writeText;
  }

  it("ctrlV disabled (default): Ctrl+V passes through as raw 0x16, no paste", async () => {
    stubFakeWebSocket(true);
    stubClipboardReadText("clipboard text");
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    const result = triggerCtrlVChord();

    expect(result).toBe(true);
    expect(getLatestTermInstance().paste).not.toHaveBeenCalled();
  });

  it("ctrlV enabled: Ctrl+V pastes clipboard text through the normal paste path", async () => {
    stubFakeWebSocket(true);
    stubClipboardReadText("clipboard text");
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    enableClipboardKeys(true, false);

    const result = triggerCtrlVChord();

    expect(result).toBe(false);
    await waitFor(() =>
      expect(getLatestTermInstance().paste).toHaveBeenCalledWith("clipboard text"),
    );
  });

  it("ctrlV enabled: an image on the clipboard routes through the image-paste path (issue #122)", async () => {
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
    vi.mocked(api.uploadSessionFile).mockResolvedValue({ path: "/cwd/.mullion-uploads/z.png" });
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    enableClipboardKeys(true, false);

    triggerCtrlVChord();

    await waitFor(() => expect(api.uploadSessionFile).toHaveBeenCalledWith(1, blob, "pasted.png"));
    await waitFor(() => {
      expect(getLatestTermInstance().paste).toHaveBeenCalledWith("/cwd/.mullion-uploads/z.png ");
    });
  });

  it("ctrlC enabled with a selection: copies, clears the selection, and swallows the chord", async () => {
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    enableClipboardKeys(false, true);

    const term = getLatestTermInstance();
    term.hasSelection.mockReturnValue(true);
    term.getSelection.mockReturnValue("selected text");

    const result = triggerCtrlCChord();

    expect(result).toBe(false);
    expect(writeText).toHaveBeenCalledWith("selected text");
    // clearSelection only runs once the async writeText() promise resolves —
    // see the next two tests for what happens when it doesn't.
    await waitFor(() => expect(term.clearSelection).toHaveBeenCalledTimes(1));
  });

  it("ctrlC enabled, clipboard write rejects: selection is NOT cleared (nothing to retry-copy would be lost)", async () => {
    stubFakeWebSocket(true);
    const writeText = vi.fn().mockRejectedValue(new Error("permission denied"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    enableClipboardKeys(false, true);

    const term = getLatestTermInstance();
    term.hasSelection.mockReturnValue(true);
    term.getSelection.mockReturnValue("selected text");

    const result = triggerCtrlCChord();

    expect(result).toBe(false);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("selected text"));
    // Give the rejected promise's .then/.catch chain a tick to settle, then
    // confirm clearSelection was never called — a failed write must not wipe
    // the selection the user was trying to copy.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(term.clearSelection).not.toHaveBeenCalled();
    // Previously this failure was console.warn-only and invisible in the UI
    // — a rejected write must now surface a toast instead.
    expect(screen.getByText("Copy failed")).toBeInTheDocument();
  });

  it("ctrlC enabled, no Clipboard API at all (plain-http deploy): falls through to SIGINT instead of swallowing", async () => {
    stubFakeWebSocket(true);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    enableClipboardKeys(false, true);

    const term = getLatestTermInstance();
    term.hasSelection.mockReturnValue(true);
    term.getSelection.mockReturnValue("selected text");

    const result = triggerCtrlCChord();

    // No clipboard API to copy to — must not eat the keypress with nothing
    // to show for it; the byte reaches the shell as SIGINT instead. This
    // path never calls copyToClipboard at all (terminalKeys.ts's own
    // hasClipboardApi() gate short-circuits before onCopy()), so unlike the
    // rejected-write case above there is no failure toast here either — a
    // toast would misleadingly imply a copy was attempted.
    expect(result).toBe(true);
    expect(term.clearSelection).not.toHaveBeenCalled();
    expect(screen.queryByText("Copy failed")).not.toBeInTheDocument();
  });

  it("two-press sequence: first Ctrl+C copies and clears, second Ctrl+C (now no selection) reaches SIGINT", async () => {
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    enableClipboardKeys(false, true);

    const term = getLatestTermInstance();
    term.hasSelection.mockReturnValue(true);
    term.getSelection.mockReturnValue("selected text");

    const firstResult = triggerCtrlCChord();
    expect(firstResult).toBe(false);
    await waitFor(() => expect(term.clearSelection).toHaveBeenCalledTimes(1));

    // clearSelection() is a mock, so it doesn't actually change what
    // hasSelection() returns — simulate the real xterm behavior of a
    // cleared selection for the second press.
    term.hasSelection.mockReturnValue(false);

    const secondResult = triggerCtrlCChord();

    expect(secondResult).toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("ctrlC enabled without a selection: falls through to SIGINT (Ctrl+C not swallowed)", async () => {
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    enableClipboardKeys(false, true);

    const term = getLatestTermInstance();
    term.hasSelection.mockReturnValue(false);

    const result = triggerCtrlCChord();

    expect(result).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    expect(term.clearSelection).not.toHaveBeenCalled();
  });

  it("ctrlC disabled: Ctrl+C with a selection still passes through to SIGINT", async () => {
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    const term = getLatestTermInstance();
    term.hasSelection.mockReturnValue(true);
    term.getSelection.mockReturnValue("selected text");

    const result = triggerCtrlCChord();

    expect(result).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("copyOnSelect + ctrlC both on: clearSelection()'s onSelectionChange fire is a no-op, not a second/empty copy", async () => {
    // Exercises the real interaction, not just the setting combination:
    // term.clearSelection() (called by the ctrlC branch) fires xterm's own
    // onSelectionChange — the same listener "copy on select" is wired to
    // (TerminalPane.tsx ~476-480). That listener already guards on a
    // non-empty getSelection(), so simulate xterm firing it with the
    // now-cleared (empty) selection and assert writeText still only saw the
    // one, real copy — not a second call with "".
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    act(() => {
      useDashboardStore.setState((s) => ({
        settings: {
          ...s.settings,
          terminal: {
            ...s.settings.terminal,
            copyOnSelect: true,
            clipboardKeys: { ctrlV: false, ctrlC: true },
          },
        },
      }));
    });

    const term = getLatestTermInstance() as unknown as {
      hasSelection: ReturnType<typeof vi.fn>;
      getSelection: ReturnType<typeof vi.fn>;
      clearSelection: ReturnType<typeof vi.fn>;
      onSelectionChange: ReturnType<typeof vi.fn>;
    };
    term.hasSelection.mockReturnValue(true);
    term.getSelection.mockReturnValue("selected text");
    const onSelectionChangeCalls = term.onSelectionChange.mock.calls;
    const selectionChangeHandler = onSelectionChangeCalls[
      onSelectionChangeCalls.length - 1
    ]![0] as () => void;
    // Simulate xterm actually firing onSelectionChange when clearSelection()
    // runs, the way the real library does — the mock doesn't wire this up
    // automatically.
    term.clearSelection.mockImplementation(() => {
      term.getSelection.mockReturnValue("");
      selectionChangeHandler();
    });

    triggerCtrlCChord();

    // clearSelection() (and thus the simulated onSelectionChange fire) only
    // happens once the async writeText() resolves.
    await waitFor(() => expect(term.clearSelection).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("selected text");
  });

  it("captureCtrlC (dock) still wins over the opt-in ctrlC setting", async () => {
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    const { rerender } = renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    rerender(<TerminalPane params={{ sessionId: 1 }} captureCtrlC={true} />);
    enableClipboardKeys(false, true);

    const term = getLatestTermInstance();
    term.hasSelection.mockReturnValue(false);
    term.getSelection.mockReturnValue("");

    const result = triggerCtrlCChord();

    // Dock's unconditional swallow, not the selection-gated opt-in path —
    // returns false (swallowed) even with no selection, unlike the plain
    // opt-in ctrlC case above.
    expect(result).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("a settings change after mount still honours ctrlV (regression: three re-attach sites)", async () => {
    stubFakeWebSocket(true);
    stubClipboardReadText("clipboard text");
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    // Forces the settings-sync effect's re-attach (TerminalPane.tsx ~line
    // 800) with an unrelated pref change, then enables ctrlV in the same
    // update — attachKeyConflictHandler holds exactly one handler, so if any
    // re-attach captured a stale getter this would still return true.
    act(() => {
      useDashboardStore.setState((s) => ({
        settings: {
          ...s.settings,
          terminal: {
            ...s.settings.terminal,
            fontSize: 18,
            clipboardKeys: { ctrlV: true, ctrlC: false },
          },
        },
      }));
    });

    const result = triggerCtrlVChord();

    expect(result).toBe(false);
    await waitFor(() =>
      expect(getLatestTermInstance().paste).toHaveBeenCalledWith("clipboard text"),
    );
  });
});
