// Scans a chunk of raw PTY output for the terminal escape sequences a TUI
// uses to signal "look at me" or announce its current state — the plumbing
// half of vision item's status-signal work (see the plan's WS-6).
//
// classifyActivityFromTitle() below is the one place that actually
// interprets `lastTitle` text (many agentic CLIs write something like
// "Thinking…" or a status emoji into the title). It's a best-effort fast
// path only: plain shells set their title to `user@host:cwd`, which matches
// neither pattern and falls through to the caller's own sustained-output
// heuristic (see pty-manager.ts's toInfo()).

export interface AttentionSignal {
  /** A BEL (0x07) byte appeared anywhere in the chunk — either a bare
   * terminal bell or an OSC sequence terminated with BEL instead of ST. */
  bell: boolean;
  /** An OSC 9 (iTerm2-style) or OSC 777 (rxvt/urxvt-style) desktop
   * notification sequence was present. */
  notification: boolean;
  /** The payload of the most recent OSC 0 (icon+title) or OSC 2 (title-only)
   * sequence in this chunk, or null if none appeared. */
  titleChange: string | null;
}

// Matches `ESC ] <code> ; <payload> (BEL | ESC \)` — the general OSC
// (Operating System Command) escape sequence shape. Non-greedy so back-to-
// back sequences in one chunk are matched individually rather than as one
// span. Note: a sequence split across two separate PTY reads (a real but
// rare possibility) won't be recognized — acceptable for this phase's
// "collect the signals" scope; not attempted to buffer across chunks.
// Matching real terminal control bytes (ESC, BEL) is the entire point of
// this parser, hence the disable below.
// eslint-disable-next-line no-control-regex
const OSC_SEQUENCE = /\x1b\](\d+);([\s\S]*?)(?:\x07|\x1b\\)/g;

export function detectAttentionSignals(chunk: string): AttentionSignal {
  // A BEL byte is only a real "bell" signal when it's not just the
  // terminator of an OSC sequence (title-set, palette query, ...) — e.g.
  // bash emits `ESC]0;title BEL` on every prompt draw, which otherwise
  // false-positives as attention on the very first output chunk of a brand
  // new session (confirmed empirically: a fresh `bash -i`'s first chunk is
  // exactly `ESC]0;<title>BEL<prompt>`). Strip matched OSC sequences before
  // testing so only a bare/stray BEL counts.
  const bell = chunk.replace(OSC_SEQUENCE, "").includes("\x07");
  let notification = false;
  let titleChange: string | null = null;

  for (const match of chunk.matchAll(OSC_SEQUENCE)) {
    const code = match[1];
    const payload = match[2];
    if (code === "9" || code === "777") notification = true;
    if (code === "0" || code === "2") titleChange = payload;
  }

  return { bell, notification, titleChange };
}

// Status words agentic CLIs (Claude Code, opencode, Codex, ...) commonly
// write into the terminal title while actively producing output.
const WORKING_TITLE_PATTERN = /working|thinking|processing|generating|running|compiling|\.{3}|…/i;

// Status words the same CLIs write once they're back at a prompt/waiting on
// the user — deliberately distinct from "attention" (a bell/notification),
// which is a separate signal.
const IDLE_TITLE_PATTERN = /waiting|idle|prompt|done|ready/i;

/**
 * Best-effort read of "working" / "idle" from a session's terminal title.
 * Returns null when the title doesn't match either pattern — e.g. a plain
 * shell's `user@host:cwd` title — so the caller can fall back to its own
 * timing-based heuristic. `command` is accepted for future per-CLI tuning
 * but unused for now.
 */
export function classifyActivityFromTitle(
  title: string | null,
  _command: string,
): "working" | "idle" | null {
  if (title === null) return null;
  // Idle words take precedence: WORKING_TITLE_PATTERN's trailing-ellipsis
  // check would otherwise match a title like "Waiting..." and misreport it
  // as "working" even though the word itself says idle.
  if (IDLE_TITLE_PATTERN.test(title)) return "idle";
  if (WORKING_TITLE_PATTERN.test(title)) return "working";
  return null;
}

