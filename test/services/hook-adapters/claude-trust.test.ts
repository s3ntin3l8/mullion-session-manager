import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  chmodSync,
  readdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  mergeClaudeTrustedPath,
  resolveClaudeGlobalConfigPath,
} from "../../../src/services/hook-adapters/claude-trust.js";

// Real fs and real git in a temp dir — the behaviour under test is the file
// protocol (parse, lock, atomic rename) and git's worktree→checkout
// resolution, which a mock would only restate. Nothing here can reach the
// real ~/.claude.json: every call passes an explicit config path, and the
// resolver tests stub CLAUDE_CONFIG_DIR/homedir.

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    stdio: "ignore",
  });

let tmp: string;
let configPath: string;
let checkout: string;
let worktree: string;

function readProjects(): Record<string, { hasTrustDialogAccepted?: boolean }> {
  return JSON.parse(readFileSync(configPath, "utf8")).projects;
}

function writeConfig(config: unknown): void {
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "claude-trust-")));
  configPath = path.join(tmp, ".claude.json");
  checkout = path.join(tmp, "checkout");
  mkdirSync(checkout);
  git(checkout, "init", "-q", "-b", "main");
  git(checkout, "commit", "-q", "--allow-empty", "-m", "init");
  worktree = path.join(checkout, ".mullion-worktrees", "wt1");
  git(checkout, "worktree", "add", "-q", worktree, "-b", "wt1");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

