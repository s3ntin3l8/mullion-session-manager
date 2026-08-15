import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import type { IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import type { ISearchResultChangeEvent } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { ImageIcon, KillIcon, RefreshIcon, WifiOffIcon } from "./ui/icons.js";
import { Spinner } from "./ui/Spinner.js";
import { useDashboardStore } from "./store/index.js";
import { buildXtermTheme, getSchemeBackground } from "./terminalTheme.js";
import { api } from "./api/index.js";
import {
  registerTerminalRepaint,
  repaintAllTerminals,
  unregisterTerminalRepaint,
} from "./terminalRepaintRegistry.js";
import { registerTerminalInput, unregisterTerminalInput } from "./terminalInputRegistry.js";
import type { TerminalInputHandle } from "./terminalInputRegistry.js";
import {
  attachKeyConflictHandler,
  hasClipboardApi,
  readClipboard,
  reservedKeysFromSettings,
  SEARCH_HIGHLIGHT_LIMIT,
} from "./lib/terminalKeys.js";
import { useTerminalSearch } from "./hooks/useTerminalSearch.js";
import { TerminalFindBar } from "./terminal-pane/TerminalFindBar.js";
import { TerminalToasts } from "./terminal-pane/TerminalToasts.js";
// ResizeMessage physically lives in src/shared/ws-protocol.ts (repo root,
// NOT this frontend workspace — see src/routes/terminal.ts's own re-export)
// as one arm of TerminalWSMessage; the other arm, ExitedMessage, isn't
// imported here since its single field is checked structurally below
// rather than through the named type.
import type { ResizeMessage } from "../../src/shared/ws-protocol.js";

export interface TerminalPaneParams {
  sessionId: number;
}

// P13 — "ended" is new: a session that is genuinely gone (killed, or its
// program exited on its own), as opposed to "failed" (backoff exhausted
// against a session that, as far as the client can tell, might still be
// alive — a real network blip, a redeploy). See the reconnect effect below
// for exactly which signals distinguish the two.
type ConnectionStatus = "connecting" | "open" | "reconnecting" | "failed" | "ended";

// SEARCH_HIGHLIGHT_LIMIT, reservedKeysFromSettings, formatMatchCount,
// hasClipboardApi, readClipboard, and attachKeyConflictHandler all moved to
// lib/terminalKeys.ts (PR 35, Wave 6 of .claude/plans/can-we-do-a-warm-cocke.md)
// — self-contained, closure-free helpers with no reason to live inside this
// file. See that module for their own comments.

// One xterm.js instance + one WebSocket per session, bound to a session id
// (not to the panel's own lifetime) — closing this panel only tears down the
// browser-side view; the WS close handler in terminal.ts explicitly does not
// kill the session, matching the "browser tab close never kills the session"
// premise from the plan. Deliberately typed on just `params` (not the full
// IDockviewPanelProps) — this component never touches `api`/`containerApi`,
// so it can be reused outside a dockview panel too (see Dock.tsx, which
// renders a dock monitor's terminal without a real dockview panel at all).
export function TerminalPane(props: {
  params: TerminalPaneParams;
  // Fires with the raw OSC 0/2 title string the instant xterm parses it from
  // the stream (issue #69) — real-time, unlike session.lastTitle which only
  // reaches the client on the ~4s session poll. Optional and dockview-agnostic
  // like the rest of this component's props (see the header comment above):
  // Dock.tsx, which renders a terminal with no real dockview panel, simply
  // omits it.
  onTitleChange?: (title: string) => void;
  // When true, Ctrl+C is intercepted and copies selected text instead of
  // forwarding ETX (SIGINT) to the PTY. Used for dock monitor terminals
  // where killing the monitored process is undesirable — the dock toggle
  // button handles stop/kill instead. Defaults to false, preserving the
  // standard terminal behavior for regular sessions.
  captureCtrlC?: boolean;
  // U7 — whether THIS pane is dockview's currently active one (see the
  // activation-focus effect near the find-bar effect below). Optional and
  // dockview-agnostic like every other prop here (see this component's own
  // header comment): the wrapper that actually knows about dockview's panel
  // API (TerminalPanelWrapper, App.tsx) resolves this via the same
  // `api.onDidActiveChange` subscription PaneTab.tsx already uses for its
  // own badge logic and passes down a plain boolean; Dock.tsx, which
  // renders a terminal outside any real dockview panel, simply omits it —
  // the effect below is a no-op for `undefined`, same as for `false`.
  active?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  // Bumped on every successful copy so the "Copied" toast below remounts
  // (via its `key`) instead of reusing the same DOM node. `copied` alone
  // can't do this: a second copy while the first toast is still showing
  // sets it true -> true, a no-op React skips, so the CSS fade animation
  // (mount-triggered) wouldn't restart and the toast could vanish mid-fade
  // right after the second copy.
  const [copyToastKey, setCopyToastKey] = useState(0);
  // Issue #68: surfaces the image-upload round trip (paste or the "attach
  // image" button below) as a small toast, same spirit as the copy toast
  // above — an upload is a real network request, unlike an ordinary paste,
  // so silently doing nothing while it's in flight (or on failure) would
  // read as broken rather than slow.
  const [uploadState, setUploadState] = useState<"idle" | "uploading" | "error">("idle");
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Exposes the mount effect's own upload-and-inject logic to the "attach
  // image" button's file input handler below, same pattern as retryRef/
  // pasteHandlerRef — the button lives in this component's render, but the
  // logic needs the mount effect's closures (pasteToTerminal, `destroyed`).
  const uploadImageRef = useRef<(blob: Blob) => void>(() => {});
  // Exposes a manual "Retry now" (design's Disconnected state) without
  // remounting the terminal/xterm instance itself — `connect`/backoff live
  // inside the effect below (closed over the real WS + timer), so this ref
  // is how the render's button reaches in and calls them directly.
  const retryRef = useRef<() => void>(() => {});
  // Exposes the mount effect's `refit` (fit + send-resize-on-delta) to the
  // settings-sync effect below, so a font-load-triggered re-fit (fontSize/
  // fontFamily change, or the web font simply finishing its own fetch) tells
  // the backend PTY about any resulting grid-size change instead of silently
  // resizing xterm without it — see that effect's own comment.
  const refitRef = useRef<() => void>(() => {});
  // Reactive: drives the settings-sync effect below whenever ANY terminal
  // pref changes — including the *first* change, which is the async
  // GET /api/settings hydration resolving after this pane has already
  // mounted with DEFAULT_SETTINGS (store.ts seeds those synchronously so
  // construction never blocks on the fetch). Without this, a pane whose
  // settings hadn't loaded yet at mount time would be permanently stuck on
  // defaults (fontSize 14, Geist Mono, ...) until manually remounted — this
  // selector is what makes every terminal pref "live" rather than
  // "read once at construction," which server-persistence requires (a
  // synchronous localStorage read never had this race). Referentially
  // stable across unrelated settings changes: store.ts's deepMerge only
  // creates a new `terminal` object when a patch actually touches it.
  const terminalSettings = useDashboardStore((s) => s.settings.terminal);
  const theme = useDashboardStore((s) => s.theme);
  // Populated by the mount effect once the terminal/WebGL/fit addons exist,
  // so the settings-sync effect below can update the *same* live instance
  // instead of only ever seeing the value captured at construction.
  const termRef = useRef<Terminal | null>(null);
  // Terminal scrollback search (U1) — find-bar open state, query text, the
  // addon's own match-position/count, and the addon ref itself all live in
  // this hook now (frontend/src/hooks/useTerminalSearch.ts, PR 35, Wave 6 of
  // .claude/plans/can-we-do-a-warm-cocke.md) — genuinely independent of the
  // mount effect below, EXCEPT `searchAddonRef`/`setMatchState`, which that
  // effect still populates directly (see the hook's own header comment for
  // why). `termRef` is passed in so the hook can hand focus back to the
  // terminal when the find bar closes.
  //
  // Called here (before the mount effect), not further down where its two
  // pre-extraction call sites (`findOpen`/`findQuery`'s useState calls, the
  // local `openFind` function) used to sit relative to the OTHER effects in
  // this component — this repo's react-hooks/immutability lint rule
  // requires a value be declared before any closure references it, even a
  // deferred one, which rules out calling this hook after the mount/
  // captureCtrlC-sync/settings-sync effects that reference `openFind`/
  // `searchAddonRef`/`setMatchState` in their own attachKeyConflictHandler
  // calls. The one real consequence: this hook's own two internal effects
  // (incremental-search, findOpen-transition-focus) now register — and
  // therefore fire, each commit — BEFORE the mount, captureCtrlC-sync, AND
  // settings-sync effects, instead of after all three (their pre-extraction
  // position, registered near the very end of the component). On first
  // mount specifically this is inert: `findOpen` starts false so
  // incremental-search returns immediately, and findOpen-transition-focus
  // hits neither of its branches (`prevFindOpenRef` also starts false) and
  // only writes its two refs — `searchAddonRef` is still null at that point
  // regardless (the mount effect hasn't constructed the addon yet). The
  // findOpenRef write itself still lands before the pane-activation effect
  // (further down) ever reads it, preserving that invariant. Confirmed
  // benign on every later commit too: the incremental-search effect only
  // touches the SearchAddon's decorations via buildSearchDecorations (plain
  // hex colors passed as addon options) — it never reads/writes
  // `term.options.theme` or the WebGL glyph texture atlas, the two things
  // this file's other ordering-sensitive comments (atlas clear/rebuild/
  // repaint, OSC dispatch order) actually depend on, so the two effect
  // groups operate on disjoint subsystems regardless of which fires first.
  // One interaction is reasoned-through rather than test-covered (a mocked
  // Terminal in tests can't observe decoration survival across a
  // term.options.theme reassignment): open the find bar with a query that
  // has matches, then toggle dark/light — highlights should persist and
  // recolor. Worth a manual spot-check if this area is touched again.
  const {
    findOpen,
    setFindOpen,
    findQuery,
    setFindQuery,
    matchState,
    setMatchState,
    findInputRef,
    searchAddonRef,
    findOpenRef,
    openFind,
    runSearch,
  } = useTerminalSearch({ colorScheme: terminalSettings.colorScheme, theme, termRef });
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  // Mirrors `ws` for the settings-sync effect below so the OSC color push on
  // theme toggle can reach the PTY without the mount effect's closure going
  // stale across reconnects.
  const wsRef = useRef<WebSocket | null>(null);
  // Tracks the previous theme value so the settings-sync effect only pushes
  // OSC color sequences on an actual dark/light toggle, not on every unrelated
  // pref update (font size, cursor blink, etc.).
  const prevThemeRef = useRef(theme);
  // Tracks the font/color config last applied to the WebGL glyph texture
  // atlas so the settings-sync effect only wipes it (clearTextureAtlas()) on
  // an actual change to a property the atlas is keyed by (see
  // acquireTextureAtlas/configEquals in @xterm/addon-webgl) rather than on
  // every run of the effect, including the initial mount. The atlas is
  // shared (module-global, keyed by config) across every terminal with a
  // matching config, so an unconditional wipe here corrupted *other* live
  // terminals' already-rasterized glyphs whenever a new terminal mounted —
  // most visibly when the dock mounts a terminal outside dockview, where
  // #124's `onDidAddPanel` sibling-repaint hook never fires.
  const prevAtlasKeyRef = useRef<string | null>(null);
  // Queues OSC color bytes when theme toggles but the socket isn't OPEN
  // (connecting/reconnecting/failed). The socket open handler below drains
  // this so a toggle that happens during a reconnect is not lost — the
  // running program always sees the current theme once the connection is
  // restored.
  const pendingOscRef = useRef<string | null>(null);
  // Mirrors `terminalSettings` for the reconnect/copy/paste logic inside the
  // mount effect's closures (connect(), onSelectionChange, contextmenu) —
  // those read `prefsRef.current` rather than a value captured once at
  // construction, so e.g. a reconnect that happens minutes into a session
  // uses whatever maxAttempts is current, not whatever was true at mount.
  const prefsRef = useRef(terminalSettings);
  const pasteHandlerRef = useRef<() => void>(() => {});
  const copyHandlerRef = useRef<() => Promise<boolean>>(() => Promise.resolve(false));
  const captureCtrlCRef = useRef(props.captureCtrlC);
  // Mirrors `props.onTitleChange` for the same reason as prefsRef above — the
  // mount effect's term.onTitleChange subscription (below) is created once
  // and must not go stale if the caller passes a new callback identity later.
  const onTitleChangeRef = useRef(props.onTitleChange);
  useEffect(() => {
    onTitleChangeRef.current = props.onTitleChange;
  });

  // INTENTIONALLY MONOLITHIC — do not split this effect up.
  //
  // This is the single riskiest piece of code in the frontend (PR 35, Wave 6
  // of .claude/plans/can-we-do-a-warm-cocke.md — see that plan's "Deliberately
  // NOT doing" table). A prior attempt to decompose it was rejected: this
  // effect constructs the xterm.js `Terminal` + WebGL/fit/search addons, the
  // WebSocket connection with its reconnect/backoff state machine, and every
  // OSC/clipboard/resize subscription, all sharing local closures (`ws`,
  // `destroyed`, `reconnectAttempt`, `sessionExited`, `term`, ...) that a
  // split would force into refs or a shared object — and per the comments
  // scattered through the body below, that sharing is load-bearing, not
  // incidental:
  //   - the WebGL glyph texture atlas is module-global and shared across
  //     every live terminal (see the atlas comments around webglAddonRef and
  //     the settings-sync effect below) — ordering the atlas
  //     clear/rebuild/repaint relative to addon construction and sibling-pane
  //     repaint wrong reintroduces the shared-atlas corruption bug (#107,
  //     #124, #129) that this effect's own comments document in detail;
  //   - the async-hydration race between this mount (which may construct the
  //     terminal with DEFAULT_SETTINGS before GET /api/settings resolves) and
  //     the settings-sync effect that corrects it in place depends on both
  //     effects reading/writing the exact same `termRef`/`prefsRef` at the
  //     right time — moving construction into a separate module makes that
  //     ordering implicit instead of a single readable function body;
  //   - the OSC 10/11/12 "report current theme" handlers (registered here so
  //     they run BEFORE xterm's own built-in OSC 10/11/12 handling, since
  //     xterm walks handlers last-registered-first) and the reconnect/backoff
  //     state machine's P13 "genuinely gone vs. network blip" distinction
  //     both depend on precise ordering against `ws`/`sessionExited` that a
  //     split across files would make easy to subtly reorder.
  //
  // Only the genuinely separable, closure-free pieces were pulled out in PR
  // 35: attachKeyConflictHandler/reservedKeysFromSettings/formatMatchCount/
  // clipboard helpers -> lib/terminalKeys.ts; the find-bar UI/state ->
  // hooks/useTerminalSearch.ts + terminal-pane/TerminalFindBar.tsx; the toast
  // UI -> terminal-pane/TerminalToasts.tsx. This effect's own internal logic
  // is otherwise untouched — only some of its local `const`/`function`
  // declarations were swapped for the equivalent imported/hook-returned
  // reference (e.g. `attachKeyConflictHandler(...)`, `searchAddonRef`,
  // `openFind`) where an extracted piece now owns that declaration.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Initial construction reads whatever's in prefsRef right now — DEFAULT_
    // SETTINGS if GET /api/settings hasn't resolved yet, otherwise the real
    // persisted values. The settings-sync effect below corrects every
    // visual option in place the moment hydration completes (or any later
    // change happens), so this is genuinely just a *starting* value, not a
    // "read once" value.
    const prefs = prefsRef.current;
    const fontFamily = `'${prefs.fontFamily}', 'Geist Mono', monospace`;
    const term = new Terminal({
      cursorBlink: prefs.cursorBlink,
      cursorStyle: prefs.cursorStyle,
      fontSize: prefs.fontSize,
      scrollback: prefs.scrollback,
      fontFamily,
      // Resolved from the selected scheme's literal palette (not app CSS
      // tokens) — xterm's `theme` option is passed straight to the renderer
      // (canvas fillStyle / WebGL texture atlas), which doesn't resolve CSS
      // custom properties on its own.
      theme: buildXtermTheme(prefs.colorScheme, theme),
      // Unicode11Addon reads term.unicode, which xterm gates behind this
      // flag as a "proposed" (not yet stabilized) API.
      allowProposedApi: true,
    });
    termRef.current = term;
    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.loadAddon(new WebLinksAddon());
    // Terminal scrollback search (U1). See SEARCH_HIGHLIGHT_LIMIT's own
    // comment (lib/terminalKeys.ts) for why this is passed explicitly rather
    // than left at the addon's default.
    const searchAddon = new SearchAddon({ highlightLimit: SEARCH_HIGHLIGHT_LIMIT });
    searchAddonRef.current = searchAddon;
    term.loadAddon(searchAddon);
    // Only fires once decorations are enabled (see useTerminalSearch's own
    // runSearch, which always passes a `decorations` option) — this is the
    // addon's only way to report match count/position, there's no
    // synchronous "how many matches" query on the addon itself.
    const searchResultsSub = searchAddon.onDidChangeResults((e: ISearchResultChangeEvent) => {
      setMatchState({ index: e.resultIndex, count: e.resultCount });
    });
    attachKeyConflictHandler({
      term,
      reservedKeys: reservedKeysFromSettings(prefsRef.current.keyCapture),
      onPaste: () => pasteHandlerRef.current(),
      onCopy: () => copyHandlerRef.current(),
      captureCtrlC: captureCtrlCRef.current,
      getClipboardKeys: () => prefsRef.current.clipboardKeys,
      onToggleFind: openFind,
    });
    // Note: no separate "wait for the web font to load, then re-fit" step
    // here — the settings-sync effect below runs immediately after this
    // mount effect (on every render, including the first) and already does
    // exactly that as part of applying `terminalSettings` to the live
    // instance, so a second copy of that logic here would just be redundant.

    // Runtime GPU context loss (driver reset, backgrounded-tab context
    // eviction, GPU hiccup) — as opposed to WebGL being unavailable at
    // *creation* time, handled by the catch below. WebglAddon has no
    // onContextRestored event, so there's no signal to retry on; a blind
    // timer-retry could only loop. Instead: dispose the addon so xterm
    // reverts to its default DOM renderer, null the ref so the repaint()
    // closure and resize path's `webglAddonRef.current?.clearTextureAtlas()`
    // calls below become harmless no-ops against a live DOM-rendered
    // terminal, then force one full re-raster so the DOM renderer paints
    // the current buffer immediately instead of leaving a frozen/blank
    // screen until the next byte of PTY output arrives. Speculative
    // hardening (issue #107 "Fix 2") — this path has never been observed
    // to fire in practice; #107's actual symptoms traced to two other,
    // already-fixed causes (#124, #129).
    let webglContextLossSub: IDisposable | null = null;
    try {
      const webglAddon = new WebglAddon();
      term.loadAddon(webglAddon);
      webglAddonRef.current = webglAddon;
      // Fall back to the DOM renderer on context loss — see comment above.
      webglContextLossSub = webglAddon.onContextLoss(() => {
        // Guards against a double-firing context-loss event (rare, but some
        // GPU drivers can raise it more than once) re-disposing an
        // already-disposed addon and double-repainting.
        if (!webglAddonRef.current) return;
        console.warn("[terminal] WebGL context lost — falling back to DOM renderer");
        webglAddon.dispose();
        webglAddonRef.current = null;
        term.refresh(0, term.rows - 1);
      });
    } catch (err) {
      // Not every environment has a usable WebGL context (e.g. some headless
      // or GPU-restricted setups) — xterm falls back to its default DOM
      // renderer automatically, so this is a soft failure, not a blocker.
      console.warn("[terminal] WebGL renderer unavailable, using default renderer", err);
    }

    term.open(container);
    fitAddon.fit();

    let destroyed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    // P13 — set the instant an `{type:"exited"}` control message arrives on
    // an already-open connection (see the "message" listener inside connect()
    // below); survives across reconnect attempts within this same mount,
    // unlike anything scoped inside connect() itself.
    let sessionExited = false;

    const dataSub = term.onData((data) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data));
      }
    });

    // Real-time tab title tracking (issue #69) — fires whenever the running
    // program emits an OSC 0/2 title sequence (e.g. a shell running `claude`
    // then `opencode` retitles itself), independent of the ~4s session poll
    // that lastTitle rides on.
    const titleSub = term.onTitleChange((title) => onTitleChangeRef.current?.(title));

    // Answers OSC 10/11/12 *query* requests ("ESC ] 10|11|12 ; ? BEL") the way
    // a real terminal emulator does (issue #91). Terminal-aware CLIs send this
    // at their own startup to detect whether they're on a light or dark
    // background before choosing colors — confirmed Claude Code does this by
    // capturing its raw PTY output. xterm.js parses the query internally but
    // doesn't expose a way to answer it (no `onColor`/report event on the
    // public Terminal API), so left unanswered the CLI falls back to colors
    // tuned for a dark terminal — which is exactly why a "selected" menu row
    // can end up invisible against one of Mullion's light color schemes: the
    // highlight color is fine on a dark background and washes out on a light
    // one. `parser.registerOscHandler` is public API (not gated behind
    // allowProposedApi) and, per xterm.js's own dispatch order, runs *before*
    // its built-in OSC 10/11/12 handling (handlers are walked last-registered-
    // first) — so this only adds the missing "report" half. Anything other
    // than the query form ("?") is left unhandled (`return false`) and falls
    // through to xterm's own existing SET handling.
    const OSC_COLOR_IDENTS: ReadonlyArray<[number, "foreground" | "background" | "cursor"]> = [
      [10, "foreground"],
      [11, "background"],
      [12, "cursor"],
    ];
    const oscColorSubs = OSC_COLOR_IDENTS.map(([ident, key]) =>
      term.parser.registerOscHandler(ident, (data) => {
        if (data !== "?") return false;
        if (ws?.readyState !== WebSocket.OPEN) return true;
        const hex = term.options.theme?.[key];
        if (typeof hex !== "string") return true;
        const clean = hex.replace("#", "");
        // OSC report replies use 16-bit-per-channel `rgb:` form (each 8-bit
        // hex byte doubled), the convention real terminal emulators use —
        // distinct from the plain `#rrggbb` form used for the SET push below.
        const [r, g, b] = [clean.slice(0, 2), clean.slice(2, 4), clean.slice(4, 6)];
        ws.send(new TextEncoder().encode(`\x1b]${ident};rgb:${r}${r}/${g}${g}/${b}${b}\x07`));
        return true;
      }),
    );

    let lastCols = term.cols;
    let lastRows = term.rows;
    const sendResizeIfOpen = () => {
      if (ws?.readyState === WebSocket.OPEN) {
        const message: ResizeMessage = { type: "resize", cols: term.cols, rows: term.rows };
        ws.send(JSON.stringify(message));
      }
    };
    const refit = () => {
      fitAddon.fit();
      if (term.cols === lastCols && term.rows === lastRows) return;
      lastCols = term.cols;
      lastRows = term.rows;
      sendResizeIfOpen();
    };
    refitRef.current = refit;

    // Full every-row re-raster (issue #107) — unlike `refit`/`fit()`, this
    // isn't gated on a cols/rows delta, so it also heals a terminal whose grid
    // size never changed (the common case: another panel opening doesn't
    // resize *this* one). `clearTextureAtlas()` forces the WebGL renderer to
    // rebuild its glyph texture atlas; `term.refresh()` then repaints every
    // row from it, including the static input/status band that a mere scroll
    // can never reach (scrolling only repaints the rows that scroll).
    const repaint = () => {
      webglAddonRef.current?.clearTextureAtlas();
      term.refresh(0, term.rows - 1);
    };
    registerTerminalRepaint(props.params.sessionId, repaint);

    // Mobile UI/UX overhaul, item C.1 — lets MobileKeyBar.tsx inject
    // Esc/Tab/Shift+Tab/`/` (sendInput) and DECCKM-aware arrow keys
    // (sendArrow, resolved against the live term.modes here — see
    // terminalInputRegistry.ts's own comment on why that resolution can't
    // happen in the bar itself) into this session's terminal from outside
    // this component. `term.input()` (not a direct ws.send) routes through
    // the existing `onData` subscription above, so a key-bar tap reaches the
    // PTY exactly like a real keystroke would. (Independent code review, PR
    // #616: `wasUserInput`'s default `true` does NOT focus anything — per
    // the installed @xterm/xterm source it only triggers scroll-to-bottom
    // and clears an active selection. The on-screen keyboard staying up is
    // entirely MobileKeyBar.tsx's own `preventDefault()` on pointerdown, not
    // anything on this end.)
    // Hermes review, PR #616 round 2 — every send below focuses the
    // terminal first. `preventDefault()` on the bar's own pointerdown
    // (MobileKeyBar.tsx) only ever *keeps* focus from leaving the terminal
    // if it was already there; it can't bring focus (or the on-screen
    // keyboard) TO the terminal if the user tapped the bar while focus was
    // somewhere else (e.g. the keyboard was already dismissed). Without
    // this, that tap's own send would be real but invisible — nothing
    // visibly happens until the user separately taps the terminal itself.
    // A deliberate explicit action (the user tapped a button that targets
    // this terminal specifically), same category as the find-bar's own
    // close-time `termRef.current?.focus()` below — not the unconditional,
    // no-user-action focus this component is otherwise kept free of (see
    // that effect's own comment).
    const focusThenInput = (data: string) => {
      term.focus();
      term.input(data);
    };
    // Named (not passed as an inline object literal) so the cleanup below
    // can pass this exact same reference to unregisterTerminalInput —
    // required for that call to remove only this mount's own registration
    // by identity, not whichever one happens to be current (see
    // terminalInputRegistry.ts's own comment on why: this component can be
    // mounted twice for the same sessionId, once as the real pane and once
    // as Dock.tsx's own monitor).
    const inputHandle: TerminalInputHandle = {
      sendInput: focusThenInput,
      sendArrow: (direction) => {
        const csi = term.modes.applicationCursorKeysMode ? "\x1bO" : "\x1b[";
        focusThenInput(csi + (direction === "up" ? "A" : "B"));
      },
      // Independent code review, PR #616 — a raw `term.input("\x03")` here
      // would bypass attachCustomKeyEventHandler's own Ctrl+C branch above
      // entirely (that handler intercepts the physical keydown before it
      // ever reaches `onData`; injecting the byte directly through
      // `term.input()` skips it), silently reintroducing exactly the two
      // cases that branch exists to prevent: a captureCtrlC dock monitor
      // (issue #332) would get a raw SIGINT byte forwarded instead of
      // triggering its copy-not-kill behavior, and a user with the opt-in
      // "Ctrl+C copies when there's a selection" setting on would have that
      // selection silently discarded and a SIGINT sent instead of copied.
      // Mirrors that branch's exact three-way decision (dock-monitor copy /
      // opt-in selection-aware copy / raw SIGINT) via the same refs it
      // reads, rather than special-casing MobileKeyBar.tsx around it.
      sendCtrlC: () => {
        term.focus();
        if (captureCtrlCRef.current) {
          void copyHandlerRef.current();
          return;
        }
        if (prefsRef.current.clipboardKeys.ctrlC && term.hasSelection() && hasClipboardApi()) {
          void copyHandlerRef.current().then((copied) => {
            if (copied) term.clearSelection();
          });
          return;
        }
        term.input("\x03");
      },
    };
    registerTerminalInput(props.params.sessionId, inputHandle);

    // Mounting a new Terminal shares (and, via the settings-sync effect's
    // clearTextureAtlas() calls, can wipe) the module-global WebGL glyph
    // texture atlas (see acquireTextureAtlas in @xterm/addon-webgl) with
    // every other live terminal of the same font/theme config — so a fresh
    // mount must proactively heal every *other* pane, the same way #124's
    // `onDidAddPanel` hook does for dockview panel adds. That hook alone
    // isn't enough: it only fires for dockview `addPanel` events, so a
    // terminal mounted outside dockview (Dock.tsx renders one inline, with
    // no real panel) never triggers it, leaving existing panes garbled with
    // nothing to heal them. rAF (not synchronous) so this runs after the
    // settings-sync effect below, which is where the atlas is actually
    // wiped/rebuilt for this mount.
    const repaintSiblingsRaf = requestAnimationFrame(() => {
      repaintAllTerminals(props.params.sessionId);
    });

    // Redundant on top of the ResizeObserver registered further down (right
    // above connect()) — Chromium doesn't always fire a ResizeObserver
    // notification for every viewport change that shrinks/grows this
    // element (observed missing the transition when DevTools docks/
    // undocks, which resizes the viewport without a plain window resize).
    // A plain `resize` listener catches those misses.
    window.addEventListener("resize", refit);

    let copyToastTimer: ReturnType<typeof setTimeout> | null = null;

    // Shared by "copy on select", the OSC 52 handler, and the Ctrl+Insert/
    // Ctrl+C handlers below. Returns whether the write actually landed — the
    // opt-in Ctrl+C path (attachKeyConflictHandler) needs that to decide
    // whether it's safe to clear the selection; the other callers ignore it.
    function copyToClipboard(text: string): Promise<boolean> {
      if (!hasClipboardApi()) {
        console.warn("[terminal] clipboard API not available (not a secure context)");
        return Promise.resolve(false);
      }
      return navigator.clipboard
        .writeText(text)
        .then(() => {
          if (destroyed) return true;
          setCopied(true);
          setCopyToastKey((k) => k + 1);
          if (copyToastTimer) clearTimeout(copyToastTimer);
          copyToastTimer = setTimeout(() => {
            if (destroyed) return;
            setCopied(false);
          }, 1500);
          return true;
        })
        .catch((err: unknown) => {
          console.warn("[terminal] clipboard write failed:", err);
          return false;
        });
    }

    // "Copy on select" (Settings -> Terminal behavior) — xterm doesn't copy
    // to the system clipboard on its own; onSelectionChange only fires when
    // the selection actually changes, so a click that clears a selection
    // (empty string) is a no-op here rather than clobbering the clipboard.
    const selectionSub = term.onSelectionChange(() => {
      if (!prefsRef.current.copyOnSelect) return;
      const text = term.getSelection();
      if (text) void copyToClipboard(text);
    });

    // OSC 52 — clipboard write requested by the foreground program. Claude
    // Code / opencode both copy this way while they own mouse reporting
    // (DECSET 1000/1002/1003/1006): a plain drag then goes to the app
    // instead of xterm's local selection, so `onSelectionChange` above never
    // fires — copy-on-select silently does nothing and the app's own OSC 52
    // write is the only thing that actually carries the text. xterm.js core
    // has no OSC 52 handling (unlike its built-in OSC 10/11/12 support
    // above), so without this handler the escape sequence is just dropped
    // and the CLI's "copied" toast is a lie. Registered the same way as the
    // OSC 10/11/12 handlers above rather than via @xterm/addon-clipboard —
    // there's no stable release of that addon for xterm 6 (0.2.0 predates
    // the @xterm/xterm peer dep and targets xterm 5; the next one requires
    // an xterm 6 beta), and a manual handler keeps control over the
    // read direction (see below).
    //
    // Gated on the "Allow programs to set the clipboard" setting
    // (terminal.clipboardWrite, default on) rather than copyOnSelect — this
    // is the app explicitly writing the clipboard, not a passive selection,
    // so it's a distinct preference with its own toggle.
    //
    // SECURITY: write only, never read. An OSC 52 *read* query (Pd === "?")
    // is swallowed and never answered, unconditionally — regardless of the
    // toggle above. Answering it would hand any program running in this PTY
    // (including code an agent executes) the contents of the user's system
    // clipboard.
    const osc52Sub = term.parser.registerOscHandler(52, (data) => {
      // Pc is optional per spec — some programs (e.g. tmux) omit it and send
      // just the base64 payload with no leading ";". Fall back to treating
      // the whole string as the payload in that case.
      const semi = data.indexOf(";");
      const payload = semi === -1 ? data : data.slice(semi + 1); // drop the Pc selection spec, unused
      if (payload === "?") return true; // read query — swallow, never reply
      if (!prefsRef.current.clipboardWrite) return true;
      let text: string;
      try {
        text = new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)));
      } catch {
        return false; // malformed base64 — leave unhandled
      }
      void copyToClipboard(text);
      return true;
    });

    // Ctrl+Insert — explicit copy, independent of "copy on select" (so it
    // still works when that's turned off). Registered via
    // attachKeyConflictHandler above so it works even when the browser
    // wants to intercept it itself. No-ops when there's no selection.
    copyHandlerRef.current = () => {
      if (term.hasSelection()) return copyToClipboard(term.getSelection());
      return Promise.resolve(false);
    };

    // Strips a trailing newline from clipboard text before it reaches the
    // PTY. Clipboard content copied from a terminal commonly ends in `\n`;
    // sent as-is, that lands on the shell as Enter and the pasted command
    // executes immediately instead of sitting at the prompt for review
    // (see issue #66). Routing through term.paste() below (rather than a
    // raw ws.send) additionally wraps the text in bracketed-paste escapes
    // (`\x1b[200~`/`\x1b[201~`) whenever the foreground app has enabled
    // bracketed paste mode (DECSET 2004 — bash/zsh/most TUIs) — the backend
    // PTY is a raw passthrough (routes/terminal.ts, pty-manager.ts) with no
    // filtering, so it needs no special support for this; xterm generates
    // and the shell interprets the escapes entirely client/foreground-app
    // side.
    function pasteToTerminal(text: string): void {
      const trimmed = text.replace(/[\r\n]+$/, "");
      if (trimmed) term.paste(trimmed);
    }

    // Issue #68: the CLI running in this PTY is a host process — it can't
    // read the browser's clipboard, and even if raw image bytes reached it
    // over the WS/PTY byte stream there's no terminal image protocol (Sixel/
    // Kitty/iTerm2) or renderer in this stack to make sense of them anyway.
    // The only thing that actually works is a file the CLI can open by path:
    // upload the image, write it under the session's own cwd (backend), then
    // inject that path into the terminal exactly like a text paste. A
    // trailing space keeps it from running straight into whatever the user
    // types next.
    function uploadAndInjectImage(blob: Blob): void {
      setUploadState("uploading");
      api
        .uploadSessionImage(props.params.sessionId, blob)
        .then(({ path }) => {
          if (destroyed) return;
          pasteToTerminal(`${path} `);
          setUploadState("idle");
        })
        .catch((err: unknown) => {
          console.warn("[terminal] image upload failed:", err);
          if (!destroyed) setUploadState("error");
        });
    }
    uploadImageRef.current = uploadAndInjectImage;

    // Checks the clipboard for an image entry (a screenshot or copied photo,
    // as opposed to copied text) and, if found, routes it through the upload
    // path above instead of a text paste. navigator.clipboard.read() needs a
    // secure context/permission and is less broadly supported than
    // readText() — any failure here (denied, unavailable, no image type
    // present) resolves false so the caller falls through to the ordinary
    // text-paste path rather than surfacing an error for what is, from the
    // user's perspective, just a normal paste.
    async function tryImagePaste(): Promise<boolean> {
      if (!navigator.clipboard?.read) return false;
      try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const imageType = item.types.find((t) => t.startsWith("image/"));
          if (!imageType) continue;
          uploadAndInjectImage(await item.getType(imageType));
          return true;
        }
      } catch (err) {
        console.warn("[terminal] clipboard image read unavailable, falling back to text:", err);
      }
      return false;
    }

    // Cmd+V / Shift+Insert paste handler — reads from the system clipboard
    // and writes to the PTY, regardless of the pasteOnRightClick setting.
    // Registered via attachKeyConflictHandler above so it works even when
    // the browser wants to intercept the chord itself.
    pasteHandlerRef.current = () => {
      tryImagePaste()
        .then((handled) => {
          if (handled) return;
          return readClipboard().then((text) => {
            if (text) pasteToTerminal(text);
          });
        })
        .catch(() => {});
    };

    // "Paste on right-click" (Settings -> Terminal behavior) — replaces the
    // browser's own context menu with a direct paste when enabled, matching
    // common terminal-emulator convention. Same image-first behavior as the
    // keyboard paste handler above.
    const onContextMenu = (event: MouseEvent) => {
      if (!prefsRef.current.pasteOnRightClick) return;
      event.preventDefault();
      tryImagePaste()
        .then((handled) => {
          if (handled) return;
          return readClipboard().then((text) => {
            if (text) pasteToTerminal(text);
          });
        })
        .catch(() => {});
    };
    container.addEventListener("contextmenu", onContextMenu);

    // Reconnects on any drop (network blip, backend redeploy, laptop sleep)
    // with capped exponential backoff — up to prefs.reconnect.maxAttempts,
    // unless auto-reconnect is disabled entirely — then gives up and shows a
    // "failed" state rather than retrying forever against a session that may
    // genuinely be gone. A successful reconnect needs no special handling to
    // restore output: the server always replays its scrollback buffer to a
    // newly-attaching client (see terminal.ts), so the same catch-up path
    // used for "reopen a detached panel" also covers "the WS silently
    // dropped and came back."
    const RECONNECT_BASE_DELAY_MS = 500;
    const RECONNECT_MAX_DELAY_MS = 8000;
    function connect(): void {
      if (destroyed) return;
      setStatus(reconnectAttempt === 0 ? "connecting" : "reconnecting");
      setReconnectAttempt(reconnectAttempt);

      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${location.host}/ws/terminal?sessionId=${props.params.sessionId}&cols=${term.cols}&rows=${term.rows}`;
      const socket = new WebSocket(wsUrl);
      socket.binaryType = "arraybuffer";
      ws = socket;
      wsRef.current = socket;

      socket.addEventListener("open", () => {
        reconnectAttempt = 0;
        setStatus("open");
        // The URL's cols/rows were captured when this connect() call was
        // made, which can be stale if a deferred refit (below) corrected
        // the terminal's size in the meantime — send whatever the terminal's
        // current size actually is now that the socket is open, rather than
        // waiting for the next real resize to reach the backend PTY.
        sendResizeIfOpen();
        // Drain any OSC color push that was queued while the socket was
        // not OPEN (theme toggle during a reconnect).  The running program
        // always sees the latest theme once the connection is restored.
        const pending = pendingOscRef.current;
        if (pending) {
          socket.send(new TextEncoder().encode(pending));
          pendingOscRef.current = null;
        }
      });

      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") {
          term.write(new Uint8Array(event.data as ArrayBuffer));
          return;
        }
        // P13 — terminal.ts's onExit handler sends this the instant the PTY
        // process exits, independent of whether the underlying WS connection
        // itself ever closes (killing a session doesn't force-close an
        // already-open browser socket — see that route's own "kept alive"
        // comment). This is the earliest, most direct "this session is
        // genuinely gone" signal available — well before any close event
        // might eventually follow, possibly never for an already-open
        // connection. Previously dropped outright (a bare `return` for any
        // string message); now the one string frame this protocol actually
        // sends is read.
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          return;
        }
        if ((parsed as { type?: unknown } | null)?.type === "exited") {
          sessionExited = true;
          if (reconnectTimer) clearTimeout(reconnectTimer);
          setStatus("ended");
        }
      });

      socket.addEventListener("close", () => {
        if (destroyed) return;
        // P13 — distinguishes "this session is genuinely gone" (no retry;
        // show "Session ended") from an ordinary network blip (keep the
        // existing backoff-and-retry behavior). The close event's own
        // code/reason carry no usable signal for the specific case this
        // exists to catch: a reconnect attempt against an already-killed
        // session fails at the WS opening handshake itself
        // (routes/terminal.ts's preValidation returns 400 for a killed/
        // exited row before the upgrade ever completes), and per the
        // WebSocket spec every browser reports a failed opening handshake as
        // code 1006 with an empty reason — indistinguishable from a genuine
        // abnormal closure (verified by reading terminal.ts; there is no
        // custom close code anywhere in this backend). The two signals that
        // DO work: (a) `sessionExited`, set above the moment an "exited"
        // control message arrives on a connection that was already open,
        // and (b) cross-checking `store.sessions` — a reconnect attempt only
        // lands here because a PRIOR attempt already failed, so by the time
        // this fires, whatever kill/exit caused that has normally long since
        // reached the store (an explicit kill's own store.deleteSession
        // awaits refreshSessions() before resolving; a session killed from
        // elsewhere reaches this store within one 4s live-refresh tick).
        //
        // `!stored` is only trustworthy as "gone" once the store has loaded
        // at least once (`sessionsLoaded`) — the "prior attempt" premise
        // above assumes this is a RECONNECT, but a pane can also hit its
        // very first close before `refreshSessions()`'s first response ever
        // lands (e.g. restored by dockview racing a backend restart), where
        // `sessions` is still `[]` for every live session, not just dead
        // ones. Gating on `sessionsLoaded` keeps that initial-load race from
        // being misread as "ended" for a session that's actually still
        // live (Hermes review, PR #592).
        const { sessions: liveSessions, sessionsLoaded } = useDashboardStore.getState();
        const stored = liveSessions.find((s) => s.id === props.params.sessionId);
        const sessionGone =
          sessionExited ||
          (sessionsLoaded && !stored) ||
          stored?.status === "killed" ||
          stored?.status === "exited";
        if (sessionGone) {
          setStatus("ended");
          return;
        }
        const reconnectPrefs = prefsRef.current.reconnect;
        if (!reconnectPrefs.enabled || reconnectAttempt >= reconnectPrefs.maxAttempts) {
          setStatus("failed");
          return;
        }
        const delay = Math.min(
          RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt,
          RECONNECT_MAX_DELAY_MS,
        );
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      });
    }

    // "Retry now" (design's Disconnected state) — reset backoff to attempt
    // 0 and reconnect immediately, without remounting the terminal itself.
    retryRef.current = () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectAttempt = 0;
      connect();
    };

    // Issue #676's own frontend follow-up — the backend clamp
    // (pty-manager.ts's MIN_TERMINAL_COLS/ROWS) already stops a garbage-tiny
    // size from ever reaching the pty, but this pane's very first connect()
    // used to fire synchronously in this same mount effect, before dockview
    // had necessarily finished laying out a brand-new panel (exactly what a
    // promote creates) — so the FIRST thing the backend ever heard could
    // still be a measurement taken before layout ran (the production
    // incident's literal `cols=10&rows=13`). Deferring the initial connect
    // to the first post-layout ResizeObserver delivery only guarantees "no
    // size measured before this container's first layout is ever reported"
    // — it can't tell a genuinely-small-but-real layout from a not-yet-laid-
    // out one, which is exactly why there's no minimum-size threshold here;
    // the backend clamp remains the safety net for that. Only the INITIAL
    // connect is deferred — retryRef.current and the backoff reconnect below
    // both call connect() directly, since by then layout has long settled
    // and routing them through this one-shot guard would just make "retry
    // now" a no-op on every call after the first.
    //
    // A mutable box (not a bare `let`) so the binding itself stays a `const`
    // declared before connectOnce/resizeObserver below, even though the
    // real timer is only assigned into it after them — the spec never
    // delivers ResizeObserver's initial observation synchronously from
    // observe() itself, but nothing here should rely on that ordering: if
    // connectOnce ever ran synchronously during resizeObserver's own
    // construction/observe() call, referencing a `let`/`const` declared
    // afterward would throw (TDZ). A property on an already-initialized
    // object avoids that regardless of timing.
    const connectBackstopHolder: { timer: ReturnType<typeof setTimeout> | null } = {
      timer: null,
    };
    let connectedOnce = false;
    const connectOnce = () => {
      if (connectedOnce || destroyed) return;
      connectedOnce = true;
      if (connectBackstopHolder.timer) clearTimeout(connectBackstopHolder.timer);
      // Re-measure now that layout has actually run — the fit() up in the
      // mount path above ran before the container was necessarily sized.
      fitAddon.fit();
      lastCols = term.cols;
      lastRows = term.rows;
      connect();
    };
    // ResizeObserver delivers after layout (including one initial delivery
    // on observe(), per spec) — requestAnimationFrame is not a substitute,
    // its callbacks run BEFORE that frame's layout. Registered here, right
    // above the deferred connect, rather than up near the mount effect's
    // other observers/listeners: `refit` (its callback once connected) and
    // `connectOnce` (its callback until then) are both declared in this
    // half of the effect.
    const resizeObserver = new ResizeObserver(() => {
      if (connectedOnce) refit();
      else connectOnce();
    });
    resizeObserver.observe(container);
    // Backstop, not decoration: a `display:none` container (a dockview tab
    // that isn't the active one — restoring a workspace keeps every pane
    // mounted) may never get an initial ResizeObserver delivery at all, so
    // connectOnce() needs a path that doesn't depend on one ever firing.
    // Kept short and never bumped up — a pane's real first paint should
    // still feel instant even when this path is the one that fires.
    const CONNECT_LAYOUT_BACKSTOP_MS = 250;
    connectBackstopHolder.timer = setTimeout(connectOnce, CONNECT_LAYOUT_BACKSTOP_MS);

    return () => {
      destroyed = true;
      cancelAnimationFrame(repaintSiblingsRaf);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (copyToastTimer) clearTimeout(copyToastTimer);
      if (connectBackstopHolder.timer) clearTimeout(connectBackstopHolder.timer);
      resizeObserver.disconnect();
      window.removeEventListener("resize", refit);
      container.removeEventListener("contextmenu", onContextMenu);
      selectionSub.dispose();
      osc52Sub.dispose();
      dataSub.dispose();
      titleSub.dispose();
      oscColorSubs.forEach((sub) => sub.dispose());
      webglContextLossSub?.dispose();
      // Explicit dispose, unlike FitAddon/Unicode11Addon/WebLinksAddon above
      // (which have no per-instance state and just get swept up by
      // term.dispose()'s own addon-manager cleanup): SearchAddon owns live
      // decoration/selection state and an event subscriber list, and this PR
      // exists precisely because per-pane addon leaks are a real cost at the
      // session counts this app runs — worth disposing explicitly and
      // verifiably rather than trusting it falls out of term.dispose() for
      // free.
      searchResultsSub.dispose();
      searchAddon.dispose();
      ws?.close();
      term.dispose();
      termRef.current = null;
      webglAddonRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
      wsRef.current = null;
      pendingOscRef.current = null;
      refitRef.current = () => {};
      unregisterTerminalRepaint(props.params.sessionId);
      unregisterTerminalInput(props.params.sessionId, inputHandle);
      uploadImageRef.current = () => {};
    };
    // theme intentionally excluded — mount effect must not recreate the
    // terminal on theme toggle; theme updates flow through the settings-sync
    // effect below which updates term.options.theme in-place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.params.sessionId]);

  // Syncs captureCtrlC to the ref and re-attaches the key handler when it
  // changes, without triggering the full font/atlas/repaint logic below.
  useEffect(() => {
    captureCtrlCRef.current = props.captureCtrlC;
    const term = termRef.current;
    if (!term) return;
    attachKeyConflictHandler({
      term,
      reservedKeys: reservedKeysFromSettings(prefsRef.current.keyCapture),
      onPaste: () => pasteHandlerRef.current(),
      onCopy: () => copyHandlerRef.current(),
      captureCtrlC: props.captureCtrlC,
      getClipboardKeys: () => prefsRef.current.clipboardKeys,
      onToggleFind: openFind,
    });
    // `openFind` (from useTerminalSearch) only closes over stable refs/
    // setState identities, same as the plain in-component function it was
    // before PR 35's extraction — deliberately excluded here exactly as it
    // was pre-extraction (this effect must only re-run on captureCtrlC
    // changes, not on every render). The linter can't see through the
    // custom-hook boundary to infer that stability on its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.captureCtrlC]);

  // Applies every terminal pref to the *live* instance in place — this is
  // what fixes the async-hydration race noted above (a pane that mounted
  // before GET /api/settings resolved gets corrected the moment it does)
  // and, for scheme/theme in particular, is also the ordinary "user changed
  // a setting" live-update path (without this, an already-open terminal
  // would keep whatever it was constructed with until the whole pane
  // remounts). Runs once right after the mount effect above too (re-applying
  // the same values it just built) — harmless and simpler than guarding
  // against it.
  useEffect(() => {
    prefsRef.current = terminalSettings;
    const term = termRef.current;
    if (!term) return;

    term.options.cursorBlink = terminalSettings.cursorBlink;
    term.options.cursorStyle = terminalSettings.cursorStyle;
    term.options.scrollback = terminalSettings.scrollback;
    term.options.fontSize = terminalSettings.fontSize;
    term.options.fontFamily = `'${terminalSettings.fontFamily}', 'Geist Mono', monospace`;
    const xtermTheme = buildXtermTheme(terminalSettings.colorScheme, theme);
    term.options.theme = xtermTheme;
    // Notify the running program of a theme change by pushing color
    // sequences through the PTY (arrives on the program's STDIN): OSC 10/11
    // SET (foreground/background) for tools that read it directly from
    // stdin, plus a DEC `\x1b[?997;1n`/`;2n` "color scheme update"
    // notification carrying the resolved dark/light mode for tools that
    // instead react to that and re-query (e.g. opencode — see issue #99 and
    // the PR description for the full mechanism). Both are harmless for
    // tools that don't handle them — unknown OSC/CSI is consumed silently in
    // raw mode. Gated behind a theme comparison to avoid re-sending
    // identical bytes on unrelated pref changes (font size, cursor blink,
    // etc.). When the socket isn't OPEN (connecting/reconnecting/failed),
    // the bytes are queued in pendingOscRef so the socket open handler above
    // drains them when the connection is restored — otherwise a theme
    // toggle during a reconnect would be silently lost.
    if (theme !== prevThemeRef.current) {
      const dec997Notification = theme === "light" ? "\x1b[?997;2n" : "\x1b[?997;1n";
      const oscPush =
        `\x1b]10;${xtermTheme.foreground}\x07` +
        `\x1b]11;${xtermTheme.background}\x07` +
        dec997Notification;
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(oscPush));
      } else {
        pendingOscRef.current = oscPush;
      }
      prevThemeRef.current = theme;
    }
    attachKeyConflictHandler({
      term,
      reservedKeys: reservedKeysFromSettings(terminalSettings.keyCapture),
      onPaste: () => pasteHandlerRef.current(),
      onCopy: () => copyHandlerRef.current(),
      captureCtrlC: captureCtrlCRef.current,
      getClipboardKeys: () => prefsRef.current.clipboardKeys,
      onToggleFind: openFind,
    });

    // The WebGL renderer caches glyphs (size and color both) in a texture
    // atlas; reassigning these options alone leaves already-rendered glyphs
    // showing their old font/size/color until the atlas is rebuilt. Cleared
    // immediately (not deferred to the repaint call below) so a color-only
    // change (theme toggle, no font-load wait involved) doesn't sit stale
    // until that later call fires.
    //
    // Gated on an actual change to a property the atlas is keyed by
    // (font/size/scheme/theme — see acquireTextureAtlas/configEquals in
    // @xterm/addon-webgl) because the atlas is module-global, shared by every
    // terminal with a matching config: an unconditional clear here — this
    // effect also runs on first render, i.e. every terminal mount — wiped
    // every *other* live terminal's already-rasterized glyphs too. Without a
    // paired global repaint (below), those siblings were left desynced from
    // the freshly-cleared atlas until something else forced a full re-raster
    // (e.g. a manual resize).
    // Mirrors the subset of @xterm/addon-webgl's own `configEquals` (see
    // CharAtlasUtils.ts) that Mullion actually exposes as a user setting —
    // if a future terminal setting starts affecting cell/glyph metrics (e.g.
    // a configurable font weight), it needs adding here too, or a real atlas
    // invalidation would go undetected.
    const atlasKey = `${terminalSettings.fontFamily}|${terminalSettings.fontSize}|${terminalSettings.colorScheme}|${theme}`;
    const atlasKeyChanged =
      prevAtlasKeyRef.current !== null && prevAtlasKeyRef.current !== atlasKey;
    prevAtlasKeyRef.current = atlasKey;
    if (atlasKeyChanged) {
      webglAddonRef.current?.clearTextureAtlas();
    }

    // fontSize/fontFamily changes affect cell measurement, so the terminal
    // needs a re-fit — deferred behind the web font's own load promise the
    // same way the mount effect's initial fit is, in case this is the font
    // actually finishing its fetch rather than a user-initiated change. Goes
    // through the mount effect's own `refit` (via refitRef) rather than a
    // raw `fitAddon.fit()` so that, if the font's final metrics do change the
    // grid size, the backend PTY is told about it the same way any other
    // resize is — otherwise this could silently desync xterm's grid from the
    // PTY's size with no resize message ever sent to reconcile them.
    //
    // The repaint alongside it must be global, not self-only (issue #107 /
    // the shared-atlas corruption above): `refit`'s `fit()` early-returns
    // without repainting when the grid size doesn't change, which is the
    // common case for a same-size font finishing its fetch — and since the
    // atlas this pane just wiped (above) is shared, every *other* terminal
    // needs the same rebuild-and-refresh, not just this one. Gated on
    // `atlasKeyChanged` — the atlas wasn't actually touched otherwise, so
    // there's nothing for any terminal to repaint (this also means a
    // fresh mount, where there's no previous key to differ from, never
    // triggers a repaint storm here).
    if (typeof document !== "undefined" && document.fonts) {
      document.fonts
        .load(`${terminalSettings.fontSize}px "${terminalSettings.fontFamily}"`)
        .then(() => {
          refitRef.current();
          if (atlasKeyChanged) repaintAllTerminals();
        })
        .catch((err: unknown) => {
          // Non-fatal — the terminal keeps running with whatever metrics
          // were already applied via term.options above; only the re-fit/
          // repaint this promise would have triggered on success is skipped.
          // Logged (not silently swallowed) so a real, persistent font-load
          // failure is still visible in the console instead of vanishing.
          console.warn("[terminal] font load failed", err);
        });
    } else {
      refitRef.current();
      if (atlasKeyChanged) repaintAllTerminals();
    }
    // `openFind` (from useTerminalSearch, used in this effect's own
    // attachKeyConflictHandler call above) only closes over stable refs/
    // setState identities — same as before PR 35's extraction, just now
    // opaque to the linter across the custom-hook boundary. See the
    // captureCtrlC-sync effect's own comment above for the full rationale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalSettings, theme]);

  // U7 fix — clicking a pane's tab (or activating it via keyboard pane-
  // switching, a deep link, a push-notification open, or auto-focus-on-
  // attention) changes dockview's *active panel*, but none of those paths
  // ever click inside xterm's own DOM, so focus never actually lands in the
  // hidden textarea xterm types into — the pane LOOKS focused and silently
  // swallows the user's first keystroke. `props.active` (see this
  // component's own prop doc comment) is the wrapper's `onDidActiveChange`
  // signal. Deliberately keyed on `[props.active]` alone (findOpenRef reads
  // the CURRENT findOpen without retriggering this effect on its own
  // change — see that ref's own comment in useTerminalSearch.ts) so this
  // only runs on the false->true (or mount-already-active) transition, same
  // "guarded, never unconditional" posture as every other `.focus()` call in
  // this file (see useTerminalSearch's own prevFindOpenRef comment) —
  // `active` going back to false intentionally does nothing, and `active`
  // staying true across an unrelated re-render (including the find bar
  // opening/closing) doesn't retrigger this effect, so it can't steal focus
  // back from e.g. the find bar's own input while this same pane stays the
  // active one. The `findOpenRef.current` check additionally skips the
  // steal-back when the find bar was ALREADY open at the moment this pane
  // became active — useTerminalSearch's own findOpen-transition effect owns
  // focus in that case.
  useEffect(() => {
    if (!props.active || findOpenRef.current) return;
    termRef.current?.focus();
    // `findOpenRef` (from useTerminalSearch) is a plain useRef — its
    // identity is stable across renders, same as before PR 35's extraction;
    // deliberately excluded per this effect's own comment above (must fire
    // ONLY on props.active's false->true transition). Opaque to the linter
    // across the custom-hook boundary, same as openFind above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.active]);

  // Auto-dismisses the "upload failed" toast — "uploading" instead clears
  // itself the moment uploadAndInjectImage's promise settles (see the mount
  // effect above), so this only ever fires for the error state.
  useEffect(() => {
    if (uploadState !== "error") return;
    const timer = setTimeout(() => setUploadState("idle"), 3000);
    return () => clearTimeout(timer);
  }, [uploadState]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {
        // Padding + border-box (not the outer wrapper) is deliberate — see
        // issue #91: `.xterm` is a normal-flow child of whatever element
        // `term.open()` is called on, so padding here visually insets the
        // rendered terminal on all sides, and FitAddon.fit() reads this same
        // element's content-box width/height, so the computed cols/rows
        // already account for it (no clipping/overflow). border-box keeps
        // this div's own occupied size at exactly 100% of its parent —
        // without it, width:100% + padding would add the padding on top and
        // overflow the pane. The four absolutely-positioned overlay siblings
        // below resolve their offsets against the *outer* `position:
        // relative` wrapper, not this div, so they're unaffected either way.
      }
      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: "100%",
          // xterm's own canvas covers the terminal area itself, but not the
          // padding ring around it — without an explicit background here,
          // that ring (and the dockview chrome peeking through it) shows
          // through as an unrelated color when it doesn't match the active
          // scheme (issue #132). getSchemeBackground (not buildXtermTheme)
          // since only the background is needed here, not a full 16-color
          // xterm theme object.
          background: getSchemeBackground(terminalSettings.colorScheme, theme),
          padding: `${terminalSettings.padding}px`,
          boxSizing: "border-box",
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Reset so selecting the same file again still fires onChange.
          event.target.value = "";
          if (file) uploadImageRef.current(file);
        }}
      />
      <button
        className="pane-tab-btn terminal-attach-image-btn"
        title="Attach image"
        onClick={() => fileInputRef.current?.click()}
      >
        <ImageIcon size={14} />
      </button>
      {
        // Scrollback find bar (U1) — opened via Ctrl+Shift+F, see
        // attachKeyConflictHandler (lib/terminalKeys.ts) for why that chord.
        // Positioned top-left rather than sharing the attach-image button's
        // top-right corner (`.terminal-attach-image-btn`, always visible) so
        // the two never collide.
      }
      {findOpen && (
        <TerminalFindBar
          findQuery={findQuery}
          onFindQueryChange={setFindQuery}
          matchState={matchState}
          findInputRef={findInputRef}
          onRunSearch={runSearch}
          onClose={() => setFindOpen(false)}
        />
      )}
      {status !== "open" && (
        <div className={`terminal-status-overlay ${status}`}>
          {status === "connecting" && (
            <>
              <Spinner variant="connecting" />
              <span className="terminal-status-text">Connecting…</span>
              <span className="terminal-status-subtext">attaching to host</span>
            </>
          )}
          {status === "reconnecting" && (
            <>
              <Spinner variant="reconnecting" />
              <span className="terminal-status-text">
                Reconnecting… <span style={{ color: "var(--muted)" }}>({reconnectAttempt})</span>
              </span>
              <span className="terminal-status-subtext">connection dropped · retrying</span>
            </>
          )}
          {status === "failed" && (
            <>
              <WifiOffIcon size={22} style={{ color: "var(--r)" }} />
              <span className="terminal-status-text">Disconnected</span>
              <button className="terminal-status-retry" onClick={() => retryRef.current()}>
                <RefreshIcon size={13} />
                Retry now
              </button>
            </>
          )}
          {
            // P13 — distinct from "failed": the sidebar already knows this
            // session is gone (killed, or its program exited), so retrying
            // the same connection can never succeed — no "Retry now" button,
            // which would otherwise burn through backoff against a session
            // that's provably never coming back.
          }
          {status === "ended" && (
            <>
              <KillIcon size={22} style={{ color: "var(--muted)" }} />
              <span className="terminal-status-text">Session ended</span>
              <span className="terminal-status-subtext">
                Open a new session from the sidebar to keep working here
              </span>
            </>
          )}
        </div>
      )}
      <TerminalToasts copied={copied} copyToastKey={copyToastKey} uploadState={uploadState} />
    </div>
  );
}