// --- Attention state machine (issue #171 / #98) -------------------------
//
// Replaces the old ad-hoc "bell followed by another chunk within
// ATTENTION_CLEAR_WINDOW_MS clears it" check that used to live directly in
// pty-manager.ts's Session.onData. That check had a real false-positive
// bug: a rapid burst of bells during heavy TUI output (confirmed against
// Claude Code's Ink renderer and Codex) set `attentionAt` — and emitted a
// #166 `attention:true` event — on literally the FIRST bell in the burst,
// then cleared it a chunk later, then set it again on the next bell, and so
// on for the whole burst. Each of those was a real, if short-lived, false
// alarm: any WS/event consumer polling or subscribing mid-burst would see
// "needs attention" for a session that's still very much working.
//
// The fix is to never report attention as true until a candidate signal has
// gone UNCONTRADICTED for long enough to be confident it's genuine — i.e.
// an explicit PENDING_ATTENTION state between "a candidate signal arrived"
// and "confirmed, tell the world". A signal is confirmed once
// ATTENTION_CONFIRM_MS[kind] has elapsed with no further output arriving to
// contradict it (see advanceAttention's "tick" input below); any output
// arriving before that — a fresh candidate signal (which just restarts the
// pending window with the newest kind/timestamp, so a whole burst just
// keeps re-arming rather than ever confirming) or plain output (which
// cancels the pending signal outright, since continued output IS the
// "still working" evidence) — means it was never real attention at all, so
// nothing is ever reported or emitted for it. This is deliberately a PURE,
// synchronous reducer — no `Date.now()`/timers/emitEvent calls in here —
// so `test/services/attention-detect.test.ts` can exercise every
// transition, threshold and the burst-false-positive regression directly,
// without needing fake timers or a real Session. See pty-manager.ts's
// Session for the (small) stateful wrapper: it feeds chunks in via onData
// and periodic real time via its own tick(), and turns `emit`/`log` below
// into actual emitEvent("attention", ...) calls and debug log lines.
export type AttentionState = "idle" | "pending_attention" | "attention" | "clearing";

// The candidate "something needs the user's attention" signal kinds this
// module recognizes. `silence` is distinct from the PTY-parsed four before
// it: it's never detected here (there's no byte to scan for it — see
// pty-manager.ts's Session.tick doc comment) but shares this machine and
// its `signal` input shape once the caller has independently decided a
// sustained work streak has gone quiet for long enough. `hookNotification`
// and `reviewGate` (Phase 2, issue #176) are the structured-channel
// counterpart of the same idea: an agent's hook message, rather than a
// terminal escape sequence, deciding attention is needed — see
// pty-manager.ts's Session.emitHookEvent. `agentIdle` is the same channel's
// authoritative "the agent finished its turn" signal (a hook `progress`
// message with `phase: "done"` — Claude Code's Stop hook, opencode's
// session.idle, codex/agy's Stop) — see Session.emitHookEvent's "progress"
// case and Session.tick's doc comment for why this replaces the byte-driven
// `silence` guess for any session a hook adapter is actually wired into.
export type AttentionSignalKind =
  | "bell"
  | "notification"
  | "titleIdle"
  | "altScreenExit"
  | "silence"
  | "hookNotification"
  | "reviewGate"
  | "agentIdle";

