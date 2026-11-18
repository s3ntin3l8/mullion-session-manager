// The shared harness for the TerminalPane test suite: the fake WebSocket,
// the mocked-terminal accessors, the store fixture `renderPane()` installs,
// and the per-test lifecycle every split test file runs.
//
// Extracted from the former frontend/src/TerminalPane.test.tsx, which grew
// past the file-size ceiling (scripts/max-file-lines.baseline.json) and was
// split along its top-level describe blocks (issue #3282). The mock
// preamble itself lives next door, in terminal-pane-mocks.ts — see that
// file's header for why the two are separate and why a test file must
// import the mocks module BEFORE this one.
import { vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import type { Theme } from "../store/index.js";
import { useDashboardStore } from "../store/index.js";
import { TerminalPane } from "../TerminalPane.js";
import { api, DEFAULT_SETTINGS } from "../api/index.js";
import type { Session } from "../api/index.js";
import { makeAppSettings } from "./fixtures.js";
import {
  registerTerminalRepaint,
  repaintAllTerminals,
  unregisterTerminalRepaint,
} from "../terminalRepaintRegistry.js";
import { registerTerminalInput, unregisterTerminalInput } from "../terminalInputRegistry.js";
import {
  csiHandlers,
  dcsHandlers,
  fitCallbackQueue,
  mockInitialTermSize,
  oscHandlers,
} from "./terminal-pane-mocks.js";

export interface FakeSocket {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  binaryType: string;
  _openHandlers: Array<() => void>;
  // P13 — close/message handlers, needed by the reconnect-vs-ended tests
  // (every other test only needs `_openHandlers`).
  _closeHandlers: Array<(event: { code?: number; reason?: string }) => void>;
  _messageHandlers: Array<(event: { data: unknown }) => void>;
}

// The most recent fake socket. Exported as a live binding (a `let`, not a
// `const`) so a test file's `import { fakeSocket }` sees the value
// `stubFakeWebSocket()` last installed.
export let fakeSocket: FakeSocket;
export let fakeWsSend: ReturnType<typeof vi.fn>;
// Every URL passed to `new WebSocket(url)`, in call order — captured
// because getOrCreate() (pty-manager.ts) ignores cols/rows for a session
// that's already alive, so the FIRST url's own cols/rows only matter for
// the create-at-attach case (see the deferred-connect tests), and
// "was there ever a connect() call at all" (the backstop test) needs the
// full list, not just the latest.
export let fakeWsUrls: string[];

function makeFakeSocket(): FakeSocket {
  const openHandlers: Array<() => void> = [];
  const closeHandlers: Array<(event: { code?: number; reason?: string }) => void> = [];
  const messageHandlers: Array<(event: { data: unknown }) => void> = [];
  const socket = {
    readyState: 0,
    send: vi.fn(),
    addEventListener: vi.fn((event: string, handler: (arg?: unknown) => void) => {
      if (event === "open") openHandlers.push(handler as () => void);
      else if (event === "close")
        closeHandlers.push(handler as (event: { code?: number; reason?: string }) => void);
      else if (event === "message")
        messageHandlers.push(handler as (event: { data: unknown }) => void);
    }),
    close: vi.fn(),
    binaryType: "",
    _openHandlers: openHandlers,
    _closeHandlers: closeHandlers,
    _messageHandlers: messageHandlers,
  };
  return socket;
}

export function stubFakeWebSocket(openImmediately: boolean) {
  fakeSocket = makeFakeSocket();
  fakeWsSend = fakeSocket.send;
  fakeWsUrls = [];
  if (openImmediately) {
    fakeSocket.readyState = 1;
  }
  // The component gates every send on `ws.readyState === WebSocket.OPEN`, so
  // the stub constructor needs the standard readyState statics too — without
  // these, WebSocket.OPEN is undefined and that comparison is always false,
  // silently swallowing every send this test is trying to observe. Built via
  // Object.assign (typed `object`) since `typeof WebSocket`'s statics are
  // declared read-only — assigning to them directly only type-checks after
  // the fact, via the final cast below.
  const fakeWebSocketCtor: object = Object.assign(
    function (url: string) {
      fakeWsUrls.push(url);
      return fakeSocket;
    },
    { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
  );
  vi.stubGlobal("WebSocket", fakeWebSocketCtor as unknown as typeof WebSocket);
}

// The mocked Terminal constructor returns a fresh object literal per call
// (see the @xterm/xterm mock) — this reaches into vitest's own call-
// tracking to grab whichever instance the most recent renderPane() created,
// the same way fakeSocket/fakeWsSend track the most recent fake WebSocket.
export function getLatestTermInstance() {
  const results = (Terminal as unknown as ReturnType<typeof vi.fn>).mock.results;
  return results[results.length - 1]!.value as {
    paste: ReturnType<typeof vi.fn>;
    attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
    hasSelection: ReturnType<typeof vi.fn>;
    getSelection: ReturnType<typeof vi.fn>;
    clearSelection: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    input: ReturnType<typeof vi.fn>;
    modes: { applicationCursorKeysMode: boolean };
    resize: ReturnType<typeof vi.fn>;
    options: Record<string, unknown>;
    // Mutable, unlike every other field here — the deferred-connect tests
    // (issue #676's frontend follow-up) mutate these directly to simulate
    // fitCallbackQueue's own re-measure mutating them via a real fit(), and
    // the geometry-sync tests do the same to simulate `resize` above having
    // taken effect.
    cols: number;
    rows: number;
  };
}

// Same pattern as getLatestTermInstance above, for the mocked FitAddon —
// used to assert a settings change re-triggers fit() without caring about
// call order relative to other effects.
export function getLatestFitAddonInstance() {
  const results = (FitAddon as unknown as ReturnType<typeof vi.fn>).mock.results;
  return results[results.length - 1]!.value as {
    fit: ReturnType<typeof vi.fn>;
    proposeDimensions: ReturnType<typeof vi.fn>;
  };
}

// Same pattern as getLatestTermInstance/getLatestFitAddonInstance above, for
// the mocked WebglAddon — used to trigger the context-loss handler
// TerminalPane subscribes to.
export function getLatestWebglAddonInstance() {
  const results = (WebglAddon as unknown as ReturnType<typeof vi.fn>).mock.results;
  return results[results.length - 1]!.value as {
    clearTextureAtlas: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    __fireContextLoss: () => void;
  };
}

// Same "last call, not the first" pattern as getLatestTermInstance above,
// but for the constructor's *options argument* rather than its returned
// instance — needed for the linkHandler tests, which read an option passed
// at construction time rather than a method on the built object.
export function getLatestTermConstructorOptions() {
  const calls = (Terminal as unknown as ReturnType<typeof vi.fn>).mock.calls;
  return calls[calls.length - 1]![0] as {
    linkHandler: {
      activate: (event: MouseEvent, text: string) => void;
      hover: (
        event: MouseEvent,
        text: string,
        range: { start: { y: number }; end: { y: number } },
      ) => void;
      leave: (event: MouseEvent, text: string, range: unknown) => void;
      allowNonHttpProtocols: boolean;
    };
  };
}

// Same pattern as getLatestWebglAddonInstance above, for the mocked
// SearchAddon — used by the scrollback search tests.
export function getLatestSearchAddonInstance() {
  const results = (SearchAddon as unknown as ReturnType<typeof vi.fn>).mock.results;
  return results[results.length - 1]!.value as {
    dispose: ReturnType<typeof vi.fn>;
    findNext: ReturnType<typeof vi.fn>;
    findPrevious: ReturnType<typeof vi.fn>;
    clearDecorations: ReturnType<typeof vi.fn>;
    clearActiveDecoration: ReturnType<typeof vi.fn>;
    __fireResults: (e: { resultIndex: number; resultCount: number }) => void;
  };
}

export function oscRegex() {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  // OSC 10/11 SET followed by the DEC `\x1b[?997;1n`/`;2n` "color scheme
  // update" notification opencode listens for (issue #99) — always appended
  // together as one push.
  return new RegExp(
    `^${ESC}\\]10;#[\\da-f]{6}${BEL}${ESC}\\]11;#[\\da-f]{6}${BEL}${ESC}\\[\\?997;[12]n$`,
    "i",
  );
}

// Once the fake socket reports OPEN, the component's own "open" handler also
// fires a resize JSON send (see TerminalPane.tsx's sendResizeIfOpen) — so the
// OSC push is not reliably `mock.calls[0]`. Scan every send for the one that
// decodes to the OSC 10/11 format instead of assuming call order.
//
// Uses ArrayBuffer.isView rather than `instanceof Uint8Array`: vitest's jsdom
// environment runs the test file in a separate vm-context realm, but the
// source's `new TextEncoder().encode(...)` (TextEncoder is native, tied to
// Node's outer realm) produces a Uint8Array that fails a raw cross-realm
// `instanceof` check against this file's own Uint8Array global even though it
// really is one — `ArrayBuffer.isView` doesn't rely on prototype identity, so
// it's realm-agnostic.
export function decodedOscSends(): string[] {
  return fakeWsSend.mock.calls
    .map((call) => call[0] as unknown)
    .filter((arg): arg is ArrayBufferView => ArrayBuffer.isView(arg))
    .map((bytes) => new TextDecoder().decode(bytes))
    .filter((decoded) => oscRegex().test(decoded));
}

// Put the mocked Terminal into the state a TUI's own screen puts it in:
// `buffer.active.type` reports "alternate" while `buffer.normal` keeps an
// inline transcript — the exact divergence scrollbackToText exists for
// (lib/terminalBufferText.ts). `lines` is the transcript the scrollback
// viewer should then show, one array entry per buffer row. Mirrors real
// xterm, where the two buffers are one and the same object until the
// program switches screens.
export function stubAlternateScreen(term: unknown, lines: string[]): void {
  const t = term as {
    buffer: {
      active: { type: string };
      normal: { length: number; getLine: (i: number) => unknown };
    };
  };
  Object.defineProperty(t.buffer.active, "type", {
    configurable: true,
    get: () => "alternate",
  });
  Object.defineProperty(t.buffer, "normal", {
    configurable: true,
    get: () => ({
      length: lines.length,
      getLine: (i: number) =>
        lines[i] === undefined
          ? undefined
          : { isWrapped: false, translateToString: () => lines[i] },
    }),
  });
}

// U7 — `active` (and any other prop a specific test wants set from the
// very first render, e.g. mount-already-active) is optional and defaults to
// unset so every existing `renderPane()` call site — none of which know or
// care about it — keeps behaving identically.
export function renderPane(
  extra: {
    active?: boolean;
    inputAffordances?: boolean;
    onOpenFile?: (path: string, line?: number) => void;
  } = {},
) {
  useDashboardStore.setState({
    settings: makeAppSettings({
      terminal: {
        ...DEFAULT_SETTINGS.terminal,
        scrollback: 1000,
        copyOnSelect: false,
        reconnect: { enabled: false, maxAttempts: 0 },
        keyCapture: { ctrlR: true, ctrlL: true, ctrlK: true },
      },
    }),
    theme: "dark" as Theme,
    settingsLoaded: true,
    projects: [],
    sessions: [],
    // The store's own boot-time default (store/slices/sessions.ts), set
    // explicitly so every test starts from the same baseline: the reconnect
    // tests flip this flag, and without an explicit reset a test that
    // doesn't set it would inherit whatever the previous test left behind.
    sessionsLoaded: false,
    hosts: [],
    workspaces: [],
    groups: [],
  });
  return render(<TerminalPane params={{ sessionId: 1 }} {...extra} />);
}

// P13 — a minimal-but-complete Session fixture for the reconnect-vs-ended
// tests, which only care about `id`/`status`. Mirrors SessionRow.test.tsx's
// own makeSession default shape.
export function makeMinimalSession(overrides: Partial<Session>): Session {
  return {
    id: 1,
    projectId: 1,
    parentSessionId: null,
    name: null,
    nameLocked: false,
    command: "claude code",
    cwd: null,
    env: null,
    liveCwd: null,
    previewBranch: null,
    kind: "terminal",
    status: "active",
    // Issue #1727 — the session's host: the raw column (null = inherits
    // its project's) and the resolved one the host badge shows.
    hostId: null,
    resolvedHostId: "local",
    // Issue #1852 — the placement decision's own words; null when
    // nothing was decided here (a test session's default).
    placementReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastAttachedAt: null,
    alive: true,
    subscriberCount: 0,
    activity: "working",
    lastActivityAt: Date.now(),
    attention: false,
    attentionAt: null,
    lastTitle: null,
    gateState: "idle",
    gates: [],
    gatePrompt: null,
    promoteState: "idle",
    promoteSummary: null,
    promoteSuggestedBaseRef: null,
    permissionState: "idle",
    planState: "idle",
    errorState: "idle",
    endedReason: null,
    liveBranch: null,
    exitCode: null,
    attentionKind: null,
    errorDetail: null,
    lastAssistantMessage: null,
    currentTodo: null,
    compactState: "idle",
    subagentCount: 0,
    subagents: [],
    elicitationState: "idle",
    elicitationServer: null,
    lastTurnEndedAt: null,
    stateRestored: true,
    staleHooks: false,
    restoredVersion: null,
    sessionStatus: "working",
    sessionStatusSeverity: "busy",
    sessionStatusDetail: null,
    sessionStatusAttentionRequired: false,
    hookEmits: [],
    pendingDevServerPort: null,
    outstandingBackgroundTasks: [],
    ...overrides,
  };
}

// A ResizeObserver stub that captures its callback WITHOUT auto-firing it
// (unlike this harness's default `beforeEach` stub, which fires
// synchronously on observe() — fine for every other test, but it collapses
// the exact async gap the deferred-connect and geometry tests need: in the
// real browser, the observer's first delivery lands strictly AFTER the
// mount effect has already fired). Returns a `fire()` the test calls once
// it wants to simulate "layout has now completed."
//
// The rationale for the deferred connect itself lives with the tests that
// use it (TerminalPane.deferredConnect.test.tsx).
export function stubManualResizeObserver() {
  let capturedCallback: ResizeObserverCallback | undefined;
  vi.stubGlobal(
    "ResizeObserver",
    vi.fn(function (this: unknown, callback: ResizeObserverCallback) {
      capturedCallback = callback;
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    }),
  );
  return { fire: () => capturedCallback?.([], {} as ResizeObserver) };
}

/**
 * The per-test lifecycle every split TerminalPane test file runs: reset the
 * mock state, the fake socket's globals, and the store fixture, so no test
 * depends on what a previous one left behind.
 *
 * Call it once, at the top level of a test file (before its describe
 * blocks) — the hooks it registers then apply to every test in the file.
 */
export function setupTerminalPaneTestLifecycle() {
  beforeEach(() => {
    oscHandlers.clear();
    csiHandlers.clear();
    dcsHandlers.clear();
    localStorage.clear();
    mockInitialTermSize.cols = 80;
    mockInitialTermSize.rows = 24;
    fitCallbackQueue.length = 0;
    // observe() invokes the registered callback synchronously — a more
    // faithful stub of the real API's own initial delivery on observe()
    // (issue #676's frontend follow-up defers TerminalPane's first connect()
    // to that delivery, so a stub that never calls back would leave every
    // test stuck at "connecting" forever). Tests exercising the
    // never-delivers case (a hidden/display:none container) construct their
    // own non-firing stub locally instead of relying on this default.
    vi.stubGlobal(
      "ResizeObserver",
      vi.fn(function (this: unknown, callback: ResizeObserverCallback) {
        return {
          observe: vi.fn(() => callback([], this as ResizeObserver)),
          unobserve: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    vi.mocked(api.uploadSessionFile).mockReset();
    vi.mocked(registerTerminalRepaint).mockClear();
    vi.mocked(unregisterTerminalRepaint).mockClear();
    vi.mocked(repaintAllTerminals).mockClear();
    vi.mocked(registerTerminalInput).mockClear();
    vi.mocked(unregisterTerminalInput).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    Reflect.deleteProperty(navigator, "clipboard");
  });
}
