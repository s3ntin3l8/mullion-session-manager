// @vitest-environment jsdom
// The repaint registry and the WebGL addon: the shared glyph atlas, the
// context-loss fallback, and the coarse-pointer skip.
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

import { registerTerminalRepaint, unregisterTerminalRepaint } from "./terminalRepaintRegistry.js";
import { WebglAddon } from "@xterm/addon-webgl";
import {
  renderPane,
  stubFakeWebSocket,
  getLatestTermInstance,
  getLatestWebglAddonInstance,
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

describe("TerminalPane WebGL context-loss fallback (issue #107)", () => {
  // These tests prove the handler is wired and the disposed addon's ref is
  // released — they can't prove a *real* lost GPU context actually recovers
  // (jsdom has no WebGL), which is why the plan for this change calls for a
  // live DevTools verification (WEBGL_lose_context) on top of these.
  it("disposes the WebGL addon and repaints via the DOM renderer on context loss", () => {
    stubFakeWebSocket(true);
    renderPane();

    const webglAddon = getLatestWebglAddonInstance();
    const term = getLatestTermInstance() as unknown as { refresh: ReturnType<typeof vi.fn> };
    term.refresh.mockClear();

    webglAddon.__fireContextLoss();

    expect(webglAddon.dispose).toHaveBeenCalledTimes(1);
    expect(term.refresh).toHaveBeenCalledTimes(1);
  });

  it("stops touching the disposed addon afterwards — repaint() falls through to term.refresh alone", () => {
    stubFakeWebSocket(true);
    renderPane();

    const webglAddon = getLatestWebglAddonInstance();
    webglAddon.__fireContextLoss();
    webglAddon.clearTextureAtlas.mockClear();

    const [, repaint] = vi.mocked(registerTerminalRepaint).mock.calls[0]!;
    const term = getLatestTermInstance() as unknown as { refresh: ReturnType<typeof vi.fn> };
    term.refresh.mockClear();

    repaint();

    expect(webglAddon.clearTextureAtlas).not.toHaveBeenCalled();
    expect(term.refresh).toHaveBeenCalledTimes(1);
  });

  it("ignores a second context-loss firing after the addon is already disposed", () => {
    stubFakeWebSocket(true);
    renderPane();

    const webglAddon = getLatestWebglAddonInstance();
    const term = getLatestTermInstance() as unknown as { refresh: ReturnType<typeof vi.fn> };
    webglAddon.__fireContextLoss();
    webglAddon.dispose.mockClear();
    term.refresh.mockClear();

    webglAddon.__fireContextLoss();

    expect(webglAddon.dispose).not.toHaveBeenCalled();
    expect(term.refresh).not.toHaveBeenCalled();
  });
});

describe("TerminalPane WebGL skipped on coarse pointer (PR 6)", () => {
  // @xterm/addon-webgl v0.19.0's own glyph canvas is sized wrong from its
  // very first construction on a coarse-pointer/high-dpr display (see
  // `isCoarsePointer`'s own comment at the top of TerminalPane.tsx for the
  // measured evidence) — same fallback the context-loss handler above
  // already exercises, just skipped preemptively instead of reactively.
  it("never constructs the WebGL addon under a coarse pointer", () => {
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
    vi.mocked(WebglAddon).mockClear();

    renderPane();

    expect(WebglAddon).not.toHaveBeenCalled();
  });

  it("still constructs the WebGL addon on a fine (mouse-driven) pointer", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    stubFakeWebSocket(true);
    vi.mocked(WebglAddon).mockClear();

    renderPane();

    expect(WebglAddon).toHaveBeenCalledTimes(1);
  });
});