// How long a candidate signal must go uncontradicted (no further output at
// all) before PENDING_ATTENTION confirms into ATTENTION. Deliberately
// per-kind, not a single shared window — see each entry's own comment.
export const ATTENTION_CONFIRM_MS: Record<AttentionSignalKind, number> = {
  // Matches the old ATTENTION_CLEAR_WINDOW_MS default. A bare BEL is the
  // noisiest of these signals by far — plenty of TUIs (Ink-based ones
  // especially) ring it as an incidental part of normal rendering, not as a
  // deliberate "look at me" — so it gets the longest debounce.
  bell: 2_000,
  // An OSC 9/777 desktop notification is a deliberate API call a program
  // makes specifically to signal something happened — meaningfully less
  // noisy than a bare bell, so it doesn't need as long a window to trust.
  notification: 1_000,
  // A working->idle TITLE transition (see classifyActivityFromTitle) only
  // fires on an actual title *change*, not once per render frame the way a
  // bell can — it's already a debounced, deliberate signal by construction,
  // so there's nothing left to gain by making callers wait further.
  titleIdle: 0,
  // Same reasoning as titleIdle: exiting alt-screen mode is itself a
  // discrete, deliberate transition (a TUI/editor closing back to the
  // shell prompt), not a per-chunk noise source.
  altScreenExit: 0,
  // The caller (Session.tick) has already waited out its own
  // SUSTAINED_SILENCE_MS quiet period before ever raising this signal —
  // layering a second wait on top here would just double-count the same
  // silence.
  silence: 0,
  // Phase 2 (issue #176): a hook `notification` message is a deliberate,
  // explicit API call an agent makes specifically to signal something
  // happened — same reasoning as the PTY-parsed `notification` kind above,
  // just arriving over the structured channel instead of an OSC 9/777
  // escape sequence. Already a discrete, one-shot event by construction
  // (there's no "per-render-frame" analogue for a hook message the way a
  // bare bell has), so no debounce is needed.
  hookNotification: 0,
  // A hook `review_gate` message announcing `state: "waiting"` is the
  // clearest possible "needs the user's attention" signal Phase 2 has: the
  // agent is explicitly blocked pending a human decision, not merely
  // reporting routine progress. Zero debounce for the same reason as
  // titleIdle/altScreenExit above — it's already a discrete, deliberate
  // transition, not a noise source to wait out.
  reviewGate: 0,
  // The agent's own hook already told us its turn is over — nothing left to
  // debounce (unlike `silence`, this isn't a guess from bytes at all).
  agentIdle: 0,
};

export interface AttentionMachineState {
  state: AttentionState;
  /** Which kind is currently being debounced, or null outside PENDING_ATTENTION. */
  pendingKind: AttentionSignalKind | null;
  /** Ms-epoch the current pending signal was (last) raised, or null outside PENDING_ATTENTION. */
  pendingSince: number | null;
  /** Ms-epoch this session was last confirmed as needing attention, or null
   * whenever state isn't "attention" — this IS pty-manager.ts's public
   * `attentionAt` field, folded into the machine's own state so there's
   * only ever one timestamp to keep in sync rather than two parallel ones. */
  confirmedAt: number | null;
}

export const INITIAL_ATTENTION_STATE: AttentionMachineState = {
  state: "idle",
  pendingKind: null,
  pendingSince: null,
  confirmedAt: null,
};

export type AttentionInput =
  // A candidate signal (bell/notification/titleIdle/altScreenExit/silence)
  // was observed in this chunk (or, for `silence`, by the periodic evaluator).
  | { type: "signal"; kind: AttentionSignalKind; now: number }
  // A chunk arrived that carried none of the above — still meaningful: it's
  // evidence the program is producing output, which can cancel a pending
  // signal or clear a confirmed one (see the "pending_attention"/"attention"
  // cases in advanceAttention).
  | { type: "output"; now: number }
  // No new bytes at all — the periodic evaluator's "has enough silent time
  // now passed to confirm a pending signal?" check. This is the ONLY input
  // that can move PENDING_ATTENTION -> ATTENTION for a nonzero-threshold
  // kind, since nothing else in this module runs off a timer.
  | { type: "tick"; now: number };

export interface AttentionEmit {
  attention: boolean;
  /** Which kind confirmed attention — omitted on the corresponding "false"
   * (clear) emit, since a clear isn't itself attributed to any one kind. */
  signal?: AttentionSignalKind;
}

/** One state transition, for the debug logging the issue asks for — pure
 * data (no I/O), turned into actual log lines by pty-manager.ts's Session.
 * A single advanceAttention() call can produce two of these (attention ->
 * clearing -> idle resolves within one call — see clearAttention's doc
 * comment for why CLEARING never actually persists as its own state). */
export interface AttentionLogEntry {
  from: AttentionState;
  to: AttentionState;
  kind?: AttentionSignalKind;
}

export interface AttentionTransition {
  next: AttentionMachineState;
  emit: AttentionEmit[];
  log: AttentionLogEntry[];
}

// A transition with nothing to report — returns the SAME state reference
// (not just an equal value), mirroring applyMouseModeChanges's "no-op
// returns prev" contract elsewhere in this file, so callers can cheaply
// tell "nothing changed" apart from "changed to an equal-looking value".
function noop(state: AttentionMachineState): AttentionTransition {
  return { next: state, emit: [], log: [] };
}

