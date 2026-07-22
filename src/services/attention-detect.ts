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
