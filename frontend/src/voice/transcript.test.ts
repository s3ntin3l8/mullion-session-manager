import { describe, it, expect } from "vitest";
import { formatForInsert, formatForPaste } from "./transcript.js";

describe("formatForInsert", () => {
  it("joins multiple segments with a single space", () => {
    expect(formatForInsert(["Add a test", "for the parser"])).toBe("Add a test for the parser");
  });

  it("trims each segment and drops empty ones", () => {
    expect(formatForInsert(["  hello  ", "", "   ", "world"])).toBe("hello world");
  });

  it("collapses internal whitespace runs to a single space", () => {
    expect(formatForInsert(["hello    world"])).toBe("hello world");
  });

  it("strips embedded newlines instead of letting them submit the prompt", () => {
    expect(formatForInsert(["line one\nline two", "line three\r\nline four"])).toBe(
      "line one line two line three line four",
    );
  });

  it("returns an empty string, not a space, for an empty buffer", () => {
    expect(formatForInsert([])).toBe("");
    expect(formatForInsert(["", "   "])).toBe("");
  });

  it("returns a single segment unchanged (trimmed)", () => {
    expect(formatForInsert(["  fix the bug  "])).toBe("fix the bug");
  });
});

describe("formatForPaste", () => {
  it("appends exactly one trailing space to non-empty text", () => {
    expect(formatForPaste(["hello", "world"])).toBe("hello world ");
  });

  it("returns an empty string (no trailing space) for an empty buffer", () => {
    expect(formatForPaste([])).toBe("");
    expect(formatForPaste(["", "  "])).toBe("");
  });
});
