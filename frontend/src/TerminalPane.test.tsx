// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { act } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import type { Theme } from "./store/index.js";
import { useDashboardStore } from "./store/index.js";
import { TerminalPane } from "./TerminalPane.js";
import { api } from "./api/index.js";
import type * as ApiModule from "./api/index.js";
import type { Session } from "./api/index.js";
import {
  registerTerminalRepaint,
  repaintAllTerminals,
  unregisterTerminalRepaint,
} from "./terminalRepaintRegistry.js";
import { registerTerminalInput, unregisterTerminalInput } from "./terminalInputRegistry.js";

vi.mock("./api/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: { ...actual.api, uploadSessionImage: vi.fn() } };
});

vi.mock("./terminalRepaintRegistry.js", () => ({
  registerTerminalRepaint: vi.fn(),
  unregisterTerminalRepaint: vi.fn(),
  repaintAllTerminals: vi.fn(),
}));

vi.mock("./terminalInputRegistry.js", () => ({
  registerTerminalInput: vi.fn(),
  unregisterTerminalInput: vi.fn(),
}));

// Keyed by OSC ident (10/11/12) — populated by the mocked Terminal's
// `parser.registerOscHandler` below so tests can simulate the running
// program sending an OSC query/set payload without a real xterm.js parser.
// Declared via vi.hoisted so the vi.mock("@xterm/xterm", ...) factory below
// (itself hoisted above this file's imports) can close over it safely.
const { oscHandlers } = vi.hoisted(() => ({
  oscHandlers: new Map<number, (data: string) => boolean>(),
}));

// Issue #676's frontend follow-up (TerminalPane defers its first connect()
// to the first post-layout ResizeObserver delivery, re-measuring via
// fitAddon.fit() right before it) needs two things the rest of this file's
// mocks don't: a mutable initial term size (to simulate a pre-layout bad
// measurement, e.g. the incident's own cols=10/rows=13), and a way to make
// fitAddon.fit() actually mutate that size on a given call (real fit()
// mutates term.cols/rows via term.resize(); the mocked FitAddon below is
// otherwise a no-op). `mockInitialTermSize` feeds the Terminal mock's own
// initial `cols`/`rows`; `fitCallbackQueue` is popped one callback per
// fit() call (extra calls beyond the queue's length are plain no-ops,
// matching every other test in this file that never touches the queue).
// Both declared via vi.hoisted for the same reason as `oscHandlers` above.
const { mockInitialTermSize, fitCallbackQueue } = vi.hoisted(() => ({
  mockInitialTermSize: { cols: 80, rows: 24 },
  fitCallbackQueue: [] as Array<() => void>,
}));

interface FakeSocket {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  binaryType: string;
  _openHandlers: Array<() => void>;
  // P13 — close/message handlers, needed by the reconnect-vs-ended tests
  // below (every other existing test in this file only needs `_openHandlers`).
  _closeHandlers: Array<(event: { code?: number; reason?: string }) => void>;
  _messageHandlers: Array<(event: { data: unknown }) => void>;
}

let fakeSocket: FakeSocket;
let fakeWsSend: ReturnType<typeof vi.fn>;
// Every URL passed to `new WebSocket(url)`, in call order — captured
// because getOrCreate() (pty-manager.ts) ignores cols/rows for a session
// that's already alive, so the FIRST url's own cols/rows only matter for
// the create-at-attach case (see the deferred-connect tests below), and
// "was there ever a connect() call at all" (the backstop test) needs the
// full list, not just the latest.
let fakeWsUrls: string[];

function oscRegex() {
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
function decodedOscSends(): string[] {
  return fakeWsSend.mock.calls
    .map((call) => call[0] as unknown)
    .filter((arg): arg is ArrayBufferView => ArrayBuffer.isView(arg))
    .map((bytes) => new TextDecoder().decode(bytes))
    .filter((decoded) => oscRegex().test(decoded));
}

vi.mock("@xterm/xterm", () => {
  function createDisposable() {
    return { dispose: vi.fn() };
  }
  const Terminal = vi.fn(function () {
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
      open: vi.fn(),
      loadAddon: vi.fn(),
      dispose: vi.fn(),
      write: vi.fn(),
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
      // these tests below prove TerminalPane wires that handle to the real
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
      buffer: { active: { type: "normal" as "normal" | "alternate" } },
      scrollLines: vi.fn(),
      onData: vi.fn(() => createDisposable()),
      onTitleChange: vi.fn(() => createDisposable()),
      onSelectionChange: vi.fn(() => createDisposable()),
      attachCustomKeyEventHandler: vi.fn(),
      parser: {
        registerOscHandler: vi.fn((ident: number, cb: (data: string) => boolean) => {
          oscHandlers.set(ident, cb);
          return createDisposable();
        }),
      },
    };
  });
  return { Terminal };
});

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn(function () {
    return {
      // Pops one callback per call from fitCallbackQueue (empty by default,
      // so this stays a plain no-op for every test that doesn't touch the
      // queue) — see fitCallbackQueue's own doc comment above.
      fit: vi.fn(() => fitCallbackQueue.shift()?.()),
    };
  }),
}));
vi.mock("@xterm/addon-webgl", () => ({
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
}));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: vi.fn() }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: vi.fn() }));
// The real @xterm/addon-search throws ("Cannot use addon until it has been
// loaded") from findNext/findPrevious unless `activate(terminal)` ran first
// — which never happens here since the mocked Terminal's `loadAddon` above
// is a bare vi.fn() that doesn't call it. Mocked the same way as
// @xterm/addon-webgl above: `onDidChangeResults` mimics xterm's IEvent
// subscribe API (captures the handler instead of firing on a real search),
// exposed via `__fireResults` so a test can simulate the addon reporting a
// match count/position the same way `__fireContextLoss` simulates a GPU
// context loss above.
vi.mock("@xterm/addon-search", () => ({
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
}));

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

function stubFakeWebSocket(openImmediately: boolean) {
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
// (see the @xterm/xterm mock above) — this reaches into vitest's own call-
// tracking to grab whichever instance the most recent renderPane() created,
// the same way fakeSocket/fakeWsSend track the most recent fake WebSocket.
function getLatestTermInstance() {
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
    // Mutable, unlike every other field here — the deferred-connect tests
    // (issue #676's frontend follow-up) mutate these directly to simulate
    // fitCallbackQueue's own re-measure mutating them via a real fit().
    cols: number;
    rows: number;
  };
}

