// @vitest-environment jsdom
// The pane's input affordances: the attach-image and mic buttons, the
// opt-in chords' inertness without them, and the paste-on-right-click vs
// touch long-press split.
//
// Split out of the former frontend/src/TerminalPane.test.tsx, which had grown
// past the file-size ceiling (scripts/max-file-lines.baseline.json). The mock
// preamble and the shared helpers now live in ./test/terminal-pane-mocks.ts
// and ./test/terminal-pane-harness.tsx.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

import { screen } from "@testing-library/react";
import { act } from "react";
import { useDashboardStore } from "./store/index.js";
import { registerTerminalInput } from "./terminalInputRegistry.js";
import {
  renderPane,
  stubFakeWebSocket,
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

describe("TerminalPane inputAffordances (PR3 — dock monitor terminal chrome)", () => {
  // voiceController.isSupported requires a SpeechRecognition constructor —
  // stub one locally (same technique as the voice-dictation describe block
  // above) so the mic button's default-visible case is actually exercised,
  // not vacuously true because isSupported is false in every other test.
  let fakeAffordanceRecognitionInstances: FakeSpeechRecognition[];
  class FakeSpeechRecognition {
    continuous = false;
    interimResults = false;
    lang = "";
    onresult: ((event: unknown) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    start = vi.fn();
    stop = vi.fn();
    abort = vi.fn();
    constructor() {
      fakeAffordanceRecognitionInstances.push(this);
    }
  }

  beforeEach(() => {
    fakeAffordanceRecognitionInstances = [];
    (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeSpeechRecognition;
  });

  afterEach(() => {
    delete (window as { SpeechRecognition?: unknown }).SpeechRecognition;
  });

  it("renders the attach-image button and the mic button by default", () => {
    renderPane();
    expect(screen.getByTitle("Attach files (or paste an image / drop files)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /dictation/i })).toBeInTheDocument();
  });

  it("hides both the attach-image button and the mic button when inputAffordances is false — a dock monitor's log stream has no interactive CLI to paste into or dictate to", () => {
    renderPane({ inputAffordances: false });
    expect(
      screen.queryByTitle("Attach files (or paste an image / drop files)"),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /dictation/i })).not.toBeInTheDocument();
  });

  it("the dictation HOTKEY is also inert when inputAffordances is false, not just its button — Hermes review", () => {
    // Round 1 of this PR only gated the mic BUTTON; the hotkey
    // (Ctrl+Shift+Space by default) still reached getVoiceChord and would
    // start dictation into the log-stream PTY with no on-screen indicator
    // at all once the button (its only phase feedback) was hidden.
    renderPane({ inputAffordances: false });
    const term = getLatestTermInstance();
    const calls = term.attachCustomKeyEventHandler.mock.calls;
    const handler = calls[calls.length - 1]![0] as (event: unknown) => boolean;
    act(() =>
      handler({
        type: "keydown",
        key: " ",
        code: "Space",
        ctrlKey: true,
        shiftKey: true,
        metaKey: false,
        altKey: false,
        repeat: false,
        preventDefault: vi.fn(),
      }),
    );

    expect(fakeAffordanceRecognitionInstances).toHaveLength(0);
  });
});

describe("TerminalPane paste-on-right-click vs touch long-press", () => {
  function stubPointer(coarse: boolean) {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: coarse && query === "(pointer: coarse)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
  }

  function fireContextMenu(container: HTMLElement): MouseEvent {
    act(() => {
      useDashboardStore.setState((s) => ({
        settings: { ...s.settings, terminal: { ...s.settings.terminal, pasteOnRightClick: true } },
      }));
    });
    const containerDiv = container.querySelector("div[style*='inset']") as HTMLDivElement;
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => {
      containerDiv.dispatchEvent(event);
    });
    return event;
  }

  it("pastes (suppressing the native menu) on a fine pointer", () => {
    stubPointer(false);
    stubFakeWebSocket(true);
    const { container } = renderPane();
    expect(fireContextMenu(container).defaultPrevented).toBe(true);
  });

  it("keeps xterm's own right-click handler out of a paste-on-right-click", () => {
    stubPointer(false);
    stubFakeWebSocket(true);
    const { container } = renderPane();
    act(() => {
      useDashboardStore.setState((st) => ({
        settings: {
          ...st.settings,
          terminal: { ...st.settings.terminal, pasteOnRightClick: true },
        },
      }));
    });
    const containerDiv = container.querySelector("div[style*='inset']") as HTMLDivElement;
    // Stands in for xterm's handler on term.element, which would otherwise
    // copy the (stale) selection into its textarea.
    const child = document.createElement("div");
    containerDiv.appendChild(child);
    const xtermHandler = vi.fn();
    child.addEventListener("contextmenu", xtermHandler);
    const xtermMouseDown = vi.fn();
    child.addEventListener("mousedown", xtermMouseDown);
    act(() => {
      child.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      child.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 2 }));
      child.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });
    expect(xtermHandler).not.toHaveBeenCalled();
    // Only the right button is swallowed; ordinary clicks still reach xterm.
    expect(xtermMouseDown).toHaveBeenCalledTimes(1);
  });

  it("a mouse right-click on a coarse-primary device still pastes, not the copy view", () => {
    stubPointer(true);
    stubFakeWebSocket(true);
    const { container } = renderPane();
    act(() => {
      useDashboardStore.setState((st) => ({
        settings: {
          ...st.settings,
          terminal: { ...st.settings.terminal, pasteOnRightClick: true },
        },
      }));
    });
    const containerDiv = container.querySelector("div[style*='inset']") as HTMLDivElement;
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "pointerType", { value: "mouse" });
    act(() => {
      containerDiv.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(screen.queryByRole("dialog", { name: "Copy terminal text" })).toBeNull();
  });

  it("opens the copy view on a coarse-pointer long-press instead of pasting", () => {
    stubPointer(true);
    stubFakeWebSocket(true);
    const { container } = renderPane();
    expect(fireContextMenu(container).defaultPrevented).toBe(true);
    expect(screen.getByRole("dialog", { name: "Copy terminal text" })).toBeInTheDocument();
    expect(getLatestTermInstance().paste).not.toHaveBeenCalled();
  });
});

describe("TerminalPane attach-image on a coarse pointer (moves into the key bar)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(pointer: coarse)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
  });

  it("hides the corner button and opens the file picker via the input handle", () => {
    stubFakeWebSocket(true);
    const { container } = renderPane();
    expect(document.querySelector(".terminal-attach-image-btn")).toBeNull();

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const click = vi.spyOn(input, "click");
    vi.mocked(registerTerminalInput).mock.calls[0]![1].attachImage();
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("attachImage is inert when inputAffordances is false", () => {
    stubFakeWebSocket(true);
    const { container } = renderPane({ inputAffordances: false });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const click = vi.spyOn(input, "click");
    vi.mocked(registerTerminalInput).mock.calls[0]![1].attachImage();
    expect(click).not.toHaveBeenCalled();
  });
});
