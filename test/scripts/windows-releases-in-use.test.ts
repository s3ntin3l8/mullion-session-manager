// Issue #2161 — deploy/windows/releases-in-use.ps1, for real: which release
// directories does a running process still use? The updater prunes old
// releases, and deleting one under a live session's pty-host master would
// leave it half-deleted (Windows removes what is not locked), so those are
// skipped. Windows only; runs in CI's test-windows job.
//
// "Using" a release means having a native module LOADED from it — the pty-host
// master is started through the `current` junction, so its command line never
// names the release it resolved to — or having its path on the command line.
import { describe, it, expect, afterEach } from "vitest";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { windowsPowerShellEnv } from "../../src/cli/pipe-acl.mjs";

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../../deploy/windows/releases-in-use.ps1", import.meta.url));
const ADDON = fileURLToPath(
  new URL(
    `../../node_modules/better-sqlite3/prebuilds/win32-${process.arch}.node`,
    import.meta.url,
  ),
);
const describeOnWindows = process.platform === "win32" ? describe : describe.skip;

async function inUse(releasesDir: string): Promise<string[]> {
  const { stdout } = await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      SCRIPT,
      "-ReleasesDir",
      releasesDir,
    ],
    { env: windowsPowerShellEnv(process.env), windowsHide: true, timeout: 60_000 },
  );
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

describeOnWindows("deploy/windows/releases-in-use.ps1", () => {
  const children: ChildProcess[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    // Wait for each process to be gone before deleting what it had loaded:
    // Windows will not delete a native module a running process holds — which
    // is the very reason this script exists.
    await Promise.all(
      children.splice(0).map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            child.once("exit", () => resolve());
            child.kill();
          }),
      ),
    );
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  /** A releases directory with the given release names, as its real (long-form) path. */
  function releases(...names: string[]): string {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "in-use-")));
    dirs.push(root);
    for (const name of names) fs.mkdirSync(path.join(root, "releases", name), { recursive: true });
    return path.join(root, "releases");
  }

  /** Starts a node process and resolves once it prints "ready". */
  function start(args: string[], cwd?: string): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "inherit"] });
      children.push(child);
      child.once("error", reject);
      child.stdout!.on("data", (chunk: Buffer) => {
        if (String(chunk).includes("ready")) resolve(child);
      });
      child.once("exit", () => reject(new Error("the test process exited before it was ready")));
    });
  }

  // A native module of this host's architecture to load from the fake release.
  const withAddon = it.runIf(fs.existsSync(ADDON));

  /** Starts a node process that has the addon loaded from `<releases>/<name>`. */
  async function holdAddon(dir: string, name: string): Promise<void> {
    const addon = path.join(dir, name, "addon.node");
    fs.copyFileSync(ADDON, addon);
    await start([
      "-e",
      `process.dlopen({ exports: {} }, ${JSON.stringify(addon)}); console.log("ready"); setInterval(() => {}, 1000)`,
    ]);
  }

  withAddon(
    "reports the release a process has a native module loaded from — how a pty-host master shows up",
    async () => {
      const dir = releases("1.0.0", "2.0.0", "3.0.0");
      await holdAddon(dir, "2.0.0");
      expect(await inUse(dir)).toEqual(["2.0.0"]);
    },
    60_000,
  );

  // The releases directory is resolved to its REAL path first. A junction (or a
  // short 8.3 name, or a substituted drive) in the path the updater was given
  // would otherwise make every loaded module look like it lives elsewhere, and
  // every release look unused — which is a release deleted under a live session.
  withAddon(
    "finds a release in use when the releases directory is reached through a junction",
    async () => {
      const dir = releases("1.0.0", "2.0.0");
      await holdAddon(dir, "1.0.0");
      const viaJunction = path.join(path.dirname(dir), "..", "via-junction");
      dirs.push(viaJunction);
      fs.symlinkSync(path.dirname(dir), viaJunction, "junction");
      expect(await inUse(path.join(viaJunction, "releases"))).toEqual(["1.0.0"]);
      // The link goes first: removing it must never reach into what it points at.
      fs.rmdirSync(viaJunction);
    },
    60_000,
  );

  it("matches a release by its whole name: 1.0.0 is not 1.0.00", async () => {
    const dir = releases("1.0.0", "1.0.00");
    const script = path.join(dir, "1.0.00", "hold.js");
    fs.writeFileSync(script, 'console.log("ready"); setInterval(() => {}, 1000);');
    await start([script]);
    expect(await inUse(dir)).toEqual(["1.0.00"]);
  }, 60_000);

  it("reports a release named as a whole argument — a working directory, not a script path", async () => {
    const dir = releases("1.0.0", "2.0.0");
    const release = path.join(dir, "2.0.0");
    const script = path.join(dir, "..", "hold.js");
    fs.writeFileSync(script, 'console.log("ready"); setInterval(() => {}, 1000);');
    await start([script, "--cwd", release]);
    expect(await inUse(dir)).toEqual(["2.0.0"]);
  }, 60_000);

  it("reports a release whose path is on a process's command line", async () => {
    const dir = releases("1.0.0", "2.0.0");
    const script = path.join(dir, "1.0.0", "hold.js");
    fs.writeFileSync(script, 'console.log("ready"); setInterval(() => {}, 1000);');
    await start([script]);
    expect(await inUse(dir)).toEqual(["1.0.0"]);
  }, 60_000);

  it("is case- and slash-insensitive about the path it is given", async () => {
    const dir = releases("1.0.0");
    const script = path.join(dir, "1.0.0", "hold.js");
    fs.writeFileSync(script, 'console.log("ready"); setInterval(() => {}, 1000);');
    await start([script]);
    expect(await inUse(dir.toUpperCase().replaceAll("\\", "/"))).toEqual(["1.0.0"]);
  }, 60_000);

  it("reports a release once no process uses it any more: nothing", async () => {
    const dir = releases("1.0.0");
    const script = path.join(dir, "1.0.0", "hold.js");
    fs.writeFileSync(script, 'console.log("ready"); setInterval(() => {}, 1000);');
    const child = await start([script]);
    expect(await inUse(dir)).toEqual(["1.0.0"]);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
    expect(await inUse(dir)).toEqual([]);
  }, 60_000);

  it("is empty when nothing runs from the releases, and for a releases directory that does not exist", async () => {
    const dir = releases("1.0.0", "2.0.0");
    expect(await inUse(dir)).toEqual([]);
    expect(await inUse(path.join(dir, "..", "no-such-releases"))).toEqual([]);
  }, 60_000);
});
