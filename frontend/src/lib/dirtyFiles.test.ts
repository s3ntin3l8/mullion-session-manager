// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { hasDirtyFileUnder, setFileDirty, useDirtyFilesVersion } from "./dirtyFiles.js";

afterEach(() => {
  for (const [p, s, path] of [
    [1, undefined, "a.ts"],
    [1, 5, "a.ts"],
    [1, undefined, "src/a.ts"],
  ] as const) {
    setFileDirty(p, s, path, false);
  }
});

describe("dirtyFiles", () => {
  it("tracks a file, a folder above it, and keeps checkouts apart", () => {
    setFileDirty(1, undefined, "src/a.ts", true);
    expect(hasDirtyFileUnder(1, undefined, "src/a.ts")).toBe(true);
    expect(hasDirtyFileUnder(1, undefined, "src")).toBe(true);
    expect(hasDirtyFileUnder(1, undefined, "")).toBe(false); // the root isn't a path key
    expect(hasDirtyFileUnder(1, undefined, "sr")).toBe(false);
    expect(hasDirtyFileUnder(1, undefined, "src/a.ts/x")).toBe(false);
    expect(hasDirtyFileUnder(1, 5, "src")).toBe(false); // the worktree's own tree
    expect(hasDirtyFileUnder(2, undefined, "src")).toBe(false); // another project
    setFileDirty(1, undefined, "src/a.ts", false);
    expect(hasDirtyFileUnder(1, undefined, "src")).toBe(false);
  });

  it("only notifies on a real change", () => {
    const { result } = renderHook(() => useDirtyFilesVersion());
    const v0 = result.current;
    act(() => setFileDirty(1, undefined, "a.ts", true));
    expect(result.current).toBe(v0 + 1);
    act(() => setFileDirty(1, undefined, "a.ts", true)); // no change
    expect(result.current).toBe(v0 + 1);
    act(() => setFileDirty(1, undefined, "a.ts", false));
    expect(result.current).toBe(v0 + 2);
    act(() => setFileDirty(1, undefined, "a.ts", false)); // no change
    expect(result.current).toBe(v0 + 2);
  });
});
