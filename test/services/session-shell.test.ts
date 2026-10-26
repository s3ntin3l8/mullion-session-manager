import { describe, it, expect } from "vitest";
import path from "node:path";
import { findGitBash, sessionShell, sessionShellOrNull } from "../../src/services/session-shell.js";

// Issue #1728 — the session shell: $SHELL off Windows (unchanged), Git Bash
// on Windows. Everything here takes the env, the platform and an `exists`
// stand-in explicitly, so the Windows rules are exercised on any host.

const win = path.win32;
const existsAmong =
  (...paths: string[]) =>
  (p: string) =>
    paths.map((q) => q.toLowerCase()).includes(p.toLowerCase());

describe("sessionShell off Windows", () => {
  it.each(["linux", "darwin"] as const)("is $SHELL on %s", (platform) => {
    expect(sessionShell({ SHELL: "/bin/zsh" }, platform)).toBe("/bin/zsh");
  });

  it("falls back to /bin/bash when $SHELL is unset or empty", () => {
    expect(sessionShell({}, "linux")).toBe("/bin/bash");
    expect(sessionShell({ SHELL: "" }, "darwin")).toBe("/bin/bash");
  });
});

describe("sessionShell on Windows (Git Bash)", () => {
  const programFilesBash = "C:\\Program Files\\Git\\bin\\bash.exe";

  it("prefers CLAUDE_CODE_GIT_BASH_PATH — Claude Code's own setting", () => {
    const custom = "D:\\tools\\git\\bin\\bash.exe";
    const env = { CLAUDE_CODE_GIT_BASH_PATH: custom, ProgramFiles: "C:\\Program Files" };
    expect(sessionShell(env, "win32", existsAmong(custom, programFilesBash))).toBe(custom);
  });

  it("takes $SHELL only when it is a real Windows path that exists", () => {
    const shell = "C:\\msys64\\usr\\bin\\bash.exe";
    expect(sessionShell({ SHELL: shell }, "win32", existsAmong(shell))).toBe(shell);
  });

  it("ignores an MSYS-style $SHELL (what Git Bash exports), which Windows cannot spawn", () => {
    const env = { SHELL: "/usr/bin/bash", ProgramFiles: "C:\\Program Files" };
    // Even if something answers for the MSYS path, it is not used.
    expect(sessionShell(env, "win32", existsAmong("/usr/bin/bash", programFilesBash))).toBe(
      programFilesBash,
    );
  });

  it("ignores a configured shell that is not a bash — it could not run the session", () => {
    const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    const env = { SHELL: pwsh, CLAUDE_CODE_GIT_BASH_PATH: pwsh, ProgramFiles: "C:\\Program Files" };
    expect(sessionShell(env, "win32", existsAmong(pwsh, programFilesBash))).toBe(programFilesBash);
  });

  it("ignores a configured path that does not exist", () => {
    const env = {
      CLAUDE_CODE_GIT_BASH_PATH: "C:\\gone\\bash.exe",
      ProgramFiles: "C:\\Program Files",
    };
    expect(sessionShell(env, "win32", existsAmong(programFilesBash))).toBe(programFilesBash);
  });

  it.each([
    ["ProgramFiles", "C:\\Program Files"],
    ["ProgramW6432", "C:\\Program Files"],
    ["ProgramFiles(x86)", "C:\\Program Files (x86)"],
  ])("finds the standard install under %s", (key, root) => {
    const bash = win.join(root, "Git", "bin", "bash.exe");
    expect(sessionShell({ [key]: root }, "win32", existsAmong(bash))).toBe(bash);
  });

  it("finds a per-user install under LOCALAPPDATA\\Programs", () => {
    const bash = "C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe";
    const env = { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" };
    expect(sessionShell(env, "win32", existsAmong(bash))).toBe(bash);
  });

  it.each([
    ["the installer's cmd dir", "E:\\Git\\cmd"],
    ["a bin dir", "E:\\Git\\bin"],
    ["mingw64\\bin", "E:\\Git\\mingw64\\bin"],
  ])("finds bash next to the git on PATH (%s)", (_label, gitDir) => {
    const bash = "E:\\Git\\bin\\bash.exe";
    const env = { Path: `C:\\Windows;;${gitDir};C:\\other` };
    expect(sessionShell(env, "win32", existsAmong(win.join(gitDir, "git.exe"), bash))).toBe(bash);
  });

  it("also reads PATH when Windows spells it upper-case", () => {
    const bash = "E:\\Git\\bin\\bash.exe";
    expect(
      sessionShell({ PATH: "E:\\Git\\cmd" }, "win32", existsAmong("E:\\Git\\cmd\\git.exe", bash)),
    ).toBe(bash);
  });

  it("reads a quoted PATH entry", () => {
    const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
    const env = { Path: 'C:\\Windows; "C:\\Program Files\\Git\\cmd" ;C:\\other' };
    expect(
      sessionShell(env, "win32", existsAmong("C:\\Program Files\\Git\\cmd\\git.exe", bash)),
    ).toBe(bash);
  });

  it("skips a git on PATH that has no bash beside it", () => {
    const env = { Path: "E:\\portable-git\\cmd" };
    expect(findGitBash(env, existsAmong("E:\\portable-git\\cmd\\git.exe"))).toBeNull();
  });

  it("fails with what to do when there is no Git Bash at all", () => {
    expect(() => sessionShell({}, "win32", () => false)).toThrow(
      /install Git for Windows.*CLAUDE_CODE_GIT_BASH_PATH/s,
    );
  });
});

describe("sessionShellOrNull", () => {
  it("is the shell when there is one", () => {
    expect(sessionShellOrNull({ SHELL: "/bin/zsh" }, "linux")).toBe("/bin/zsh");
  });

  it("is null, not a throw, on a Windows host with no Git Bash", () => {
    expect(sessionShellOrNull({}, "win32", () => false)).toBeNull();
  });

  it("lets any other failure through instead of reading it as 'no shell'", () => {
    const failing = () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    expect(() =>
      sessionShellOrNull({ ProgramFiles: "C:\\Program Files" }, "win32", failing),
    ).toThrow("EACCES");
  });
});
