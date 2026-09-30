import { describe, it, expect } from "vitest";
import type { IBuffer, IBufferLine, Terminal } from "@xterm/xterm";
import { bufferToText, scrollbackToText } from "./terminalBufferText.js";

function fakeBuffer(rows: [string, boolean][]): IBuffer {
  return {
    length: rows.length,
    getLine: (i: number) =>
      rows[i]
        ? ({
            isWrapped: rows[i][1],
            translateToString: (trimRight?: boolean) =>
              trimRight ? rows[i][0].replace(/\s+$/, "") : rows[i][0],
          } as unknown as IBufferLine)
        : undefined,
  } as unknown as IBuffer;
}

// Minimal Terminal stub — we only need .buffer.normal; the only call site for
// scrollbackToText reads that one field.
function fakeTerm(normal: IBuffer): Terminal {
  return { buffer: { normal } } as unknown as Terminal;
}

describe("bufferToText", () => {
  it("rejoins soft-wrapped rows and trims trailing whitespace and blank lines", () => {
    const text = bufferToText(
      fakeBuffer([
        ["$ echo hello   ", false],
        ["hello", false],
        ["a very long line that wr", false],
        ["aps", true],
        ["", false],
        ["   ", false],
      ]),
    );
    expect(text).toBe("$ echo hello\nhello\na very long line that wraps");
  });

  it("keeps a space that sits in the last column of a wrapped row", () => {
    // "abcdefghi jkl" at 10 columns: the space is the 10th cell of row 1.
    expect(
      bufferToText(
        fakeBuffer([
          ["abcdefghi ", false],
          ["jkl       ", true],
        ]),
      ),
    ).toBe("abcdefghi jkl");
  });

  it("treats a wrapped first row as its own line", () => {
    expect(bufferToText(fakeBuffer([["x", true]]))).toBe("x");
  });

  it("returns an empty string for an empty buffer", () => {
    expect(bufferToText(fakeBuffer([]))).toBe("");
  });
});

describe("scrollbackToText", () => {
  it("reads term.buffer.normal (the persistent history, not the active one)", () => {
    // The "active" buffer is the Codex question dialog (a single row, "y/n
    // (y/N)"), but the persistent scrollback — held in the normal buffer —
    // is the inline transcript the user wants to see. The point of
    // scrollbackToText is to ignore `active` and route through `normal`.
    const normal = fakeBuffer([
      ["$ echo hello", false],
      ["hello", false],
      ["$ ", false],
    ]);
    const term = fakeTerm(normal);
    expect(scrollbackToText(term)).toBe("$ echo hello\nhello\n$");
  });
});
