import { afterEach, describe, it, expect } from "vitest";
import {
  describeTerminalProtocol,
  ProtocolTrace,
  PROTOCOL_TRACE_MAX_LINES,
  PROTOCOL_TRACE_MAX_COLOR_LINES,
  setProtocolTraceEnabled,
} from "../../src/services/terminal-protocol-trace.js";

describe("describeTerminalProtocol", () => {
  it("tags OSC color queries, reports and sets", () => {
    expect(describeTerminalProtocol("\x1b]11;?\x07").tags).toEqual(["osc11?"]);
    expect(describeTerminalProtocol("\x1b]11;rgb:f2f2/f2f2/f2f2\x07").tags).toEqual([
      "osc11=rgb:f2f2/f2f2/f2f2",
    ]);
    expect(describeTerminalProtocol("\x1b]10;#0d0d0d\x1b\\").tags).toEqual(["osc10=#0d0d0d"]);
  });

  it("tags the palette reset family, which carries no payload, and OSC 4", () => {
    const d = describeTerminalProtocol(
      "\x1b]110\x07\x1b]111\x1b\\\x1b]112\x07\x1b]104\x07\x1b]4;1;?\x07",
    );
    expect(d.tags).toEqual(["osc110", "osc111", "osc112", "osc104", "osc4?1"]);
    expect(d.color).toBe(true);
  });

  it("tags an OSC 4 query by palette index and an OSC 4 report as a set", () => {
    expect(describeTerminalProtocol("\x1b]4;7;?\x07").tags).toEqual(["osc4?7"]);
    expect(describeTerminalProtocol("\x1b]4;7;rgb:ffff/0000/0000\x07").tags).toEqual([
      "osc4=7;rgb:ffff/0000/0000",
    ]);
  });

  it("ignores non-palette OSC such as titles and hyperlinks", () => {
    expect(describeTerminalProtocol("\x1b]0;my title\x07\x1b]8;;http://x\x1b\\").tags).toEqual([]);
  });

  it("strips control bytes from a payload so it cannot forge a journal line", () => {
    const d = describeTerminalProtocol("\x1b]11;a\nFAKE protocol line\r\x07");
    expect(d.tags).toEqual(["osc11=aFAKE protocol line"]);
  });

  it("flags color traffic, including the DEC 997 notification", () => {
    expect(describeTerminalProtocol("\x1b]12;?\x07").color).toBe(true);
    const dec997 = describeTerminalProtocol("\x1b[?997;2n");
    expect(dec997.tags).toEqual(["csi?997;2n"]);
    expect(dec997.color).toBe(true);
  });

  it("tags CPR, DSR, DA, DECRQM, kitty and focus sequences without flagging them as color", () => {
    const d = describeTerminalProtocol(
      "\x1b[6n\x1b[21;3R\x1b[c\x1b[>c\x1b[?2026$p\x1b[>7u\x1b[I\x1b[O",
    );
    expect(d.tags).toEqual([
      "csi6n",
      "csi21;3R",
      "csic",
      "csi>c",
      "csi?2026$p",
      "csi>7u",
      "csiI",
      "csiO",
    ]);
    expect(d.color).toBe(false);
  });

  it("ignores text, SGR and cursor movement", () => {
    expect(describeTerminalProtocol("hello \x1b[1;31mred\x1b[0m\x1b[10;5H").tags).toEqual([]);
  });
});

describe("ProtocolTrace", () => {
  afterEach(() => setProtocolTraceEnabled(true));

  function make() {
    const lines: string[] = [];
    let t = 1_500;
    const trace = new ProtocolTrace(
      "42",
      1_000,
      (l) => lines.push(l),
      () => t,
    );
    return { trace, lines, advance: (ms: number) => (t += ms) };
  }

  it("logs direction, session, elapsed time and tags", () => {
    const { trace, lines } = make();
    trace.record("from-pty", "\x1b]11;?\x07\x1b[6n");
    expect(lines).toEqual(["[pty-manager] session 42 protocol from-pty +500ms osc11? csi6n"]);
  });

  it("skips chunks with no ESC byte and chunks with nothing worth tracing", () => {
    const { trace, lines } = make();
    trace.record("to-pty", "plain typing");
    trace.record("to-pty", "\x1b[1mbold\x1b[0m");
    expect(lines).toEqual([]);
  });

  it("caps non-color lines per session but always keeps color traffic", () => {
    const { trace, lines } = make();
    for (let i = 0; i < PROTOCOL_TRACE_MAX_LINES; i++) trace.record("from-pty", "\x1b[6n");
    expect(lines).toHaveLength(PROTOCOL_TRACE_MAX_LINES);

    trace.record("from-pty", "\x1b[6n");
    expect(lines).toHaveLength(PROTOCOL_TRACE_MAX_LINES);

    trace.record("to-pty", "\x1b]11;rgb:0d0d/0d0d/0d0d\x07");
    expect(lines).toHaveLength(PROTOCOL_TRACE_MAX_LINES + 1);
  });

  it("bounds color traffic too: a per-frame color query cannot flood the journal", () => {
    const { trace, lines } = make();
    for (let i = 0; i < PROTOCOL_TRACE_MAX_COLOR_LINES + 500; i++) {
      trace.record("from-pty", "\x1b]11;?\x07");
    }
    expect(lines).toHaveLength(PROTOCOL_TRACE_MAX_COLOR_LINES);
  });

  it("logs nothing when switched off (MULLION_PROTOCOL_TRACE=false)", () => {
    setProtocolTraceEnabled(false);
    const { trace, lines } = make();
    trace.record("from-pty", "\x1b]11;?\x07\x1b[6n");
    expect(lines).toEqual([]);
  });
});
