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
