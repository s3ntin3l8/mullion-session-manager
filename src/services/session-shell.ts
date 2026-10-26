import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The shell a session runs in, and the one the login-shell probes (agent
 * detection, version checks) ask — the two must be the same shell, or a
 * probe would report a different world than the session sees.
 *
 * **Linux and macOS:** `$SHELL`, falling back to `/bin/bash` — exactly the
 * expression every caller used before this module existed.
 *
 * **Windows (issue #1728): Git Bash.** Sessions run `<shell> -lc <command>`,
 * and everything that composes that command line assumes a POSIX shell: the
 * hook adapters' single-quote escaping, the agy/Codex `sh` forwarder shim,
 * `command -v` agent detection. Git for Windows' `bash.exe` honours all of
 * them unchanged, and Claude Code on Windows already requires it — so it is
 * the session shell there rather than cmd.exe or PowerShell, which would each
 * need their own quoting and shims. Found, in order, at:
 *
 *   1. `CLAUDE_CODE_GIT_BASH_PATH` — Claude Code's own setting for the same
 *      thing, so a user who pointed Claude Code at their Git Bash has
 *      pointed Mullion there too;
 *   2. `$SHELL`, but only when it is a real Windows path to an existing
 *      `bash.exe` — started from Git Bash, `$SHELL` is an MSYS path
 *      (`/usr/bin/bash`) that Windows itself cannot spawn, and a `$SHELL`
 *      naming some other shell (pwsh, cmd, zsh) could not run the POSIX
 *      command line either;
 *   3. the standard Git for Windows install locations;
 *   4. next to the `git` found on `PATH` (`<git>\cmd\git.exe` ->
 *      `<git>\bin\bash.exe`).
 *
 * The two EXPLICIT settings (1, 2) are honoured for any `bash.exe` the user
 * names — an MSYS2 `usr\bin\bash.exe` works too, since `-l` runs its
 * profile. The ones Mullion DISCOVERS (3, 4) pick Git's `bin\bash.exe`, the
 * launcher that sets the MSYS environment up before the profile runs.
 */
export function sessionShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): string {
  if (platform !== "win32") return env.SHELL || "/bin/bash";
  const found = findGitBash(env, exists);
  if (found) return found;
  throw new Error(
    "no Git Bash found: Mullion runs sessions on Windows in Git for Windows' bash.exe — " +
      "install Git for Windows (https://git-scm.com/download/win), or set " +
      "CLAUDE_CODE_GIT_BASH_PATH to the full path of its bin\\bash.exe",
  );
}

/**
 * The session shell, or null where there is none — for the probes, which
 * report "not found" rather than fail when the host cannot run a session.
 */
export function sessionShellOrNull(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): string | null {
  try {
    return sessionShell(env, platform, exists);
  } catch {
    return null;
  }
}

/** Git Bash's `bash.exe`, by the order in sessionShell()'s doc comment. */
export function findGitBash(
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean = existsSync,
): string | null {
  const win = path.win32;
  const usable = (candidate: string | undefined): candidate is string =>
    typeof candidate === "string" &&
    candidate !== "" &&
    win.isAbsolute(candidate) &&
    // An MSYS-style "/usr/bin/bash" is "absolute" to path.win32 too (it is
    // rooted at the current drive), but it is not what it looks like.
    /^[a-zA-Z]:[\\/]|^\\\\/.test(candidate) &&
    exists(candidate);

  // Only a bash can run the session's POSIX command line — a configured
  // pwsh.exe or cmd.exe must not win over a perfectly good Git Bash.
  const isBash = (candidate: string) => /^bash(\.exe)?$/i.test(win.basename(candidate));
  for (const candidate of [env.CLAUDE_CODE_GIT_BASH_PATH, env.SHELL]) {
    if (usable(candidate) && isBash(candidate)) return candidate;
  }

  const installRoots = [
    env.ProgramFiles,
    env.ProgramW6432,
    env["ProgramFiles(x86)"],
    env.LOCALAPPDATA ? win.join(env.LOCALAPPDATA, "Programs") : undefined,
  ];
  for (const root of installRoots) {
    const candidate = root ? win.join(root, "Git", "bin", "bash.exe") : undefined;
    if (usable(candidate)) return candidate;
  }

  // Next to the git on PATH: Git for Windows puts git.exe in <root>\cmd (the
  // installer's default PATH entry), <root>\bin or <root>\mingw64\bin.
  const pathValue = env.Path ?? env.PATH ?? "";
  for (const entry of pathValue.split(";")) {
    // Windows allows a PATH entry in quotes ("C:\Program Files\Git\cmd").
    const dir = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || !usable(win.join(dir, "git.exe"))) continue;
    const parent = win.dirname(dir);
    const root =
      win.basename(dir).toLowerCase() === "bin" && win.basename(parent).toLowerCase() === "mingw64"
        ? win.dirname(parent)
        : parent;
    const candidate = win.join(root, "bin", "bash.exe");
    if (usable(candidate)) return candidate;
  }
  return null;
}
