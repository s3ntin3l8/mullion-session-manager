// @vitest-environment jsdom
// The mobile key bar's input handle: how TerminalPane wires it to the
// real term.input()/term.modes, and how sendCtrlC replicates the
// attachCustomKeyEventHandler's own Ctrl+C decision.
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

import { waitFor } from "@testing-library/react";
import { act } from "react";
import { useDashboardStore } from "./store/index.js";
import { TerminalPane } from "./TerminalPane.js";
import { registerTerminalInput, unregisterTerminalInput } from "./terminalInputRegistry.js";
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

// Mobile UI/UX overhaul, item C.1 — MobileKeyBar.test.tsx covers the bar's
// own behavior against a fake TerminalInputHandle; these tests prove
// TerminalPane wires that handle to the *real* term.input()/term.modes
// correctly, which is the half MobileKeyBar's own tests can't reach.
describe("TerminalPane input registry (mobile key bar, issue: mobile UI/UX overhaul)", () => {
  it("registers this session's input handle on mount and unregisters it on unmount", () => {
    stubFakeWebSocket(true);
    const { unmount } = renderPane();

    expect(registerTerminalInput).toHaveBeenCalledTimes(1);
    const [sessionId, handle] = vi.mocked(registerTerminalInput).mock.calls[0]!;
    expect(sessionId).toBe(1);
    expect(handle.sendInput).toBeInstanceOf(Function);
    expect(handle.sendArrow).toBeInstanceOf(Function);
    expect(unregisterTerminalInput).not.toHaveBeenCalled();

    unmount();

    // Hermes review, PR #616 round 3 — unregister now takes the same handle
    // reference registerTerminalInput was called with (identity-guarded
    // removal, since the same sessionId can be registered twice at once —
    // Dock.tsx's own monitor mount), not just the sessionId.
    expect(unregisterTerminalInput).toHaveBeenCalledExactlyOnceWith(1, handle);
  });

  it("sendInput routes a fixed sequence straight to term.input()", () => {
    stubFakeWebSocket(true);
    renderPane();
    const term = getLatestTermInstance();

    const [, handle] = vi.mocked(registerTerminalInput).mock.calls[0]!;
    handle.sendInput("\x1b[Z");

    expect(term.input).toHaveBeenCalledExactlyOnceWith("\x1b[Z");
  });

  // Hermes review, PR #616 round 2 — MobileKeyBar's own pointerdown
  // preventDefault only ever *preserves* focus the terminal already had; if
  // the on-screen keyboard was already dismissed before the tap, a send
  // with no explicit focus() would be real but invisible to the user.
  // Covers all three handle methods, since each one independently needs
  // this (sendCtrlC's own dock/opt-in/raw branches all still focus first).
  it("focuses the terminal before every send, regardless of prior focus state", () => {
    stubFakeWebSocket(true);
    renderPane();
    const term = getLatestTermInstance();

    const [, handle] = vi.mocked(registerTerminalInput).mock.calls[0]!;
    handle.sendInput("\x1b");
    expect(term.focus).toHaveBeenCalledTimes(1);

    handle.sendArrow("up");
    expect(term.focus).toHaveBeenCalledTimes(2);

    handle.sendCtrlC();
    expect(term.focus).toHaveBeenCalledTimes(3);
  });

  it("sendArrow emits normal-mode CSI sequences when DECCKM (applicationCursorKeysMode) is off", () => {
    stubFakeWebSocket(true);
    renderPane();
    const term = getLatestTermInstance();
    term.modes.applicationCursorKeysMode = false;

    const [, handle] = vi.mocked(registerTerminalInput).mock.calls[0]!;
    handle.sendArrow("up");
    handle.sendArrow("down");

    expect(term.input).toHaveBeenNthCalledWith(1, "\x1b[A");
    expect(term.input).toHaveBeenNthCalledWith(2, "\x1b[B");
  });

  it("sendArrow emits application-mode SS3 sequences when DECCKM is on", () => {
    stubFakeWebSocket(true);
    renderPane();
    const term = getLatestTermInstance();
    term.modes.applicationCursorKeysMode = true;

    const [, handle] = vi.mocked(registerTerminalInput).mock.calls[0]!;
    handle.sendArrow("up");
    handle.sendArrow("down");

    expect(term.input).toHaveBeenNthCalledWith(1, "\x1bOA");
    expect(term.input).toHaveBeenNthCalledWith(2, "\x1bOB");
  });

  // Independent code review, PR #616 — sendCtrlC has to replicate
  // attachCustomKeyEventHandler's own three-way Ctrl+C decision (below),
  // not just forward a raw byte through term.input() (which would bypass
  // that handler entirely — see terminalInputRegistry.ts's own comment).
  // Same stubClipboardWrite/useDashboardStore.setState pattern as the
  // "TerminalPane captureCtrlC for dock monitors" and opt-in clipboardKeys
  // describe blocks further down, which test the identical decision via a
  // real keydown chord instead of this registry handle.
  describe("sendCtrlC (independent code review, PR #616)", () => {
    function stubClipboardWrite() {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
      return writeText;
    }

    it("copies the selection instead of SIGINT for a captureCtrlC (dock monitor) session", async () => {
      stubFakeWebSocket(true);
      const writeText = stubClipboardWrite();
      const { rerender } = renderPane();
      await waitFor(() => expect(fakeSocket.readyState).toBe(1));
      rerender(<TerminalPane params={{ sessionId: 1 }} captureCtrlC={true} />);

      const term = getLatestTermInstance();
      term.hasSelection.mockReturnValue(true);
      term.getSelection.mockReturnValue("dock output");

      const [, handle] = vi.mocked(registerTerminalInput).mock.calls[0]!;
      handle.sendCtrlC();

      await waitFor(() => expect(writeText).toHaveBeenCalledWith("dock output"));
      expect(term.input).not.toHaveBeenCalledWith("\x03");
    });

    it("copies the selection instead of SIGINT when the opt-in clipboardKeys.ctrlC setting is on", async () => {
      stubFakeWebSocket(true);
      const writeText = stubClipboardWrite();
      renderPane();
      await waitFor(() => expect(fakeSocket.readyState).toBe(1));
      act(() => {
        useDashboardStore.setState((s) => ({
          settings: {
            ...s.settings,
            terminal: { ...s.settings.terminal, clipboardKeys: { ctrlV: false, ctrlC: true } },
          },
        }));
      });

      const term = getLatestTermInstance();
      term.hasSelection.mockReturnValue(true);
      term.getSelection.mockReturnValue("selected text");

      const [, handle] = vi.mocked(registerTerminalInput).mock.calls[0]!;
      handle.sendCtrlC();

      await waitFor(() => expect(term.clearSelection).toHaveBeenCalledTimes(1));
      expect(writeText).toHaveBeenCalledWith("selected text");
      expect(term.input).not.toHaveBeenCalledWith("\x03");
    });

    it("sends a raw SIGINT byte when neither captureCtrlC nor the opt-in setting apply", () => {
      stubFakeWebSocket(true);
      renderPane();
      const term = getLatestTermInstance();

      const [, handle] = vi.mocked(registerTerminalInput).mock.calls[0]!;
      handle.sendCtrlC();

      expect(term.input).toHaveBeenCalledWith("\x03");
    });

    it("sends a raw SIGINT byte when the opt-in setting is on but there is no selection", () => {
      stubFakeWebSocket(true);
      renderPane();
      act(() => {
        useDashboardStore.setState((s) => ({
          settings: {
            ...s.settings,
            terminal: { ...s.settings.terminal, clipboardKeys: { ctrlV: false, ctrlC: true } },
          },
        }));
      });
      const term = getLatestTermInstance();
      term.hasSelection.mockReturnValue(false);

      const [, handle] = vi.mocked(registerTerminalInput).mock.calls[0]!;
      handle.sendCtrlC();

      expect(term.input).toHaveBeenCalledWith("\x03");
    });
  });
});
