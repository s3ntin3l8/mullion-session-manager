// The mock preamble every TerminalPane test file shares: the xterm.js
// addons, the api/registry modules the pane talks to, and the state those
// mocks record (the OSC/CSI/DCS handler maps a test fires by hand, the
// mutable initial grid size, the fit-callback queue).
//
// Extracted from the former frontend/src/TerminalPane.test.tsx, which grew
// past the file-size ceiling (scripts/max-file-lines.baseline.json) and was
// split along its top-level describe blocks (issue #3282).
//
// WHY THIS IS ITS OWN FILE, AND WHY IT MUST BE IMPORTED FIRST:
//
//   A `vi.mock(...)` factory runs the moment the mocked module is first
//   imported — which, for these tests, happens while the harness module
//   (frontend/src/test/terminal-pane-harness.tsx) is still being evaluated
//   (the harness imports TerminalPane.js, which imports @xterm/xterm). Vitest
//   evaluates a test file's imports in order, so the factory's reference to
//   the module that owns it — `mockXtermFactory` below — must already be
//   initialized by then. That is only true if the test file imports THIS
//   module before the harness: this module has no application imports, so
//   evaluating it completes immediately, while the harness's own evaluation
//   is what triggers the mock factories in the first place.
//
//   Hence the rule every split test file follows: this module is imported
//   FIRST, before the harness. The failure mode if that order is broken is
//   loud ("Cannot access '__vi_import_0__' before initialization"), not
//   silent.
//
//   Nothing here imports an application module at runtime, so evaluating this
//   module can never trigger a mock factory itself.
import { vi } from "vitest";
import type * as ApiModule from "../api/index.js";

// Keyed by OSC ident (10/11/12) — populated by the mocked Terminal's
// `parser.registerOscHandler` below so tests can simulate the running
// program sending an OSC query/set payload without a real xterm.js parser.
export const oscHandlers = new Map<number, (data: string) => boolean>();
// Keyed by "<prefix><intermediates><final>", e.g. "n", "?n", ">c", "$p".
export const csiHandlers = new Map<string, () => boolean>();
// Keyed by "<intermediates><final>", e.g. "$q" (DECRQSS).
export const dcsHandlers = new Map<string, () => boolean>();

// Issue #676's frontend follow-up (TerminalPane defers its first connect()
// to the first post-layout ResizeObserver delivery, re-measuring via
// fitAddon.fit() right before it) needs two things the rest of the mocks
// don't: a mutable initial term size (to simulate a pre-layout bad
// measurement, e.g. the incident's own cols=10/rows=13), and a way to make
// fitAddon.fit() actually mutate that size on a given call (real fit()
// mutates term.cols/rows via term.resize(); the mocked FitAddon below is
// otherwise a no-op). `mockInitialTermSize` feeds the Terminal mock's own
// initial `cols`/`rows`; `fitCallbackQueue` is popped one callback per
// fit() call (extra calls beyond the queue's length are plain no-ops,
// matching every other test that never touches the queue).
export const mockInitialTermSize = { cols: 80, rows: 24 };
export const fitCallbackQueue: Array<() => void> = [];

// The api module, with `uploadSessionFile` (the pane's attach/upload path)
// stubbed out — the real one would fetch. `vi.importActual` loads the
// genuine module and swaps that one method, exactly like the inline
// `vi.mock` factory this replaces.
export async function mockApiFactory() {
  const actual = await vi.importActual<typeof ApiModule>("../api/index.js");
  return { ...actual, api: { ...actual.api, uploadSessionFile: vi.fn() } };
}

export function mockRepaintRegistryFactory() {
  return {
    registerTerminalRepaint: vi.fn(),
    unregisterTerminalRepaint: vi.fn(),
    repaintAllTerminals: vi.fn(),
  };
}

export function mockInputRegistryFactory() {
  return {
    registerTerminalInput: vi.fn(),
    unregisterTerminalInput: vi.fn(),
  };
}