function enterPending(
  state: AttentionMachineState,
  kind: AttentionSignalKind,
  now: number,
): AttentionTransition {
  const threshold = ATTENTION_CONFIRM_MS[kind];
  if (threshold <= 0) {
    // Zero-threshold kinds are already unambiguous, debounced-by-construction
    // signals (see ATTENTION_CONFIRM_MS's per-kind comments) — nothing to
    // gain by parking in PENDING_ATTENTION first, so skip straight to
    // confirming.
    return confirmAttention(state, kind, now);
  }
  return {
    next: { state: "pending_attention", pendingKind: kind, pendingSince: now, confirmedAt: null },
    emit: [],
    log: [{ from: state.state, to: "pending_attention", kind }],
  };
}

function cancelPending(state: AttentionMachineState): AttentionTransition {
  return {
    next: INITIAL_ATTENTION_STATE,
    emit: [],
    log: [{ from: state.state, to: "idle", kind: state.pendingKind ?? undefined }],
  };
}

function confirmAttention(
  state: AttentionMachineState,
  kind: AttentionSignalKind,
  now: number,
): AttentionTransition {
  // Already confirmed (a further signal arrived while ATTENTION was already
  // set) — refresh the sticky timestamp but this isn't a new transition, so
  // no re-emit/re-log, matching #166's original "wasAttention" transition
  // guard (only the false -> true edge is event-worthy).
  const alreadyConfirmed = state.state === "attention";
  const next: AttentionMachineState = {
    state: "attention",
    pendingKind: null,
    pendingSince: null,
    confirmedAt: now,
  };
  return {
    next,
    emit: alreadyConfirmed ? [] : [{ attention: true, signal: kind }],
    log: alreadyConfirmed ? [] : [{ from: state.state, to: "attention", kind }],
  };
}

// No `state` parameter: the caller only ever calls this from the "attention"
// case (see advanceAttention below), so both endpoints of the transition are
// already fixed.
function clearAttention(): AttentionTransition {
  return {
    next: INITIAL_ATTENTION_STATE,
    emit: [{ attention: false }],
    // Passes through CLEARING as a logged step distinct from a plain
    // "attention -> idle" jump, without giving it its own persisted dwell
    // time: unlike PENDING_ATTENTION -> ATTENTION (which must wait out real
    // silence to rule out mid-render noise), the mere arrival of a
    // signal-free chunk while ATTENTION is set is already sufficient
    // evidence the program resumed and is no longer waiting on the user —
    // there's no analogous "might just be noise" case to debounce against
    // here, so resolving synchronously within this one call is correct, not
    // a shortcut.
    log: [
      { from: "attention", to: "clearing" },
      { from: "clearing", to: "idle" },
    ],
  };
}

/**
 * The attention state machine's single transition function — see the
 * "Attention state machine" comment above for the full false-positive-fix
 * rationale. Pure: same (state, input) always produces the same output, no
 * clock/IO reads. Callers own feeding real chunks/ticks in and turning
 * `emit`/`log` into actual emitEvent()/debug-log calls (pty-manager.ts's
 * Session).
 */
export function advanceAttention(
  state: AttentionMachineState,
  input: AttentionInput,
): AttentionTransition {
  switch (state.state) {
    case "idle":
      return input.type === "signal" ? enterPending(state, input.kind, input.now) : noop(state);

    case "pending_attention":
      if (input.type === "signal") {
        // A fresh candidate signal before confirmation restarts the pending
        // window against the NEWEST kind/timestamp — this is the core fix:
        // a whole burst of bells during heavy output just keeps re-arming
        // this window instead of ever accumulating enough quiet time to
        // confirm (see the file-level comment above for the concrete bug).
        return enterPending(state, input.kind, input.now);
      }
      if (input.type === "output") {
        // Plain output before the window elapsed is itself evidence the
        // program is still working — cancel outright.
        return cancelPending(state);
      }
      // "tick": promote once enough quiet time has passed since the signal
      // was (last) raised, with nothing since to contradict it.
      {
        const threshold = ATTENTION_CONFIRM_MS[state.pendingKind as AttentionSignalKind];
        const elapsed = input.now - (state.pendingSince ?? input.now);
        return elapsed >= threshold
          ? confirmAttention(state, state.pendingKind as AttentionSignalKind, input.now)
          : noop(state);
      }

    case "attention":
      if (input.type === "signal") {
        // Still needs attention — refresh confirmedAt, no new transition.
        return { next: { ...state, confirmedAt: input.now }, emit: [], log: [] };
      }
      if (input.type === "output") return clearAttention();
      return noop(state); // "tick": nothing to do once already confirmed.

    case "clearing":
      // Never actually reached in practice — clearAttention() resolves
      // synchronously to "idle" within the same call that enters it (see
      // its doc comment). Kept so AttentionState's full four-value union is
      // still exhaustively handled here rather than silently assuming
      // "clearing" can't occur.
      return { next: INITIAL_ATTENTION_STATE, emit: [], log: [] };
  }
}

