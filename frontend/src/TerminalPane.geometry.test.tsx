// @vitest-environment jsdom
// Geometry sync: the server's applied echo, the narrow-pane font
// auto-fit, and the grid-size ceiling that stops a dock monitor's runaway
// resize.
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
  mockInitialTermSize,
  fitCallbackQueue,
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
import { MAX_TERMINAL_COLS, MAX_TERMINAL_ROWS } from "./lib/terminalGridSize.js";
import {
  renderPane,
  stubFakeWebSocket,
  fakeSocket,
  fakeWsSend,
  getLatestTermInstance,
  getLatestFitAddonInstance,
  stubManualResizeObserver,
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

// Issue: small panes/floating windows ignoring input — pty-manager.ts floors
// a too-small resize (MIN_TERMINAL_COLS/ROWS) and TerminalPane.tsx never knew
// about the clamp, so xterm's own grid silently drifted from what the pty was
// actually drawing to (a 300x300 dockview default floating group, or a
// heavily-split pane, both land under the floor at the terminal's default
// font size). The fix is the server echoing its applied geometry back over
// the same WS as a GeometryMessage (see that type's own doc comment in
// ws-protocol.ts) — these tests cover TerminalPane's handler for it.
describe("TerminalPane geometry sync (issue: small panes/floating windows ignoring input)", () => {
  // Regression test for PR #724 — the narrow-pane font auto-fit used to
  // target `geo.cols`/`geo.rows` (this session's CURRENT applied geometry,
  // which the client's own resizes keep changing) instead of the server's
  // CONSTANT MIN_TERMINAL_COLS/ROWS floor. On attach, the FIRST geometry
  // echo can reflect a size from before this client's own resize was
  // processed (a stale `session.size`, e.g. left over from a previous,
  // differently-sized attach) — that stale echo used to arm a shrink
  // against itself, on an ordinary, comfortably-wide docked pane that was
  // never anywhere near the real 40x10 floor. Reproduces the real attach
  // frame order (routes/terminal.ts's attachSocketToSession): a stale
  // geometry echo sent before this client's own resize is processed, then a
  // second echo confirming what the client actually asked for.
  it("does not shrink the font for a normal pane, even when the first geometry echo is stale and larger than the pane", () => {
    stubFakeWebSocket(true);
    renderPane();
    // This pane's real, font-independent natural fit — flat/font-oblivious
    // on purpose (unlike the font-aware mock further down in this describe
    // block) so this test isolates the arming bug from the shrink-ratio
    // math computeFitFontSize.test.ts already covers on its own.
    getLatestFitAddonInstance().proposeDimensions.mockReturnValue({ cols: 90, rows: 30 });

    // Stale echo: larger than this pane's own 90x30 fit — e.g. a previous,
    // wider attach's applied size, arriving before the server has processed
    // this client's own resize.
    act(() => {
      for (const handler of fakeSocket._messageHandlers) {
        handler({
          data: JSON.stringify({ type: "geometry", cols: 126, rows: 42, minCols: 40, minRows: 10 }),
        });
      }
    });
    // On origin/main (pre-fix) this is ~10 — computeFitFontSize's ratio math
    // shrinking against the stale 126x42 "target." Asserted here (not just
    // at the end) because the bug is a transient-but-real mis-shrink, not
    // merely a final divergent value — see this test's own header comment.
    expect(getLatestTermInstance().options.fontSize).toBe(14);

    // Second echo: the server confirming the resize this client actually
    // sent for its own 90x30 fit.
    act(() => {
      for (const handler of fakeSocket._messageHandlers) {
        handler({
          data: JSON.stringify({ type: "geometry", cols: 90, rows: 30, minCols: 40, minRows: 10 }),
        });
      }
    });
    expect(getLatestTermInstance().options.fontSize).toBe(14);
  });

  it("resizes xterm to the server's applied geometry and flags the pane as too small when it exceeds what fits", () => {
    stubFakeWebSocket(true);
    // Simulates a pane whose viewport only fits a 20x8 grid — smaller than
    // pty-manager.ts's 40x10 floor, e.g. a freshly-floated session at
    // dockview's own 300x300 default (constants.js) or a heavily-split pane.
    mockInitialTermSize.cols = 20;
    mockInitialTermSize.rows = 8;
    renderPane();

    act(() => {
      for (const handler of fakeSocket._messageHandlers) {
        handler({
          data: JSON.stringify({ type: "geometry", cols: 40, rows: 10, minCols: 40, minRows: 10 }),
        });
      }
    });

    const term = getLatestTermInstance();
    expect(term.resize).toHaveBeenCalledWith(40, 10);
    expect(screen.getByText("Pane too small")).toBeInTheDocument();
  });

  // Narrow-pane font auto-fit — when the container is too small for the
  // server's floor at the configured font size but WOULD fit it at a
  // smaller one, TerminalPane should shrink the font (rather than leave the
  // grid clipped past the pane's own edge), and the "Pane too small" hint
  // should clear once that shrink actually resolves things. Unlike every
  // other test in this file — which treats proposeDimensions() as a flat
  // container-size knob (`mockInitialTermSize`) — this test makes it
  // font-size-aware, because that's the one dimension this feature actually
  // depends on: a smaller font must report more achievable columns for the
  // same physical container.
  it("shrinks the font instead of leaving the grid clipped, and clears the hint once it fits", () => {
    stubFakeWebSocket(true);
    renderPane();

    const baseCols = 25;
    const baseRows = 9;
    const proposedAt = (fontSize: number) => ({
      cols: Math.floor(baseCols * (14 / fontSize)),
      rows: Math.floor(baseRows * (14 / fontSize)),
    });
    getLatestFitAddonInstance().proposeDimensions.mockImplementation(() => {
      const fontSize = (getLatestTermInstance().options.fontSize as number | undefined) ?? 14;
      // Cell width scales ~linearly with font size — the same assumption
      // computeFitFontSize's own ratio math makes, mirrored here so this
      // stand-in behaves like a real container would.
      return proposedAt(fontSize);
    });
    // Stands in for the real FitAddon.fit(): applies whatever
    // proposeDimensions() would report at the font size current when it
    // fires — same "queue one callback to model the real resize side
    // effect" pattern every other geometry test in this file uses.
    fitCallbackQueue.push(() => {
      const term = getLatestTermInstance();
      const fontSize = (term.options.fontSize as number | undefined) ?? 14;
      const proposed = proposedAt(fontSize);
      term.cols = proposed.cols;
      term.rows = proposed.rows;
    });

    act(() => {
      for (const handler of fakeSocket._messageHandlers) {
        handler({
          data: JSON.stringify({ type: "geometry", cols: 40, rows: 10, minCols: 40, minRows: 10 }),
        });
      }
    });

    const term = getLatestTermInstance();
    // 25/40 = 0.625 cols ratio (the binding constraint over 9/10 = 0.9);
    // 14 * 0.625 = 8.75, floored to 8 — at MIN_RENDER_FONT_SIZE, not below
    // it, so still achievable.
    expect(term.options.fontSize).toBe(8);
    // At fontSize 8 the container now proposes floor(25 * 14/8) = 43 cols,
    // clearing the 40-col floor — refit()'s own pre-existing capped-branch
    // re-check (unmodified by this feature) is what clears the hint here.
    expect(screen.queryByText("Pane too small")).not.toBeInTheDocument();
  });

  // Independent code review — the shrink test above proves the font goes
  // DOWN; this proves it comes back UP once the pane is genuinely spacious
  // again, via a pure container resize with no settings/theme change
  // involved (refit()'s own fitRetryTick bump, not the geometry handler —
  // see that bump's own comment for why a resize-only path needs it too).
  it("restores the configured font once the container grows back past the floor", () => {
    stubFakeWebSocket(true);
    const resizeObserver = stubManualResizeObserver();
    renderPane();
    act(() => {
      resizeObserver.fire(); // deferred initial connect (issue #676)
    });

    let baseCols = 25;
    let baseRows = 9;
    const proposedAt = (fontSize: number) => ({
      cols: Math.floor(baseCols * (14 / fontSize)),
      rows: Math.floor(baseRows * (14 / fontSize)),
    });
    getLatestFitAddonInstance().proposeDimensions.mockImplementation(() => {
      const fontSize = (getLatestTermInstance().options.fontSize as number | undefined) ?? 14;
      return proposedAt(fontSize);
    });
    const settle = () => {
      const term = getLatestTermInstance();
      const fontSize = (term.options.fontSize as number | undefined) ?? 14;
      const proposed = proposedAt(fontSize);
      term.cols = proposed.cols;
      term.rows = proposed.rows;
    };
    fitCallbackQueue.push(settle);

    act(() => {
      for (const handler of fakeSocket._messageHandlers) {
        handler({
          data: JSON.stringify({ type: "geometry", cols: 40, rows: 10, minCols: 40, minRows: 10 }),
        });
      }
    });
    const term = getLatestTermInstance();
    expect(term.options.fontSize).toBe(8); // same shrink as the test above

    // The container genuinely widens — 50x20 comfortably fits the 40x10
    // floor even at the full configured 14px font, unlike the earlier
    // 25x9 (which only fit once shrunk). Several settle callbacks queued
    // since the resize->tick->re-measure->resize chain can take a few
    // internal passes to converge (see fitRetryTick's own comment) — see
    // that settle-cascade converging is exactly what this test is
    // verifying, not a fixed call count.
    baseCols = 50;
    baseRows = 20;
    for (let i = 0; i < 5; i++) fitCallbackQueue.push(settle);

    act(() => {
      resizeObserver.fire();
    });

    expect(term.options.fontSize).toBe(14);
    expect(screen.queryByText("Pane too small")).not.toBeInTheDocument();
  });

  it("is a no-op when the server's geometry already matches the fitted grid", () => {
    stubFakeWebSocket(true);
    mockInitialTermSize.cols = 40;
    mockInitialTermSize.rows = 10;
    renderPane();

    act(() => {
      for (const handler of fakeSocket._messageHandlers) {
        handler({
          data: JSON.stringify({ type: "geometry", cols: 40, rows: 10, minCols: 40, minRows: 10 }),
        });
      }
    });

    const term = getLatestTermInstance();
    expect(term.resize).not.toHaveBeenCalled();
    expect(screen.queryByText("Pane too small")).not.toBeInTheDocument();
  });

  // Hermes review, PR #708 — proposeDimensions() returns undefined when the
  // container can't fit even one character cell (a near-collapsed pane, or
  // the brief zero-height layout state mid-drag). The naive `proposed !==
  // undefined && (...)` check treats that as "not too small," hiding the
  // hint exactly when the pane is least usable — undefined must count as
  // too small.
  it('shows "Pane too small" when the container is too small to propose any dimensions at all', () => {
    stubFakeWebSocket(true);
    renderPane();
    getLatestFitAddonInstance().proposeDimensions.mockReturnValue(undefined);

    act(() => {
      for (const handler of fakeSocket._messageHandlers) {
        handler({
          data: JSON.stringify({ type: "geometry", cols: 40, rows: 10, minCols: 40, minRows: 10 }),
        });
      }
    });

    expect(screen.getByText("Pane too small")).toBeInTheDocument();
  });

  // mullion-reviewer, PR "target the PTY floor" — fitFloorRef is now set
  // from every pane's very first geometry echo (it's just the constant
  // floor), so applyFontFit runs on every settings/theme change for every
  // pane, INCLUDING a `display:none` one dockview keeps mounted (a restored
  // workspace's inactive tabs — see the settings-sync effect's own comment
  // on that). FitAddon.proposeDimensions() reads `getComputedStyle(...)
  // .width/height` via parseInt, which resolves to NaN (not undefined) for
  // such a container — a case the `!proposed` check alone doesn't catch.
  // Without the Number.isFinite guards (both here and inside
  // computeFitFontSize), NaN would flow through the ratio math and back out
  // as the font size, which `fontSize === term.options.fontSize` can never
  // match (NaN !== NaN) — reapplying on every subsequent settings/theme
  // change forever, on a pane that was never actually narrow.
  it("does not corrupt the font when a hidden pane's container reports NaN dimensions on a settings change", () => {
    stubFakeWebSocket(true);
    renderPane();

    // Establishes fitFloorRef (any valid echo does, post-fix) without
    // implying the pane is actually too small.
    act(() => {
      for (const handler of fakeSocket._messageHandlers) {
        handler({
          data: JSON.stringify({ type: "geometry", cols: 80, rows: 24, minCols: 40, minRows: 10 }),
        });
      }
    });

    // Simulates FitAddon.proposeDimensions() on a `display:none` container.
    getLatestFitAddonInstance().proposeDimensions.mockReturnValue({ cols: NaN, rows: NaN });

    act(() => {
      useDashboardStore.setState((s) => ({
        settings: { ...s.settings, terminal: { ...s.settings.terminal, fontSize: 18 } },
      }));
    });

    expect(getLatestTermInstance().options.fontSize).toBe(18);
  });

  // Independent code review, PR #708 — unlike the backend's own
  // isResizeMessage guard for the opposite direction of this socket, the
  // geometry handler used to trust `parsed.cols`/`parsed.rows` unconditionally
  // once `parsed.type === "geometry"` matched, with no check that they're
  // actually numbers. For a remote-hosted session this frame crosses an
  // agent-to-primary proxy that forwards it as an opaque, unvalidated
  // pass-through (proxyToRemoteAttach, routes/terminal.ts).
  it("ignores a malformed geometry frame (non-numeric cols/rows) instead of resizing on bad data", () => {
    stubFakeWebSocket(true);
    renderPane();

    act(() => {
      for (const handler of fakeSocket._messageHandlers) {
        handler({ data: JSON.stringify({ type: "geometry", cols: "40", rows: 10 }) });
      }
    });

    const term = getLatestTermInstance();
    expect(term.resize).not.toHaveBeenCalled();
    expect(screen.queryByText("Pane too small")).not.toBeInTheDocument();
  });

  it("suppresses the next refit's resize frame once the server's applied geometry lands", () => {
    stubFakeWebSocket(true);
    const resizeObserver = stubManualResizeObserver();
    mockInitialTermSize.cols = 20;
    mockInitialTermSize.rows = 8;

    renderPane();
    act(() => {
      resizeObserver.fire(); // deferred initial connect (issue #676)
    });

    act(() => {
      for (const handler of fakeSocket._messageHandlers) {
        handler({
          data: JSON.stringify({ type: "geometry", cols: 40, rows: 10, minCols: 40, minRows: 10 }),
        });
      }
    });

    const term = getLatestTermInstance();
    expect(term.resize).toHaveBeenCalledWith(40, 10);
    // Simulate the resize having actually taken effect, the same way the
    // deferred-connect tests above simulate fitCallbackQueue's re-measure —
    // the mocked term.resize (unlike the real xterm.js one) doesn't mutate
    // cols/rows itself.
    term.cols = 40;
    term.rows = 10;

    const sendsAfterGeometry = fakeWsSend.mock.calls.length;
    act(() => {
      resizeObserver.fire(); // e.g. the container's own layout settling further
    });

    // Without the geometry handler updating lastCols/lastRows, this refit()
    // would see term.cols/rows (40/10) differ from the STALE lastCols/
    // lastRows captured at mount (20/8) and re-send an already-redundant
    // {cols:40,rows:10} frame right back to the server it just came from.
    expect(fakeWsSend.mock.calls.length).toBe(sendsAfterGeometry);
  });

  // Hermes review, PR #708 — the previous test above simulates the server's
  // resize "taking effect" by manually overwriting term.cols/rows, which is
  // accurate for the mock's own no-op fit() but hides a real interaction:
  // on a genuinely too-small CONTAINER, the real fitAddon.fit() re-measures
  // and shrinks xterm back down on every subsequent layout event, no matter
  // what term.resize() just set it to — so without the refit()-side guard,
  // every later ResizeObserver delivery (not just a real resize of this
  // pane) would re-trigger fit() -> shrink -> mismatch -> a fresh resize
  // send, forever bouncing between the container's real size and the
  // server's floor. This test's fitCallbackQueue entry stands in for that
  // real fit()-shrinks-back behavior; the guard's job is to never let it run
  // at all while capped below the floor and the container hasn't grown.
  it("does not re-fit (and re-shrink) a still-too-small container on a later layout event", () => {
    stubFakeWebSocket(true);
    const resizeObserver = stubManualResizeObserver();
    // The container can only ever fit 20x8 — unlike the previous test, this
    // stays true for the rest of the test (nothing widens the container),
    // so proposeDimensions() keeps reporting the same too-small size.
    mockInitialTermSize.cols = 20;
    mockInitialTermSize.rows = 8;

    renderPane();
    act(() => {
      resizeObserver.fire(); // deferred initial connect (issue #676)
    });

    act(() => {
      for (const handler of fakeSocket._messageHandlers) {
        handler({
          data: JSON.stringify({ type: "geometry", cols: 40, rows: 10, minCols: 40, minRows: 10 }),
        });
      }
    });
    const term = getLatestTermInstance();
    expect(term.resize).toHaveBeenCalledWith(40, 10);
    term.cols = 40;
    term.rows = 10;

    const fitAddon = getLatestFitAddonInstance();
    const fitCallsAfterGeometry = fitAddon.fit.mock.calls.length;
    const sendsAfterGeometry = fakeWsSend.mock.calls.length;
    // Stands in for the real xterm.js FitAddon: if refit() ever calls
    // fit() again while still capped, this callback fires and shrinks the
    // terminal right back down to what the (unchanged) container reports.
    fitCallbackQueue.push(() => {
      term.cols = 20;
      term.rows = 8;
    });

    act(() => {
      resizeObserver.fire(); // e.g. an unrelated sibling pane's own resize
    });

    expect(fitAddon.fit.mock.calls.length).toBe(fitCallsAfterGeometry);
    expect(term.cols).toBe(40);
    expect(term.rows).toBe(10);
    expect(fakeWsSend.mock.calls.length).toBe(sendsAfterGeometry);
  });

  // The counterpart to the test above — once the container genuinely grows
  // past the floor, refit() must stop skipping and resume normal fit()/
  // resize-send behavior.
  it("resumes normal fit()/resize once the container grows past the floor", () => {
    stubFakeWebSocket(true);
    const resizeObserver = stubManualResizeObserver();
    mockInitialTermSize.cols = 20;
    mockInitialTermSize.rows = 8;

    renderPane();
    act(() => {
      resizeObserver.fire();
    });
    act(() => {
      for (const handler of fakeSocket._messageHandlers) {
        handler({
          data: JSON.stringify({ type: "geometry", cols: 40, rows: 10, minCols: 40, minRows: 10 }),
        });
      }
    });
    const term = getLatestTermInstance();
    term.cols = 40;
    term.rows = 10;

    // The container widens past the floor — proposeDimensions() (and the
    // real fit() it stands in for) now reports 80x24.
    mockInitialTermSize.cols = 80;
    mockInitialTermSize.rows = 24;
    fitCallbackQueue.push(() => {
      term.cols = 80;
      term.rows = 24;
    });
    const sendsBeforeGrow = fakeWsSend.mock.calls.length;

    act(() => {
      resizeObserver.fire();
    });

    expect(term.cols).toBe(80);
    expect(term.rows).toBe(24);
    const resizeMessages = fakeWsSend.mock.calls
      .slice(sendsBeforeGrow)
      .map(([data]) => JSON.parse(data as string) as { type?: string; cols?: number });
    expect(resizeMessages.some((m) => m.type === "resize" && m.cols === 80)).toBe(true);
  });

  // Independent code review, PR #708 — the growth test above lands strictly
  // ABOVE the floor, which sends a real resize and lets the geometry
  // handler clear the hint the ordinary way. This test grows the container
  // to land EXACTLY on the floor: refit()'s own `term.cols === lastCols &&
  // term.rows === lastRows` guard means no resize is ever sent for that
  // case (nothing about the applied size actually changed), so no fresh
  // geometry echo ever arrives either — without refit() re-evaluating
  // cappedBelowFloor itself, the hint would stay stuck up forever even
  // though the pane is no longer too small.
  it('clears "Pane too small" when the container grows to exactly the floor, with no resize round trip', () => {
    stubFakeWebSocket(true);
    const resizeObserver = stubManualResizeObserver();
    mockInitialTermSize.cols = 20;
    mockInitialTermSize.rows = 8;

    renderPane();
    act(() => {
      resizeObserver.fire();
    });
    act(() => {
      for (const handler of fakeSocket._messageHandlers) {
        handler({
          data: JSON.stringify({ type: "geometry", cols: 40, rows: 10, minCols: 40, minRows: 10 }),
        });
      }
    });
    const term = getLatestTermInstance();
    term.cols = 40;
    term.rows = 10;
    expect(screen.getByText("Pane too small")).toBeInTheDocument();

    // The container grows to EXACTLY the floor — fit() would compute the
    // same 40x10 the pty is already running at, a true no-op.
    mockInitialTermSize.cols = 40;
    mockInitialTermSize.rows = 10;
    const sendsBeforeGrow = fakeWsSend.mock.calls.length;

    act(() => {
      resizeObserver.fire();
    });

    expect(screen.queryByText("Pane too small")).not.toBeInTheDocument();
    expect(fakeWsSend.mock.calls.length).toBe(sendsBeforeGrow);
  });

  it("down-fits from backend default 80 cols to mobile container size (45 cols) without showing Pane too small", () => {
    stubFakeWebSocket(true);
    const resizeObserver = stubManualResizeObserver();
    mockInitialTermSize.cols = 45;
    mockInitialTermSize.rows = 24;

    renderPane();
    act(() => {
      resizeObserver.fire();
    });

    const term = getLatestTermInstance();
    fitCallbackQueue.push(() => {
      term.cols = 45;
      term.rows = 24;
    });

    // Backend echoes initial 80x24 session geometry with 40x10 floor
    const sendsBeforeEcho = fakeWsSend.mock.calls.length;
    act(() => {
      for (const handler of fakeSocket._messageHandlers) {
        handler({
          data: JSON.stringify({ type: "geometry", cols: 80, rows: 24, minCols: 40, minRows: 10 }),
        });
      }
    });

    // Container is 45 cols >= 40 floor, so "Pane too small" must NOT show
    expect(screen.queryByText("Pane too small")).not.toBeInTheDocument();

    expect(term.cols).toBe(45);
    const resizeMessages = fakeWsSend.mock.calls
      .slice(sendsBeforeEcho)
      .map(([data]) => JSON.parse(data as string) as { type?: string; cols?: number });
    expect(resizeMessages.some((m) => m.type === "resize" && m.cols === 45)).toBe(true);
  });
});

// Dock monitor resize-runaway — the dock's CSS lets a terminal's own
// rendered content inflate the size of the container this pane measures
// itself against next (see lib/terminalGridSize.ts's own doc comment for the
// full mechanism, and empty-states.css's `.dock-monitor-body` for the CSS
// half of the fix), which without a ceiling closed into an unbounded resize
// loop that locked up the tab. applyClampedFit() is the single choke point
// shared by the mount-time fit, connectOnce()'s re-fit, and refit() — these
// tests cover all three, since a runaway proposal reaching any one of them
// unclamped would still let the loop compound.
describe("TerminalPane grid-size ceiling (dock monitor resize-runaway)", () => {
  it("clamps the initial mount fit and connectOnce's re-fit when the container is already inflated", () => {
    stubFakeWebSocket(true);
    // mockInitialTermSize feeds BOTH the Terminal mock's own initial
    // cols/rows AND FitAddon.proposeDimensions()'s default return (see its
    // own doc comment) — setting it huge simulates exactly the scenario
    // this bug reproduced live: a pane mounting inside a shared dock
    // container a SIBLING monitor's own prior runaway has already inflated,
    // so even this pane's very FIRST measurement (at mount, before any
    // resize of its own) reports an oversized grid.
    mockInitialTermSize.cols = 35_140;
    mockInitialTermSize.rows = 9_000;

    // renderPane()'s default ResizeObserver stub (unlike
    // stubManualResizeObserver() used elsewhere in this file) fires
    // synchronously on observe() — so mounting exercises BOTH the raw
    // term.open()/applyClampedFit() call and connectOnce()'s own
    // applyClampedFit() re-fit in one render, matching how they actually
    // run back-to-back in the real mount effect.
    renderPane();

    const term = getLatestTermInstance();
    // toHaveBeenLastCalledWith, not toHaveBeenCalledWith — this mock's own
    // resize() never applies a size itself (see its own doc comment above),
    // so a plain "was called with the ceiling at some point" would pass
    // whether or not an earlier, unclamped call also went through; asserting
    // the LAST call is the discriminating check.
    expect(term.resize).toHaveBeenLastCalledWith(MAX_TERMINAL_COLS, MAX_TERMINAL_ROWS);
  });

  it("clamps a later refit() when the container grows past the ceiling", () => {
    stubFakeWebSocket(true);
    const resizeObserver = stubManualResizeObserver();
    mockInitialTermSize.cols = 80;
    mockInitialTermSize.rows = 24;

    renderPane();
    act(() => {
      resizeObserver.fire(); // deferred initial connect (issue #676)
    });

    const term = getLatestTermInstance();
    const resizeCallsBeforeRunaway = term.resize.mock.calls.length;

    // The shared dock container has since been inflated by a sibling
    // monitor's own runaway growth (or, in principle, any other cause) —
    // this pane's own next layout event proposes a grid to match.
    mockInitialTermSize.cols = 35_140;
    mockInitialTermSize.rows = 9_000;

    act(() => {
      resizeObserver.fire();
    });

    expect(term.resize.mock.calls.length).toBeGreaterThan(resizeCallsBeforeRunaway);
    expect(term.resize).toHaveBeenLastCalledWith(MAX_TERMINAL_COLS, MAX_TERMINAL_ROWS);
  });

  // Hermes review — the geometry-echo handler trusts geo.cols/rows as
  // already within bounds because the SAME-version backend's own
  // clampTerminalSize() bounds session.size before ever echoing it; this
  // simulates the one case that isn't true — a differently-versioned (e.g.
  // remote-hosted, this file's own comment on that frame) host echoing a
  // size from before that ceiling existed.
  it("clamps an oversized geometry echo (e.g. a pre-ceiling remote host)", () => {
    stubFakeWebSocket(true);
    renderPane();

    act(() => {
      for (const handler of fakeSocket._messageHandlers) {
        handler({
          data: JSON.stringify({
            type: "geometry",
            cols: 35_140,
            rows: 9_000,
            minCols: 40,
            minRows: 10,
          }),
        });
      }
    });

    const term = getLatestTermInstance();
    expect(term.resize).toHaveBeenLastCalledWith(MAX_TERMINAL_COLS, MAX_TERMINAL_ROWS);
  });
});
