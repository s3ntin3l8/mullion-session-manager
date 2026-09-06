import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  PathEscapeError,
  resolveSymlinkTargetWithin,
  resolveWithin,
} from "../../src/services/safe-path.js";

// mullion-reviewer review, PR #1102 — resolveWithin/resolveSymlinkTargetWithin
// had no dedicated test file of their own, only indirect coverage through
// host-files.test.ts's and project-setup.test.ts's call sites. Both are now
// the shared gate for two wire-reachable handlers (routes/internal.ts's
// /internal/read-files and /internal/write-files), so they get direct
// coverage here too.

describe("resolveWithin", () => {
  const root = "/tmp/mullion-safe-path-root";

  it("resolves a plain relative path inside root", () => {
    expect(resolveWithin(root, "a/b.txt")).toBe(path.join(root, "a", "b.txt"));
  });

  it("resolves root itself", () => {
    expect(resolveWithin(root, ".")).toBe(path.resolve(root));
  });

  it("throws PathEscapeError for a relative traversal outside root", () => {
    expect(() => resolveWithin(root, "../outside")).toThrow(PathEscapeError);
  });

  it("throws PathEscapeError for an absolute path outside root", () => {
    expect(() => resolveWithin(root, "/etc/passwd")).toThrow(PathEscapeError);
  });
});

describe("resolveSymlinkTargetWithin", () => {
  const root = "/tmp/mullion-safe-path-root";

  it("resolves a relative target against the symlink's own directory", () => {
    // Symlink at root/a/b/link, target "../../c" -> root/a/b -> root/c
    const resolved = resolveSymlinkTargetWithin(root, "a/b/link", "../../c");
    expect(resolved).toBe(path.join(root, "c"));
  });

  it("throws PathEscapeError for a relative target that escapes root", () => {
    expect(() => resolveSymlinkTargetWithin(root, "a/b/link", "../../../../etc/passwd")).toThrow(
      PathEscapeError,
    );
  });

  it("throws PathEscapeError for an ABSOLUTE target, never silently mangling it into an in-bounds one", () => {
    // The bug this function exists to fix: path.join("a/b", "/etc/passwd")
    // silently produces "a/b/etc/passwd" (strips the leading slash), which
    // would pass containment while symlinkSync itself still receives the
    // real, unmangled "/etc/passwd". path.resolve correctly resets on an
    // absolute second argument instead, so this must throw.
    expect(() => resolveSymlinkTargetWithin(root, "a/b/link", "/etc/passwd")).toThrow(
      PathEscapeError,
    );
  });

  it("allows an absolute target that happens to already be inside root", () => {
    const resolved = resolveSymlinkTargetWithin(root, "a/b/link", path.join(root, "c"));
    expect(resolved).toBe(path.join(root, "c"));
  });
});
