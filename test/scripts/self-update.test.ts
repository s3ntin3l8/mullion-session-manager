// Issue #647 / roadmap 7.8 — scripts/self-update.sh had zero automated
// coverage before this (see the plan's own note: vitest doesn't cover
// shell). Exercises the REAL script end-to-end via execFile, with
// curl/npm/npx/systemctl shimmed on PATH (this suite never downloads
// anything or touches the host's real systemd) but every other command
// — mkdir, tar, sha256sum, the two `node -e` smoke checks, ln/mv, find —
// running for real against real temp directories, the same coverage shape
// the plan's own §5 promises: lock/status/symlink/prune logic and the
// failure paths are real; the *content* of a real npm-ci'd node_modules is
// not (that stays the live-acceptance gate documented in the PR).
//
// Linux-only: sha256sum, GNU `stat -c`, and `mv -T` (all used by the script
// itself) aren't portable to macOS/BSD.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { buildFakeRelease } from "../helpers/fake-release.js";

const execFileAsync = promisify(execFile);

const SELF_UPDATE_SCRIPT = fileURLToPath(new URL("../../scripts/self-update.sh", import.meta.url));

const describeOnLinux = process.platform === "linux" ? describe : describe.skip;

function writeShim(binDir: string, name: string, script: string) {
  const p = path.join(binDir, name);
  fs.writeFileSync(p, script);
  fs.chmodSync(p, 0o755);
}

// curl/npm/npx/systemctl are the only commands this script shells out to
// that would either reach the real network, run a real (slow) install, or
// touch the host's real systemd — every other command it uses (mkdir, tar,
// sha256sum, node, ln, mv, find, rm) runs for real. curl's shim resolves a
// `file://<path>` "URL" by copying that real local file — this test controls
// both the asset/checksum "URLs" it hands the script (bypassing the JSON
// schema the Fastify route separately enforces on `https://github.com/...`,
// same as the script itself never validates them).
function writeShims(binDir: string) {
  writeShim(
    binDir,
    "curl",
    `#!/usr/bin/env bash
set -euo pipefail
output=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then
    output="$arg"
  fi
  prev="$arg"
done
url="\${*: -1}"
src="\${url#file://}"
cp "$src" "$output"
`,
  );
  for (const name of ["npm", "npx"]) {
    writeShim(binDir, name, "#!/usr/bin/env bash\nexit 0\n");
  }
  // The REAL rm, under the shim dir's name: the harness already puts its own
  // bin dir first on the PATH so the commands the script runs resolve there,
  // and `rm` is one of them (the update script removes the update job's plist
  // and prunes old releases). Pointing it at /bin/rm keeps the script's own
  // behaviour — and its assertions — independent of whatever `rm` happens to
  // be on the host's PATH.
  writeShim(binDir, "rm", '#!/usr/bin/env bash\nexec /bin/rm "$@"\n');
  writeShim(
    binDir,
    "systemctl",
    `#!/usr/bin/env bash
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
echo "$*" >> "$DIR/systemctl.log"
exit 0
`,
  );
  // The script's own `export PATH="$(dirname "$NODE_EXEC_PATH"):$PATH"`
  // (needed in production, where systemd's minimal PATH means npm/node
  // aren't reliably on it — see the script's own header comment) would
  // otherwise prepend a real node install's bin/ dir — which, under nvm,
  // ALSO bundles a real npm/npx — ahead of this shim dir, defeating the
  // npm/npx shims above. Copying (not symlinking — a symlinked binary can
  // resolve its own sibling paths differently) the real node binary into
  // this same dir makes dirname(NODE_EXEC_PATH) resolve to binDir itself,
  // so the prepend is a harmless no-op duplicate and the shims stay first.
  fs.copyFileSync(process.execPath, path.join(binDir, "node"));
  fs.chmodSync(path.join(binDir, "node"), 0o755);
}

