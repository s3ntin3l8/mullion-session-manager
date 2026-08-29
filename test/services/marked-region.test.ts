import { describe, it, expect } from "vitest";
import {
  clampToBytes,
  extractMarkedRegion,
  upsertMarkedRegion,
} from "../../src/services/marked-region.js";

const START = "<!-- start -->";
const END = "<!-- end -->";

describe("extractMarkedRegion", () => {
  it("extracts the trimmed text between the markers", () => {
    const text = `before\n${START}\n  hello world  \n${END}\nafter`;
    expect(extractMarkedRegion(text, START, END)).toBe("hello world");
  });

  it("ignores text outside the markers", () => {
    const text = `IGNORE ME\n${START}\nkept\n${END}\nIGNORE ME TOO`;
    const region = extractMarkedRegion(text, START, END);
    expect(region).not.toContain("IGNORE");
  });

  it("returns null when the start marker is missing", () => {
    expect(extractMarkedRegion(`no start\n${END}`, START, END)).toBeNull();
  });

  it("returns null when the end marker is missing", () => {
    expect(extractMarkedRegion(`${START}\nno end`, START, END)).toBeNull();
  });

  it("returns null when the end marker precedes the start marker", () => {
    expect(extractMarkedRegion(`${END}\nbody\n${START}`, START, END)).toBeNull();
  });

  it("first-region-wins: a second START...END pair is not concatenated in", () => {
    const text = `${START}\nfirst\n${END}\nmiddle\n${START}\nsecond\n${END}`;
    expect(extractMarkedRegion(text, START, END)).toBe("first");
  });

  it("matches markers across CRLF line endings", () => {
    const text = `${START}\r\nhello\r\n${END}`;
    expect(extractMarkedRegion(text, START, END)).toBe("hello");
  });
});

describe("clampToBytes", () => {
  it("returns the text unchanged, no marker appended, when it already fits", () => {
    const text = "short";
    expect(clampToBytes(text, 100, "source.md")).toBe(text);
  });

  it("truncates and appends a marker naming the source when over budget", () => {
    const text = "a".repeat(50);
    const result = clampToBytes(text, 10, "source.md");
    expect(result).not.toBe(text);
    expect(result).toContain("[mullion: truncated at 10 bytes");
    expect(result).toContain("source.md");
  });

  it("the retained body portion never exceeds maxBytes", () => {
    const text = "x".repeat(1000);
    const maxBytes = 50;
    const result = clampToBytes(text, maxBytes, "source.md");
    const bodyOnly = result.split("\n\n[mullion: truncated")[0];
    expect(Buffer.byteLength(bodyOnly, "utf8")).toBeLessThanOrEqual(maxBytes);
  });

  it("never splits a multibyte UTF-8 character mid-sequence", () => {
    // "é" is 2 bytes in UTF-8; repeat enough times that a byte-oblivious
    // slice at an odd byte count would land mid-character.
    const text = "é".repeat(20);
    const result = clampToBytes(text, 7, "source.md");
    expect(result).not.toContain("�");
  });
});

describe("upsertMarkedRegion", () => {
  it("appends a fresh region to empty text", () => {
    expect(upsertMarkedRegion("", START, END, "hello")).toBe(`${START}\nhello\n${END}\n`);
  });

  it("appends a fresh region after existing content, separated by a blank line", () => {
    const result = upsertMarkedRegion("# Title\n\nSome prose.", START, END, "hello");
    expect(result).toBe(`# Title\n\nSome prose.\n\n${START}\nhello\n${END}\n`);
  });

  it("replaces an existing region in place, leaving surrounding text untouched", () => {
    const text = `before\n${START}\nold content\n${END}\nafter`;
    const result = upsertMarkedRegion(text, START, END, "new content");
    expect(result).toBe(`before\n${START}\nnew content\n${END}\nafter`);
  });

  it("trims the body before placing it between the markers", () => {
    const result = upsertMarkedRegion("", START, END, "  padded  \n");
    expect(result).toBe(`${START}\npadded\n${END}\n`);
  });

  it("only replaces the FIRST region — matches extractMarkedRegion's own first-region-only contract", () => {
    const text = `${START}\nfirst\n${END}\nmiddle\n${START}\nsecond\n${END}`;
    const result = upsertMarkedRegion(text, START, END, "replaced");
    expect(result).toBe(`${START}\nreplaced\n${END}\nmiddle\n${START}\nsecond\n${END}`);
  });

  it("appends a new region when the end marker precedes the start marker (same 'no valid region' case extractMarkedRegion treats as absent)", () => {
    const text = `${END}\nold\n${START}`;
    const result = upsertMarkedRegion(text, START, END, "hello");
    expect(result).toBe(`${text}\n\n${START}\nhello\n${END}\n`);
  });

  it("round-trips through extractMarkedRegion", () => {
    const result = upsertMarkedRegion("# Doc", START, END, "round trip body");
    expect(extractMarkedRegion(result, START, END)).toBe("round trip body");
  });
});
