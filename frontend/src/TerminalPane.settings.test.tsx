// @vitest-environment jsdom
// The pane's chrome reacting to a settings change: the shared WebGL
// atlas wipe on a font/theme change, and the container's padding inset.
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
import { repaintAllTerminals } from "./terminalRepaintRegistry.js";
import {
  renderPane,
  stubFakeWebSocket,
  fakeSocket,
  getLatestTermInstance,
  getLatestFitAddonInstance,
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

describe("TerminalPane WebGL shared-atlas repaint (dock terminal corruption fix)", () => {
  // The WebGL glyph texture atlas is module-global (shared across every
  // terminal with a matching font/theme config, see @xterm/addon-webgl's
  // acquireTextureAtlas) — so wiping it from one terminal corrupts every
  // other live terminal's already-rasterized glyphs unless every wipe is
  // paired with a repaint of every registered terminal, not just this one.

  it("schedules a sibling repaint (excluding itself) one animation frame after mount", async () => {
    stubFakeWebSocket(true);
    renderPane();

    expect(repaintAllTerminals).not.toHaveBeenCalled();

    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    expect(repaintAllTerminals).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("cancels the pending sibling-repaint animation frame on unmount", async () => {
    stubFakeWebSocket(true);
    const { unmount } = renderPane();
    unmount();

    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    });

    expect(repaintAllTerminals).not.toHaveBeenCalled();
  });

  it("does not touch the shared atlas on a fresh mount — nothing has changed yet to invalidate", () => {
    stubFakeWebSocket(true);
    renderPane();

    const webglAddon = getLatestWebglAddonInstance();

    expect(webglAddon.clearTextureAtlas).not.toHaveBeenCalled();
  });

  it("wipes the atlas and repaints every terminal (not just itself) when the font actually changes", async () => {
    stubFakeWebSocket(true);
    renderPane();

    const webglAddon = getLatestWebglAddonInstance();
    webglAddon.clearTextureAtlas.mockClear();
    vi.mocked(repaintAllTerminals).mockClear();

    act(() => {
      useDashboardStore.setState((s) => ({
        settings: { ...s.settings, terminal: { ...s.settings.terminal, fontSize: 18 } },
      }));
    });

    expect(webglAddon.clearTextureAtlas).toHaveBeenCalledTimes(1);
    // No exceptSessionId — a genuine font/theme change invalidates the
    // shared atlas for every terminal, including this one, unlike the
    // mount-time sibling repaint above which excludes the mounting pane.
    expect(repaintAllTerminals).toHaveBeenCalledExactlyOnceWith();
    // Regression coverage for PR #724's narrow-pane font auto-fit: a pane
    // that was never floored (this one — no geometry echo has ever arrived)
    // must land on exactly the newly-configured size, not some auto-fit
    // shrink of it.
    expect(getLatestTermInstance().options.fontSize).toBe(18);
  });

  it("wipes the atlas and repaints on a color scheme change too", async () => {
    stubFakeWebSocket(true);
    renderPane();

    const webglAddon = getLatestWebglAddonInstance();
    webglAddon.clearTextureAtlas.mockClear();
    vi.mocked(repaintAllTerminals).mockClear();

    act(() => {
      useDashboardStore.setState((s) => ({
        settings: { ...s.settings, terminal: { ...s.settings.terminal, colorScheme: "solarized" } },
      }));
    });

    expect(webglAddon.clearTextureAtlas).toHaveBeenCalledTimes(1);
    expect(repaintAllTerminals).toHaveBeenCalledExactlyOnceWith();
  });

  it("does not wipe the atlas or repaint on an unrelated pref change (cursor blink)", async () => {
    stubFakeWebSocket(true);
    renderPane();

    const webglAddon = getLatestWebglAddonInstance();
    webglAddon.clearTextureAtlas.mockClear();
    vi.mocked(repaintAllTerminals).mockClear();

    act(() => {
      useDashboardStore.setState((s) => ({
        settings: { ...s.settings, terminal: { ...s.settings.terminal, cursorBlink: false } },
      }));
    });

    expect(webglAddon.clearTextureAtlas).not.toHaveBeenCalled();
    expect(repaintAllTerminals).not.toHaveBeenCalled();
  });
});

describe("TerminalPane pane padding (issue #91)", () => {
  it("insets the terminal container by the configured padding instead of CSS padding", () => {
    stubFakeWebSocket(true);
    const { container } = renderPane();

    // The containerRef div is the one xterm opens into — distinguish it
    // from the outer position:relative wrapper by its inline inset, which
    // only this div ever sets. No CSS padding: FitAddon measures this
    // element's own box, so padding here would overflow the last row.
    const containerDiv = container.querySelector("div[style*='inset']") as HTMLDivElement;
    expect(containerDiv).toBeTruthy();
    expect(containerDiv.style.inset).toBe("4px");
    expect(containerDiv.style.position).toBe("absolute");
    expect(containerDiv.style.padding).toBe("");
  });

  it("re-fits the terminal when the padding setting changes", async () => {
    stubFakeWebSocket(true);
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    const fitAddon = getLatestFitAddonInstance();
    fitAddon.fit.mockClear();

    act(() => {
      useDashboardStore.setState((s) => ({
        settings: { ...s.settings, terminal: { ...s.settings.terminal, padding: 10 } },
      }));
    });

    await waitFor(() => expect(fitAddon.fit).toHaveBeenCalled());
  });

  it("reflects a padding change in the rendered container's inline style", () => {
    stubFakeWebSocket(true);
    const { container } = renderPane();

    act(() => {
      useDashboardStore.setState((s) => ({
        settings: { ...s.settings, terminal: { ...s.settings.terminal, padding: 0 } },
      }));
    });

    const containerDiv = container.querySelector("div[style*='inset']") as HTMLDivElement;
    expect(containerDiv.style.inset).toBe("0px");
  });
});
