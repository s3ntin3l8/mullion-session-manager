// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Suspense, useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { IDockviewPanelProps } from "dockview-react";
import { makePanelWrapper, components } from "./registry.js";
import { useDashboardStore } from "../store/index.js";
import { makeSession, makeProject } from "../test/fixtures.js";
import { resetStore } from "../test/resetStore.js";
import { ErrorBoundary } from "../ErrorBoundary.js";
import { useRetriableLazy } from "../lib/retriableLazy.js";

// Minimal stand-in for the dockview panel props every real wrapper receives
// — only `params` is read by makePanelWrapper itself; `api`/`containerApi`
// are supplied so the type checks, same "as unknown as" pattern PaneTab.test.tsx
// already uses for the same interface.
function makeProps<Params extends { [index: string]: unknown }>(
  params: Params,
): IDockviewPanelProps<Params> {
  return { params, api: {}, containerApi: {} } as unknown as IDockviewPanelProps<Params>;
}

interface CounterParams {
  label: string;
}

// A dummy panel that carries its own internal state (a counter) — used to
// prove the load-bearing part of the resetKey pattern: a crash-triggered
// remount must NOT preserve internal state, only the `params` a fresh mount
// is given.
function Counter({ params }: { params: CounterParams }) {
  const [count, setCount] = useState(0);
  return (
    <div>
      <span data-testid="label">{params.label}</span>
      <span data-testid="count">{count}</span>
      <button onClick={() => setCount((c) => c + 1)}>increment</button>
    </div>
  );
}

interface FlakyParams {
  shouldCrash: boolean;
}

// Throws whenever told to via `params.shouldCrash` — a prop, not a mutable
// closure flag, deliberately: React re-runs a throwing render an extra time
// internally (dev-mode's synchronous "recovery" pass) before handing the
// error to the boundary, and a self-resetting closure flag would make only
// the *first* of those two attempts throw, silently swallowing the error
// instead of reaching the boundary. Reading straight from `params` means
// both attempts see the same value, matching how a real crash (bad data, a
// thrown network error) would behave.
function StatefulFlaky({ params }: { params: FlakyParams }) {
  const [count, setCount] = useState(0);
  if (params.shouldCrash) {
    throw new Error("boom");
  }
  return (
    <div>
      <span data-testid="count">{count}</span>
      <button onClick={() => setCount((c) => c + 1)}>increment</button>
    </div>
  );
}

