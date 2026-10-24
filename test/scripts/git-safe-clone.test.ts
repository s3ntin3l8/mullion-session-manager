import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitEnv } from "../../src/services/git-env.js";

const script = path.resolve(__dirname, "../../scripts/git-safe-clone.mjs");

// The script writes to the clone's OWN git config, so every test runs it
// against a throwaway repo — never this checkout's .git.
let repo: string;

const run = (cwd: string) => spawnSync("node", [script], { cwd, encoding: "utf8", env: gitEnv() });

const git = (args: string[], cwd = repo) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv() }).trim();

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "git-safe-clone-"));
  execFileSync("git", ["init", "-q", repo], { env: gitEnv() });
});
afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("git-safe-clone.mjs", () => {
  it("sets gc.auto to 0 in the clone's own config", () => {
    const result = run(repo);
    expect(result.status).toBe(0);
    expect(git(["config", "--local", "--get", "gc.auto"])).toBe("0");
  });

  it("is idempotent — a second run changes nothing and still succeeds", () => {
    expect(run(repo).status).toBe(0);
    const second = run(repo);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("already 0");
    expect(git(["config", "--local", "--get", "gc.auto"])).toBe("0");
  });

  // A linked worktree shares one git dir with the clone it came from, so the
  // setting has to land in the SHARED config — otherwise every worktree of
  // the clone would need its own, and a hand-made worktree would have none.
  it("writes the shared config when run from a linked worktree", () => {
    const worktree = path.join(repo, "..", path.basename(repo) + "-wt");
    try {
      git(["worktree", "add", "-q", worktree, "-b", "side"]);
      const result = run(worktree);
      expect(result.status).toBe(0);
      // The MAIN clone's config carries it — that is the shared one.
      expect(git(["config", "--local", "--get", "gc.auto"])).toBe("0");
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true });
    }
  });

  it("refuses, with a clear message, outside a git checkout", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
    try {
      const result = run(outside);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("not inside a git checkout");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not touch the global config — the safety is this clone's alone", () => {
    // Point HOME at a throwaway global config with a sentinel value. If the
    // script wrote globally, the sentinel would be overwritten; if it only
    // writes the clone's own config, the sentinel survives untouched.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "git-safe-home-"));
    try {
      fs.writeFileSync(path.join(home, ".gitconfig"), "[gc]\n\tauto = 42\n");
      const result = spawnSync("node", [script], {
        cwd: repo,
        encoding: "utf8",
        env: { ...gitEnv(), HOME: home },
      });
      expect(result.status).toBe(0);
      const global = spawnSync("git", ["config", "--global", "--get", "gc.auto"], {
        encoding: "utf8",
        env: { ...gitEnv(), HOME: home },
      });
      expect(global.stdout.trim()).toBe("42");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
