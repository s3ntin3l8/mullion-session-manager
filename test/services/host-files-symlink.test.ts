import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as Fs from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Issue #1728 — createSymlink() turns Windows' bare EPERM (no Developer Mode,
// not an administrator) into an error that says what to do, and changes
// nothing anywhere else. symlinkSync is mocked so the Windows refusal can be
// produced on any host.

let symlinkError: NodeJS.ErrnoException | null = null;
const symlinkCalls: Array<[string, string]> = [];
/** What readlinkSync reports for an existing link; null = the real call. */
let readlinkResult: string | null = null;
const rmCalls: string[] = [];

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  return {
    ...actual,
    symlinkSync: (target: string, linkPath: string) => {
      symlinkCalls.push([target, linkPath]);
      if (symlinkError) throw symlinkError;
    },
    readlinkSync: (...args: Parameters<typeof actual.readlinkSync>) =>
      readlinkResult ?? actual.readlinkSync(...args),
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      rmCalls.push(String(args[0]));
      return actual.rmSync(...args);
    },
  };
});

const { createSymlink, sameSymlinkTarget, writeEntriesLocally } =
  await import("../../src/services/host-files.js");

const errno = (code: string) => Object.assign(new Error(code), { code });

beforeEach(() => {
  symlinkError = null;
  symlinkCalls.length = 0;
  readlinkResult = null;
  rmCalls.length = 0;
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

describe("writeEntriesLocally — an already-correct link is left alone", () => {
  const entry = {
    path: ".claude/skills/x/SKILL.md",
    kind: "symlink" as const,
    target: "../../../shared/SKILL.md",
  };

  function withPlatform(platform: NodeJS.Platform, fn: () => void) {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    try {
      fn();
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  }

  it("on Windows, where the link reads back with backslashes, nothing is removed or recreated", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "host-files-symlink-"));
    try {
      // How Node on Windows reports the link it wrote for `entry.target`.
      readlinkResult = "..\\..\\..\\shared\\SKILL.md";
      withPlatform("win32", () => writeEntriesLocally(cwd, [entry]));
      expect(symlinkCalls).toEqual([]);
      expect(rmCalls).toEqual([]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("off Windows the same backslash form is a different link, so it is replaced", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "host-files-symlink-"));
    try {
      readlinkResult = "..\\..\\..\\shared\\SKILL.md";
      withPlatform("linux", () => writeEntriesLocally(cwd, [entry]));
      expect(symlinkCalls).toHaveLength(1);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
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
