import { describe, it, expect } from "vitest";
import type { IBuffer, IBufferLine } from "@xterm/xterm";
import { bufferToText } from "./terminalBufferText.js";

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
