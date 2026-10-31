import path from "node:path";
import { describe, expect, it } from "vitest";
import { TRUSTED_SYSTEM_DIRS, pinnedPath } from "./pinned-path.js";

describe("pinnedPath", () => {
  it("puts the shim dirs first, then only the trusted system dirs", () => {
    expect(pinnedPath("/shim-a", "/shim-b").split(path.delimiter)).toEqual([
      "/shim-a",
      "/shim-b",
      ...TRUSTED_SYSTEM_DIRS,
    ]);
  });

  it("ignores the inherited PATH entirely", () => {
    const saved = process.env.PATH;
    process.env.PATH = "/home/x/.shims:/opt/evil";
    try {
      expect(pinnedPath()).not.toContain("/opt/evil");
      expect(pinnedPath()).not.toContain(".shims");
    } finally {
      process.env.PATH = saved;
    }
  });
});
