// Scans a chunk of raw PTY output for the terminal escape sequences a TUI
// uses to signal "look at me" or announce its current state — the plumbing
// half of vision item's status-signal work (see the plan's WS-6). This is
// deliberately just signal collection, not a "is it waiting for my input"
// classifier: that judgment call is heuristic and left to the redesign,
// which can inspect `lastTitle`'s actual text (many agentic CLIs write
// something like "Waiting for input" or a status emoji into the title) —
// we plumb the input, we don't over-promise the classifier.

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
  const bell = chunk.includes("\x07");
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
