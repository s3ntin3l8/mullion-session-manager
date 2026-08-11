import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";

// Same mocking shape as git-fetch.test.ts's own header comment — a mocked
// child_process lets the unsafe-path rejection assert "no subprocess was
// ever spawned", not just "the returned result looked right", and lets a
// non-zero git exit be asserted deterministically without depending on a
// real git binary's failure behavior.

let spawnCalls: unknown[][] = [];
let closeCode = 0;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((...args: unknown[]) => {
      spawnCalls.push(args);
      const child = new EventEmitter();
      setImmediate(() => child.emit("close", closeCode));
      return child;
    }),
  };
});

const { runGitInit } = await import("../../src/services/git-init.js");

describe("runGitInit", () => {
  it("rejects a relative cwd before any subprocess spawns", async () => {
    spawnCalls = [];
    const result = await runGitInit("relative/path");
    expect(result).toEqual({
      success: false,
      error: "cwd must be an absolute path with no '..' segments",
    });
    expect(spawnCalls).toHaveLength(0);
  });

  it("spawns git init --quiet for a safe absolute cwd and reports success on a clean exit", async () => {
    spawnCalls = [];
    closeCode = 0;
    const result = await runGitInit("/home/user/project");
    expect(result).toEqual({ success: true });
    expect(spawnCalls).toHaveLength(1);
    const [file, args] = spawnCalls[0] as [string, string[]];
    expect(file).toBe("git");
    expect(args).toEqual(["-C", "/home/user/project", "init", "--quiet"]);
  });

  it("reports failure (not a throw) on a non-zero git exit", async () => {
    spawnCalls = [];
    closeCode = 128;
    const result = await runGitInit("/home/user/project");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exited with code 128/);
  });
});
