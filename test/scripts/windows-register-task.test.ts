// Issue #2160 — deploy/windows/register-task.ps1, for real: it registers a
// throwaway per-user scheduled task through Windows PowerShell 5.1 (started
// the way deploy/install.sh starts it — without a PSModulePath inherited from
// PowerShell 7), reads the task back, and removes it. Windows only; runs in
// CI's test-windows job.
import { describe, it, expect, afterEach } from "vitest";
import { execFile } from "node:child_process";
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
    expect(xml).toContain(`<Command>${process.execPath}</Command>`);
    expect(xml).toContain(`<Arguments>"${f.launcher}" "${f.home}" "${name}"</Arguments>`);
    expect(xml).toContain(`<WorkingDirectory>${f.home}</WorkingDirectory>`);
  }, 90_000);

  it("replaces an existing registration instead of failing or duplicating it", async () => {
    const f = fixture();
    expect((await register(f)).code).toBe(0);
    const again = await register(f);
    expect(again.code, again.stderr).toBe(0);
    expect(await taskXml(name)).not.toBeNull();
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
      expect(JSON.parse(fs.readFileSync(f.marker, "utf8"))).toEqual([f.home, name]);
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
