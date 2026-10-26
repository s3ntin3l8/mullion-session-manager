import { describe, it, expect } from "vitest";
import { minimalChange } from "./minimalChange.js";

const apply = (before: string, c: { from: number; to: number; insert: string }) =>
  before.slice(0, c.from) + c.insert + before.slice(c.to);

describe("minimalChange", () => {
  it.each([
    ["a middle edit", "hello world", "hello brave world"],
    ["an insert at the start", "abc", "xabc"],
    ["an append", "abc", "abcd"],
    ["a delete", "abcdef", "abef"],
    ["a full replacement", "abc", "xyz"],
    ["into an empty doc", "", "new"],
    ["to an empty doc", "old", ""],
    ["no change", "same", "same"],
    ["a repeated-character edit (prefix and suffix must not overlap)", "aaa", "aa"],
    ["the other way", "aa", "aaa"],
    ["multi-line, one line changed", "a\nb\nc\n", "a\nB!\nc\n"],
  ])("%s round-trips", (_name, before, after) => {
    expect(apply(before, minimalChange(before, after))).toBe(after);
  });

  it("only touches what differs", () => {
    expect(minimalChange("hello world", "hello brave world")).toEqual({
      from: 6,
      to: 6,
      insert: "brave ",
    });
    expect(minimalChange("aaa", "aa")).toEqual({ from: 2, to: 3, insert: "" });
    expect(minimalChange("same", "same")).toEqual({ from: 4, to: 4, insert: "" });
  });
});
