import { describe, it, expect } from "vitest";
import { sameCwd } from "./sameCwd.js";

// Issue #1728 — "is this session in a worktree?" on a Windows host, where a
// session's live cwd and the project's stored cwd can differ only in
// spelling.

describe("sameCwd", () => {
  it("compares POSIX paths exactly, as before", () => {
    expect(sameCwd("/home/me/proj", "/home/me/proj")).toBe(true);
    expect(sameCwd("/home/me/Proj", "/home/me/proj")).toBe(false);
    expect(sameCwd("/home/me/proj/", "/home/me/proj")).toBe(false);
  });

  it("compares Windows paths case-insensitively", () => {
    expect(sameCwd("C:\\Users\\Me\\Proj", "c:\\users\\me\\proj")).toBe(true);
  });

  it("treats either separator, and a trailing one, as the same Windows path", () => {
    expect(sameCwd("C:/Users/me/proj/", "C:\\Users\\me\\proj")).toBe(true);
  });

  it("still tells two different Windows directories apart", () => {
    expect(sameCwd("C:\\proj\\.mullion-worktrees\\feat", "C:\\proj")).toBe(false);
    expect(sameCwd("D:\\proj", "C:\\proj")).toBe(false);
  });

  it("never matches a Windows path against a POSIX one", () => {
    expect(sameCwd("C:\\proj", "/c/proj")).toBe(false);
  });

  it("matches absent against absent only", () => {
    expect(sameCwd(undefined, undefined)).toBe(true);
    expect(sameCwd(null, undefined)).toBe(false);
    expect(sameCwd("C:\\proj", undefined)).toBe(false);
  });
});
