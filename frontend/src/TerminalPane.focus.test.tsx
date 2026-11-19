// @vitest-environment jsdom
// Pane-activation focus: the `active` prop's own transition, and the
// coarse-pointer case where the terminal must not steal focus.
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

import { TerminalPane } from "./TerminalPane.js";
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

// U7 — clicking a pane tab (or activating it via keyboard pane-switching, a
// deep link, a push-notification open, or auto-focus-on-attention) changes
// dockview's active panel, but TerminalPane itself never called .focus() in
// reaction to that — only a direct click inside xterm's own DOM landed
// focus in its hidden textarea. TerminalPanelWrapper (App.tsx) now threads
// the dockview panel's own api.onDidActiveChange signal down as a plain
// `active` boolean (mirroring PaneTab.tsx's identical subscription); these
// tests exercise that boolean directly, the same way the existing
// captureCtrlC tests above exercise a prop via `rerender` rather than
// mounting the whole dockview panel machinery.
describe("TerminalPane pane-activation focus (U7)", () => {
  it("focuses the terminal when `active` transitions from unset to true", () => {
    stubFakeWebSocket(true);
    const { rerender } = renderPane();
    const term = getLatestTermInstance();
    expect(term.focus).not.toHaveBeenCalled();

    rerender(<TerminalPane params={{ sessionId: 1 }} active={true} />);

    expect(term.focus).toHaveBeenCalledTimes(1);
  });

  it("does not call focus again on an unrelated re-render while already active", () => {
    stubFakeWebSocket(true);
    const { rerender } = renderPane();
    const term = getLatestTermInstance();

    rerender(<TerminalPane params={{ sessionId: 1 }} active={true} />);
    expect(term.focus).toHaveBeenCalledTimes(1);

    // Same `active` value, different otherwise-irrelevant prop identity —
    // must not retrigger the activation-focus effect (it's keyed on
    // `[props.active]` alone).
    rerender(<TerminalPane params={{ sessionId: 1 }} active={true} captureCtrlC={false} />);

    expect(term.focus).toHaveBeenCalledTimes(1);
  });

  it("does not call focus when `active` becomes false", () => {
    stubFakeWebSocket(true);
    const { rerender } = renderPane();
    const term = getLatestTermInstance();

    rerender(<TerminalPane params={{ sessionId: 1 }} active={true} />);
    expect(term.focus).toHaveBeenCalledTimes(1);

    rerender(<TerminalPane params={{ sessionId: 1 }} active={false} />);

    // Still just the one call from the true transition above — going
    // inactive is intentionally a no-op, not a second call.
    expect(term.focus).toHaveBeenCalledTimes(1);
  });

  it("mounting already-active (e.g. the default tab on first load) focuses immediately", () => {
    stubFakeWebSocket(true);
    renderPane({ active: true });

    expect(getLatestTermInstance().focus).toHaveBeenCalledTimes(1);
  });

  it("does not focus the terminal on active transition under a coarse pointer (mobile/tablet)", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(pointer: coarse)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    stubFakeWebSocket(true);
    const { rerender } = renderPane();
    const term = getLatestTermInstance();
    expect(term.focus).not.toHaveBeenCalled();

    rerender(<TerminalPane params={{ sessionId: 1 }} active={true} />);

    expect(term.focus).not.toHaveBeenCalled();
  });

  it("does not focus when mounting already-active under a coarse pointer", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(pointer: coarse)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    stubFakeWebSocket(true);
    renderPane({ active: true });

    expect(getLatestTermInstance().focus).not.toHaveBeenCalled();
  });
});
