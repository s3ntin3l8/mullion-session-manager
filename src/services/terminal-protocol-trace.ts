// Diagnostic trace of terminal-protocol traffic (queries, replies, color
// pushes) on a session's PTY, for the "a Codex pane's palette changed
// mid-session" and "stray `[21;3R` in the composer" reports. Both come down
// to *which* bytes a running program was sent or asked, and *when* — which
// only the PTY boundary can answer, and survives a browser reload.
//
// Records only the escape sequences that carry that signal (color OSC
// 10/11/12, DSR/CPR, DA, DECRQM, kitty keyboard, focus in/out, the DEC 997
// color-scheme notification). Everything else — text, SGR, cursor movement —
// is skipped, so the volume is a handful of lines per session start.
//
// A sequence split across two PTY reads is not reassembled: this is a
// diagnostic, and a split query shows up as its two halves missing, which is
// itself the signal worth noticing.

export type ProtocolDirection = "to-pty" | "from-pty";

// Lines logged per session regardless of kind, before only color traffic is
// kept — a program that polls CPR on every frame must not flood the journal.
export const PROTOCOL_TRACE_MAX_LINES = 300;

/* eslint-disable no-control-regex */
const OSC_COLOR_RE = /\x1b\](1[012]);([^\x07\x1b]{0,64})(?:\x07|\x1b\\)/g;
const CSI_RE = /\x1b\[([?>=<]?)([0-9;:]*)([$!]?)([nRcIOpu])/g;
/* eslint-enable no-control-regex */

export interface ProtocolDescription {
  tags: string[];
  /** True if any tag is an OSC color sequence or a DEC 997 notification. */
  color: boolean;
}

/** "OSC 11;?" is a query; anything else after the ident is a set or a report. */
function describeOsc(ident: string, payload: string): string {
  return payload === "?" ? `osc${ident}?` : `osc${ident}=${payload}`;
}

export function describeTerminalProtocol(data: string): ProtocolDescription {
  const tags: string[] = [];
  let color = false;
  for (const m of data.matchAll(OSC_COLOR_RE)) {
    tags.push(describeOsc(m[1]!, m[2]!));
    color = true;
  }
  for (const m of data.matchAll(CSI_RE)) {
    const [, prefix, params, intermediate, final] = m;
    tags.push(`csi${prefix}${params}${intermediate}${final}`);
    if (prefix === "?" && params!.startsWith("997") && final === "n") color = true;
  }
  return { tags, color };
}

export class ProtocolTrace {
  private lines = 0;

  constructor(
    private readonly sessionId: string,
    private readonly startedAt: number,
    private readonly sink: (line: string) => void = (line) => console.log(line),
    private readonly now: () => number = Date.now,
  ) {}

  /** Cheap on the hot path: a chunk with no ESC byte is never inspected. */
  record(direction: ProtocolDirection, data: string): void {
    if (!data.includes("\x1b")) return;
    const { tags, color } = describeTerminalProtocol(data);
    if (tags.length === 0) return;
    if (this.lines >= PROTOCOL_TRACE_MAX_LINES && !color) return;
    this.lines += 1;
    this.sink(
      `[pty-manager] session ${this.sessionId} protocol ${direction} ` +
        `+${this.now() - this.startedAt}ms ${tags.join(" ")}`,
    );
  }
}
