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

import { monitorEventLoopDelay } from "node:perf_hooks";

export type ProtocolDirection = "to-pty" | "from-pty";

// Lines logged per session of any kind. Past it only color traffic is kept —
// a program that polls CPR on every frame must not flood the journal.
export const PROTOCOL_TRACE_MAX_LINES = 300;
// Hard ceiling per session, color traffic included: a program polling the
// background color on every frame floods the journal just the same.
// Event-loop stall is only sampled this long: startup queries are the case it explains.
const PROTOCOL_TRACE_LOOP_WINDOW_MS = 30_000;
export const PROTOCOL_TRACE_MAX_COLOR_LINES = 1000;

let enabled = true;

export function isProtocolTraceEnabled(): boolean {
  return enabled;
}

/** Boot-time switch (`MULLION_PROTOCOL_TRACE`, see plugins/pty.ts). On by default. */
export function setProtocolTraceEnabled(value: boolean): void {
  enabled = value;
}

/* eslint-disable no-control-regex */
// General OSC form (the payload is absent for the reset sequences 104/110-112)
// filtered by COLOR_OSC_IDENTS below, same shape as attention-detect.ts's.
const OSC_RE = /\x1b\](\d+)(?:;([^\x07\x1b]{0,64}))?(?:\x07|\x1b\\)/g;
const CSI_RE = /\x1b\[([?>=<]?)([0-9;:]*)([$!]?)([nRcIOpu])/g;
const CONTROL_BYTES_RE = /[\x00-\x1f\x7f]/g;
/* eslint-enable no-control-regex */

// Palette-affecting OSC: 4 (palette entry), 10/11/12 (fg/bg/cursor) and the
// resets 104/110/111/112 — the most direct cause of a mid-session palette change.
const COLOR_OSC_IDENTS = new Set(["4", "10", "11", "12", "104", "110", "111", "112"]);

export interface ProtocolDescription {
  tags: string[];
  /** True if any tag is an OSC color sequence or a DEC 997 notification. */
  color: boolean;
}

/**
 * "OSC 11;?" is a query, a bare ident is a reset, anything else after the
 * ident is a set or a report. Control bytes are stripped from the payload:
 * from-pty carries agent output, and a newline would forge a journal line.
 */
function describeOsc(ident: string, payload: string | undefined): string {
  if (payload === undefined) return `osc${ident}`;
  if (payload === "?") return `osc${ident}?`;
  // OSC 4 carries `index;spec` pairs: it is a query when every spec is `?`
  // (`4;0;?;1;?` queries entries 0 and 1) and a set/report otherwise. Only
  // digit indexes make it into the tag, so no payload byte can.
  if (ident === "4") {
    const parts = payload.split(";");
    const indexes = parts.filter((_, n) => n % 2 === 0);
    const specs = parts.filter((_, n) => n % 2 === 1);
    if (
      parts.length % 2 === 0 &&
      indexes.every((v) => /^\d+$/.test(v)) &&
      specs.every((v) => v === "?")
    ) {
      return `osc4?${indexes.join(",")}`;
    }
  }
  return `osc${ident}=${payload.replace(CONTROL_BYTES_RE, "")}`;
}

export function describeTerminalProtocol(data: string): ProtocolDescription {
  const tags: string[] = [];
  let color = false;
  for (const m of data.matchAll(OSC_RE)) {
    if (!COLOR_OSC_IDENTS.has(m[1]!)) continue;
    tags.push(describeOsc(m[1]!, m[2]));
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
  // Event-loop stall since this session's previous traced chunk, so a late reply
  // to a startup query (Codex gives up after 250 ms) can be told apart from a
  // slow program. One histogram per session: a shared one would be reset by
  // another session's chatter and hide the stall. Started on first use.
  private loopDelay: ReturnType<typeof monitorEventLoopDelay> | null = null;
  private loopDelayDone = false;

  constructor(
    private readonly sessionId: string,
    private readonly startedAt: number,
    private readonly sink: (line: string) => void = (line) => console.log(line),
    private readonly now: () => number = Date.now,
  ) {}

  /** Cheap on the hot path: a chunk with no ESC byte is never inspected. */
  record(direction: ProtocolDirection, data: string): void {
    if (!enabled || !data.includes("\x1b")) return;
    const { tags, color } = describeTerminalProtocol(data);
    if (tags.length === 0) return;
    const loopMax = this.takeLoopMaxMs();
    if (this.lines >= PROTOCOL_TRACE_MAX_COLOR_LINES) return;
    if (this.lines >= PROTOCOL_TRACE_MAX_LINES && !color) return;
    this.lines += 1;
    this.sink(
      `[pty-manager] session ${this.sessionId} protocol ${direction} ` +
        `+${this.now() - this.startedAt}ms ${tags.join(" ")}${loopMax}`,
    );
  }

  /** " loop-max=Nms" for a session's first 30 s (the startup probes), "" after. */
  private takeLoopMaxMs(): string {
    if (this.loopDelayDone) return "";
    if (!this.loopDelay) {
      const left = PROTOCOL_TRACE_LOOP_WINDOW_MS - (this.now() - this.startedAt);
      if (left <= 0) {
        this.loopDelayDone = true;
        return "";
      }
      const histogram = monitorEventLoopDelay({ resolution: 10 });
      histogram.enable();
      // Disabled on a timer, not on the next line: a session may never log again.
      setTimeout(() => {
        histogram.disable();
        this.loopDelayDone = true;
      }, left).unref();
      this.loopDelay = histogram;
    }
    const max = Math.round(this.loopDelay.max / 1e6);
    this.loopDelay.reset();
    return ` loop-max=${max}ms`;
  }
}
