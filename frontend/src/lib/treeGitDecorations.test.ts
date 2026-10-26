import { describe, it, expect } from "vitest";
import { buildGitDecorations } from "./treeGitDecorations.js";

const files = [
  { path: "README.md", status: "M" as const },
  { path: "src/new.ts", status: "A" as const },
  { path: "src/deep/x/scratch.txt", status: "?" as const },
  { path: "docs/gone.md", status: "D" as const },
  { path: "lib/clash.ts", status: "U" as const },
];

describe("buildGitDecorations", () => {
  const decorate = buildGitDecorations(files);

  it("describes each file by its own status, with a letter and a label", () => {
    expect(decorate("README.md", false)).toMatchObject({
      kind: "modified",
      letter: "M",
      label: "Modified",
    });
    expect(decorate("src/new.ts", false)).toMatchObject({ kind: "added", letter: "A" });
    expect(decorate("src/deep/x/scratch.txt", false)).toMatchObject({
      kind: "untracked",
      letter: "U",
    });
    expect(decorate("docs/gone.md", false)).toMatchObject({ kind: "deleted", letter: "D" });
    expect(decorate("lib/clash.ts", false)).toMatchObject({ kind: "conflict", letter: "!" });
  });

  it("marks every folder above a change, however deep, but not siblings", () => {
    for (const dir of ["src", "src/deep", "src/deep/x", "docs"]) {
      expect(decorate(dir, true), dir).toMatchObject({ kind: "dir", label: "Contains changes" });
    }
    expect(decorate("src/other", true)).toBeNull();
    expect(decorate("srcs", true)).toBeNull();
  });

  it("a conflict below a folder outranks plain changes, in either order", () => {
    expect(decorate("lib", true)).toMatchObject({ kind: "dir-conflict" });
    const both = buildGitDecorations([
      { path: "a/clash.ts", status: "U" },
      { path: "a/plain.ts", status: "M" },
    ]);
    expect(both("a", true)).toMatchObject({ kind: "dir-conflict" });
    const reversed = buildGitDecorations([
      { path: "a/plain.ts", status: "M" },
      { path: "a/clash.ts", status: "U" },
    ]);
    expect(reversed("a", true)).toMatchObject({ kind: "dir-conflict" });
  });

  it("does not decorate a clean file, a file as a folder, or a folder as a file", () => {
    expect(decorate("src/clean.ts", false)).toBeNull();
    expect(decorate("README.md", true)).toBeNull();
    expect(decorate("src", false)).toBeNull();
  });

  it("copes with no status at all, and an unknown code", () => {
    expect(buildGitDecorations(undefined)("a", false)).toBeNull();
    expect(buildGitDecorations(null)("a", true)).toBeNull();
    const odd = buildGitDecorations([{ path: "x", status: "Z" as never }]);
    expect(odd("x", false)).toBeNull();
  });
});