export function mockXtermFactory() {
  function createDisposable() {
    return { dispose: vi.fn() };
  }
  const Terminal = vi.fn(function () {
    // Real xterm.js: on the main screen `buffer.normal` IS
    // `buffer.active` — the very identity scrollbackToText relies on to be
    // a no-op there (lib/terminalBufferText.ts). Sharing one object keeps
    // that true by default; the alt-screen test redefines
    // `buffer.normal` to the inline transcript so the two diverge the way
    // they do while a TUI owns the alternate screen.
    const activeBuffer = {
      type: "normal" as "normal" | "alternate",
      // lib/terminalLinks.ts's own LinkBufferSource wraps this — never
      // exercised here since registerLinkProvider below is a bare
      // disposable-returning stub that never calls provideLinks, but
      // present so the wrapper object TerminalPane builds around
      // `term.buffer.active` type-checks against the real shape.
      getLine: vi.fn(() => undefined),
    };
    return {
      options: {} as Record<string, unknown>,
      unicode: {
        _v: "",
        set activeVersion(v: string) {
          this._v = v;
        },
        get activeVersion() {
          return this._v;
        },
      },
      // Read at construction time only — matches the real Terminal, whose
      // cols/rows only change via resize()/fit(), not by mutating this
      // shared default afterward. See mockInitialTermSize's own doc comment.
      cols: mockInitialTermSize.cols,
      rows: mockInitialTermSize.rows,
      // Issue: small panes ignoring input — TerminalPane's GeometryMessage
      // handler calls this directly when the server's applied geometry
      // differs from the current grid. A bare vi.fn() rather than a
      // self-mutating implementation, same "test mutates cols/rows directly"
      // posture the harness's own getLatestTermInstance comment documents
      // for fitCallbackQueue — a geometry-sync test asserts the call, then
      // sets the returned instance's cols/rows itself to simulate the resize
      // having taken effect.
      resize: vi.fn(),
      reset: vi.fn(),
      open: vi.fn(),
      loadAddon: vi.fn(),
      dispose: vi.fn(),
      // Real xterm.js queues writes and invokes the completion callback once
      // that chunk is fully parsed (FIFO) — the OSC-52-replay-guard tests
      // depend on the callback actually firing, so this mock invokes
      // it synchronously rather than the no-op `vi.fn()` every other test
      // relied on being a pure call-recorder. Synchronous invocation is a
      // strictly stronger/earlier guarantee than the real async queue, so it
      // can't spuriously pass a test that would fail against real xterm.
      write: vi.fn((_data: unknown, cb?: () => void) => cb?.()),
      // jsdom has no `document.fonts`, so the settings-sync effect's
      // font-load path (TerminalPane.tsx) takes its synchronous fallback
      // branch on every render, which calls `repaint()` -> `term.refresh()`
      // (issue #107) unconditionally — needed or every existing test throws.
      refresh: vi.fn(),
      hasSelection: vi.fn(() => false),
      getSelection: vi.fn(() => ""),
      clearSelection: vi.fn(),
      paste: vi.fn(),
      // Real xterm.js Terminal has a public focus() — needed by the find-bar
      // close path (TerminalPane.tsx), which hands focus back to the
      // terminal once the bar closes.
      focus: vi.fn(),
      // Mobile UI/UX overhaul, item C.1 — input()/modes are what
      // terminalInputRegistry.ts's registered handle calls into
      // (MobileKeyBar.test.tsx tests the bar itself against a fake handle;
      // the TerminalPane tests prove the pane wires that handle to the real
      // term.input()/term.modes correctly). modes.applicationCursorKeysMode
      // is a plain mutable field, not a getter, so a test can flip it
      // directly to exercise the DECCKM branch in sendArrow.
      input: vi.fn(),
      modes: { applicationCursorKeysMode: false, mouseTrackingMode: "none" },
      // terminalTouchScroll.ts's two bail conditions read modes.mouse
      // TrackingMode (above) and buffer.active.type (below); scrollLines is
      // what it calls once a drag clears the movement threshold.
      // `undefined` element exercises that module's fontSize*lineHeight
      // fallback row-height path, same as it does in real jsdom (no layout,
      // clientHeight always 0) — not a stand-in for anything more specific.
      element: undefined as HTMLElement | undefined,
      buffer: { active: activeBuffer, normal: activeBuffer },
      scrollLines: vi.fn(),
      onData: vi.fn(() => createDisposable()),
      onTitleChange: vi.fn(() => createDisposable()),
      onSelectionChange: vi.fn(() => createDisposable()),
      attachCustomKeyEventHandler: vi.fn(),
      // Wrap-aware link provider (lib/terminalLinks.ts), replacing
      // @xterm/addon-web-links — every test mounts TerminalPane, so this
      // needs to exist or the mount effect throws immediately.
      registerLinkProvider: vi.fn(() => createDisposable()),
      parser: {
        registerOscHandler: vi.fn((ident: number, cb: (data: string) => boolean) => {
          oscHandlers.set(ident, cb);
          return createDisposable();
        }),
        registerCsiHandler: vi.fn(
          (id: { prefix?: string; intermediates?: string; final: string }, cb: () => boolean) => {
            csiHandlers.set(`${id.prefix ?? ""}${id.intermediates ?? ""}${id.final}`, cb);
            return createDisposable();
          },
        ),
        registerDcsHandler: vi.fn(
          (id: { intermediates?: string; final: string }, cb: () => boolean) => {
            dcsHandlers.set(`${id.intermediates ?? ""}${id.final}`, cb);
            return createDisposable();
          },
        ),
      },
    };
  });
  return { Terminal };
}

