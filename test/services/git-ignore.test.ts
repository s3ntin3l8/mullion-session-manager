import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { isPathGitIgnored } from "../../src/services/git-ignore.js";
import { gitEnv } from "../../src/services/git-env.js";

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

function initRepo(cwd: string) {
  fs.mkdirSync(cwd, { recursive: true });
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test"]);
}

describe("isPathGitIgnored", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-ignore-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns false for a directory that isn't a git repo", async () => {
    expect(await isPathGitIgnored(tmpDir, "some-file.txt")).toBe(false);
  });

  it("returns true for a path matched by .gitignore, given an absolute path", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "ignored-dir/\n");
    fs.mkdirSync(path.join(tmpDir, "ignored-dir"));
    fs.writeFileSync(path.join(tmpDir, "ignored-dir", "plan.md"), "hi");

    expect(await isPathGitIgnored(tmpDir, path.join(tmpDir, "ignored-dir", "plan.md"))).toBe(true);
  });

  it("returns true for a path matched by .gitignore, given a path relative to root", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "ignored-dir/\n");
    fs.mkdirSync(path.join(tmpDir, "ignored-dir"));
    fs.writeFileSync(path.join(tmpDir, "ignored-dir", "plan.md"), "hi");

    expect(await isPathGitIgnored(tmpDir, "ignored-dir/plan.md")).toBe(true);
  });

  it("returns false for a tracked (non-ignored) file", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "ignored-dir/\n");
    fs.writeFileSync(path.join(tmpDir, "tracked.ts"), "export {}");

    expect(await isPathGitIgnored(tmpDir, path.join(tmpDir, "tracked.ts"))).toBe(false);
  });

  it("returns false for a relative root, even one that would otherwise resolve correctly", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "ignored-dir/\n");
    fs.mkdirSync(path.join(tmpDir, "ignored-dir"));
    fs.writeFileSync(path.join(tmpDir, "ignored-dir", "plan.md"), "hi");

    const relRoot = path.relative(process.cwd(), tmpDir);
    expect(await isPathGitIgnored(relRoot, "ignored-dir/plan.md")).toBe(false);
  });

  it("rejects a relative or path-traversing root, same guard as isGitRepo", async () => {
    initRepo(tmpDir);
    expect(await isPathGitIgnored("relative/path", "x")).toBe(false);
    expect(await isPathGitIgnored(path.join(tmpDir, "..", "escape"), "x")).toBe(false);
  });
});