describe("mergeClaudeTrustedPath", () => {
  it("trusts the main checkout when the cwd is a worktree, keeping everything else", () => {
    writeConfig({ numStartups: 7, projects: { "/other": { hasTrustDialogAccepted: false } } });

    expect(mergeClaudeTrustedPath(worktree, configPath)).toBe("written");

    const written = JSON.parse(readFileSync(configPath, "utf8"));
    expect(written.numStartups).toBe(7);
    expect(written.projects["/other"]).toEqual({ hasTrustDialogAccepted: false });
    expect(written.projects[checkout]).toEqual({
      allowedTools: [],
      mcpContextUris: [],
      mcpServers: {},
      enabledMcpjsonServers: [],
      disabledMcpjsonServers: [],
      hasTrustDialogAccepted: true,
      hasClaudeMdExternalIncludesApproved: false,
      hasClaudeMdExternalIncludesWarningShown: false,
    });
    // The worktree itself gets no entry of its own.
    expect(written.projects[worktree]).toBeUndefined();
  });

  it("keeps the config's mode and leaves no lock or temp file behind", () => {
    writeConfig({ projects: {} });
    chmodSync(configPath, 0o600);

    mergeClaudeTrustedPath(worktree, configPath);

    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(tmp).filter((f) => f.includes(".lock") || f.includes(".tmp-"))).toEqual([]);
  });

  it("is a no-op when the checkout is already trusted", () => {
    writeConfig({ projects: { [checkout]: { hasTrustDialogAccepted: true } } });
    const before = readFileSync(configPath, "utf8");
    const mtime = statSync(configPath).mtimeMs;

    expect(mergeClaudeTrustedPath(worktree, configPath)).toBe("already-trusted");
    expect(mergeClaudeTrustedPath(checkout, configPath)).toBe("already-trusted");

    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(statSync(configPath).mtimeMs).toBe(mtime);
  });

  it("is idempotent across repeated launches", () => {
    writeConfig({ projects: {} });
    expect(mergeClaudeTrustedPath(worktree, configPath)).toBe("written");
    expect(mergeClaudeTrustedPath(worktree, configPath)).toBe("already-trusted");
    expect(Object.keys(readProjects())).toEqual([checkout]);
  });

  it("flips an existing untrusted entry for the checkout without losing its fields", () => {
    writeConfig({
      projects: { [checkout]: { hasTrustDialogAccepted: false, allowedTools: ["Bash(ls)"] } },
    });

    mergeClaudeTrustedPath(worktree, configPath);

    const entry = JSON.parse(readFileSync(configPath, "utf8")).projects[checkout];
    expect(entry.hasTrustDialogAccepted).toBe(true);
    expect(entry.allowedTools).toEqual(["Bash(ls)"]);
  });

  it("outside a git repo, trusts the cwd itself — unless an ancestor is already trusted", () => {
    const plain = path.join(tmp, "plain", "deep");
    mkdirSync(plain, { recursive: true });
    writeConfig({ projects: {} });
    expect(mergeClaudeTrustedPath(plain, configPath)).toBe("written");
    expect(readProjects()[plain]?.hasTrustDialogAccepted).toBe(true);

    const other = path.join(tmp, "elsewhere", "deep");
    mkdirSync(other, { recursive: true });
    writeConfig({ projects: { [path.join(tmp, "elsewhere")]: { hasTrustDialogAccepted: true } } });
    expect(mergeClaudeTrustedPath(other, configPath)).toBe("already-trusted");
  });

  it("does nothing when Claude has never run on the host (no config file)", () => {
    expect(mergeClaudeTrustedPath(worktree, configPath)).toBe("no-config");
    expect(existsSync(configPath)).toBe(false);
  });

  it("leaves an unparseable or wrong-shaped config untouched, and throws", () => {
    for (const raw of ["{ not json", "[]", '"str"', '{"projects": []}', '{"projects": "x"}']) {
      writeFileSync(configPath, raw);
      expect(() => mergeClaudeTrustedPath(worktree, configPath)).toThrow(/leaving it untouched/);
      expect(readFileSync(configPath, "utf8")).toBe(raw);
    }
  });

  it("gives up without writing while a live process holds the lock", () => {
    writeConfig({ projects: {} });
    const before = readFileSync(configPath, "utf8");
    mkdirSync(`${configPath}.lock`);

    expect(mergeClaudeTrustedPath(worktree, configPath)).toBe("locked");

    expect(readFileSync(configPath, "utf8")).toBe(before);
    // Someone else's lock is never removed by us.
    expect(existsSync(`${configPath}.lock`)).toBe(true);
  });

  it("breaks a stale lock and writes", () => {
    writeConfig({ projects: {} });
    mkdirSync(`${configPath}.lock`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${configPath}.lock`, old, old);

    expect(mergeClaudeTrustedPath(worktree, configPath)).toBe("written");

    expect(readProjects()[checkout]?.hasTrustDialogAccepted).toBe(true);
    expect(existsSync(`${configPath}.lock`)).toBe(false);
  });

  it("writes through a symlinked config instead of replacing the link", () => {
    const real = path.join(tmp, "real-config.json");
    writeFileSync(real, JSON.stringify({ projects: {} }), { mode: 0o600 });
    symlinkSync(real, configPath);

    expect(mergeClaudeTrustedPath(worktree, configPath)).toBe("written");

    expect(statSync(configPath).isFile()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf8")).projects[checkout].hasTrustDialogAccepted).toBe(
      true,
    );
    expect(existsSync(`${real}.lock`)).toBe(false);
  });

  it("releases the lock and removes its temp file when the write fails", () => {
    writeConfig({ projects: {} });
    // A directory where the temp file must go makes the write throw.
    mkdirSync(`${configPath}.tmp-${process.pid}`);

    expect(() => mergeClaudeTrustedPath(worktree, configPath)).toThrow();

    expect(existsSync(`${configPath}.lock`)).toBe(false);
    expect(readProjects()).toEqual({});
  });

  it("replaces a non-object entry for the checkout rather than spreading it", () => {
    writeConfig({ projects: { [checkout]: "oops" } });
    mergeClaudeTrustedPath(worktree, configPath);
    expect(readProjects()[checkout]?.hasTrustDialogAccepted).toBe(true);
  });
});

describe("resolveClaudeGlobalConfigPath", () => {
  it("is <CLAUDE_CONFIG_DIR>/.claude.json when the env var is set", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", tmp);
    expect(resolveClaudeGlobalConfigPath()).toBe(path.join(tmp, ".claude.json"));
  });

  it("is ~/.claude.json when CLAUDE_CONFIG_DIR is unset or empty", () => {
    vi.spyOn(os, "homedir").mockReturnValue(tmp);
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    expect(resolveClaudeGlobalConfigPath()).toBe(path.join(tmp, ".claude.json"));
  });

  it("uses the -custom-oauth file when CLAUDE_CODE_CUSTOM_OAUTH_URL is set", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", tmp);
    vi.stubEnv("CLAUDE_CODE_CUSTOM_OAUTH_URL", "https://auth.example");
    expect(resolveClaudeGlobalConfigPath()).toBe(path.join(tmp, ".claude-custom-oauth.json"));
  });

  it("prefers a non-empty legacy <configDir>/.config.json, but not an empty one", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", tmp);
    writeFileSync(path.join(tmp, ".config.json"), "");
    expect(resolveClaudeGlobalConfigPath()).toBe(path.join(tmp, ".claude.json"));
    writeFileSync(path.join(tmp, ".config.json"), "{}");
    expect(resolveClaudeGlobalConfigPath()).toBe(path.join(tmp, ".config.json"));
  });
});