export function mockFitAddonFactory() {
  return {
    FitAddon: vi.fn(function () {
      return {
        // Pops one callback per call from fitCallbackQueue (empty by default,
        // so this stays a plain no-op for every test that doesn't touch the
        // queue) — see fitCallbackQueue's own doc comment above.
        fit: vi.fn(() => fitCallbackQueue.shift()?.()),
        // Issue: small panes ignoring input — TerminalPane's GeometryMessage
        // handler reads this to decide whether the server's applied geometry
        // exceeds what actually fits (the "pane too small" hint), without
        // hardcoding the backend's MIN_TERMINAL_COLS/ROWS floor. Defaults to
        // mockInitialTermSize (i.e. "the pane fits its own grid") so every
        // test — none of which know about this — stays unaffected; a
        // geometry-sync test overrides it via
        // getLatestFitAddonInstance().proposeDimensions.mockReturnValue(...).
        proposeDimensions: vi.fn(() => ({ ...mockInitialTermSize })),
      };
    }),
  };
}

export function mockWebglAddonFactory() {
  return {
    WebglAddon: vi.fn(function () {
      // `onContextLoss` mimics xterm's IEvent subscribe API: it captures the
      // handler (rather than actually firing on real GPU context loss, which
      // jsdom has no concept of) so a test can invoke it directly via
      // `__fireContextLoss`, and returns a disposable like the real addon does.
      let contextLossHandler: (() => void) | undefined;
      return {
        clearTextureAtlas: vi.fn(),
        dispose: vi.fn(),
        onContextLoss: vi.fn((handler: () => void) => {
          contextLossHandler = handler;
          return { dispose: vi.fn() };
        }),
        __fireContextLoss: () => contextLossHandler?.(),
      };
    }),
  };
}

export function mockUnicode11AddonFactory() {
  return { Unicode11Addon: vi.fn() };
}

// The real @xterm/addon-search throws ("Cannot use addon until it has been
// loaded") from findNext/findPrevious unless `activate(terminal)` ran first
// — which never happens here since the mocked Terminal's `loadAddon` above
// is a bare vi.fn() that doesn't call it. Mocked the same way as
// @xterm/addon-webgl above: `onDidChangeResults` mimics xterm's IEvent
// subscribe API (captures the handler instead of firing on a real search),
// exposed via `__fireResults` so a test can simulate the addon reporting a
// match count/position the same way `__fireContextLoss` simulates a GPU
// context loss.
export function mockSearchAddonFactory() {
  return {
    SearchAddon: vi.fn(function () {
      let resultsHandler: ((e: { resultIndex: number; resultCount: number }) => void) | undefined;
      return {
        dispose: vi.fn(),
        findNext: vi.fn(() => true),
        findPrevious: vi.fn(() => true),
        clearDecorations: vi.fn(),
        clearActiveDecoration: vi.fn(),
        onDidChangeResults: vi.fn(
          (handler: (e: { resultIndex: number; resultCount: number }) => void) => {
            resultsHandler = handler;
            return { dispose: vi.fn() };
          },
        ),
        __fireResults: (e: { resultIndex: number; resultCount: number }) => resultsHandler?.(e),
      };
    }),
  };
}
