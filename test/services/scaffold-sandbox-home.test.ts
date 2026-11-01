import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitEnv } from "../../src/services/git-env.js";
import { homeMaskArgs } from "../../src/services/scaffold-sandbox-home.js";
import { wrapWithSandbox } from "../../src/services/scaffold-generate.js";

function bwrapUsable(): boolean {
  const r = spawnSync("bwrap", ["--ro-bind", "/", "/", "--tmpfs", os.tmpdir(), "/bin/true"], {
    stdio: "ignore",
  });
  return r.status === 0;
}
const describeIfBwrap = bwrapUsable() ? describe : describe.skip;

function exe(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
}

describe("homeMaskArgs", () => {
  let home: string;
  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mask-home-")));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it("masks HOME and, without an agent, binds nothing back", () => {
    expect(homeMaskArgs({ home })).toEqual(["--tmpfs", home]);
  });

  it("does nothing for an unresolvable HOME or the filesystem root", () => {
    expect(homeMaskArgs({ home: path.join(home, "missing") })).toEqual([]);
    expect(homeMaskArgs({ home: "/" })).toEqual([]);
  });

  it("re-binds an nvm-style prefix once, and the agent's symlink target", () => {
    exe(path.join(home, "nvm", "bin", "node"));
    exe(path.join(home, "nvm", "lib", "node_modules", "pkg", "bin", "tool.js"));
    fs.symlinkSync(
      path.join(home, "nvm", "lib", "node_modules", "pkg", "bin", "tool.js"),
      path.join(home, "nvm", "bin", "tool"),
    );
    const args = homeMaskArgs({
      home,
      agentCommand: "tool",
      pathEnv: path.join(home, "nvm", "bin"),
    });
    expect(args).toEqual([
      "--tmpfs",
      home,
      "--ro-bind-try",
      path.join(home, "nvm"),
      path.join(home, "nvm"),
    ]);
  });

  it("binds nothing for an agent and node that live outside HOME", () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mask-out-")));
    try {
      exe(path.join(outside, "bin", "node"));
      exe(path.join(outside, "bin", "tool"));
      // `outside` is a sibling of `home`, not inside it.
      expect(
        homeMaskArgs({ home, agentCommand: "tool", pathEnv: path.join(outside, "bin") }),
      ).toEqual(["--tmpfs", home]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("re-binds the common git dir a linked worktree points at", () => {
    const wt = path.join(home, "wt");
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${home}/repo/.git/worktrees/w\n`);
    fs.mkdirSync(path.join(home, "repo", ".git", "worktrees", "w"), { recursive: true });
    expect(homeMaskArgs({ home, worktreePath: wt })).toEqual([
      "--tmpfs",
      home,
      "--ro-bind-try",
      path.join(home, "repo", ".git"),
      path.join(home, "repo", ".git"),
    ]);
  });
});

describeIfBwrap("a sandboxed turn with HOME masked (real bwrap)", () => {
  let home: string;
  let wt: string;
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mask-home-live-")));
    fs.mkdirSync(path.join(home, ".ssh"));
    fs.writeFileSync(path.join(home, ".ssh", "id_secret"), "TOP-SECRET");
    const repo = path.join(home, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "init", "--no-verify"]);
    wt = path.join(home, "scratch-wt");
    git(repo, ["worktree", "add", "-b", "scratch", wt]);
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const run = (script: string) => {
    const { bin, args } = wrapWithSandbox(
      "/bin/sh",
      ["-c", script],
      wt,
      [],
      undefined,
      homeMaskArgs({ home, worktreePath: wt }),
    );
    return spawnSync(bin, args, { encoding: "utf8" });
  };

  it("cannot read a file under the real HOME", () => {
    const r = run(`cat ${home}/.ssh/id_secret`);
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("TOP-SECRET");
  });

  it("still reads and writes the scratch worktree under HOME, and runs git there", () => {
    const r = run(`cat ${wt}/a.txt && echo x > ${wt}/new.txt && git -C ${wt} log -1 --format=%s`);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("hello");
    expect(r.stdout).toContain("init");
  });
});
