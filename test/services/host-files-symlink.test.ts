import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as Fs from "node:fs";

// Issue #1728 — createSymlink() turns Windows' bare EPERM (no Developer Mode,
// not an administrator) into an error that says what to do, and changes
// nothing anywhere else. symlinkSync is mocked so the Windows refusal can be
// produced on any host.

let symlinkError: NodeJS.ErrnoException | null = null;
const symlinkCalls: Array<[string, string]> = [];

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  return {
    ...actual,
    symlinkSync: (target: string, linkPath: string) => {
      symlinkCalls.push([target, linkPath]);
      if (symlinkError) throw symlinkError;
    },
  };
});

const { createSymlink, sameSymlinkTarget } = await import("../../src/services/host-files.js");

const errno = (code: string) => Object.assign(new Error(code), { code });

beforeEach(() => {
  symlinkError = null;
  symlinkCalls.length = 0;
});

describe("createSymlink", () => {
  it("creates the symlink with the target verbatim", () => {
    createSymlink("../shared/SKILL.md", "/repo/.claude/skills/x/SKILL.md", "linux");
    expect(symlinkCalls).toEqual([["../shared/SKILL.md", "/repo/.claude/skills/x/SKILL.md"]]);
  });

  it("explains Windows' EPERM: Developer Mode or an administrator", () => {
    symlinkError = errno("EPERM");
    expect(() => createSymlink("a", "C:\\repo\\b", "win32")).toThrow(
      /C:\\repo\\b.*Developer Mode.*administrator/s,
    );
  });

  it("keeps the original error as the cause", () => {
    symlinkError = errno("EPERM");
    try {
      createSymlink("a", "b", "win32");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).cause).toBe(symlinkError);
    }
  });

  it("rethrows any other error unchanged — and EPERM elsewhere too", () => {
    symlinkError = errno("EEXIST");
    expect(() => createSymlink("a", "b", "win32")).toThrow(symlinkError);
    symlinkError = errno("EPERM");
    expect(() => createSymlink("a", "b", "linux")).toThrow(symlinkError);
  });
});

describe("sameSymlinkTarget", () => {
  it("compares exactly off Windows", () => {
    expect(sameSymlinkTarget("../a/b", "../a/b", "linux")).toBe(true);
    expect(sameSymlinkTarget("..\\a\\b", "../a/b", "linux")).toBe(false);
  });

  it("treats both separators as the same on Windows, where Node stores backslashes", () => {
    expect(sameSymlinkTarget("..\\shared\\SKILL.md", "../shared/SKILL.md", "win32")).toBe(true);
    expect(sameSymlinkTarget("..\\other\\SKILL.md", "../shared/SKILL.md", "win32")).toBe(false);
  });
});
