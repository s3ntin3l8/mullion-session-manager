// Issue #2160 — scripts/portable.sh's directory-link helpers (make_dir_link,
// replace_symlink, remove_dir_link, native_path), which the installer and the
// updater use for the `current` link. On Linux and macOS they are `ln -s` and
// friends; on Windows (Git Bash) `current` is a directory JUNCTION, because a
// real symlink needs Developer Mode or administrator rights and Git Bash's
// `ln -s` silently makes a copy without them. This suite runs the real
// helpers on whichever platform it is on — so on Windows CI it is the
// junction code that is exercised, and the property that matters most is
// checked: removing the link never touches what it points at.
import { describe, it, expect, afterEach } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { sessionShellOrNull } from "../../src/services/session-shell.js";

const run = promisify(execFile);
const PORTABLE = fileURLToPath(new URL("../../scripts/portable.sh", import.meta.url));
// On Windows `bash` on PATH may be WSL's; the Git Bash Mullion itself uses is
// the one under test.
const BASH = process.platform === "win32" ? sessionShellOrNull() : "bash";

/** Runs `body` in bash with portable.sh sourced; the helper paths are passed as $1..$n. */
async function bash(body: string, ...args: string[]): Promise<string> {
  // Forward slashes: Git Bash takes a Windows path in that spelling as it is.
  const fwd = (a: string) => (process.platform === "win32" ? a.replaceAll("\\", "/") : a);
  const { stdout } = await run(
    BASH!,
    ["-c", `set -euo pipefail; . "$1"; shift; ${body}`, "bash", fwd(PORTABLE), ...args.map(fwd)],
    { timeout: 30_000 },
  );
  return stdout.trim();
}

const tmpDirs: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portable-links-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** releases/<v>/marker.txt for each version, returning the root. */
function releases(...versions: string[]): string {
  const root = tmpRoot();
  for (const v of versions) {
    fs.mkdirSync(path.join(root, "releases", v), { recursive: true });
    fs.writeFileSync(path.join(root, "releases", v, "marker.txt"), v);
  }
  return root;
}

describe.runIf(BASH)("scripts/portable.sh directory links", () => {
  it("make_dir_link makes a link that reads through to the target and reads back as a link", async () => {
    const root = releases("1.0.0");
    const out = await bash(
      'make_dir_link "$1/releases/1.0.0" "$1/current"; cat "$1/current/marker.txt"; echo; [ -L "$1/current" ] && echo is-link',
      root,
    );
    expect(out).toBe("1.0.0\nis-link");
  });

  it("replace_symlink flips the link to the new release and leaves the old one intact", async () => {
    const root = releases("1.0.0", "2.0.0");
    await bash(
      [
        'make_dir_link "$1/releases/1.0.0" "$1/current"',
        'make_dir_link "$1/releases/2.0.0" "$1/current.tmp"',
        'replace_symlink "$1/current.tmp" "$1/current"',
      ].join("; "),
      root,
    );
    expect(fs.readFileSync(path.join(root, "current", "marker.txt"), "utf8")).toBe("2.0.0");
    expect(fs.existsSync(path.join(root, "current.tmp"))).toBe(false);
    // Still a link to 2.0.0, not a copy: the old release is untouched and the
    // new one's files are what `current` shows.
    expect(fs.readFileSync(path.join(root, "releases", "1.0.0", "marker.txt"), "utf8")).toBe(
      "1.0.0",
    );
    expect(fs.readlinkSync(path.join(root, "current"))).toMatch(/2\.0\.0[\\/]?$/);
  });

  it("replace_symlink works when there is no current yet", async () => {
    const root = releases("1.0.0");
    await bash(
      'make_dir_link "$1/releases/1.0.0" "$1/current.tmp"; replace_symlink "$1/current.tmp" "$1/current"',
      root,
    );
    expect(fs.readFileSync(path.join(root, "current", "marker.txt"), "utf8")).toBe("1.0.0");
  });

  it("remove_dir_link removes the link and never what it points at", async () => {
    const root = releases("1.0.0");
    fs.writeFileSync(path.join(root, "releases", "1.0.0", "second.txt"), "kept");
    await bash(
      'make_dir_link "$1/releases/1.0.0" "$1/current"; remove_dir_link "$1/current"',
      root,
    );
    expect(fs.existsSync(path.join(root, "current"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "releases", "1.0.0", "marker.txt"), "utf8")).toBe(
      "1.0.0",
    );
    expect(fs.readFileSync(path.join(root, "releases", "1.0.0", "second.txt"), "utf8")).toBe(
      "kept",
    );
  });

  it("remove_dir_link on a path that is not there is not an error", async () => {
    const root = tmpRoot();
    await bash('remove_dir_link "$1/nothing"', root);
  });

  it.runIf(process.platform === "win32")(
    "on Windows the link is a junction (no Developer Mode needed), and remove_dir_link refuses a real directory",
    async () => {
      const root = releases("1.0.0");
      await bash('make_dir_link "$1/releases/1.0.0" "$1/current"', root);
      // A junction is a reparse point: node reports it as a symlink, a copy would not be one.
      expect(fs.lstatSync(path.join(root, "current")).isSymbolicLink()).toBe(true);
      // A real, non-empty directory is not a link: removing it must fail loudly, not delete it.
      fs.mkdirSync(path.join(root, "real"));
      fs.writeFileSync(path.join(root, "real", "f.txt"), "x");
      await expect(bash('remove_dir_link "$1/real"', root)).rejects.toThrow();
      expect(fs.existsSync(path.join(root, "real", "f.txt"))).toBe(true);
    },
  );

  it("native_path is the identity off Windows and the mixed drive form on it", async () => {
    const root = tmpRoot();
    const out = await bash('native_path "$1"', root);
    if (process.platform === "win32") {
      expect(out).toMatch(/^[A-Za-z]:\//);
      expect(out).not.toContain("\\");
    } else {
      expect(out).toBe(root);
    }
  });

  it("is_windows follows uname", async () => {
    const expected = process.platform === "win32" ? "yes" : "no";
    expect(await bash("if is_windows; then echo yes; else echo no; fi")).toBe(expected);
  });
});