describe("makePanelWrapper", () => {
  // The crash tests below deliberately throw inside a render — React and
  // ErrorBoundary.componentDidCatch both log that to console.error, which is
  // expected here, not a real failure. Silenced per-test rather than
  // globally so a genuinely unexpected console.error elsewhere still shows.
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("passes params through to the wrapped component", () => {
    const Wrapped = makePanelWrapper<CounterParams>(Counter);
    render(<Wrapped {...makeProps({ label: "hello" })} />);
    expect(screen.getByTestId("label")).toHaveTextContent("hello");
  });

  it("shows the crashed-pane fallback on error, then a live remounted child after Reload", async () => {
    const user = userEvent.setup();
    const Wrapped = makePanelWrapper<FlakyParams>(StatefulFlaky);
    const { rerender } = render(<Wrapped {...makeProps({ shouldCrash: true })} />);

    expect(screen.getByText("This pane crashed")).toBeInTheDocument();
    expect(screen.queryByTestId("count")).not.toBeInTheDocument();

    // Fix the underlying cause (same idea as a retried fetch or corrected
    // state), then hit the boundary's own "Reload pane" — matches
    // ErrorBoundary.tsx's own documented contract: a prop change alone does
    // NOT clear a caught error, only onReset()+its own state reset does.
    rerender(<Wrapped {...makeProps({ shouldCrash: false })} />);
    expect(screen.getByText("This pane crashed")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reload pane" }));

    expect(screen.queryByText("This pane crashed")).not.toBeInTheDocument();
    expect(screen.getByTestId("count")).toBeInTheDocument();
  });

  it("does not carry internal state across a crash-triggered remount", async () => {
    const user = userEvent.setup();
    const Wrapped = makePanelWrapper<FlakyParams>(StatefulFlaky);
    const { rerender } = render(<Wrapped {...makeProps({ shouldCrash: false })} />);

    await user.click(screen.getByRole("button", { name: "increment" }));
    await user.click(screen.getByRole("button", { name: "increment" }));
    expect(screen.getByTestId("count")).toHaveTextContent("2");

    // The already-mounted instance (still holding count=2) starts throwing
    // on its next render — same as a real runtime bug surfacing mid-session.
    rerender(<Wrapped {...makeProps({ shouldCrash: true })} />);
    expect(screen.getByText("This pane crashed")).toBeInTheDocument();

    rerender(<Wrapped {...makeProps({ shouldCrash: false })} />);
    await user.click(screen.getByRole("button", { name: "Reload pane" }));

    // Fresh mount under the bumped resetKey — internal useState count is
    // back to 0, not carried over from before the crash.
    expect(screen.getByTestId("count")).toHaveTextContent("0");
  });

  it("wraps the panel in Suspense with the shared fallback when suspense: true", () => {
    // Suspense only fires when a child actually suspends; here we just
    // assert the non-suspended (already-resolved) path renders normally —
    // the fallback itself reuses LazyPanelFallback, kept private to this
    // module (not worth exporting purely to assert its exact markup).
    const Wrapped = makePanelWrapper<CounterParams>(Counter, { suspense: true });
    render(<Wrapped {...makeProps({ label: "suspended-ok" })} />);
    expect(screen.getByTestId("label")).toHaveTextContent("suspended-ok");
  });

  it("passes extraProps derived from the dockview panel props through to the component", () => {
    function WithExtra({ params, extra }: { params: CounterParams; extra: string }) {
      return (
        <div>
          <span data-testid="label">{params.label}</span>
          <span data-testid="extra">{extra}</span>
        </div>
      );
    }
    const Wrapped = makePanelWrapper<CounterParams, { extra: string }>(WithExtra, {
      extraProps: () => ({ extra: "derived" }),
    });
    render(<Wrapped {...makeProps({ label: "hi" })} />);
    expect(screen.getByTestId("extra")).toHaveTextContent("derived");
  });
});

// Workspace-autosave rate-limit-storm fix — TerminalPanelWrapper's own
// onTitleChange throttles OSC title updates (issue #69's live-title
// feature ticks roughly once a second while an agent is "thinking", and
// dockview-core feeds a panel's title change into the same emitter that
// backs onDidLayoutChange — see registry.tsx's own OSC_TITLE_THROTTLE_MS
// comment for the full trace). TerminalPane itself is covered elsewhere
// (its own test file) and reaches for xterm/browser APIs jsdom doesn't
// implement — mocked here the same way DockMonitor.test.tsx's own comment
// explains, capturing the onTitleChange callback this wrapper passes down
// so tests can drive it directly, like a real OSC event stream would.
let capturedOnTitleChange: ((title: string) => void) | null = null;
vi.mock("../TerminalPane.js", () => ({
  TerminalPane: (props: { onTitleChange?: (title: string) => void }) => {
    capturedOnTitleChange = props.onTitleChange ?? null;
    return <div data-testid="terminal-pane" />;
  },
}));

describe("TerminalPanelWrapper — OSC title throttling (workspace-autosave storm fix)", () => {
  beforeEach(() => {
    capturedOnTitleChange = null;
    resetStore();
    useDashboardStore.setState({
      sessions: [makeSession({ id: 1, projectId: 1, nameLocked: false })],
      projects: [makeProject({ id: 1, name: "demo" })],
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderTerminalPanel(setTitle: ReturnType<typeof vi.fn>) {
    const props = {
      params: { sessionId: 1 },
      api: {
        setTitle,
        isActive: false,
        onDidActiveChange: () => ({ dispose: () => {} }),
      },
      containerApi: {},
    } as unknown as IDockviewPanelProps<{ sessionId: number }>;
    render(<components.terminal {...props} />);
  }

  it("applies the first OSC title immediately, with no delay", () => {
    const setTitle = vi.fn();
    renderTerminalPanel(setTitle);

    capturedOnTitleChange?.("first title");

    expect(setTitle).toHaveBeenCalledTimes(1);
    expect(setTitle).toHaveBeenCalledWith("first title · demo");
  });

  it("collapses a burst of titles inside the throttle window into one trailing apply carrying the latest", () => {
    const setTitle = vi.fn();
    renderTerminalPanel(setTitle);
    capturedOnTitleChange?.("first"); // leading-edge apply, starts the window
    setTitle.mockClear();

    capturedOnTitleChange?.("second");
    capturedOnTitleChange?.("third");
    capturedOnTitleChange?.("fourth");
    expect(setTitle).not.toHaveBeenCalled(); // still inside the 1s window

    vi.advanceTimersByTime(1000);

    expect(setTitle).toHaveBeenCalledTimes(1);
    expect(setTitle).toHaveBeenCalledWith("fourth · demo");
  });

  it("applies immediately again once the throttle window has elapsed", () => {
    const setTitle = vi.fn();
    renderTerminalPanel(setTitle);
    capturedOnTitleChange?.("first");
    setTitle.mockClear();
    vi.advanceTimersByTime(1000);

    capturedOnTitleChange?.("second");

    expect(setTitle).toHaveBeenCalledTimes(1);
    expect(setTitle).toHaveBeenCalledWith("second · demo");
  });

  it("never calls setTitle once the session is nameLocked (an explicit rename pins it)", () => {
    useDashboardStore.setState({
      sessions: [makeSession({ id: 1, projectId: 1, nameLocked: true })],
    });
    const setTitle = vi.fn();
    renderTerminalPanel(setTitle);

    capturedOnTitleChange?.("ignored");
    vi.advanceTimersByTime(1000);

    expect(setTitle).not.toHaveBeenCalled();
  });
});

// React 19's lazyInitializer (react/cjs/react.production.js) latches a
// rejected dynamic import forever — the SAME lazy() payload re-throws the
// identical cached error on every subsequent render, with zero new network
// requests. Every real lazy-loaded panel wrapper (KanbanBoardOverlay,
// BrowserPanelWrapper, BrowserPaneWrapper, plus App.tsx's Settings modal)
// now builds its `lazy()` via useRetriableLazy, keyed on the same resetKey
// "Reload pane" already bumps, instead of a module-level `lazy()`
// singleton — this proves that pattern actually lets a retried import
// succeed, using a harness component that mirrors those wrappers' exact
// ErrorBoundary+Suspense+useRetriableLazy shape without depending on a real
// (heavy, always-succeeding-in-jsdom) module import.
describe("useRetriableLazy — 'Reload pane' can recover from a rejected dynamic import", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("recovers once Reload pane rebuilds the lazy() payload and the retried import resolves", async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const loader = vi.fn(() => {
      attempt += 1;
      if (attempt === 1) {
        return Promise.reject(new Error("Failed to fetch dynamically imported module"));
      }
      return Promise.resolve({ default: () => <div data-testid="loaded">loaded</div> });
    });

    function LazyHarness() {
      const [resetKey, setResetKey] = useState(0);
      const Lazy = useRetriableLazy(loader, resetKey);
      return (
        <ErrorBoundary onReset={() => setResetKey((k) => k + 1)}>
          <Suspense fallback={<div data-testid="loading" />}>
            {/* Same intentional new-identity-per-resetKey reasoning as the
                real wrappers this harness mirrors — see registry.tsx's own
                comments on this. */}
            {/* eslint-disable-next-line react-hooks/static-components */}
            <Lazy key={resetKey} />
          </Suspense>
        </ErrorBoundary>
      );
    }

    render(<LazyHarness />);

    expect(await screen.findByText("This pane crashed")).toBeInTheDocument();
    expect(screen.queryByTestId("loaded")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reload pane" }));

    // A second, distinct loader() call is the load-bearing assertion here —
    // without this fix (a module-level `lazy()` singleton reused across the
    // remount), the payload's cached Rejected status would re-throw
    // synchronously and the loader would never be called again.
    expect(await screen.findByTestId("loaded")).toBeInTheDocument();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("This pane crashed")).not.toBeInTheDocument();
  });

  it("shares one resolved payload across sibling mounts of the same loader, on the happy path", async () => {
    const loader = vi.fn(() =>
      Promise.resolve({ default: () => <div data-testid="loaded">loaded</div> }),
    );

    function LazyHarness() {
      const Lazy = useRetriableLazy(loader, 0);
      return (
        <Suspense fallback={<div data-testid="loading" />}>
          {/* Same intentional new-identity-per-resetKey reasoning as the
              other harness above. */}
          {/* eslint-disable-next-line react-hooks/static-components */}
          <Lazy />
        </Suspense>
      );
    }

    const { unmount } = render(<LazyHarness />);
    expect(await screen.findByTestId("loaded")).toBeInTheDocument();
    expect(loader).toHaveBeenCalledTimes(1);
    unmount();

    // A second, independent mount of the SAME loader — e.g. opening a
    // second browser pane after the first has already resolved. Without a
    // cache shared across instances (keyed by loader identity), this would
    // build a brand-new lazy() payload and briefly re-suspend even though
    // the module is already loaded — the loading fallback (and a second
    // loader() call) would show up here.
    render(<LazyHarness />);
    expect(screen.getByTestId("loaded")).toBeInTheDocument();
    expect(screen.queryByTestId("loading")).not.toBeInTheDocument();
    expect(loader).toHaveBeenCalledTimes(1);
  });
});

// The harness test above proves useRetriableLazy itself; this one proves the
// actual production wiring — components.browserPane, i.e. BrowserPaneWrapper
// as registered for real — recovers too, so a future revert back to a bare
// module-level `lazy()` in registry.tsx would break this test.
//
// Mocking "../BrowserPane.js" with a THROWING GETTER (rather than a
// rejecting import()) is what makes a controllable reject-once-then-succeed
// possible here: loadBrowserPane's `.then((m) => ({ default: m.BrowserPane }))`
// reads `m.BrowserPane` on every call, so a getter that throws on its first
// access turns that `.then()` handler's promise rejection into exactly what
// lazy() sees from a real "Failed to fetch dynamically imported module"
// network failure — with no way to actually make jsdom's import() itself
// reject on demand.
let browserPaneImportAttempts = 0;
vi.mock("../BrowserPane.js", () => ({
  get BrowserPane() {
    browserPaneImportAttempts += 1;
    if (browserPaneImportAttempts === 1) {
      throw new Error("Failed to fetch dynamically imported module");
    }
    return () => <div data-testid="browser-pane-loaded" />;
  },
}));

describe("components.browserPane — 'Reload pane' recovers the real registered panel", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    browserPaneImportAttempts = 0;
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("recovers after Reload pane once the retried import resolves", async () => {
    const user = userEvent.setup();
    const BrowserPaneWrapper = components.browserPane;
    render(<BrowserPaneWrapper {...makeProps({ sessionId: 1 })} />);

    expect(await screen.findByText("This pane crashed")).toBeInTheDocument();
    expect(browserPaneImportAttempts).toBe(1);

    await user.click(screen.getByRole("button", { name: "Reload pane" }));

    expect(await screen.findByTestId("browser-pane-loaded")).toBeInTheDocument();
    expect(browserPaneImportAttempts).toBe(2);
  });
});
