import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";

// B9 — runGitFetch was the one git helper in this repo's sibling group
// (git-status.ts, git-refs.ts, git-worktree.ts, git-branch-delete.ts,
// git-ignore.ts, git-remote.ts) with no isSafeAbsolutePath guard before ever
// reaching a `git -C <cwd>` spawn. child_process is mocked so an unsafe-path
// rejection can be asserted as "no subprocess was ever spawned", not just
// "the returned result looked right" — same mocking shape as
// agent-detect.test.ts.

let spawnCalls: unknown[][] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((...args: unknown[]) => {
      spawnCalls.push(args);
      const child = new EventEmitter();
      setImmediate(() => child.emit("close", 0));
      return child;
    }),
  };
});

const { runGitFetch } = await import("../../src/services/git-fetch.js");

describe("runGitFetch", () => {
  it("rejects a relative cwd before any subprocess spawns", async () => {
    spawnCalls = [];
    const result = await runGitFetch("relative/path");
    expect(result).toEqual({
      success: false,
      error: "cwd must be an absolute path with no '..' segments",
    });
    expect(spawnCalls).toHaveLength(0);
  });

  it("spawns git fetch for a safe absolute cwd and reports success on a clean exit", async () => {
    spawnCalls = [];
    const result = await runGitFetch("/home/user/project");
    expect(result).toEqual({ success: true });
    expect(spawnCalls).toHaveLength(1);
    const [file, args] = spawnCalls[0] as [string, string[]];
    expect(file).toBe("git");
    expect(args).toEqual(["-C", "/home/user/project", "fetch", "--quiet", "--prune"]);
  });
});
