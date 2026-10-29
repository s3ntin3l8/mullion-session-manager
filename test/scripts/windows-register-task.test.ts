// Issue #2160 — deploy/windows/register-task.ps1, for real: it registers a
// throwaway per-user scheduled task through Windows PowerShell 5.1 (started
// the way deploy/install.sh starts it — without a PSModulePath inherited from
// PowerShell 7), reads the task back, and removes it. Windows only; runs in
// CI's test-windows job.
import { describe, it, expect, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { windowsPowerShellEnv } from "../../src/cli/pipe-acl.mjs";

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../../deploy/windows/register-task.ps1", import.meta.url));
const describeOnWindows = process.platform === "win32" ? describe : describe.skip;

// The task's own start needs the user's interactive session, which a CI
// runner does not reliably have — register/read/remove is what runs there.
const canStartTask = !process.env.CI;

type Result = { code: number; stdout: string; stderr: string };

async function powershell(args: string[]): Promise<Result> {
  try {
    const { stdout, stderr } = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, ...args],
      { env: windowsPowerShellEnv(process.env), windowsHide: true, timeout: 60_000 },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

async function taskXml(name: string): Promise<string | null> {
  try {
    const { stdout } = await run("schtasks", ["/Query", "/TN", name, "/XML"], {
      windowsHide: true,
    });
    return stdout;
  } catch {
    return null;
  }
}

describeOnWindows("deploy/windows/register-task.ps1", () => {
  const name = `MullionTest-${process.pid}`;
  const dirs: string[] = [];
  afterEach(async () => {
    await powershell(["-TaskName", name, "-Remove"]);
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A temp install root (with a space in its path) and a stub launcher that records its arguments. */
  function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "register-task-"));
    dirs.push(root);
    const home = path.join(root, "Mullion home");
    fs.mkdirSync(home);
    const launcher = path.join(root, "launcher.mjs");
    fs.writeFileSync(
      launcher,
      'import { writeFileSync } from "node:fs";\n' +
        'writeFileSync(new URL("./marker.json", import.meta.url), JSON.stringify(process.argv.slice(2)));\n',
    );
    return { root, home, launcher, marker: path.join(root, "marker.json") };
  }
  const register = (f: ReturnType<typeof fixture>, ...extra: string[]) =>
    powershell([
      "-TaskName",
      name,
      "-NodePath",
      process.execPath,
      "-LauncherPath",
      f.launcher,
      "-MullionHome",
      f.home,
      ...extra,
    ]);

  it("registers a per-user logon task that runs the launcher without elevation or a time limit", async () => {
    const f = fixture();
    const result = await register(f);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`registered task ${name}`);

    const xml = (await taskXml(name))!;
    expect(xml).not.toBeNull();
    expect(xml).toContain("<LogonTrigger>");
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).not.toContain("HighestAvailable");
    expect(xml).not.toMatch(/<UserId>(S-1-5-18|NT AUTHORITY\\SYSTEM)<\/UserId>/);
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).toContain("<StartWhenAvailable>true</StartWhenAvailable>");
    // Task Scheduler stores the long form of a path: on a CI runner the temp
    // directory is the 8.3 short form (C:\Users\RUNNER~1\...), and the XML
    // has C:\Users\runneradmin\... for it.
    const launcher = fs.realpathSync.native(f.launcher);
    const home = fs.realpathSync.native(f.home);
    // The task runs the windowless copy of Node, not node.exe itself.
    expect(xml).toContain(`<Command>${path.join(home, "runtime", "mullion-agent.exe")}</Command>`);
    expect(xml).toContain(`<Arguments>"${launcher}" "${home}" "${name}"</Arguments>`);
    expect(xml).toContain(`<WorkingDirectory>${home}</WorkingDirectory>`);
  }, 90_000);

  describe("the windowless copy of Node", () => {
    const copyOf = (f: ReturnType<typeof fixture>) =>
      path.join(f.home, "runtime", "mullion-agent.exe");
    const stampOf = (f: ReturnType<typeof fixture>) =>
      JSON.parse(fs.readFileSync(`${copyOf(f)}.json`, "utf8")) as Record<string, unknown>;

    /** The PE Subsystem field: 3 = console, 2 = Windows GUI (no console window). */
    function subsystem(file: string): number {
      const fd = fs.openSync(file, "r");
      try {
        const head = Buffer.alloc(4);
        fs.readSync(fd, head, 0, 4, 0x3c);
        const pe = head.readInt32LE(0);
        const field = Buffer.alloc(2);
        fs.readSync(fd, field, 0, 2, pe + 0x5c);
        return field.readUInt16LE(0);
      } finally {
        fs.closeSync(fd);
      }
    }
    const versionOf = async (file: string) =>
      (await run(file, ["--version"], { windowsHide: true, timeout: 30_000 })).stdout.trim();

    it("is a GUI-subsystem copy that behaves exactly like the Node it came from", async () => {
      const f = fixture();
      const result = await register(f);
      expect(result.code, result.stderr).toBe(0);
      expect(subsystem(copyOf(f))).toBe(2);
      expect(subsystem(process.execPath)).toBe(3);
      expect(await versionOf(copyOf(f))).toBe(`v${process.versions.node}`);
      expect(stampOf(f)).toMatchObject({
        rcedit: false,
        length: fs.statSync(process.execPath).size,
      });
      expect(fs.realpathSync.native(String(stampOf(f).source))).toBe(
        fs.realpathSync.native(process.execPath),
      );
    }, 120_000);

    it("is built once, and again only when the Node it was made from changed", async () => {
      const f = fixture();
      expect((await register(f)).code).toBe(0);
      const built = fs.statSync(copyOf(f)).mtimeMs;
      expect((await register(f)).code).toBe(0);
      expect(fs.statSync(copyOf(f)).mtimeMs).toBe(built);

      // The recorded Node no longer matches: the copy is made again.
      const stamp = stampOf(f);
      fs.writeFileSync(`${copyOf(f)}.json`, JSON.stringify({ ...stamp, length: 1 }));
      expect((await register(f)).code).toBe(0);
      expect(stampOf(f)).toEqual(stamp);
    }, 180_000);

    it("hands the original Node back when the copy itself is passed as -NodePath, as the updater does", async () => {
      const f = fixture();
      expect((await register(f)).code).toBe(0);
      const stamp = stampOf(f);
      const again = await powershell([
        "-TaskName",
        name,
        "-NodePath",
        copyOf(f),
        "-LauncherPath",
        f.launcher,
        "-MullionHome",
        f.home,
      ]);
      expect(again.code, again.stderr).toBe(0);
      expect(stampOf(f)).toEqual(stamp);
      const xml = (await taskXml(name))!;
      expect(xml).toContain(`<Command>${fs.realpathSync.native(copyOf(f))}</Command>`);
    }, 150_000);

    it("-NoBrand keeps the plain node.exe", async () => {
      const f = fixture();
      const result = await register(f, "-NoBrand");
      expect(result.code, result.stderr).toBe(0);
      expect(fs.existsSync(copyOf(f))).toBe(false);
      expect(await taskXml(name)).toContain(`<Command>${process.execPath}</Command>`);
    }, 90_000);

    it("falls back to the given Node, and says so, when a copy cannot be made", async () => {
      const f = fixture();
      const notNode = path.join(f.root, "node.exe");
      fs.writeFileSync(notNode, "this is not a PE file");
      const result = await powershell([
        "-TaskName",
        name,
        "-NodePath",
        notNode,
        "-LauncherPath",
        f.launcher,
        "-MullionHome",
        f.home,
      ]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("branding skipped");
      expect(fs.existsSync(copyOf(f))).toBe(false);
      expect(await taskXml(name)).toContain(
        `<Command>${fs.realpathSync.native(notNode)}</Command>`,
      );
    }, 90_000);

    // The resource editing needs rcedit. Set MULLION_TEST_RCEDIT to an
    // rcedit-x64.exe to run it locally; in CI it is fetched from the bootstrap's
    // own pin and checked against its SHA-256, so a wrong rcedit flag cannot hide
    // behind the fallback to an unbranded copy.
    async function rceditPath(): Promise<string | null> {
      const given = process.env.MULLION_TEST_RCEDIT;
      if (given && fs.existsSync(given)) return given;
      if (!process.env.CI) return null;
      const ps1 = fs.readFileSync(
        fileURLToPath(new URL("../../deploy/windows/mullion-install.ps1", import.meta.url)),
        "utf8",
      );
      const url = /\$PinRceditUrl\s*=\s*'([^']+)'/.exec(ps1)?.[1];
      const sha = /\$PinRceditSha256\s*=\s*'([0-9a-f]{64})'/.exec(ps1)?.[1];
      if (!url || !sha) throw new Error("could not read the rcedit pin from mullion-install.ps1");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rcedit-"));
      dirs.push(dir);
      const file = path.join(dir, "rcedit-x64.exe");
      const res = await fetch(url);
      if (!res.ok) throw new Error(`downloading rcedit: HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      const got = createHash("sha256").update(bytes).digest("hex");
      if (got !== sha) throw new Error(`rcedit checksum ${got} does not match the pin ${sha}`);
      fs.writeFileSync(file, bytes);
      return file;
    }
    it("carries the Mullion name and icon when rcedit is there", async () => {
      const rcedit = await rceditPath();
      if (!rcedit) return; // not CI, and no MULLION_TEST_RCEDIT
      const f = fixture();
      fs.mkdirSync(path.join(f.home, "runtime"));
      fs.copyFileSync(rcedit, path.join(f.home, "runtime", "rcedit.exe"));
      const result = await register(f);
      expect(result.code, result.stderr).toBe(0);
      expect(stampOf(f)).toMatchObject({ rcedit: true });
      const { stdout } = await run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$v = (Get-Item '${copyOf(f)}').VersionInfo; "$($v.FileDescription)|$($v.ProductName)|$($v.OriginalFilename)"`,
        ],
        { env: windowsPowerShellEnv(process.env), windowsHide: true, timeout: 60_000 },
      );
      expect(stdout.trim()).toBe("Mullion agent|Mullion|mullion-agent.exe");
      expect(await versionOf(copyOf(f))).toBe(`v${process.versions.node}`);
    }, 150_000);
  });

  it("does not let a trailing backslash on the install root swallow the task name", async () => {
    // "C:\...\Mullion home\" followed by a quote: the backslash escapes the
    // quote, and the launcher would see the root and the task name as one
    // argument.
    const f = fixture();
    const result = await powershell([
      "-TaskName",
      name,
      "-NodePath",
      process.execPath,
      "-LauncherPath",
      f.launcher,
      "-MullionHome",
      `${f.home}\\`,
    ]);
    expect(result.code, result.stderr).toBe(0);
    const xml = (await taskXml(name))!;
    const home = fs.realpathSync.native(f.home);
    expect(xml).toContain(`"${home}" "${name}"</Arguments>`);
    expect(xml).toContain(`<WorkingDirectory>${home}</WorkingDirectory>`);
  }, 90_000);

  it("replaces an existing registration instead of failing or duplicating it", async () => {
    const f = fixture();
    expect((await register(f)).code).toBe(0);
    const again = await register(f);
    expect(again.code, again.stderr).toBe(0);
    expect(await taskXml(name)).not.toBeNull();
  }, 90_000);

  it("replaces the DEFINITION in place — what the updater relies on to move the task onto a new release", async () => {
    // The first registration points at one launcher; the second, at another.
    // Afterwards only the second is there (not both, and not a leftover of the
    // first), and the task never had to be removed to get there.
    const first = fixture();
    const second = fixture();
    expect((await register(first)).code).toBe(0);
    const again = await register(second);
    expect(again.code, again.stderr).toBe(0);
    const xml = (await taskXml(name))!;
    expect(xml).toContain(fs.realpathSync.native(second.launcher));
    expect(xml).not.toContain(fs.realpathSync.native(first.launcher));
    expect((xml.match(/<Exec>/g) ?? []).length).toBe(1);
  }, 90_000);

  it.runIf(canStartTask)(
    "starts the task, passing the launcher the install root and the task name",
    async () => {
      const f = fixture();
      const result = await register(f, "-Start");
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain(`started task ${name}`);
      const deadline = Date.now() + 20_000;
      while (!fs.existsSync(f.marker) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(JSON.parse(fs.readFileSync(f.marker, "utf8"))).toEqual([
        fs.realpathSync.native(f.home),
        name,
      ]);
    },
    90_000,
  );

  it("removes the task, and removing one that is not there is not an error", async () => {
    const f = fixture();
    expect((await register(f)).code).toBe(0);
    const removed = await powershell(["-TaskName", name, "-Remove"]);
    expect(removed.code, removed.stderr).toBe(0);
    expect(removed.stdout).toContain(`removed task ${name}`);
    expect(await taskXml(name)).toBeNull();
    const again = await powershell(["-TaskName", name, "-Remove"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("was not registered");
  }, 90_000);

  it("refuses a task name with characters that would end up on a command line", async () => {
    const f = fixture();
    const result = await powershell([
      "-TaskName",
      "bad name; calc",
      "-NodePath",
      process.execPath,
      "-LauncherPath",
      f.launcher,
      "-MullionHome",
      f.home,
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/may only contain letters, digits/);
  }, 90_000);

  it("names what is missing instead of registering a task that cannot start", async () => {
    const f = fixture();
    const result = await powershell([
      "-TaskName",
      name,
      "-NodePath",
      process.execPath,
      "-LauncherPath",
      path.join(f.root, "missing.mjs"),
      "-MullionHome",
      f.home,
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/the launcher was not found at .*missing\.mjs/);
    expect(await taskXml(name)).toBeNull();
  }, 90_000);
});
