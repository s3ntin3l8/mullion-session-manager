import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureShellIntegrationFiles,
  applyShellIntegrationEnv,
} from "../../src/services/shell-integration.js";

const tmpDirs: string[] = [];

function mkTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("ensureShellIntegrationFiles", () => {
  it("writes all four zsh startup files under <sessionsDir>/shell-integration/zsh", () => {
    const sessionsDir = mkTmpDir("shell-integration-sessionsdir-");
    const zdotdir = ensureShellIntegrationFiles(sessionsDir);

    expect(zdotdir).toBe(path.join(sessionsDir, "shell-integration", "zsh"));
    for (const file of [".zshenv", ".zprofile", ".zlogin", ".zshrc"]) {
      expect(fs.existsSync(path.join(zdotdir, file))).toBe(true);
    }
  });

  it("has .zshenv/.zprofile/.zlogin source the user's real counterpart via MULLION_USER_ZDOTDIR", () => {
    const sessionsDir = mkTmpDir("shell-integration-source-");
    const zdotdir = ensureShellIntegrationFiles(sessionsDir);

    for (const file of [".zshenv", ".zprofile", ".zlogin"]) {
      const content = fs.readFileSync(path.join(zdotdir, file), "utf8");
      expect(content).toContain(`$MULLION_USER_ZDOTDIR/${file}`);
    }
  });

  it(".zshrc restores ZDOTDIR to the user's real dotfiles dir before sourcing their real .zshrc", () => {
    // Unlike the other three shim files, .zshrc must NOT leave $ZDOTDIR
    // pointed at the shim directory for the rest of the shell's life — a
    // user's real .zshrc (or anything it sources, e.g. "source
    // $ZDOTDIR/plugin.zsh") expects $ZDOTDIR to mean their own dotfiles dir.
    const sessionsDir = mkTmpDir("shell-integration-zshrc-restore-");
    const zdotdir = ensureShellIntegrationFiles(sessionsDir);
    const content = fs.readFileSync(path.join(zdotdir, ".zshrc"), "utf8");

    const restoreLine = 'export ZDOTDIR="$MULLION_USER_ZDOTDIR"';
    const sourceLine = '[ -f "$ZDOTDIR/.zshrc" ] && source "$ZDOTDIR/.zshrc"';
    expect(content).toContain(restoreLine);
    expect(content).toContain(sourceLine);
    // The restore must happen BEFORE the user's real .zshrc is sourced, not
    // after — otherwise their .zshrc would still see the shim directory.
    expect(content.indexOf(restoreLine)).toBeLessThan(content.indexOf(sourceLine));
  });

  it("only appends the OSC 7 hook to .zshrc, not to the other three startup files", () => {
    const sessionsDir = mkTmpDir("shell-integration-hook-scope-");
    const zdotdir = ensureShellIntegrationFiles(sessionsDir);

    expect(fs.readFileSync(path.join(zdotdir, ".zshrc"), "utf8")).toContain("_mullion_osc7_precmd");
    for (const file of [".zshenv", ".zprofile", ".zlogin"]) {
      expect(fs.readFileSync(path.join(zdotdir, file), "utf8")).not.toContain(
        "_mullion_osc7_precmd",
      );
    }
  });

  it("emits an OSC 7 hook using the ST terminator, matching detectCwdChange's grammar", () => {
    const sessionsDir = mkTmpDir("shell-integration-osc7-shape-");
    const zdotdir = ensureShellIntegrationFiles(sessionsDir);

    const zshrc = fs.readFileSync(path.join(zdotdir, ".zshrc"), "utf8");
    expect(zshrc).toContain("\\033]7;file://%s%s\\033\\\\");
  });

  it("is idempotent — overwrites cleanly on a second call rather than duplicating content", () => {
    const sessionsDir = mkTmpDir("shell-integration-idempotent-");
    ensureShellIntegrationFiles(sessionsDir);
    const zdotdir = ensureShellIntegrationFiles(sessionsDir);

    const zshrc = fs.readFileSync(path.join(zdotdir, ".zshrc"), "utf8");
    expect(zshrc.match(/_mullion_osc7_precmd\(\)/g)).toHaveLength(1);
  });
});

describe("applyShellIntegrationEnv", () => {
  it("sets ZDOTDIR to the shim directory and captures HOME as MULLION_USER_ZDOTDIR for zsh", () => {
    const sessionsDir = mkTmpDir("shell-integration-env-zsh-");
    const env: NodeJS.ProcessEnv = { HOME: "/home/user" };

    applyShellIntegrationEnv("/usr/bin/zsh", env, sessionsDir);

    expect(env.MULLION_USER_ZDOTDIR).toBe("/home/user");
    expect(env.ZDOTDIR).toBe(path.join(sessionsDir, "shell-integration", "zsh"));
  });

  it("recognizes a bare shell name, not just an absolute path", () => {
    const sessionsDir = mkTmpDir("shell-integration-env-zsh-bare-");
    const env: NodeJS.ProcessEnv = { HOME: "/home/user" };

    applyShellIntegrationEnv("zsh", env, sessionsDir);

    expect(env.ZDOTDIR).toBe(path.join(sessionsDir, "shell-integration", "zsh"));
  });

  it("preserves the user's own pre-existing ZDOTDIR as MULLION_USER_ZDOTDIR, not just HOME", () => {
    const sessionsDir = mkTmpDir("shell-integration-env-zsh-preexisting-");
    const env: NodeJS.ProcessEnv = { HOME: "/home/user", ZDOTDIR: "/home/user/.config/zsh" };

    applyShellIntegrationEnv("zsh", env, sessionsDir);

    expect(env.MULLION_USER_ZDOTDIR).toBe("/home/user/.config/zsh");
  });

  it("appends the OSC 7 snippet to an existing PROMPT_COMMAND for bash, without clobbering it", () => {
    const sessionsDir = mkTmpDir("shell-integration-env-bash-");
    const env: NodeJS.ProcessEnv = { HOME: "/home/user", PROMPT_COMMAND: "my_existing_hook" };

    applyShellIntegrationEnv("/bin/bash", env, sessionsDir);

    expect(env.PROMPT_COMMAND).toContain("my_existing_hook");
    expect(env.PROMPT_COMMAND).toContain("printf");
    expect(env.PROMPT_COMMAND?.indexOf("my_existing_hook")).toBeLessThan(
      env.PROMPT_COMMAND?.indexOf("printf") ?? -1,
    );
  });

  it("sets PROMPT_COMMAND from scratch for bash when none was set before", () => {
    const sessionsDir = mkTmpDir("shell-integration-env-bash-fresh-");
    const env: NodeJS.ProcessEnv = { HOME: "/home/user" };

    applyShellIntegrationEnv("bash", env, sessionsDir);

    expect(env.PROMPT_COMMAND).toContain("printf");
  });

  it("does not touch env or write any files for a shell it doesn't instrument", () => {
    const sessionsDir = mkTmpDir("shell-integration-env-unknown-");
    const env: NodeJS.ProcessEnv = { HOME: "/home/user" };

    applyShellIntegrationEnv("/usr/bin/fish", env, sessionsDir);

    expect(env.ZDOTDIR).toBeUndefined();
    expect(env.MULLION_USER_ZDOTDIR).toBeUndefined();
    expect(env.PROMPT_COMMAND).toBeUndefined();
    expect(fs.existsSync(path.join(sessionsDir, "shell-integration"))).toBe(false);
  });
});