// Matches the three enter/exit escape-sequence pairs xterm honors for the
// alternate screen buffer — ?1049 (the modern pair: save/restore cursor +
// clear), ?1047 (clear-on-exit only), and the legacy ?47 (no clear at all).
// Whichever pair a program uses, entering means "switch to alt", exiting
// means "switch to primary" — callers only need to know which side of that
// switch the stream last crossed, not which pair did it.
// eslint-disable-next-line no-control-regex
const ALT_SCREEN_SWITCH = /\x1b\[\?(?:1049|1047|47)([hl])/g;

/**
 * Scans a chunk for alt-screen-buffer enter/exit sequences and returns which
 * side of the switch the LAST one in this chunk lands on, or null if the
 * chunk contains none at all (the common case — most output is plain
 * program text, not a screen-mode switch). Used by pty-manager.ts's Session
 * to track true screen-mode state across a session's lifetime, so scrollback
 * replay can synthesize a correct preamble instead of trusting the buffered
 * bytes to be a self-balanced enter/exit pair (see issue #83: FIFO eviction
 * of the ring buffer can strand a dangling exit, never a dangling enter, so
 * "just replay the raw bytes" silently drifts out of sync with reality).
 */
export function detectAltScreenSwitch(chunk: string): "alt" | "primary" | null {
  let result: "alt" | "primary" | null = null;
  for (const match of chunk.matchAll(ALT_SCREEN_SWITCH)) {
    result = match[1] === "h" ? "alt" : "primary";
  }
  return result;
}

// Derived xterm.js CoreMouseService state tracked the same deliberate way
// detectAltScreenSwitch/inAltScreen track screen mode above — issue #93's
// "opencode sometimes cycles prompt history instead of scrolling on mouse
// wheel" traced to exactly this gap: a reconnecting client's fresh xterm.js
// only ever sees whatever DECSET bytes are still within the bounded
// scrollback ring buffer (see SCROLLBACK_MAX_BYTES in pty-manager.ts), so if
// the program's original mouse-tracking-enabling escape has aged out by the
// time a client (re)attaches, the client silently defaults to no tracking
// while the real process is never told anything changed. protocol/encoding
// are kept as two independent derived enums (not a raw per-DECSET-code
// on/off map) because that's what xterm.js itself derives them into —
// critically, DECRST's reset side doesn't mirror DECSET's per-code
// granularity: resetting any of ?9/?1000/?1002/?1003 collapses the whole
// protocol axis to "NONE" (xterm.js's InputHandler DECRST case block falls
// through all four into one activeProtocol = 'NONE' assignment), so e.g.
// ?1002h then ?1003h then ?1003l genuinely ends with tracking OFF even
// though ?1002 was never itself reset — a naive per-code "on" map would get
// this wrong. Encoding (?1006 SGR / ?1016 SGR_PIXELS) is a separate,
// independent axis.
export interface MouseTrackingState {
  /** xterm.js CoreMouseService protocol; "NONE" = mouse tracking off. */
  protocol: "NONE" | "X10" | "VT200" | "DRAG" | "ANY";
  /** xterm.js CoreMouseService encoding; "DEFAULT" = legacy X10 byte encoding. */
  encoding: "DEFAULT" | "SGR" | "SGR_PIXELS";
}

export const INITIAL_MOUSE_TRACKING_STATE: MouseTrackingState = {
  protocol: "NONE",
  encoding: "DEFAULT",
};

const MOUSE_PROTOCOL_BY_CODE = { 9: "X10", 1000: "VT200", 1002: "DRAG", 1003: "ANY" } as const;
const MOUSE_ENCODING_BY_CODE = { 1006: "SGR", 1016: "SGR_PIXELS" } as const;

// Matches any DECSET/DECRST for the mouse-tracking-protocol codes (9/1000/
// 1002/1003), the two encodings xterm.js still implements (1006/1016), and
// the two it no longer does (1005/1015 -- removed upstream in xterm.js's own
// tracker; DECRST still courtesy-resets encoding to DEFAULT for these,
// DECSET is a no-op). Known limitation, same one ALT_SCREEN_SWITCH above
// already has: a combined-parameter form like `\x1b[?1003;1006h` isn't
// matched -- doesn't affect the confirmed #93 bug, since the programs
// observed emit separate sequences per mode.
// eslint-disable-next-line no-control-regex
const MOUSE_MODE_SWITCH = /\x1b\[\?(9|1000|1002|1003|1005|1006|1015|1016)([hl])/g;

/**
 * Scans a chunk for mouse-tracking DECSET/DECRST sequences and folds them
 * into `prev`, returning the resulting state (or `prev` itself, unchanged,
 * if the chunk contains none -- the common case). See MouseTrackingState's
 * docstring for why protocol/encoding are derived enums rather than a raw
 * per-code map, and specifically why a DECRST for *any* protocol code resets
 * the whole protocol axis to "NONE" rather than just that code.
 */
export function applyMouseModeChanges(chunk: string, prev: MouseTrackingState): MouseTrackingState {
  let { protocol, encoding } = prev;
  for (const match of chunk.matchAll(MOUSE_MODE_SWITCH)) {
    const code = Number(match[1]);
    const set = match[2] === "h";
    if (code in MOUSE_PROTOCOL_BY_CODE) {
      protocol = set ? MOUSE_PROTOCOL_BY_CODE[code as keyof typeof MOUSE_PROTOCOL_BY_CODE] : "NONE";
    } else if (code in MOUSE_ENCODING_BY_CODE) {
      encoding = set
        ? MOUSE_ENCODING_BY_CODE[code as keyof typeof MOUSE_ENCODING_BY_CODE]
        : "DEFAULT";
    } else if (!set) {
      // 1005/1015 DECRST courtesy-reset only -- DECSET for these is a no-op
      // in xterm.js (see the regex comment above).
      encoding = "DEFAULT";
    }
  }
  return protocol === prev.protocol && encoding === prev.encoding ? prev : { protocol, encoding };
}

// Matches a not-yet-terminated prefix of the CSI shape ALT_SCREEN_SWITCH and
// MOUSE_MODE_SWITCH both share: ESC, optionally "[", optionally "?",
// optionally up to 4 parameter digits -- anything short of the closing
// "h"/"l". Anchored to the whole tail (not "somewhere in the tail") so an
// OSC-sequence partial (ESC "]" ...) or any other byte outside this shape
// correctly fails to match and isn't carried.
// eslint-disable-next-line no-control-regex
const PARTIAL_ESCAPE_TAIL = /^\x1b(?:\[(?:\?\d{0,4})?)?$/;

/**
 * Returns the trailing unterminated escape-sequence prefix of `chunk` if it
 * ends mid-sequence for the shape detectAltScreenSwitch/applyMouseModeChanges
 * scan for (e.g. a PTY read boundary landing right after "\x1b[?104"), or ""
 * if it doesn't. Callers prepend the result to the next chunk before
 * re-running those two detectors, so a sequence split across two `onData`
 * reads -- the longest recognized one, "\x1b[?1049h", is 8 bytes, and a PTY
 * read boundary can land anywhere inside it -- is still recognized exactly
 * once, on the read that completes it.
 *
 * Detection-only: never prepend this carry to scrollback or any live
 * listener -- only to the copy fed to the two detectors -- or the carried
 * bytes get duplicated into the replayed stream. See Session.onData in
 * pty-manager.ts.
 */
export function carryPartialEscape(chunk: string): string {
  const lastEsc = chunk.lastIndexOf("\x1b");
  if (lastEsc === -1) return "";
  const tail = chunk.slice(lastEsc);
  return PARTIAL_ESCAPE_TAIL.test(tail) ? tail : "";
}
