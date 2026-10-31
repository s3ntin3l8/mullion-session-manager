import { describe, expect, it } from "vitest";
import { truncateHead, truncateMiddle } from "./truncatePath.js";

describe("truncateHead", () => {
  it("returns the text unchanged when it already fits", () => {
    expect(truncateHead("short", 20)).toBe("short");
  });

  it("returns the text unchanged when it exactly matches max", () => {
    expect(truncateHead("exactly10!", 10)).toBe("exactly10!");
  });

  it("truncates from the head, keeping the distinguishing tail", () => {
    const path =
      "external_directory /home/bjoern/.config/superpowers/worktrees/branchDAM/feat-sync-status-156/*";
    const result = truncateHead(path, 40);
    expect(result.length).toBe(40);
    expect(result.startsWith("…")).toBe(true);
    expect(result.endsWith("feat-sync-status-156/*")).toBe(true);
  });

  it("two paths sharing a long prefix but differing at the tail stay distinguishable after truncation", () => {
    const a = truncateHead(
      "external_directory /home/bjoern/.config/superpowers/worktrees/branchDAM/feat-sync-status-156/*",
      40,
    );
    const b = truncateHead(
      "external_directory /home/bjoern/.config/superpowers/worktrees/branchDAM/feat-exif-xmp-inheritance/*",
      40,
    );
    expect(a).not.toBe(b);
  });

  it("never returns a result longer than max", () => {
    expect(truncateHead("a".repeat(100), 5).length).toBe(5);
  });

  it("handles max of 0 without throwing", () => {
    expect(truncateHead("abc", 0)).toBe("…");
  });

  it("handles empty input", () => {
    expect(truncateHead("", 10)).toBe("");
  });
});

describe("truncateMiddle", () => {
  it("returns the text unchanged when it already fits", () => {
    expect(truncateMiddle("short", 20)).toBe("short");
  });

  it("returns the text unchanged when it exactly matches max", () => {
    expect(truncateMiddle("exactly10!", 10)).toBe("exactly10!");
  });

  it("cuts in the middle, keeping both the start and the distinctive tail", () => {
    const branch = "fix(dock): the dock branch picker runs off-screen and can't be searched";
    const result = truncateMiddle(branch, 30);
    expect(result.length).toBe(30);
    expect(result.startsWith("fix(dock): the ")).toBe(true);
    expect(result.endsWith("be searched")).toBe(true);
    expect(result).toContain("…");
  });

  it("never returns a result longer than max", () => {
    expect(truncateMiddle("a".repeat(100), 5).length).toBe(5);
  });

  it("keeps two branches that share a prefix but differ at the tail distinguishable", () => {
    const a = truncateMiddle("fix(dock): the dock branch picker runs off-screen", 30);
    const b = truncateMiddle("fix(dock): the dock branch picker is searchable now", 30);
    expect(a).not.toBe(b);
  });

  it("handles max of 0 without throwing", () => {
    expect(truncateMiddle("abc", 0)).toBe("…");
  });

  it("handles empty input", () => {
    expect(truncateMiddle("", 10)).toBe("");
  });
});
