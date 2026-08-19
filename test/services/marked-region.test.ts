import { describe, it, expect } from "vitest";
import { clampToBytes, extractMarkedRegion } from "../../src/services/marked-region.js";

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
