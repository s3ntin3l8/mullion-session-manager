import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  normalizeGitRemote,
  parseGitRemote,
  readOriginUrl,
} from "../../src/services/git-remote.js";

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

// Issue #2090 — the raw origin and its normal form, used to decide that two
// checkouts on different hosts are the same repository.
describe("readOriginUrl", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-origin-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the raw origin url for any host, not just github.com", () => {
    writeGitConfig(
      tmpDir,
      '[remote "origin"]\n\turl = ssh://git@git.example.org:2222/team/app.git\n',
    );
    expect(readOriginUrl(tmpDir)).toBe("ssh://git@git.example.org:2222/team/app.git");
  });

  it("is null for no origin, no config, an empty url, a relative path or a worktree's .git file", () => {
    expect(readOriginUrl(tmpDir)).toBeNull();
    writeGitConfig(tmpDir, '[remote "upstream"]\n\turl = git@github.com:o/r.git\n');
    expect(readOriginUrl(tmpDir)).toBeNull();
    writeGitConfig(tmpDir, '[remote "origin"]\n\turl = \n');
    expect(readOriginUrl(tmpDir)).toBeNull();
    expect(readOriginUrl("relative/dir")).toBeNull();

    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "git-origin-wt-"));
    fs.writeFileSync(path.join(worktree, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
    try {
      expect(readOriginUrl(worktree)).toBeNull();
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true });
    }
  });
});

describe("normalizeGitRemote", () => {
  it("spells the same repository the same way, whatever the transport", () => {
    const forms = [
      "git@github.com:Owner/Repo.git",
      "git@github.com:owner/repo",
      "https://github.com/owner/repo.git",
      "https://x-access-token:tok@GitHub.com/owner/repo/", // pragma: allowlist secret
      "ssh://git@github.com:22/owner/repo.git/",
      "git://github.com/owner/repo.git",
      "  https://github.com/owner/repo  ",
    ];
    for (const form of forms) expect(normalizeGitRemote(form), form).toBe("github.com/owner/repo");
  });

  it("keeps other hosts and nested paths, and tells different repositories apart", () => {
    expect(normalizeGitRemote("git@gitlab.example.org:group/sub/app.git")).toBe(
      "gitlab.example.org/group/sub/app",
    );
    expect(normalizeGitRemote("https://github.com/owner/repo")).not.toBe(
      normalizeGitRemote("https://github.com/owner/other"),
    );
    expect(normalizeGitRemote("https://github.com/owner/repo")).not.toBe(
      normalizeGitRemote("https://gitlab.com/owner/repo"),
    );
  });

  it("is null for anything that cannot identify a repository on another host", () => {
    for (const bad of [
      "",
      "   ",
      "/srv/git/repo.git",
      "./repo",
      "file:///srv/git/repo.git",
      "C:\\repos\\app",
      "not a url",
      "https://github.com",
      "https://github.com/",
    ]) {
      expect(normalizeGitRemote(bad), bad).toBeNull();
    }
  });
});
