import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitEnv } from "../../src/services/git-env.js";
import { homeMaskArgs, turnEnv } from "../../src/services/scaffold-sandbox-home.js";
import { wrapWithSandbox } from "../../src/services/scaffold-generate.js";

function bwrapUsable(): boolean {
  const r = spawnSync("bwrap", ["--ro-bind", "/", "/", "--tmpfs", os.tmpdir(), "/bin/true"], {
    stdio: "ignore",
  });
  return r.status === 0;
}
const describeIfBwrap = bwrapUsable() ? describe : describe.skip;

/** The `src dest` pairs of the re-binds, in order. */
function binds(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ro-bind-try") out.push(`${args[i + 1]} ${args[i + 2]}`);
  }
  return out;
}

function exe(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
}

describe("turnEnv", () => {
  it("drops the ssh-agent sockets and keeps the rest", () => {
    expect(
      turnEnv({
        SSH_AUTH_SOCK: "/s",
        MULLION_SSH_AUTH_SOCK: "/m",
        PATH: "/bin",
        ANTHROPIC_API_KEY: "k",
      }),
    ).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "k" });
  });
});

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

  const link = (target: string, at: string) => {
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.symlinkSync(target, at);
  };

  it("re-binds a nested nvm-style prefix once (agent and node inside it)", () => {
    const prefix = path.join(home, ".nvm", "versions", "node", "v1");
    exe(path.join(prefix, "bin", "node"));
    exe(path.join(prefix, "lib", "node_modules", "pkg", "bin", "tool.js"));
    link(
      path.join(prefix, "lib", "node_modules", "pkg", "bin", "tool.js"),
      path.join(prefix, "bin", "tool"),
    );
    const args = homeMaskArgs({ home, agentCommand: "tool", pathEnv: path.join(prefix, "bin") });
    // node_modules (the agent's package tree) and the bin entries; the prefix
    // itself is taken for node, which swallows the rest.
    expect(args.slice(0, 2)).toEqual(["--tmpfs", home]);
    expect(binds(args)).toEqual([`${prefix} ${prefix}`]);
  });

  it("does not re-bind a shared root such as ~/.local for a prefix directly under HOME", () => {
    const prefix = path.join(home, ".local");
    exe(path.join(prefix, "bin", "node"));
    exe(path.join(prefix, "share", "opencode", "auth.json"));
    const args = homeMaskArgs({ home, pathEnv: path.join(prefix, "bin"), agentCommand: "node" });
    const b = binds(args).join("\n");
    expect(b).not.toContain(`${prefix} ${prefix}`);
    expect(b).not.toContain(path.join(prefix, "share"));
    expect(b).toContain(path.join(prefix, "bin", "node"));
  });

  it("binds a global node_modules tree whole, so a sibling vendor package comes along", () => {
    const root = path.join(home, ".npm-global");
    exe(path.join(root, "lib", "node_modules", "@o", "codex", "bin", "codex.js"));
    exe(path.join(root, "lib", "node_modules", "@o", "codex-linux", "vendor", "codex"));
    link(
      path.join(root, "lib", "node_modules", "@o", "codex", "bin", "codex.js"),
      path.join(root, "bin", "codex"),
    );
    const args = homeMaskArgs({ home, agentCommand: "codex", pathEnv: path.join(root, "bin") });
    const nm = path.join(root, "lib", "node_modules");
    expect(binds(args)).toContain(`${nm} ${nm}`);
    // the target at the symlink's own path, never the (shared) directory
    expect(binds(args)).toContain(
      `${path.join(nm, "@o", "codex", "bin", "codex.js")} ${path.join(root, "bin", "codex")}`,
    );
    expect(binds(args).join("\n")).not.toContain(`${path.join(root, "bin")} `);
  });

  it("skips a directory or relative PATH entry that merely shares the agent's name", () => {
    fs.mkdirSync(path.join(home, "d", "tool"), { recursive: true });
    exe(path.join(home, "e", "tool"));
    const args = homeMaskArgs({
      home,
      agentCommand: "tool",
      pathEnv: ["rel/bin", path.join(home, "d"), path.join(home, "e")].join(path.delimiter),
    });
    expect(binds(args)).toEqual([
      `${path.join(home, "e", "tool")} ${path.join(home, "e", "tool")}`,
    ]);
  });

  it("binds the target when the exec path is outside HOME but the symlink points into it", () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mask-out-")));
    try {
      exe(path.join(home, ".claude", "local", "claude"));
      link(path.join(home, ".claude", "local", "claude"), path.join(outside, "bin", "claude"));
      const target = path.join(home, ".claude", "local", "claude");
      expect(
        binds(homeMaskArgs({ home, agentCommand: "claude", pathEnv: path.join(outside, "bin") })),
      ).toEqual([`${target} ${target}`]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
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
    fs.writeFileSync(path.join(home, "repo", ".git", "worktrees", "w", "commondir"), "../..\n");
    expect(homeMaskArgs({ home, worktreePath: wt })).toEqual([
      "--tmpfs",
      home,
      "--ro-bind-try",
      path.join(home, "repo", ".git"),
      path.join(home, "repo", ".git"),
    ]);
  });
});

it("falls back to the gitdir itself when there is no commondir (submodule layout)", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mask-sub-")));
  try {
    const wt = path.join(home, "wt");
    fs.mkdirSync(wt);
    fs.mkdirSync(path.join(home, "outer", ".git", "modules", "x"), { recursive: true });
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${home}/outer/.git/modules/x\n`);
    expect(homeMaskArgs({ home, worktreePath: wt })).toContain(
      path.join(home, "outer", ".git", "modules", "x"),
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
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

  it("starts an agent installed under HOME by bare name", () => {
    const bin = path.join(home, "tools", "fakeagent");
    fs.mkdirSync(path.dirname(bin));
    fs.writeFileSync(bin, "#!/bin/sh\necho agent-ok\n", { mode: 0o755 });
    const { bin: b, args } = wrapWithSandbox(
      "fakeagent",
      [],
      wt,
      [],
      undefined,
      homeMaskArgs({
        home,
        agentCommand: "fakeagent",
        worktreePath: wt,
        pathEnv: path.dirname(bin),
      }),
    );
    const r = spawnSync(b, args, {
      encoding: "utf8",
      env: { ...process.env, PATH: path.dirname(bin) + ":" + process.env.PATH },
    });
    expect(r.stdout).toContain("agent-ok");
  });

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