describeOnLinux("scripts/self-update.sh", () => {
  let mullionHome: string;
  let binDir: string;

  beforeEach(() => {
    mullionHome = fs.mkdtempSync(path.join(os.tmpdir(), "self-update-test-home-"));
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "self-update-test-bin-"));
    writeShims(binDir);
  });

  afterEach(() => {
    fs.rmSync(mullionHome, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  function readStatus(): { phase: string; version?: string; error?: string } {
    return JSON.parse(fs.readFileSync(path.join(mullionHome, ".update-status.json"), "utf8"));
  }

  function readSystemctlLog(): string[] {
    const p = path.join(binDir, "systemctl.log");
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
  }

  function readLaunchctlLog(): string[] {
    const p = path.join(binDir, "launchctl.log");
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
  }

  function runScript(opts: {
    version: string;
    assetUrl: string;
    checksumUrl: string;
    unitName?: string;
    env?: Record<string, string>;
  }) {
    return execFileAsync(
      "bash",
      [
        SELF_UPDATE_SCRIPT,
        opts.version,
        opts.assetUrl,
        opts.checksumUrl,
        mullionHome,
        path.join(binDir, "node"),
        opts.unitName ?? "fake-mullion.service",
      ],
      {
        cwd: mullionHome,
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, ...opts.env },
        timeout: 20_000,
      },
    );
  }

  // The macOS restart (issue #1718): launchctl kickstart replaces
  // systemctl --user restart, and the one-shot update job boots itself out
  // afterwards.
  it("restarts through launchctl on macOS, and never through systemctl", async () => {
    writeShim(
      binDir,
      "launchctl",
      `#!/usr/bin/env bash
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
echo "$*" >> "$DIR/launchctl.log"
# Booting this job out kills the process that ran it — which is exactly why
# the script's own bootout has to be its LAST statement. Modelling that here
# is what keeps the ordering honest: a script that booted itself out early
# would never reach its release prune or its final status write, and this
# shim would kill it where it stood.
case "$*" in
  *bootout*)
    kill -TERM $PPID
    ;;
esac
exit 0
`,
    );
    // The platform detection goes through `uname -s`.
    writeShim(
      binDir,
      "uname",
      `#!/usr/bin/env bash
if [ "$1" = "-s" ]; then echo Darwin; else echo Linux; fi
`,
    );
    const { tarballPath, checksumPath } = await buildFakeRelease("9.9.9");
    // The plist the update job runs from. Nothing in the script CREATES it
    // (the app writes it, when it bootstraps the job), so the "it is gone"
    // assertion below only means something if it exists before the run.
    const plistPath = path.join(mullionHome, "logs", "com.mullion.update-9.9.9.plist");
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, "<plist/>\n");

    // The script's own bootout kills the script (the shim above models
    // launchd's SIGTERM), so it exits on that signal rather than 0 — which is
    // exactly what happens on a real Mac. The assertions below are what
    // matter: the kickstart happened, the bootout happened, the plist is
    // gone, and the run reached "done".
    await runScript({
      version: "9.9.9",
      assetUrl: `file://${tarballPath}`,
      checksumUrl: `file://${checksumPath}`,
      unitName: "com.mullion.primary",
    }).catch(() => undefined);

    const launchctlLog = readLaunchctlLog();
    expect(launchctlLog).toContainEqual(
      `kickstart -k gui/${process.getuid?.() ?? 501}/com.mullion.primary`,
    );
    // The job removes its own plist and boots itself out.
    expect(launchctlLog.some((line) => line.includes("bootout"))).toBe(true);
    expect(fs.existsSync(plistPath)).toBe(false);
    // ...and systemctl was never involved.
    expect(readSystemctlLog().some((line) => line.includes("restart"))).toBe(false);
    // The bootout kills the script, so reaching "done" proves the bootout was
    // the LAST thing it did: the release prune and this status write are both
    // after it.
    expect(readStatus().phase).toBe("done");
  });

  // The Windows branch (issue #2161, part of #1728). Git for Windows' bash
  // reports MINGW64_NT-… from `uname -s`, so a shimmed `uname` runs it on a
  // Linux runner, with cygpath / schtasks / powershell.exe shimmed (and the
  // junction `current` becoming a plain symlink, which is all `node -e
  // fs.symlinkSync(…, "junction")` makes here). What this proves is the
  // script's own logic: the gate, the flip, the restart, the prune.
  // test/scripts/self-update-windows.test.ts runs the real thing on Windows.
  describe("Windows branch", () => {
    let fakeHome: string;

    // Everything a Windows release has to carry for the script's own gates.
    const windowsFiles = {
      "scripts/windows-launcher.mjs": "// launcher\n",
      "deploy/windows/register-task.ps1": "# register\n",
      "deploy/windows/releases-in-use.ps1": "# in use\n",
    };

    beforeEach(() => {
      fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "self-update-test-fakehome-"));
      writeShim(
        binDir,
        "uname",
        `#!/usr/bin/env bash
if [ "$1" = "-s" ]; then echo MINGW64_NT-10.0-26200; else echo Windows; fi
`,
      );
      // cygpath: the paths are already native here.
      writeShim(
        binDir,
        "cygpath",
        `#!/usr/bin/env bash
for last in "$@"; do P="$last"; done
printf '%s\\n' "$P"
`,
      );
      // schtasks: `//Query //TN NAME` answers from a one-name-per-line registry.
      writeShim(
        binDir,
        "schtasks",
        `#!/usr/bin/env bash
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    //TN) NAME="$2"; shift ;;
  esac
  shift
done
grep -qxF "$NAME" "$DIR/schtasks.registered" 2>/dev/null
`,
      );
      // powershell.exe: records the call; the in-use script answers from
      // powershell.inuse (one release name per line), or fails on demand.
      writeShim(
        binDir,
        "powershell.exe",
        `#!/usr/bin/env bash
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
echo "$*" >> "$DIR/powershell.log"
echo "PSModulePath=\${PSModulePath-unset}" >> "$DIR/powershell.env"
case "$*" in
  *releases-in-use.ps1*)
    if [ -n "\${INUSE_FAIL:-}" ]; then echo "releases-in-use: boom" >&2; exit 1; fi
    [ -f "$DIR/powershell.inuse" ] && cat "$DIR/powershell.inuse"
    exit 0
    ;;
esac
exit 0
`,
      );
    });

    afterEach(() => {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    });

    const registerTask = (name = "Mullion-agent") =>
      fs.appendFileSync(path.join(binDir, "schtasks.registered"), `${name}\n`);
    const readLog = (name: string): string[] => {
      const p = path.join(binDir, name);
      if (!fs.existsSync(p)) return [];
      return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
    };
    const update = async (
      opts: { files?: Record<string, string>; env?: Record<string, string>; unit?: string } = {},
    ) => {
      const { tarballPath, checksumPath } = await buildFakeRelease("9.9.9", {
        extraFiles: opts.files ?? windowsFiles,
      });
      return runScript({
        version: "9.9.9",
        assetUrl: `file://${tarballPath}`,
        checksumUrl: `file://${checksumPath}`,
        unitName: opts.unit ?? "Mullion-agent",
        env: { HOME: fakeHome, ...opts.env },
      });
    };

    it("flips current, restarts the task by re-registering it, and never touches systemctl or launchctl", async () => {
      registerTask();
      await update();

      expect(readStatus()).toMatchObject({ phase: "done", version: "9.9.9" });
      const release = path.join(mullionHome, "releases", "9.9.9");
      expect(fs.realpathSync(path.join(mullionHome, "current"))).toBe(fs.realpathSync(release));

      // The restart: the NEW release's register-task.ps1, with -Start, naming
      // the task, node, the launcher under `current` and the install root.
      const register = readLog("powershell.log").filter((l) => l.includes("register-task.ps1"));
      expect(register).toHaveLength(1);
      expect(register[0]).toContain("-NoProfile -NonInteractive -ExecutionPolicy Bypass -File");
      expect(register[0]).toContain(path.join(release, "deploy", "windows", "register-task.ps1"));
      expect(register[0]).toContain("-TaskName Mullion-agent");
      expect(register[0]).toContain(`-NodePath ${path.join(binDir, "node")}`);
      expect(register[0]).toContain(
        `-LauncherPath ${path.join(mullionHome, "current", "scripts", "windows-launcher.mjs")}`,
      );
      expect(register[0]).toContain(`-MullionHome ${mullionHome}`);
      expect(register[0].trim().endsWith("-Start")).toBe(true);

      expect(readSystemctlLog()).toEqual([]);
      expect(readLaunchctlLog()).toEqual([]);
      // PowerShell 7's PSModulePath would break the ScheduledTasks module.
      expect(new Set(readLog("powershell.env"))).toEqual(new Set(["PSModulePath=unset"]));
    });

    it("falls back to the running release's register-task.ps1 when the new one has none", async () => {
      registerTask();
      await update({ files: { "scripts/windows-launcher.mjs": "// launcher\n" } });
      const register = readLog("powershell.log").filter((l) => l.includes("register-task.ps1"));
      expect(register).toHaveLength(1);
      // $RUNNING_SCRIPTS_DIR/../deploy/windows — the copy in the release the
      // updater runs from, by its PHYSICAL directory (SCRIPT_DIR, reached
      // through `current`, would point into the new release after the flip),
      // spelled the way the script builds it (path.join would collapse the `..`).
      expect(register[0]).toContain(
        `${fs.realpathSync(path.dirname(SELF_UPDATE_SCRIPT))}/../deploy/windows/register-task.ps1`,
      );
      expect(register[0]).not.toContain(path.join("releases", "9.9.9", "deploy"));
    });

    it("puts the old current back, and fails, when the new link cannot be moved into place", async () => {
      // A virus scanner or an indexer holding current.tmp makes the move fail
      // AFTER the old link has been removed. `current` must not be left missing
      // (the next logon's task would point at a launcher that is not there),
      // and the update must say it failed rather than die under `set -e`.
      registerTask();
      const running = path.join(mullionHome, "releases", "1.0.0");
      fs.mkdirSync(running, { recursive: true });
      fs.symlinkSync(running, path.join(mullionHome, "current"));
      writeShim(
        binDir,
        "mv",
        `#!/usr/bin/env bash
case "$*" in
  *current.tmp*) echo "mv: cannot move: Device or resource busy" >&2; exit 1 ;;
esac
exec /bin/mv "$@"
`,
      );
      await expect(update()).rejects.toThrow();
      expect(readStatus()).toMatchObject({ phase: "failed" });
      expect(readStatus().error).toMatch(
        /could not move current to the new release — it is unchanged/,
      );
      expect(fs.realpathSync(path.join(mullionHome, "current"))).toBe(fs.realpathSync(running));
      // Nothing was restarted onto a release `current` does not point at.
      expect(readLog("powershell.log").filter((l) => l.includes("register-task"))).toEqual([]);
    });

    it("refuses a release without the Windows launcher, before current moves", async () => {
      registerTask();
      await expect(update({ files: {} })).rejects.toThrow();
      expect(readStatus()).toMatchObject({ phase: "failed" });
      expect(readStatus().error).toMatch(/windows-launcher\.mjs missing/);
      expect(fs.existsSync(path.join(mullionHome, "current"))).toBe(false);
      expect(fs.existsSync(path.join(mullionHome, "releases", "9.9.9"))).toBe(false);
      expect(readLog("powershell.log").filter((l) => l.includes("register-task"))).toEqual([]);
    });

    it("does not start a second agent when no task is registered: it says so and fails", async () => {
      // Re-registering from nothing would run a new agent beside one the
      // operator started by hand, both wanting the same port.
      await expect(update()).rejects.toThrow();
      expect(readStatus()).toMatchObject({ phase: "failed" });
      expect(readStatus().error).toMatch(/no scheduled task named Mullion-agent is registered/);
      expect(readLog("powershell.log").filter((l) => l.includes("register-task"))).toEqual([]);
      // The update itself is in place, as the message says.
      expect(fs.realpathSync(path.join(mullionHome, "current"))).toBe(
        fs.realpathSync(path.join(mullionHome, "releases", "9.9.9")),
      );
    });

    it("refuses a task name that is not a plain name", async () => {
      await expect(update({ unit: "bad name; calc" })).rejects.toThrow();
      expect(readStatus().error).toMatch(/refusing to restart a scheduled task named/);
      expect(readLog("powershell.log").filter((l) => l.includes("register-task"))).toEqual([]);
    });

    it("writes the mullion launcher script in ~/bin, not a symlink in ~/.local/bin", async () => {
      registerTask();
      await update({
        files: { ...windowsFiles, "dist/cli/mullion.mjs": "// cli\n" },
      });
      const cli = path.join(fakeHome, "bin", "mullion");
      const body = fs.readFileSync(cli, "utf8");
      expect(fs.lstatSync(cli).isSymbolicLink()).toBe(false);
      expect(body).toMatch(/^#!\/bin\/sh\nexec /);
      expect(body).toContain(path.join(binDir, "node"));
      expect(body).toContain(`${mullionHome}/current/dist/cli/mullion.mjs`);
      expect(fs.existsSync(path.join(fakeHome, ".local", "bin", "mullion"))).toBe(false);
    });

    describe("pruning", () => {
      const seed = (...names: string[]) => {
        for (const name of names) {
          fs.mkdirSync(path.join(mullionHome, "releases", name), { recursive: true });
          fs.writeFileSync(path.join(mullionHome, "releases", name, "marker"), name);
        }
      };
      const remaining = () => fs.readdirSync(path.join(mullionHome, "releases")).sort();

      it("removes the oldest release when none is in use", async () => {
        registerTask();
        seed("1.0.0", "1.0.1", "1.0.2");
        await update();
        expect(remaining()).toEqual(["1.0.1", "1.0.2", "9.9.9"]);
      });

      it("keeps a release a running process still uses, even the oldest", async () => {
        registerTask();
        seed("1.0.0", "1.0.1", "1.0.2");
        fs.writeFileSync(path.join(binDir, "powershell.inuse"), "1.0.0\n");
        const { stderr } = await update();
        expect(remaining()).toEqual(["1.0.0", "1.0.1", "1.0.2", "9.9.9"]);
        expect(stderr).toContain("keeping release 1.0.0: a running process still uses it");
        expect(readStatus().phase).toBe("done");
      });

      it("prunes nothing when it cannot tell what is in use", async () => {
        registerTask();
        seed("1.0.0", "1.0.1", "1.0.2");
        const { stderr } = await update({ env: { INUSE_FAIL: "1" } });
        expect(remaining()).toEqual(["1.0.0", "1.0.1", "1.0.2", "9.9.9"]);
        expect(stderr).toContain("could not tell which releases are in use — not pruning");
        expect(readStatus().phase).toBe("done");
      });

      it("treats a release it cannot delete (a locked file) as a warning, not a failed update", async () => {
        registerTask();
        seed("1.0.0", "1.0.1", "1.0.2");
        writeShim(
          binDir,
          "rm",
          `#!/usr/bin/env bash
case "$*" in
  *releases/1.0.0*) echo "rm: cannot remove: Device or resource busy" >&2; exit 1 ;;
esac
exec /bin/rm "$@"
`,
        );
        const { stderr } = await update();
        expect(stderr).toContain("could not remove release 1.0.0 completely");
        expect(readStatus().phase).toBe("done");
        expect(fs.existsSync(path.join(mullionHome, "releases", "1.0.0"))).toBe(true);
      });
    });
  });

  it("downloads, verifies, installs, and flips current on a successful update", async () => {
    const { tarballPath, checksumPath } = await buildFakeRelease("9.9.9");

    await runScript({
      version: "9.9.9",
      assetUrl: `file://${tarballPath}`,
      checksumUrl: `file://${checksumPath}`,
    });

    expect(readStatus()).toMatchObject({ phase: "done", version: "9.9.9" });
    expect(fs.readlinkSync(path.join(mullionHome, "current"))).toBe(
      path.join(mullionHome, "releases", "9.9.9"),
    );
    expect(fs.existsSync(path.join(mullionHome, "releases", "9.9.9", "dist", "server.js"))).toBe(
      true,
    );
    expect(readSystemctlLog()).toEqual([
      "--user daemon-reload",
      "--user restart fake-mullion.service",
    ]);
  });

  // The darwin branch of fail(): a failed update must not leave its launchd
  // job (or its plist) behind — the next apply for the same version would
  // then be refused by `launchctl bootstrap` (an already-loaded label).
  it("boots the update job out and drops its plist when an update fails on macOS", async () => {
    writeShim(
      binDir,
      "launchctl",
      `#!/usr/bin/env bash
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
echo "$*" >> "$DIR/launchctl.log"
exit 0
`,
    );
    writeShim(
      binDir,
      "uname",
      `#!/usr/bin/env bash
if [ "$1" = "-s" ]; then echo Darwin; else echo Linux; fi
`,
    );
    // A checksum that does NOT match the tarball: the script fails at the
    // verify gate (not at the download — the checksum file exists, it just
    // carries the wrong hash).
    const { tarballPath, checksumPath } = await buildFakeRelease("9.9.9");
    fs.writeFileSync(checksumPath, `${"0".repeat(64)}  ${path.basename(tarballPath)}\n`);
    // The plist the job runs from — pre-created, so "it is gone" means
    // something.
    const plistPath = path.join(mullionHome, "logs", "com.mullion.update-9.9.9.plist");
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, "<plist/>\n");

    await expect(
      runScript({
        version: "9.9.9",
        assetUrl: `file://${tarballPath}`,
        checksumUrl: `file://${checksumPath}`,
        unitName: "com.mullion.primary",
      }),
    ).rejects.toThrow();

    const log = readLaunchctlLog();
    expect(log.some((line) => line.includes("bootout"))).toBe(true);
    expect(fs.existsSync(plistPath)).toBe(false);
  });

  it("leaves current untouched when checksum verification fails", async () => {
    const { tarballPath, checksumPath } = await buildFakeRelease("9.9.8");
    // Corrupt the checksum file's hash (same filename, wrong hex) — the
    // script's sha256sum -c must reject this before ever extracting.
    fs.writeFileSync(checksumPath, `${"0".repeat(64)}  mullion-9.9.8.tgz\n`);

    await expect(
      runScript({
        version: "9.9.8",
        assetUrl: `file://${tarballPath}`,
        checksumUrl: `file://${checksumPath}`,
      }),
    ).rejects.toThrow();

    expect(readStatus()).toMatchObject({ phase: "failed" });
    expect(fs.existsSync(path.join(mullionHome, "current"))).toBe(false);
  });

  it("leaves current untouched when dist/server.js is missing after extraction (verify gate)", async () => {
    const { tarballPath, checksumPath } = await buildFakeRelease("9.9.7", {
      includeServerJs: false,
    });

    await expect(
      runScript({
        version: "9.9.7",
        assetUrl: `file://${tarballPath}`,
        checksumUrl: `file://${checksumPath}`,
      }),
    ).rejects.toThrow();

    const status = readStatus();
    expect(status.phase).toBe("failed");
    expect(status.error).toMatch(/dist\/server\.js/);
    expect(fs.existsSync(path.join(mullionHome, "current"))).toBe(false);
    // The partial release dir is cleaned up on this failure path too.
    expect(fs.existsSync(path.join(mullionHome, "releases", "9.9.7"))).toBe(false);
  });

  it("refuses to run when a fresh update lock is already held", async () => {
    fs.mkdirSync(path.join(mullionHome, ".update.lock"));
    const { tarballPath, checksumPath } = await buildFakeRelease("9.9.6");

    await expect(
      runScript({
        version: "9.9.6",
        assetUrl: `file://${tarballPath}`,
        checksumUrl: `file://${checksumPath}`,
      }),
    ).rejects.toThrow();

    // acquire_lock fails before write_status("downloading") is ever
    // called — no status file, no releases dir, from THIS run.
    expect(fs.existsSync(path.join(mullionHome, ".update-status.json"))).toBe(false);
    expect(fs.existsSync(path.join(mullionHome, "releases"))).toBe(false);
  });

  it("recovers from a stale lock left by a crashed prior run", async () => {
    const lockDir = path.join(mullionHome, ".update.lock");
    fs.mkdirSync(lockDir);
    // Older than STALE_LOCK_SECONDS (2400s, post-#647 correction) — must be
    // treated as abandoned, not a genuinely running update.
    const staleTime = new Date(Date.now() - 3000 * 1000);
    fs.utimesSync(lockDir, staleTime, staleTime);
    const { tarballPath, checksumPath } = await buildFakeRelease("9.9.5");

    await runScript({
      version: "9.9.5",
      assetUrl: `file://${tarballPath}`,
      checksumUrl: `file://${checksumPath}`,
    });

    expect(readStatus()).toMatchObject({ phase: "done", version: "9.9.5" });
  });

  it("keeps only the newest 3 releases, protecting whatever `current` points at", async () => {
    const releasesDir = path.join(mullionHome, "releases");
    fs.mkdirSync(releasesDir, { recursive: true });
    for (const oldVersion of ["0.0.1", "0.0.2", "0.0.3"]) {
      fs.mkdirSync(path.join(releasesDir, oldVersion));
    }
    const { tarballPath, checksumPath } = await buildFakeRelease("9.9.4");

    await runScript({
      version: "9.9.4",
      assetUrl: `file://${tarballPath}`,
      checksumUrl: `file://${checksumPath}`,
    });

    const remaining = fs.readdirSync(releasesDir).sort();
    expect(remaining).toEqual(["0.0.2", "0.0.3", "9.9.4"]);
    expect(fs.readlinkSync(path.join(mullionHome, "current"))).toBe(
      path.join(releasesDir, "9.9.4"),
    );
  });
});
