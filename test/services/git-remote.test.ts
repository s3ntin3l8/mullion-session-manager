import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { parseGitRemote } from "../../src/services/git-remote.js";

function writeGitConfig(cwd: string, body: string) {
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".git", "config"), body);
}

describe("parseGitRemote", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-remote-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses an SSH github.com remote", () => {
    writeGitConfig(tmpDir, '[remote "origin"]\n\turl = git@github.com:owner/repo.git\n');
    expect(parseGitRemote(tmpDir)).toEqual({ owner: "owner", repo: "repo" });
  });

  it("parses an SSH remote with no .git suffix", () => {
    writeGitConfig(tmpDir, '[remote "origin"]\n\turl = git@github.com:owner/repo\n');
    expect(parseGitRemote(tmpDir)).toEqual({ owner: "owner", repo: "repo" });
  });

  it("parses an HTTPS github.com remote", () => {
    writeGitConfig(tmpDir, '[remote "origin"]\n\turl = https://github.com/owner/repo.git\n');
    expect(parseGitRemote(tmpDir)).toEqual({ owner: "owner", repo: "repo" });
  });

  it("parses an HTTPS remote with a user@ prefix (e.g. a PAT-in-URL remote)", () => {
    writeGitConfig(
      tmpDir,
      '[remote "origin"]\n\turl = https://x-access-token@github.com/owner/repo.git\n',
    );
    expect(parseGitRemote(tmpDir)).toEqual({ owner: "owner", repo: "repo" });
  });

  it("parses a config with other sections around the remote", () => {
    writeGitConfig(
      tmpDir,
      '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:owner/repo.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n',
    );
    expect(parseGitRemote(tmpDir)).toEqual({ owner: "owner", repo: "repo" });
  });

  it("returns null for a non-github.com remote (e.g. GitHub Enterprise / GitLab)", () => {
    writeGitConfig(tmpDir, '[remote "origin"]\n\turl = git@gitlab.com:owner/repo.git\n');
    expect(parseGitRemote(tmpDir)).toBeNull();
  });

  it("returns null when there's no origin remote", () => {
    writeGitConfig(tmpDir, "[core]\n\trepositoryformatversion = 0\n");
    expect(parseGitRemote(tmpDir)).toBeNull();
  });

  it("returns null when .git/config doesn't exist", () => {
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    expect(parseGitRemote(tmpDir)).toBeNull();
  });

  it("returns null when cwd isn't a git repo at all", () => {
    expect(parseGitRemote(tmpDir)).toBeNull();
  });

  it("returns null for a relative cwd, even one that would otherwise resolve correctly", () => {
    writeGitConfig(tmpDir, '[remote "origin"]\n\turl = git@github.com:owner/repo.git\n');
    expect(parseGitRemote(path.relative(process.cwd(), tmpDir))).toBeNull();
  });

  it("rejects an owner/repo containing characters outside GitHub's naming charset", () => {
    writeGitConfig(
      tmpDir,
      '[remote "origin"]\n\turl = git@github.com:owner_with_underscore/repo.git\n',
    );
    expect(parseGitRemote(tmpDir)).toBeNull();
  });
});