// Same pattern as getLatestTermInstance above, for the mocked FitAddon
// (see the @xterm/addon-fit mock) — used to assert a settings change
// re-triggers fit() without caring about call order relative to other
// effects.
function getLatestFitAddonInstance() {
  const results = (FitAddon as unknown as ReturnType<typeof vi.fn>).mock.results;
  return results[results.length - 1]!.value as { fit: ReturnType<typeof vi.fn> };
}

// Same pattern as getLatestTermInstance/getLatestFitAddonInstance above, for
// the mocked WebglAddon (see the @xterm/addon-webgl mock) — used to trigger
// the context-loss handler TerminalPane subscribes to.
function getLatestWebglAddonInstance() {
  const results = (WebglAddon as unknown as ReturnType<typeof vi.fn>).mock.results;
  return results[results.length - 1]!.value as {
    clearTextureAtlas: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    __fireContextLoss: () => void;
  };
}

// Same pattern as getLatestWebglAddonInstance above, for the mocked
// SearchAddon (see the @xterm/addon-search mock) — used by the scrollback
// search tests below.
function getLatestSearchAddonInstance() {
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

beforeEach(() => {
  oscHandlers.clear();
  localStorage.clear();
  mockInitialTermSize.cols = 80;
  mockInitialTermSize.rows = 24;
  fitCallbackQueue.length = 0;
  // observe() invokes the registered callback synchronously — a more
  // faithful stub of the real API's own initial delivery on observe()
  // (issue #676's frontend follow-up defers TerminalPane's first connect()
  // to that delivery, so a stub that never calls back would leave every
  // test below stuck at "connecting" forever). Tests exercising the
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
  vi.mocked(api.uploadSessionImage).mockReset();
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

// U7 — `active` (and any other prop a specific test wants set from the
// very first render, e.g. mount-already-active) is optional and defaults to
// unset so every existing `renderPane()` call site — none of which know or
// care about it — keeps behaving identically.
function renderPane(extra: { active?: boolean } = {}) {
  useDashboardStore.setState({
    settings: {
      theme: "dark",
      terminal: {
        fontFamily: "Geist Mono",
        fontSize: 14,
        padding: 4,
        colorScheme: "default",
        cursorStyle: "block",
        cursorBlink: true,
        scrollback: 1000,
        copyOnSelect: false,
        pasteOnRightClick: false,
        clipboardWrite: true,
        reconnect: { enabled: false, maxAttempts: 0 },
        keyCapture: { ctrlR: true, ctrlL: true, ctrlK: true },
        clipboardKeys: { ctrlV: false, ctrlC: false },
      },
      sidebarDensity: "comfortable",
      projectRoots: [],
      launchers: {
        defaultShell: "bash",
        defaultAgent: "claude",
        hiddenAgents: [],
        skipPermissionsAgents: [],
      },
      notifications: {
        channels: { browser: false, sound: false, push: false },
        soundName: "blip" as const,
        idleThresholdSeconds: 300,
        autoFocusOnAttention: false,
        notificationMatrix: {
          exited: { notify: false, sound: false, autoFocus: false },
          api_error: { notify: true, sound: false, autoFocus: false },
          tool_failure: { notify: true, sound: false, autoFocus: false },
          awaiting_permission: { notify: true, sound: false, autoFocus: false },
          awaiting_plan: { notify: true, sound: false, autoFocus: false },
          awaiting_review_gate: { notify: true, sound: false, autoFocus: false },
          awaiting_promote: { notify: true, sound: false, autoFocus: false },
          awaiting_question: { notify: true, sound: false, autoFocus: false },
          awaiting_elicitation: { notify: true, sound: false, autoFocus: false },
          finished: { notify: false, sound: false, autoFocus: false },
          needs_input: { notify: true, sound: false, autoFocus: false },
          compacting: { notify: false, sound: false, autoFocus: false },
          subagent: { notify: false, sound: false, autoFocus: false },
          background: { notify: false, sound: false, autoFocus: false },
          working: { notify: false, sound: false, autoFocus: false },
          idle: { notify: false, sound: false, autoFocus: false },
          // No `as Record<string, ...>` cast on this object — it would
          // silently defeat the compile-time exhaustiveness check the
          // surrounding `settings: AppSettings` context gives this literal,
          // exactly how this fixture went missing awaiting_question and
          // background unnoticed (#554; see api.ts's DEFAULT_SETTINGS for
          // the same fix, #553).
        },
      },
      sessions: {
        namePattern: "",
        confirmBeforeKill: false,
        hideEndedSessions: false,
        reconcileIntervalSeconds: 30,
        staleErrorSeconds: 600,
        staleBusySeconds: 2400,
        gitAutoFetchIntervalSeconds: 300,
        eventPersistence: false,
        eventRetentionDays: 30,
        eventRetentionPerSession: 0,
        injectAgentGuide: true,
        maxChildSessionsPerParent: 5,
        autoOpenChildPanels: false,
      },
      dock: {
        defaultWorktreeRefresh: false,
        autoDetectDevServer: "ask",
        dockerServices: true,
      },
      taskMaster: {
        autoClaimPaused: false,
        enabled: "inherit",
        maxConcurrent: -1,
        budgetMinutes: -1,
        progressCommentMinutes: -1,
        skipPermissions: "inherit",
      },
    },
    theme: "dark" as Theme,
    settingsLoaded: true,
    projects: [],
    sessions: [],
    hosts: [],
    workspaces: [],
    groups: [],
  });
  return render(<TerminalPane params={{ sessionId: 1 }} {...extra} />);
}

// P13 — a minimal-but-complete Session fixture for the reconnect-vs-ended
// tests below, which only care about `id`/`status`. Mirrors SessionRow.
// test.tsx's own makeSession default shape.
function makeMinimalSession(overrides: Partial<Session>): Session {
  return {
    id: 1,
    projectId: 1,
    parentSessionId: null,
    name: null,
    nameLocked: false,
    command: "claude code",
    cwd: null,
    liveCwd: null,
    previewBranch: null,
    kind: "terminal",
    status: "active",
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

// fix: status-clearing-semantics — the "viewed" ack (and the `active` prop
// that gated it) is gone; a session's rich status now clears only via a
// genuine keystroke or a resolving hook (see pty-manager.ts's write()), never
// on a mere tab-switch/reconnect. Pin the regression: mounting and
// reconnecting a pane sends no "viewed" control frame at all, regardless of
// document visibility.
describe("TerminalPane no longer sends a 'viewed' ack (fix: status-clearing-semantics)", () => {
  afterEach(() => {
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
  });

  function controlMessagesSent(): unknown[] {
    return fakeWsSend.mock.calls.map((call: unknown[]) => JSON.parse(call[0] as string));
  }

  it("sends no 'viewed' message once the socket is open", async () => {
    stubFakeWebSocket(true);
    renderPane();

    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    expect(controlMessagesSent().some((msg) => (msg as { type?: string }).type === "viewed")).toBe(
      false,
    );
  });

  it("sends no 'viewed' message on a reconnect", async () => {
    stubFakeWebSocket(false);
    renderPane();

    act(() => {
      fakeSocket.readyState = 1;
      for (const handler of fakeSocket._openHandlers) handler();
    });

    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    expect(controlMessagesSent().some((msg) => (msg as { type?: string }).type === "viewed")).toBe(
      false,
    );
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

describe("TerminalPane pane padding (issue #91)", () => {
  it("applies the configured padding and border-box sizing to the terminal container", () => {
    stubFakeWebSocket(true);
    const { container } = renderPane();

    // The containerRef div is the one xterm opens into — distinguish it
    // from the outer position:relative wrapper by its inline padding, which
    // only this div ever sets.
    const containerDiv = container.querySelector("div[style*='padding']") as HTMLDivElement;
    expect(containerDiv).toBeTruthy();
    expect(containerDiv.style.padding).toBe("4px");
    expect(containerDiv.style.boxSizing).toBe("border-box");
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

    const containerDiv = container.querySelector("div[style*='box-sizing']") as HTMLDivElement;
    expect(containerDiv.style.padding).toBe("0px");
  });
});

describe("TerminalPane OSC push", () => {
  it("sends OSC 10/11 bytes on theme toggle when socket is OPEN", async () => {
    stubFakeWebSocket(true);
    renderPane();

    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    useDashboardStore.setState({ theme: "light" as Theme });

    await waitFor(() => {
      expect(decodedOscSends().length).toBeGreaterThan(0);
    });
  });

  it("does NOT send when socket is CLOSED, but sends on open", async () => {
    stubFakeWebSocket(false);
    renderPane();

    // act() here (rather than a bare setState) forces the settings-sync
    // effect to flush before the next line — without it, the effect that
    // queues the OSC bytes into pendingOscRef hasn't necessarily run yet by
    // the time the socket's "open" handler is fired manually below, so the
    // drain would find nothing queued and silently no-op.
    act(() => {
      useDashboardStore.setState({ theme: "light" as Theme });
    });

    expect(fakeWsSend).not.toHaveBeenCalled();

    act(() => {
      fakeSocket.readyState = 1;
      for (const handler of fakeSocket._openHandlers) handler();
    });

    // The open handler also fires a resize send (component's own
    // sendResizeIfOpen), so the OSC push isn't necessarily the first call —
    // scan every send for the one matching the OSC 10/11 format.
    await waitFor(() => {
      expect(decodedOscSends().length).toBeGreaterThan(0);
    });

    // Toggle back to dark — prevThemeRef was advanced when the queued bytes
    // were stored, so this correctly detects a new change and sends again.
    fakeWsSend.mockClear();
    act(() => {
      useDashboardStore.setState({ theme: "dark" as Theme });
    });

    await waitFor(() => {
      expect(decodedOscSends().length).toBeGreaterThan(0);
    });
  });

  it("does not send on unrelated pref changes (cursor blink)", async () => {
    stubFakeWebSocket(true);
    renderPane();

    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    useDashboardStore.setState((s) => ({
      settings: { ...s.settings, terminal: { ...s.settings.terminal, cursorBlink: false } },
    }));

    await vi.waitFor(() => {
      expect(fakeWsSend).not.toHaveBeenCalled();
    });
  });

  it("appends the DEC 997 notification matching the resolved mode (issue #99)", async () => {
    stubFakeWebSocket(true);
    renderPane();

    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    useDashboardStore.setState({ theme: "light" as Theme });
    await waitFor(() => {
      expect(decodedOscSends().some((s) => s.endsWith("\x1b[?997;2n"))).toBe(true);
    });

    fakeWsSend.mockClear();
    useDashboardStore.setState({ theme: "dark" as Theme });
    await waitFor(() => {
      expect(decodedOscSends().some((s) => s.endsWith("\x1b[?997;1n"))).toBe(true);
    });
  });
});

describe("TerminalPane OSC 10/11/12 query responder (issue #91)", () => {
  // Every send is a raw byte payload here (unlike decodedOscSends() above,
  // which filters for the `#rrggbb` SET-push format) — decode all of them.
  function decodedSends(): string[] {
    return fakeWsSend.mock.calls
      .map((call) => call[0] as unknown)
      .filter((arg): arg is ArrayBufferView => ArrayBuffer.isView(arg))
      .map((bytes) => new TextDecoder().decode(bytes));
  }

  it("answers an OSC 11 background query with the live scheme's background, rgb: doubled-hex form", async () => {
    stubFakeWebSocket(true);
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    fakeWsSend.mockClear();

    const handled = oscHandlers.get(11)!("?");

    expect(handled).toBe(true);
    // Mullion Dark's dark background is #0d0d0d (terminalSchemes.ts).
    expect(decodedSends()).toContain("\x1b]11;rgb:0d0d/0d0d/0d0d\x07");
  });

  it("answers OSC 10 (foreground) and OSC 12 (cursor) queries too", async () => {
    stubFakeWebSocket(true);
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    fakeWsSend.mockClear();

    oscHandlers.get(10)!("?");
    oscHandlers.get(12)!("?");

    // Mullion Dark's dark foreground/cursor is #ededed.
    expect(decodedSends()).toContain("\x1b]10;rgb:eded/eded/eded\x07");
    expect(decodedSends()).toContain("\x1b]12;rgb:eded/eded/eded\x07");
  });

  it("does not answer (and reports unhandled) a non-query OSC 11 payload, leaving it for xterm's own SET handling", async () => {
    stubFakeWebSocket(true);
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    fakeWsSend.mockClear();

    const handled = oscHandlers.get(11)!("#112233");

    expect(handled).toBe(false);
    expect(fakeWsSend).not.toHaveBeenCalled();
  });

  it("swallows the query without sending when the socket isn't open", async () => {
    stubFakeWebSocket(false);
    renderPane();

    const handled = oscHandlers.get(11)!("?");

    expect(handled).toBe(true);
    expect(fakeWsSend).not.toHaveBeenCalled();
  });
});

describe("TerminalPane OSC 52 clipboard write", () => {
  function stubClipboardWrite() {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    return writeText;
  }

  it("writes the decoded payload to the clipboard on an OSC 52 set", async () => {
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    const handled = oscHandlers.get(52)!(`c;${btoa("hello from claude")}`);

    expect(handled).toBe(true);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("hello from claude"));
  });

  it("never replies to an OSC 52 read query, regardless of the clipboardWrite setting", async () => {
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    fakeWsSend.mockClear();

    const handled = oscHandlers.get(52)!("c;?");

    expect(handled).toBe(true);
    expect(fakeWsSend).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("does not write to the clipboard when clipboardWrite is turned off", async () => {
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    act(() => {
      useDashboardStore.setState((s) => ({
        settings: { ...s.settings, terminal: { ...s.settings.terminal, clipboardWrite: false } },
      }));
    });

    const handled = oscHandlers.get(52)!(`c;${btoa("should not be copied")}`);

    expect(handled).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("writes the payload when Pc is omitted (some programs, e.g. tmux, skip it)", async () => {
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    const handled = oscHandlers.get(52)!(btoa("no Pc here"));

    expect(handled).toBe(true);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("no Pc here"));
  });

  it("leaves malformed base64 unhandled", async () => {
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    const handled = oscHandlers.get(52)!("c;not-valid-base64!!!");

    expect(handled).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("TerminalPane image paste/upload (issue #68)", () => {
  // Simulates the Cmd+V chord attachKeyConflictHandler listens for, by
  // invoking whatever callback the (mocked) term.attachCustomKeyEventHandler
  // was last registered with — the mount effect and the settings-sync effect
  // that runs right after it both register one, and both close over the same
  // pasteHandlerRef, so the most recent registration is equivalent to either.
  function triggerPasteChord() {
    const term = getLatestTermInstance();
    const calls = term.attachCustomKeyEventHandler.mock.calls;
    const handler = calls[calls.length - 1]![0] as (event: unknown) => boolean;
    act(() => {
      handler({
        type: "keydown",
        key: "v",
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        preventDefault: vi.fn(),
      });
    });
  }

  it("uploads a clipboard image and injects its path instead of pasting text", async () => {
    stubFakeWebSocket(true);
    const blob = new Blob(["fake"], { type: "image/png" });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: vi
          .fn()
          .mockResolvedValue([{ types: ["image/png"], getType: vi.fn().mockResolvedValue(blob) }]),
        readText: vi.fn().mockResolvedValue("should not be used"),
      },
    });
    vi.mocked(api.uploadSessionImage).mockResolvedValue({ path: "/cwd/.mullion-uploads/x.png" });

    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    triggerPasteChord();

    await waitFor(() => expect(api.uploadSessionImage).toHaveBeenCalledWith(1, blob));
    await waitFor(() => {
      expect(getLatestTermInstance().paste).toHaveBeenCalledWith("/cwd/.mullion-uploads/x.png ");
    });
    expect(navigator.clipboard.readText).not.toHaveBeenCalled();
  });

  it("falls back to a text paste when the clipboard has no image entry", async () => {
    stubFakeWebSocket(true);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: vi.fn().mockResolvedValue([{ types: ["text/plain"], getType: vi.fn() }]),
        readText: vi.fn().mockResolvedValue("hello"),
      },
    });

    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    triggerPasteChord();

    await waitFor(() => expect(getLatestTermInstance().paste).toHaveBeenCalledWith("hello"));
    expect(api.uploadSessionImage).not.toHaveBeenCalled();
  });

  it("falls back to a text paste when navigator.clipboard.read is unavailable", async () => {
    stubFakeWebSocket(true);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: vi.fn().mockResolvedValue("plain text") },
    });

    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    triggerPasteChord();

    await waitFor(() => expect(getLatestTermInstance().paste).toHaveBeenCalledWith("plain text"));
    expect(api.uploadSessionImage).not.toHaveBeenCalled();
  });

  it("uploads a file selected via the attach-image button and injects its path", async () => {
    stubFakeWebSocket(true);
    vi.mocked(api.uploadSessionImage).mockResolvedValue({ path: "/cwd/.mullion-uploads/y.jpg" });

    const { container } = renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["fake"], "photo.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(api.uploadSessionImage).toHaveBeenCalledWith(1, file));
    await waitFor(() => {
      expect(getLatestTermInstance().paste).toHaveBeenCalledWith("/cwd/.mullion-uploads/y.jpg ");
    });
  });

  it("shows an error toast when the upload fails", async () => {
    stubFakeWebSocket(true);
    vi.mocked(api.uploadSessionImage).mockRejectedValue(new Error("network error"));

    const { container, getByText } = renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["fake"], "photo.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(getByText("Image upload failed")).toBeTruthy());
  });
});

describe("TerminalPane captureCtrlC for dock monitors (issue #332)", () => {
  function triggerCtrlCChord() {
    const term = getLatestTermInstance();
    const calls = term.attachCustomKeyEventHandler.mock.calls;
    const handler = calls[calls.length - 1]![0] as (event: unknown) => boolean;
    return handler({
      type: "keydown",
      key: "c",
      ctrlKey: true,
      shiftKey: false,
      metaKey: false,
      altKey: false,
      preventDefault: () => {},
    }) as boolean;
  }

  function stubClipboardWrite() {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    return writeText;
  }

  it("captureCtrlC=true with selection copies text and returns false (no ETX)", async () => {
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    const { rerender } = renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    rerender(<TerminalPane params={{ sessionId: 1 }} captureCtrlC={true} />);

    const term = getLatestTermInstance() as {
      paste: ReturnType<typeof vi.fn>;
      attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
      hasSelection: ReturnType<typeof vi.fn>;
      getSelection: ReturnType<typeof vi.fn>;
    };
    term.hasSelection.mockReturnValue(true);
    term.getSelection.mockReturnValue("hello from dock monitor");

    const result = triggerCtrlCChord();

    expect(result).toBe(false);
    expect(writeText).toHaveBeenCalledWith("hello from dock monitor");
  });

  it("captureCtrlC=true without selection is a silent no-op", async () => {
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    const { rerender } = renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    rerender(<TerminalPane params={{ sessionId: 1 }} captureCtrlC={true} />);

    const result = triggerCtrlCChord();

    expect(result).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("captureCtrlC=false (default) passes Ctrl+C through to PTY", async () => {
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    const result = triggerCtrlCChord();

    expect(result).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("TerminalPane opt-in Ctrl+V / Ctrl+C clipboard chords (issue #67 follow-up)", () => {
  function triggerCtrlVChord() {
    const term = getLatestTermInstance();
    const calls = term.attachCustomKeyEventHandler.mock.calls;
    const handler = calls[calls.length - 1]![0] as (event: unknown) => boolean;
    let result = true;
    act(() => {
      result = handler({
        type: "keydown",
        key: "v",
        ctrlKey: true,
        shiftKey: false,
        metaKey: false,
        altKey: false,
        preventDefault: vi.fn(),
      }) as boolean;
    });
    return result;
  }

  function triggerCtrlCChord() {
    const term = getLatestTermInstance();
    const calls = term.attachCustomKeyEventHandler.mock.calls;
    const handler = calls[calls.length - 1]![0] as (event: unknown) => boolean;
    let result = true;
    act(() => {
      result = handler({
        type: "keydown",
        key: "c",
        ctrlKey: true,
        shiftKey: false,
        metaKey: false,
        altKey: false,
        preventDefault: vi.fn(),
      }) as boolean;
    });
    return result;
  }

  function enableClipboardKeys(ctrlV: boolean, ctrlC: boolean) {
    act(() => {
      useDashboardStore.setState((s) => ({
        settings: {
          ...s.settings,
          terminal: { ...s.settings.terminal, clipboardKeys: { ctrlV, ctrlC } },
        },
      }));
    });
  }

  function stubClipboardReadText(text: string) {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: vi.fn().mockResolvedValue(text) },
    });
  }

  function stubClipboardWrite() {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    return writeText;
  }

  it("ctrlV disabled (default): Ctrl+V passes through as raw 0x16, no paste", async () => {
    stubFakeWebSocket(true);
    stubClipboardReadText("clipboard text");
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    const result = triggerCtrlVChord();

    expect(result).toBe(true);
    expect(getLatestTermInstance().paste).not.toHaveBeenCalled();
  });

  it("ctrlV enabled: Ctrl+V pastes clipboard text through the normal paste path", async () => {
    stubFakeWebSocket(true);
    stubClipboardReadText("clipboard text");
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    enableClipboardKeys(true, false);

    const result = triggerCtrlVChord();

    expect(result).toBe(false);
    await waitFor(() =>
      expect(getLatestTermInstance().paste).toHaveBeenCalledWith("clipboard text"),
    );
  });

  it("ctrlV enabled: an image on the clipboard routes through the image-paste path (issue #122)", async () => {
    stubFakeWebSocket(true);
    const blob = new Blob(["fake"], { type: "image/png" });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: vi
          .fn()
          .mockResolvedValue([{ types: ["image/png"], getType: vi.fn().mockResolvedValue(blob) }]),
        readText: vi.fn().mockResolvedValue("should not be used"),
      },
    });
    vi.mocked(api.uploadSessionImage).mockResolvedValue({ path: "/cwd/.mullion-uploads/z.png" });
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    enableClipboardKeys(true, false);

    triggerCtrlVChord();

    await waitFor(() => expect(api.uploadSessionImage).toHaveBeenCalledWith(1, blob));
    await waitFor(() => {
      expect(getLatestTermInstance().paste).toHaveBeenCalledWith("/cwd/.mullion-uploads/z.png ");
    });
  });

  it("ctrlC enabled with a selection: copies, clears the selection, and swallows the chord", async () => {
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    enableClipboardKeys(false, true);

    const term = getLatestTermInstance();
    term.hasSelection.mockReturnValue(true);
    term.getSelection.mockReturnValue("selected text");

    const result = triggerCtrlCChord();

    expect(result).toBe(false);
    expect(writeText).toHaveBeenCalledWith("selected text");
    // clearSelection only runs once the async writeText() promise resolves —
    // see the next two tests for what happens when it doesn't.
    await waitFor(() => expect(term.clearSelection).toHaveBeenCalledTimes(1));
  });

  it("ctrlC enabled, clipboard write rejects: selection is NOT cleared (nothing to retry-copy would be lost)", async () => {
    stubFakeWebSocket(true);
    const writeText = vi.fn().mockRejectedValue(new Error("permission denied"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    enableClipboardKeys(false, true);

    const term = getLatestTermInstance();
    term.hasSelection.mockReturnValue(true);
    term.getSelection.mockReturnValue("selected text");

    const result = triggerCtrlCChord();

    expect(result).toBe(false);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("selected text"));
    // Give the rejected promise's .then/.catch chain a tick to settle, then
    // confirm clearSelection was never called — a failed write must not wipe
    // the selection the user was trying to copy.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(term.clearSelection).not.toHaveBeenCalled();
  });

  it("ctrlC enabled, no Clipboard API at all (plain-http deploy): falls through to SIGINT instead of swallowing", async () => {
    stubFakeWebSocket(true);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    enableClipboardKeys(false, true);

    const term = getLatestTermInstance();
    term.hasSelection.mockReturnValue(true);
    term.getSelection.mockReturnValue("selected text");

    const result = triggerCtrlCChord();

    // No clipboard API to copy to — must not eat the keypress with nothing
    // to show for it; the byte reaches the shell as SIGINT instead.
    expect(result).toBe(true);
    expect(term.clearSelection).not.toHaveBeenCalled();
  });

  it("two-press sequence: first Ctrl+C copies and clears, second Ctrl+C (now no selection) reaches SIGINT", async () => {
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    enableClipboardKeys(false, true);

    const term = getLatestTermInstance();
    term.hasSelection.mockReturnValue(true);
    term.getSelection.mockReturnValue("selected text");

    const firstResult = triggerCtrlCChord();
    expect(firstResult).toBe(false);
    await waitFor(() => expect(term.clearSelection).toHaveBeenCalledTimes(1));

    // clearSelection() is a mock, so it doesn't actually change what
    // hasSelection() returns — simulate the real xterm behavior of a
    // cleared selection for the second press.
    term.hasSelection.mockReturnValue(false);

    const secondResult = triggerCtrlCChord();

    expect(secondResult).toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("ctrlC enabled without a selection: falls through to SIGINT (Ctrl+C not swallowed)", async () => {
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    enableClipboardKeys(false, true);

    const term = getLatestTermInstance();
    term.hasSelection.mockReturnValue(false);

    const result = triggerCtrlCChord();

    expect(result).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    expect(term.clearSelection).not.toHaveBeenCalled();
  });

  it("ctrlC disabled: Ctrl+C with a selection still passes through to SIGINT", async () => {
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    const term = getLatestTermInstance();
    term.hasSelection.mockReturnValue(true);
    term.getSelection.mockReturnValue("selected text");

    const result = triggerCtrlCChord();

    expect(result).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("copyOnSelect + ctrlC both on: clearSelection()'s onSelectionChange fire is a no-op, not a second/empty copy", async () => {
    // Exercises the real interaction, not just the setting combination:
    // term.clearSelection() (called by the ctrlC branch) fires xterm's own
    // onSelectionChange — the same listener "copy on select" is wired to
    // (TerminalPane.tsx ~476-480). That listener already guards on a
    // non-empty getSelection(), so simulate xterm firing it with the
    // now-cleared (empty) selection and assert writeText still only saw the
    // one, real copy — not a second call with "".
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    act(() => {
      useDashboardStore.setState((s) => ({
        settings: {
          ...s.settings,
          terminal: {
            ...s.settings.terminal,
            copyOnSelect: true,
            clipboardKeys: { ctrlV: false, ctrlC: true },
          },
        },
      }));
    });

    const term = getLatestTermInstance() as unknown as {
      hasSelection: ReturnType<typeof vi.fn>;
      getSelection: ReturnType<typeof vi.fn>;
      clearSelection: ReturnType<typeof vi.fn>;
      onSelectionChange: ReturnType<typeof vi.fn>;
    };
    term.hasSelection.mockReturnValue(true);
    term.getSelection.mockReturnValue("selected text");
    const onSelectionChangeCalls = term.onSelectionChange.mock.calls;
    const selectionChangeHandler = onSelectionChangeCalls[
      onSelectionChangeCalls.length - 1
    ]![0] as () => void;
    // Simulate xterm actually firing onSelectionChange when clearSelection()
    // runs, the way the real library does — the mock doesn't wire this up
    // automatically.
    term.clearSelection.mockImplementation(() => {
      term.getSelection.mockReturnValue("");
      selectionChangeHandler();
    });

    triggerCtrlCChord();

    // clearSelection() (and thus the simulated onSelectionChange fire) only
    // happens once the async writeText() resolves.
    await waitFor(() => expect(term.clearSelection).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("selected text");
  });

  it("captureCtrlC (dock) still wins over the opt-in ctrlC setting", async () => {
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    const { rerender } = renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    rerender(<TerminalPane params={{ sessionId: 1 }} captureCtrlC={true} />);
    enableClipboardKeys(false, true);

    const term = getLatestTermInstance();
    term.hasSelection.mockReturnValue(false);
    term.getSelection.mockReturnValue("");

    const result = triggerCtrlCChord();

    // Dock's unconditional swallow, not the selection-gated opt-in path —
    // returns false (swallowed) even with no selection, unlike the plain
    // opt-in ctrlC case above.
    expect(result).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("a settings change after mount still honours ctrlV (regression: three re-attach sites)", async () => {
    stubFakeWebSocket(true);
    stubClipboardReadText("clipboard text");
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    // Forces the settings-sync effect's re-attach (TerminalPane.tsx ~line
    // 800) with an unrelated pref change, then enables ctrlV in the same
    // update — attachKeyConflictHandler holds exactly one handler, so if any
    // re-attach captured a stale getter this would still return true.
    act(() => {
      useDashboardStore.setState((s) => ({
        settings: {
          ...s.settings,
          terminal: {
            ...s.settings.terminal,
            fontSize: 18,
            clipboardKeys: { ctrlV: true, ctrlC: false },
          },
        },
      }));
    });

    const result = triggerCtrlVChord();

    expect(result).toBe(false);
    await waitFor(() =>
      expect(getLatestTermInstance().paste).toHaveBeenCalledWith("clipboard text"),
    );
  });
});

describe("TerminalPane scrollback search (U1)", () => {
  // Simulates the Ctrl+Shift+F chord attachKeyConflictHandler listens for,
  // the same way triggerPasteChord/triggerCtrlCChord above simulate theirs —
  // by invoking whatever callback the (mocked) term.attachCustomKeyEventHandler
  // was last registered with.
  function triggerFindChord() {
    const term = getLatestTermInstance();
    const calls = term.attachCustomKeyEventHandler.mock.calls;
    const handler = calls[calls.length - 1]![0] as (event: unknown) => boolean;
    return act(() => {
      handler({
        type: "keydown",
        key: "f",
        ctrlKey: true,
        shiftKey: true,
        metaKey: false,
        altKey: false,
        preventDefault: vi.fn(),
      });
    });
  }

  it("opens the find bar on Ctrl+Shift+F and closes it on Escape", () => {
    stubFakeWebSocket(true);
    const { getByPlaceholderText, queryByPlaceholderText } = renderPane();

    expect(queryByPlaceholderText("Find in scrollback…")).toBeNull();

    triggerFindChord();

    const input = getByPlaceholderText("Find in scrollback…");
    expect(input).toBeTruthy();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(queryByPlaceholderText("Find in scrollback…")).toBeNull();
    // Closing hands focus back to the terminal (see TerminalPane.tsx's
    // findOpen-transition effect) so typing resumes immediately instead of
    // landing wherever the browser defaults to once the input unmounts.
    expect(getLatestTermInstance().focus).toHaveBeenCalledTimes(1);
  });

  it("does not open the find bar on plain Ctrl+F (left to the browser's own find)", () => {
    stubFakeWebSocket(true);
    const { queryByPlaceholderText } = renderPane();
    const term = getLatestTermInstance();
    const calls = term.attachCustomKeyEventHandler.mock.calls;
    const handler = calls[calls.length - 1]![0] as (event: unknown) => boolean;
    const preventDefault = vi.fn();

    act(() => {
      handler({
        type: "keydown",
        key: "f",
        ctrlKey: true,
        shiftKey: false,
        metaKey: false,
        altKey: false,
        preventDefault,
      });
    });

    expect(queryByPlaceholderText("Find in scrollback…")).toBeNull();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("does not steal focus into the terminal on a plain mount (find bar never opened)", () => {
    stubFakeWebSocket(true);
    renderPane();

    expect(getLatestTermInstance().focus).not.toHaveBeenCalled();
  });

  it("refocuses the find input on a repeat Ctrl+Shift+F while the bar is already open (Hermes review, PR #578)", () => {
    stubFakeWebSocket(true);
    const { getByPlaceholderText } = renderPane();

    triggerFindChord();
    const input = getByPlaceholderText("Find in scrollback…") as HTMLInputElement;
    const focusSpy = vi.spyOn(input, "focus");

    // Second chord while the bar is already open — setFindOpen(true) alone
    // is a no-op here (same value), so without openFind's explicit
    // focus()/select() call this would be a dead keypress (jsdom doesn't
    // auto-move focus off the input just because the assertion above didn't
    // call .focus() on it, so this specifically exercises the "already
    // open" branch, not the initial-open one).
    triggerFindChord();

    expect(focusSpy).toHaveBeenCalled();
  });

  it("calls findNext on the addon when Next is clicked or Enter is pressed", () => {
    stubFakeWebSocket(true);
    const { getByPlaceholderText, getByTitle } = renderPane();
    triggerFindChord();
    const input = getByPlaceholderText("Find in scrollback…");
    const searchAddon = getLatestSearchAddonInstance();

    fireEvent.change(input, { target: { value: "migration failed" } });
    searchAddon.findNext.mockClear();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(searchAddon.findNext).toHaveBeenCalledWith(
      "migration failed",
      expect.objectContaining({ decorations: expect.any(Object) }),
    );

    searchAddon.findNext.mockClear();
    fireEvent.click(getByTitle("Next match (Enter)"));
    expect(searchAddon.findNext).toHaveBeenCalledTimes(1);
  });

  it("calls findPrevious on the addon when Previous is clicked or Shift+Enter is pressed", () => {
    stubFakeWebSocket(true);
    const { getByPlaceholderText, getByTitle } = renderPane();
    triggerFindChord();
    const input = getByPlaceholderText("Find in scrollback…");
    const searchAddon = getLatestSearchAddonInstance();

    fireEvent.change(input, { target: { value: "abc" } });
    searchAddon.findPrevious.mockClear();

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(searchAddon.findPrevious).toHaveBeenCalledWith("abc", expect.any(Object));

    searchAddon.findPrevious.mockClear();
    fireEvent.click(getByTitle("Previous match (Shift+Enter)"));
    expect(searchAddon.findPrevious).toHaveBeenCalledTimes(1);
  });

  it("live-searches as the query changes (incremental findNext) and clears decorations once emptied", () => {
    stubFakeWebSocket(true);
    const { getByPlaceholderText } = renderPane();
    triggerFindChord();
    const input = getByPlaceholderText("Find in scrollback…");
    const searchAddon = getLatestSearchAddonInstance();

    fireEvent.change(input, { target: { value: "err" } });
    expect(searchAddon.findNext).toHaveBeenCalledWith(
      "err",
      expect.objectContaining({ incremental: true }),
    );

    // Opening the find bar with an empty query already clears decorations
    // once (see the assertion below is on a fresh count) — reset the mock so
    // this only asserts the *emptying* triggers its own clear, not just the
    // one from the bar opening on an empty query above.
    searchAddon.clearDecorations.mockClear();
    fireEvent.change(input, { target: { value: "" } });
    expect(searchAddon.clearDecorations).toHaveBeenCalledTimes(1);
  });

  it("shows a match count from the addon's onDidChangeResults event", () => {
    stubFakeWebSocket(true);
    const { getByPlaceholderText, getByText } = renderPane();
    triggerFindChord();
    const input = getByPlaceholderText("Find in scrollback…");
    const searchAddon = getLatestSearchAddonInstance();

    fireEvent.change(input, { target: { value: "foo" } });

    act(() => {
      searchAddon.__fireResults({ resultIndex: 2, resultCount: 5 });
    });

    expect(getByText("3/5")).toBeTruthy();
  });

  it("appends '+' to the count once the addon's highlightLimit is reached (Hermes review, PR #578)", () => {
    stubFakeWebSocket(true);
    const { getByPlaceholderText, getByText } = renderPane();
    triggerFindChord();
    const input = getByPlaceholderText("Find in scrollback…");
    const searchAddon = getLatestSearchAddonInstance();

    fireEvent.change(input, { target: { value: "x" } });

    // resultCount is the *decorated* count (capped at SEARCH_HIGHLIGHT_LIMIT,
    // 1000) — at the cap it may not be the true total, so the UI marks it as
    // a lower bound rather than an exact count.
    act(() => {
      searchAddon.__fireResults({ resultIndex: 4, resultCount: 1000 });
    });

    expect(getByText("5/1000+")).toBeTruthy();
  });

  it("shows just the count (no index) when resultIndex is -1 — the addon's own highlight-limit-exceeded case", () => {
    stubFakeWebSocket(true);
    const { getByPlaceholderText, getByText } = renderPane();
    triggerFindChord();
    const input = getByPlaceholderText("Find in scrollback…");
    const searchAddon = getLatestSearchAddonInstance();

    fireEvent.change(input, { target: { value: "x" } });

    act(() => {
      searchAddon.__fireResults({ resultIndex: -1, resultCount: 1000 });
    });

    // Not "0/1000+" — resultIndex -1 means the selected match is beyond the
    // decorated set, not that it's the first match.
    expect(getByText("1000+")).toBeTruthy();
  });

  it("disposes the search addon (and its result subscription) on unmount", () => {
    stubFakeWebSocket(true);
    const { unmount } = renderPane();
    const searchAddon = getLatestSearchAddonInstance();

    unmount();

    expect(searchAddon.dispose).toHaveBeenCalledTimes(1);
  });
});

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
});

// P13 — the WS close listener used to retry with backoff regardless of why
// the connection closed, then show a generic "Disconnected / Retry now"
// that can never succeed once the session is genuinely gone (killed, or its
// program exited). Two signals now distinguish "gone" from "network blip":
// an `{type:"exited"}` control message (sent the instant the PTY exits,
// terminal.ts's onExit), and cross-checking store.sessions at close time —
// the close event's own code/reason carry no usable signal here (see the
// close listener's own comment in TerminalPane.tsx for why: a reconnect
// against an already-killed session fails at the WS opening handshake, which
// every browser reports as code 1006/empty reason regardless of cause).
describe("TerminalPane reconnect vs. session-ended (P13)", () => {
  function enableReconnect(maxAttempts = 5) {
    act(() => {
      useDashboardStore.setState((s) => ({
        settings: {
          ...s.settings,
          terminal: { ...s.settings.terminal, reconnect: { enabled: true, maxAttempts } },
        },
      }));
    });
  }

  it('shows "Session ended" (no retry) when the session is absent from store.sessions at close time', () => {
    stubFakeWebSocket(false);
    renderPane();
    enableReconnect();
    // `sessionsLoaded: true` is what makes an absent session trustworthy as
    // "confirmed gone" rather than "store hasn't fetched yet" — see the
    // next test for the initial-load-race case this guards against
    // (Hermes review, PR #592).
    useDashboardStore.setState({ sessions: [], sessionsLoaded: true });

    act(() => {
      for (const handler of fakeSocket._closeHandlers) handler({ code: 1006, reason: "" });
    });

    expect(screen.getByText("Session ended")).toBeInTheDocument();
    expect(screen.queryByText("Disconnected")).not.toBeInTheDocument();
    expect(screen.queryByText("Retry now")).not.toBeInTheDocument();
  });

  // Hermes review (PR #592): `!stored` alone isn't trustworthy as "gone" —
  // a pane can hit its very first close before refreshSessions()'s first
  // response ever lands (e.g. restored by dockview racing a backend
  // restart), where `sessions` is `[]` for every live session, not just
  // dead ones. `sessionsLoaded` distinguishes "confirmed empty" from
  // "haven't checked yet", so this must fall through to the ordinary
  // retry-with-backoff path instead of getting stuck on "Session ended".
  it('does NOT show "Session ended" for a close before the store has ever loaded (sessionsLoaded still false), even with an empty sessions list', () => {
    vi.useFakeTimers();
    try {
      stubFakeWebSocket(false);
      renderPane();
      enableReconnect();
      useDashboardStore.setState({ sessions: [], sessionsLoaded: false });

      act(() => {
        for (const handler of fakeSocket._closeHandlers) handler({ code: 1006, reason: "" });
      });
      act(() => {
        vi.advanceTimersByTime(600);
      });

      expect(screen.getByText(/Reconnecting/)).toBeInTheDocument();
      expect(screen.queryByText("Session ended")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows "Session ended" when store.sessions reports this session as killed', () => {
    stubFakeWebSocket(false);
    renderPane();
    enableReconnect();
    useDashboardStore.setState({
      sessions: [makeMinimalSession({ id: 1, status: "killed" })],
    });

    act(() => {
      for (const handler of fakeSocket._closeHandlers) handler({ code: 1006, reason: "" });
    });

    expect(screen.getByText("Session ended")).toBeInTheDocument();
  });

  it('shows "Session ended" immediately on an {type:"exited"} message, without waiting for close', () => {
    stubFakeWebSocket(true);
    renderPane();
    useDashboardStore.setState({
      sessions: [makeMinimalSession({ id: 1, status: "active" })],
    });

    act(() => {
      for (const handler of fakeSocket._messageHandlers) {
        handler({ data: JSON.stringify({ type: "exited" }) });
      }
    });

    expect(screen.getByText("Session ended")).toBeInTheDocument();
  });

  it("an ordinary close (e.g. code 1006, abnormal closure) still retries with backoff when the session is still active in the store", () => {
    vi.useFakeTimers();
    try {
      stubFakeWebSocket(false);
      renderPane();
      enableReconnect();
      useDashboardStore.setState({
        sessions: [makeMinimalSession({ id: 1, status: "active" })],
      });

      act(() => {
        for (const handler of fakeSocket._closeHandlers) handler({ code: 1006, reason: "" });
      });
      // The close handler only SCHEDULES the retry (RECONNECT_BASE_DELAY_MS,
      // TerminalPane.tsx) — status flips to "reconnecting" once that timer
      // actually fires and connect() re-runs, not synchronously on close.
      act(() => {
        vi.advanceTimersByTime(600);
      });

      expect(screen.getByText(/Reconnecting/)).toBeInTheDocument();
      expect(screen.queryByText("Session ended")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the ordinary Disconnected/Retry state (not Session ended) once backoff is exhausted against a still-active session", () => {
    stubFakeWebSocket(false);
    renderPane();
    enableReconnect(0);
    useDashboardStore.setState({
      sessions: [makeMinimalSession({ id: 1, status: "active" })],
    });

    act(() => {
      for (const handler of fakeSocket._closeHandlers) handler({ code: 1006, reason: "" });
    });

    expect(screen.getByText("Disconnected")).toBeInTheDocument();
    expect(screen.getByText("Retry now")).toBeInTheDocument();
    expect(screen.queryByText("Session ended")).not.toBeInTheDocument();
  });
});

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
function stubManualResizeObserver() {
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
