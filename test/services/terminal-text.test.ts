import { describe, it, expect } from "vitest";
import {
  ANSI_ESCAPE_SEQUENCE,
  stripTerminalEscapes,
  lastMeaningfulLine,
  collapseAndTruncate,
} from "../../src/services/terminal-text.js";

const ESC = "\x1b";
const BEL = "\x07";

describe("ANSI_ESCAPE_SEQUENCE", () => {
  it("matches a CSI/SGR sequence", () => {
    expect(`${ESC}[1mbold${ESC}[22m`.replace(ANSI_ESCAPE_SEQUENCE, "")).toBe("bold");
  });
});

describe("stripTerminalEscapes", () => {
  it("strips a CSI/SGR sequence", () => {
    expect(stripTerminalEscapes(`${ESC}[1mLocal${ESC}[22m: 5173`)).toBe("Local: 5173");
  });

  it("strips a DEC private-mode CSI sequence", () => {
    expect(stripTerminalEscapes(`${ESC}[?1049lhello`)).toBe("hello");
  });

  it("strips an OSC sequence terminated with BEL", () => {
    expect(stripTerminalEscapes(`${ESC}]0;my title${BEL}hello`)).toBe("hello");
  });

  it("strips an OSC sequence terminated with ST (ESC \\)", () => {
    expect(stripTerminalEscapes(`${ESC}]0;my title${ESC}\\hello`)).toBe("hello");
  });

  it("strips a lone single-character ESC sequence", () => {
    expect(stripTerminalEscapes(`${ESC}Mhello`)).toBe("hello");
  });

  it("strips stray control bytes while keeping tab/newline/carriage-return", () => {
    expect(stripTerminalEscapes("a\x00b\x01c\td\ne\rf")).toBe("abc\td\ne\rf");
  });

  it("leaves plain text untouched", () => {
    expect(stripTerminalEscapes("just some regular output")).toBe("just some regular output");
  });
});

describe("lastMeaningfulLine", () => {
  it("returns the last non-blank line", () => {
    expect(lastMeaningfulLine("first line\nsecond line\nthird line", { truncated: false })).toBe(
      "third line",
    );
  });

  it("skips trailing blank lines", () => {
    expect(lastMeaningfulLine("real content\n\n\n", { truncated: false })).toBe("real content");
  });

  it("takes only the segment after the last \\r on a spinner/progress line", () => {
    expect(
      lastMeaningfulLine("Building...\rBuilding..\rBuilding.\rDone", { truncated: false }),
    ).toBe("Done");
  });

  it("applies the \\r rule to the last line even among several lines", () => {
    const text = "step one\nstep two\rstep two (retry)\rstep two (final)";
    expect(lastMeaningfulLine(text, { truncated: false })).toBe("step two (final)");
  });

  it("returns the real content of a line ending in the normal PTY \\r\\n terminator, not an empty string", () => {
    // A real pty (node-pty, this repo's actual backend) emits \r\n as the
    // ordinary line terminator, not bare \n — so every real line carries
    // its own trailing \r that is NOT an overwrite. Regression test: a
    // naive "split on \r, take the last segment" reads that trailing \r as
    // an overwrite-to-nothing and returns "", not the real line.
    expect(lastMeaningfulLine("line one\r\nline two\r\n", { truncated: false })).toBe("line two");
  });

  it("combines a mid-line overwrite with a trailing \\r\\n terminator correctly", () => {
    expect(lastMeaningfulLine("Building...\rDone\r\n", { truncated: false })).toBe("Done");
  });

  it("strips ANSI escapes before extracting the line", () => {
    expect(
      lastMeaningfulLine(`plain\n${ESC}[1mBuild succeeded${ESC}[22m`, { truncated: false }),
    ).toBe("Build succeeded");
  });

  it("discards a possibly-partial first line when truncated is true", () => {
    // Simulates a hard byte cut landing mid-line: the first "line" here is
    // a fragment, not a real line, and must never be returned even though
    // it's technically non-blank.
    const text = "rtial first line\nsecond line\nthird line";
    expect(lastMeaningfulLine(text, { truncated: true })).toBe("third line");
  });

  it("does not discard the first line when truncated is false", () => {
    expect(lastMeaningfulLine("only line", { truncated: false })).toBe("only line");
  });

  it("returns null when nothing qualifies (all blank)", () => {
    expect(lastMeaningfulLine("\n\n\n", { truncated: false })).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(lastMeaningfulLine("", { truncated: false })).toBeNull();
  });

  it("returns null when the only line is discarded as a truncated partial", () => {
    expect(lastMeaningfulLine("only a partial fragment", { truncated: true })).toBeNull();
  });

  it("returns null for input that's entirely escape sequences/control bytes", () => {
    expect(lastMeaningfulLine(`${ESC}[1m${ESC}[22m\x00\x01`, { truncated: false })).toBeNull();
  });
});

describe("collapseAndTruncate", () => {
  it("returns short text unchanged", () => {
    expect(collapseAndTruncate("hello world", 120)).toBe("hello world");
  });

  it("collapses embedded whitespace/newlines into single spaces", () => {
    expect(collapseAndTruncate("hello\n\n  world\t\tagain", 120)).toBe("hello world again");
  });

  it("trims leading/trailing whitespace", () => {
    expect(collapseAndTruncate("   hello world   ", 120)).toBe("hello world");
  });

  it("truncates at exactly maxChars and appends an ellipsis", () => {
    const text = "a".repeat(150);
    const result = collapseAndTruncate(text, 120);
    expect(result).toBe(`${"a".repeat(120)}…`);
  });

  it("does not truncate when exactly at maxChars", () => {
    const text = "a".repeat(120);
    expect(collapseAndTruncate(text, 120)).toBe(text);
  });

  it("truncates by code point, not UTF-16 code unit, so a surrogate pair is never split", () => {
    // U+1F600 (😀) is a surrogate pair — two UTF-16 code units, one code
    // point. Placing several right at the boundary must never split one
    // in half and render U+FFFD.
    const text = "😀".repeat(10);
    const result = collapseAndTruncate(text, 5);
    expect(result).toBe(`${"😀".repeat(5)}…`);
    expect(result).not.toContain("�");
  });
});
