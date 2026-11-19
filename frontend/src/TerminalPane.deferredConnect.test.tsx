// @vitest-environment jsdom
// The deferred initial connect: the pane waits for the first
// post-layout ResizeObserver delivery before it connects (issue #676).
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

import { act } from "react";
import {
  renderPane,
  stubFakeWebSocket,
  fakeSocket,
  fakeWsSend,
  fakeWsUrls,
  getLatestTermInstance,
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

// Issue #676's frontend follow-up — the backend clamp (pty-manager.ts's
// MIN_TERMINAL_COLS/ROWS, PR #686) already stops a garbage-tiny size from
// ever reaching a session's pty, but this pane's very first connect() used
// to fire synchronously in the mount effect, before dockview had
// necessarily finished laying out a brand-new panel — so the FIRST thing
// the backend ever heard could still be a measurement taken before layout
// ran (the production incident's own `cols=10&rows=13`). These tests prove
// the fix: the initial connect() is deferred to the first post-layout
// ResizeObserver delivery, re-measuring via fitAddon.fit() right before it.
// A ResizeObserver stub that captures its callback WITHOUT auto-firing it
// (unlike this file's default `beforeEach` stub, which fires synchronously
// on observe() — fine for every other test, but it collapses the exact
// async gap these tests need: in the real browser, and in the pre-fix
// source, the observer's first delivery lands strictly AFTER connect() has
// already fired with whatever term.cols/rows happened to be at that
// synchronous point in the mount effect). Returns a `fire()` the test calls
// once it wants to simulate "layout has now completed."

describe("TerminalPane deferred initial connect (issue #676 frontend follow-up)", () => {
  it("never sends a resize frame carrying a size measured before the first post-layout fit()", () => {
    // openImmediately=false: the fake socket's readyState starts at
    // CONNECTING, same as a real handshake — collapsing that gap (as
    // openImmediately=true does) would hide the very race this test exists
    // to catch, since sendResizeIfOpen()'s readyState gate would trivially
    // pass the instant `ws` is assigned instead of only once truly "open."
    stubFakeWebSocket(false);
    const resizeObserver = stubManualResizeObserver();
    // The incident's own bad measurement — what the mount's own synchronous
    // fitAddon.fit() (before layout has necessarily run) reports.
    mockInitialTermSize.cols = 10;
    mockInitialTermSize.rows = 13;
    // Two fit() calls happen synchronously during mount, before the
    // ResizeObserver ever gets a chance to fire — the mount effect's own
    // `fitAddon.fit()`, and the settings-sync effect's own `refitRef.current()`
    // fallback (jsdom has no `document.fonts`, so that effect's "font
    // finished loading" path runs synchronously on every render, including
    // the first — see that effect's own comment in TerminalPane.tsx). Both
    // are no-ops here, so the bad size sticks through mount exactly like the
    // real race. The THIRD fit() call is the observer's own delivery (fired
    // manually below) — on unfixed source that's an ordinary refit() call;
    // on fixed source it's connectOnce's own re-measure.
    fitCallbackQueue.push(() => {});
    fitCallbackQueue.push(() => {});
    fitCallbackQueue.push(() => {
      const term = getLatestTermInstance();
      term.cols = 80;
      term.rows = 24;
    });

    renderPane();
    // Simulate the real handshake completing FIRST, before layout ever gets
    // a chance to correct anything — matching both production timing (the
    // browser can complete a same-origin WS handshake before a brand-new
    // dockview panel's layout settles) and the literal incident evidence
    // (`cols=10&rows=13` reached the backend at all, which requires the
    // socket to have opened while the bad measurement was still current).
    act(() => {
      fakeSocket.readyState = 1;
      for (const handler of fakeSocket._openHandlers) handler();
    });
    // THEN layout "completes." On unfixed source this is a late correction
    // — after the socket already opened and (see below) already sent the
    // bad size once. On fixed source this is connectOnce's own re-measure,
    // and connect() (hence "open") hasn't happened at all until now.
    act(() => {
      resizeObserver.fire();
    });
    // Fixed source only just registered its (real) open handler inside the
    // resizeObserver.fire() call above — fire "open" again so it gets a
    // chance to run too. Harmless on unfixed source: same already-registered
    // handler, re-invoked with an already-correct size.
    act(() => {
      fakeSocket.readyState = 1;
      for (const handler of fakeSocket._openHandlers) handler();
    });

    // The frame that actually reached session 330's pty in the incident was
    // this resize (from the `open` handler's sendResizeIfOpen), not the WS
    // URL — getOrCreate() (pty-manager.ts) ignores cols/rows for a session
    // that's already alive, which a promoted session always is by the time
    // its pane attaches.
    const resizeMessages = fakeWsSend.mock.calls
      .map(
        ([data]) => JSON.parse(data as string) as { type?: string; cols?: number; rows?: number },
      )
      .filter((m) => m.type === "resize");
    expect(resizeMessages.length).toBeGreaterThan(0);
    expect(resizeMessages.every((m) => m.cols === 80 && m.rows === 24)).toBe(true);
  });

  it("carries the corrected size in the FIRST connect URL too (secondary path: a session recreated at attach time)", () => {
    stubFakeWebSocket(false);
    const resizeObserver = stubManualResizeObserver();
    mockInitialTermSize.cols = 10;
    mockInitialTermSize.rows = 13;
    // See the previous test's comment for why this needs three entries, not
    // two: two fit() calls (mount's own, and the settings-sync effect's own
    // synchronous fallback) happen before the ResizeObserver ever fires.
    fitCallbackQueue.push(() => {});
    fitCallbackQueue.push(() => {});
    fitCallbackQueue.push(() => {
      const term = getLatestTermInstance();
      term.cols = 80;
      term.rows = 24;
    });

    renderPane();
    act(() => {
      resizeObserver.fire();
    });

    // Exactly one connect() attempt so far, and its URL already carries the
    // corrected size — on unfixed source, connect() fires synchronously in
    // the mount effect itself (before resizeObserver.fire() above), so its
    // URL would carry the bad 10x13 measurement instead.
    expect(fakeWsUrls).toHaveLength(1);
    const url = new URL(fakeWsUrls[0]!, "http://localhost");
    expect(url.searchParams.get("cols")).toBe("80");
    expect(url.searchParams.get("rows")).toBe("24");
  });

  it("still connects via the layout backstop when the ResizeObserver never delivers, re-measuring first (e.g. a hidden dockview tab)", () => {
    vi.useFakeTimers();
    try {
      // A ResizeObserver stub that never calls back at all — standing in
      // for a `display:none` container (an inactive dockview tab, kept
      // mounted) that may never get an initial delivery.
      vi.stubGlobal(
        "ResizeObserver",
        vi.fn(function () {
          return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
        }),
      );
      stubFakeWebSocket(true);
      // Same bad-then-corrected setup as the two tests above — proves the
      // backstop path re-measures via fitAddon.fit() too, not just that
      // SOME connect() eventually fires regardless of size.
      mockInitialTermSize.cols = 10;
      mockInitialTermSize.rows = 13;
      fitCallbackQueue.push(() => {});
      fitCallbackQueue.push(() => {});
      fitCallbackQueue.push(() => {
        const term = getLatestTermInstance();
        term.cols = 80;
        term.rows = 24;
      });

      renderPane();
      expect(fakeWsUrls).toHaveLength(0);

      act(() => {
        vi.advanceTimersByTime(250);
      });

      expect(fakeWsUrls).toHaveLength(1);
      const url = new URL(fakeWsUrls[0]!, "http://localhost");
      expect(url.searchParams.get("cols")).toBe("80");
      expect(url.searchParams.get("rows")).toBe("24");
    } finally {
      vi.useRealTimers();
    }
  });
});
