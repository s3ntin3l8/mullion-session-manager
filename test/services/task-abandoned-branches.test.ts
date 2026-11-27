// Issue #3229 — a "Start fresh" retry collides with the branch it abandoned.
//
// The unit-level half of the issue: the branch-name derivation that keeps a
// new claim off the abandoned branch's name, the record of what a "Start
// fresh" abandoned, and the orphan-clear's refusal to delete a branch the
// task row records as abandoned.
//
// The end-to-end half (the real route, the real dispatch tick, a real
// repository) is test/routes/tasks-start-fresh-branch.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import {
  clearOrphanedTaskWorktree,
  createWorktree,
  deriveTaskBranchName,
  deriveWorktreePath,
} from "../../src/services/git-worktree.js";
import {
  abandonedBranchNames,
  abandonedBranchesOf,
  parseAbandonedBranches,
  serializeAbandonedBranches,
} from "../../src/services/task-abandoned-branches.js";
import { gitEnv } from "../../src/services/git-env.js";
import { RemoteHostClient } from "../../src/services/remote-host-client.js";
import * as remoteHostClientModule from "../../src/services/remote-host-client.js";
import { resolveBackend } from "../../src/services/session-backend.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv() });
}

function initRepo(cwd: string): void {
  git(cwd, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "a");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", "initial", "--no-verify"]);
}

function branchExists(cwd: string, branch: string): boolean {
  try {
    git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

describe("deriveTaskBranchName and the branches a task abandoned (#3229)", () => {
  it("keeps the plain name when nothing was abandoned", () => {
    expect(deriveTaskBranchName({ id: 7, title: "Add dark mode" })).toBe(
      "mullion/task-7-Add-dark-mode",
    );
    expect(
      deriveTaskBranchName({ id: 7, title: "Add dark mode" }, { avoid: ["mullion/task-8-x"] }),
    ).toBe("mullion/task-7-Add-dark-mode");
  });

  it("gives a claim of its own a name when the plain one was abandoned", () => {
    expect(
      deriveTaskBranchName(
        { id: 7, title: "Add dark mode" },
        { avoid: ["mullion/task-7-Add-dark-mode"] },
      ),
    ).toBe("mullion/task-7-Add-dark-mode-attempt-2");
  });

  it("keeps handing out fresh names when several were abandoned", () => {
    expect(
      deriveTaskBranchName(
        { id: 7, title: "Add dark mode" },
        { avoid: ["mullion/task-7-Add-dark-mode", "mullion/task-7-Add-dark-mode-attempt-2"] },
      ),
    ).toBe("mullion/task-7-Add-dark-mode-attempt-3");
  });

  it("records and reads back what was abandoned, host included", () => {
    const serialized = serializeAbandonedBranches([
      { hostId: "macbook", branch: "mullion/task-7-Add-dark-mode" },
      { hostId: null, branch: "mullion/task-7-Add-dark-mode-attempt-2" },
    ]);
    const parsed = parseAbandonedBranches(serialized);
    expect(parsed).toEqual([
      { hostId: "macbook", branch: "mullion/task-7-Add-dark-mode" },
      { hostId: null, branch: "mullion/task-7-Add-dark-mode-attempt-2" },
    ]);
    expect(abandonedBranchNames(parsed)).toEqual([
      "mullion/task-7-Add-dark-mode",
      "mullion/task-7-Add-dark-mode-attempt-2",
    ]);
    expect(abandonedBranchesOf({ abandonedBranches: serialized })).toHaveLength(2);
  });

  it("reads a malformed column as nothing abandoned, never as a crash", () => {
    expect(parseAbandonedBranches(null)).toEqual([]);
    expect(parseAbandonedBranches("")).toEqual([]);
    expect(parseAbandonedBranches("not json")).toEqual([]);
    expect(parseAbandonedBranches('{"branch":"x"}')).toEqual([]);
    expect(parseAbandonedBranches('[{"hostId":1}]')).toEqual([]);
    expect(parseAbandonedBranches('[{"branch":"x"}]')).toEqual([{ hostId: null, branch: "x" }]);
  });
});

describe("clearOrphanedTaskWorktree and an abandoned branch (#3229)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "abandoned-branch-test-"));
    initRepo(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("never deletes a branch the task row records as abandoned", async () => {
    // The abandoned branch, with a commit on it — the only copy of that
    // work.
    const abandoned = "mullion/task-1-add-dark-mode";
    const worktreePath = deriveWorktreePath(tmpDir, abandoned);
    git(tmpDir, ["worktree", "add", "-b", abandoned, worktreePath, "main"]);
    fs.writeFileSync(path.join(worktreePath, "worker.txt"), "work");
    git(worktreePath, ["add", "-A"]);
    git(worktreePath, ["commit", "-m", "worker work", "--no-verify"]);

    const result = await clearOrphanedTaskWorktree(tmpDir, worktreePath, abandoned, {
      abandonedBranchNames: [abandoned],
    });

    // Same posture as a branch outside the closed namespace: never deleted,
    // never blocking.
    expect(result).toEqual({ cleared: true });
    expect(branchExists(tmpDir, abandoned)).toBe(true);
    expect(git(tmpDir, ["log", "-1", "--format=%s", abandoned]).trim()).toBe("worker work");
  });

  it("still deletes an ordinary leftover branch that was not abandoned", async () => {
    const branch = "mullion/task-2-add-dark-mode";
    const worktreePath = deriveWorktreePath(tmpDir, branch);
    const created = await createWorktree({
      cwd: tmpDir,
      baseRef: "main",
      seed: branch,
      branchName: branch,
    });
    expect(created).not.toBeNull();

    const result = await clearOrphanedTaskWorktree(tmpDir, worktreePath, branch, {
      abandonedBranchNames: ["mullion/task-3-something-else"],
    });

    expect(result).toEqual({ cleared: true });
    expect(branchExists(tmpDir, branch)).toBe(false);
  });
});

describe("the remote agent is told which branches are abandoned (#3229)", () => {
  function client() {
    return new RemoteHostClient({
      hostId: "h1",
      baseUrl: "http://example.invalid:1234/",
      token: "tok",
    });
  }

  function jsonResponse(body: unknown) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  it("sends the abandoned names with the clear-orphan request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ cleared: true }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await client().resolveClearOrphanedTaskWorktree("/w", "/w/a", "mullion/task-1-a", [
        "mullion/task-1-a",
      ]);
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(String(init.body));
      expect(body.abandonedBranchNames).toEqual(["mullion/task-1-a"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("omits the field when nothing was abandoned", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ cleared: true }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await client().resolveClearOrphanedTaskWorktree("/w", "/w/a", "mullion/task-1-a");
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(String(init.body));
      expect(body.abandonedBranchNames).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the remote backend hands the abandoned names to the agent (#3229)", () => {
  it("passes them on with the branch it is clearing", async () => {
    const resolveClearOrphanedTaskWorktree = vi.fn().mockResolvedValue({ cleared: true });
    vi.spyOn(remoteHostClientModule, "getRemoteHostClient").mockReturnValue({
      resolveClearOrphanedTaskWorktree,
    } as never);
    try {
      const backend = resolveBackend({} as never, "h1");
      await backend.clearOrphanedTaskWorktree("/w", "/w/a", "mullion/task-1-a", {
        abandonedBranchNames: ["mullion/task-1-a"],
      });
      expect(resolveClearOrphanedTaskWorktree).toHaveBeenCalledWith(
        "/w",
        "/w/a",
        "mullion/task-1-a",
        ["mullion/task-1-a"],
      );
    } finally {
      vi.restoreAllMocks();
    }
  });
});
