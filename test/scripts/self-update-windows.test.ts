// Issue #2161 — scripts/self-update.sh on Windows, for real: the actual script
// in the actual Git Bash, a real directory-junction `current`, a real
// scheduled task that the update restarts through the real register-task.ps1,
// and a real process the prune has to leave alone. Only the things that would
// reach the network or run a slow install are replaced: the release is a local
// tarball served through file:// URLs, with the stub native modules the
// Linux suite uses (test/helpers/fake-release.ts), and npm/npx are no-ops.
//
// Windows only, and not in CI: restarting the task starts it, which needs the
// user's interactive logon session, and a CI runner does not reliably have one
// (the same reason windows-register-task.test.ts skips its -Start test there).
// The Linux suite (self-update.test.ts, "Windows branch") covers the script's
// logic under shims on every push; this is the check that the shims are right.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { windowsPowerShellEnv } from "../../src/cli/pipe-acl.mjs";
import { sessionShellOrNull } from "../../src/services/session-shell.js";
import { buildFakeRelease } from "../helpers/fake-release.js";

const run = promisify(execFile);
const repo = (relative: string) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));
const BASH = process.platform === "win32" ? sessionShellOrNull() : null;
const describeIt = BASH && !process.env.CI ? describe : describe.skip;

const slashed = (p: string) => p.replaceAll("\\", "/");

describeIt("scripts/self-update.sh on Windows", () => {
  let root: string;
  let home: string;
  let binDir: string;
  let task: string;
  let counter = 0;
  const holders: ChildProcess[] = [];

  /** A stub windows-launcher.mjs: all the task needs is to run and say with what. */
  const launcher = (label: string) =>
    [
      'import { writeFileSync } from "node:fs";',
      'import path from "node:path";',
      // argv[2] is the install root the task passes, argv[3] the task name.
      `writeFileSync(path.join(process.argv[2], "marker-${label}.json"), JSON.stringify(process.argv.slice(2)));`,
      "",
    ].join("\n");

  async function powershellScript(script: string, args: string[]): Promise<void> {
    await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
      { env: windowsPowerShellEnv(process.env), windowsHide: true, timeout: 60_000 },
    );
  }

  // These tests register REAL tasks (with a logon trigger). A run that was
  // killed outright never reached its afterEach, and would leave one behind to
  // start at every logon — so any left by an earlier run are removed first.
  beforeAll(async () => {
    await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-ScheduledTask -TaskName 'MullionUpdTest-*' -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false",
      ],
      { env: windowsPowerShellEnv(process.env), windowsHide: true, timeout: 60_000 },
    );
  });

  beforeEach(async () => {
    counter += 1;
    task = `MullionUpdTest-${process.pid}-${counter}`;
    // A space in the install root: the script and the task both have to quote it.
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "upd-")));
    home = path.join(root, "Mullion home");
    binDir = path.join(root, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(home, { recursive: true });

    // node.exe copied into the shim dir so the script's own PATH prepend
    // (dirname of the node it is given) puts the no-op npm/npx first.
    fs.copyFileSync(process.execPath, path.join(binDir, "node.exe"));
    for (const name of ["npm", "npx"]) {
      fs.writeFileSync(path.join(binDir, name), "#!/usr/bin/env bash\nexit 0\n");
    }

    // The running release, 1.0.0, behind a `current` junction.
    const running = path.join(home, "releases", "1.0.0");
    fs.mkdirSync(path.join(running, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(running, "scripts", "windows-launcher.mjs"), launcher("old"));
    fs.symlinkSync(running, path.join(home, "current"), "junction");

    // Its task, registered (not started) the way the installer does.
    await powershellScript(repo("deploy/windows/register-task.ps1"), [
      "-TaskName",
      task,
      "-NodePath",
      path.join(binDir, "node.exe"),
      "-LauncherPath",
      path.join(home, "current", "scripts", "windows-launcher.mjs"),
      "-MullionHome",
      home,
    ]);
  });

  afterEach(async () => {
    await powershellScript(repo("deploy/windows/register-task.ps1"), [
      "-TaskName",
      task,
      "-Remove",
    ]).catch(() => undefined);
    await Promise.all(
      holders.splice(0).map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            child.once("exit", () => resolve());
            child.kill();
          }),
      ),
    );
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  /** Release 9.9.9 as a tarball, carrying the Windows scripts the update needs. */
  async function release() {
    return buildFakeRelease("9.9.9", {
      extraFiles: {
        "scripts/windows-launcher.mjs": launcher("new"),
        "deploy/windows/register-task.ps1": fs.readFileSync(
          repo("deploy/windows/register-task.ps1"),
          "utf8",
        ),
        "deploy/windows/releases-in-use.ps1": fs.readFileSync(
          repo("deploy/windows/releases-in-use.ps1"),
          "utf8",
        ),
      },
    });
  }

  /** Runs the updater exactly as update-apply.ts launches it. */
  async function update(tarballPath: string, checksumPath: string, taskName = task) {
    return run(
      BASH!,
      [
        "-l",
        slashed(repo("scripts/self-update.sh")),
        "9.9.9",
        `file:///${slashed(tarballPath)}`,
        `file:///${slashed(checksumPath)}`,
        slashed(home),
        slashed(path.join(binDir, "node.exe")),
        taskName,
      ],
      { cwd: home, env: process.env, timeout: 180_000 },
    );
  }

  const status = (): { phase: string; error?: string } =>
    JSON.parse(fs.readFileSync(path.join(home, ".update-status.json"), "utf8"));
  const releaseNames = () => fs.readdirSync(path.join(home, "releases")).sort();

  async function waitFor(file: string, ms = 30_000): Promise<string | null> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return null;
  }

  it("installs the release, moves current, and restarts the task onto it", async () => {
    const { tarballPath, checksumPath } = await release();
    await update(tarballPath, checksumPath);

    expect(status().phase).toBe("done");
    // `current` is a junction onto the new release, and the old one is intact.
    expect(fs.realpathSync.native(path.join(home, "current"))).toBe(
      path.join(home, "releases", "9.9.9"),
    );
    expect(
      fs.existsSync(path.join(home, "releases", "1.0.0", "scripts", "windows-launcher.mjs")),
    ).toBe(true);
    // The task was re-registered and started: the NEW release's launcher ran,
    // through `current`, with the install root and the task name.
    const marker = await waitFor(path.join(home, "marker-new.json"));
    expect(marker).not.toBeNull();
    expect(JSON.parse(marker!)).toEqual([home, task]);
    expect(fs.existsSync(path.join(home, "marker-old.json"))).toBe(false);
  }, 240_000);

  it("keeps a release a running process uses, and prunes the older one that nothing uses", async () => {
    for (const name of ["0.8.0", "0.9.0", "0.9.5"]) {
      fs.mkdirSync(path.join(home, "releases", name), { recursive: true });
      fs.writeFileSync(path.join(home, "releases", name, "marker"), name);
    }
    // A process running from 0.8.0, the oldest — a session's master would be.
    const hold = path.join(home, "releases", "0.8.0", "hold.js");
    fs.writeFileSync(hold, 'console.log("ready"); setInterval(() => {}, 1000);');
    const holder = spawn(process.execPath, [hold], { stdio: ["ignore", "pipe", "inherit"] });
    holders.push(holder);
    await new Promise<void>((resolve) =>
      holder.stdout!.on("data", (chunk: Buffer) => String(chunk).includes("ready") && resolve()),
    );

    const { tarballPath, checksumPath } = await release();
    const { stderr } = await update(tarballPath, checksumPath);

    expect(status().phase).toBe("done");
    expect(stderr).toContain("keeping release 0.8.0: a running process still uses it");
    // Five releases, keep three: the two oldest were candidates. 0.8.0 is in
    // use and stays; 0.9.0 is not and goes. The one `current` pointed at is safe.
    expect(releaseNames()).toEqual(["0.8.0", "0.9.5", "1.0.0", "9.9.9"]);
    expect(fs.existsSync(hold)).toBe(true);
  }, 240_000);

  it("fails, and starts nothing, when the task it is meant to restart is not registered", async () => {
    const { tarballPath, checksumPath } = await release();
    await expect(
      update(tarballPath, checksumPath, "MullionUpdTest-not-registered"),
    ).rejects.toThrow();

    expect(status().phase).toBe("failed");
    expect(status().error).toMatch(
      /no scheduled task named MullionUpdTest-not-registered is registered/,
    );
    // No second agent: nothing was registered or started in its place.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(fs.existsSync(path.join(home, "marker-new.json"))).toBe(false);
    // The update is in place, as the message says.
    expect(fs.realpathSync.native(path.join(home, "current"))).toBe(
      path.join(home, "releases", "9.9.9"),
    );
  }, 240_000);

  it("leaves current, and the running release, alone when the download does not verify", async () => {
    const { tarballPath, checksumPath } = await release();
    fs.writeFileSync(checksumPath, `${"0".repeat(64)}  mullion-9.9.9.tgz\n`);
    await expect(update(tarballPath, checksumPath)).rejects.toThrow();

    expect(status().phase).toBe("failed");
    expect(fs.realpathSync.native(path.join(home, "current"))).toBe(
      path.join(home, "releases", "1.0.0"),
    );
    expect(fs.existsSync(path.join(home, "releases", "9.9.9"))).toBe(false);
  }, 240_000);
});
