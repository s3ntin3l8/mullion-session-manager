// deploy/windows/mullion-install.ps1, for real: the bootstrap that makes sure
// Git Bash and Node 26 exist and then runs the release's installer. Windows
// PowerShell 5.1, a real Git Bash, no network -- the "release" it installs is
// a directory holding a stub mullion-install.sh that is addressed by a file://
// URL, and the Node it downloads is a copy of the Node running this test.
// Windows only; runs in CI's test-windows job.
import { describe, it, expect, afterEach } from "vitest";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findGitBash } from "../../src/services/session-shell.js";
import { windowsPowerShellEnv } from "../../src/cli/pipe-acl.mjs";

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../../deploy/windows/mullion-install.ps1", import.meta.url));
const describeOnWindows = process.platform === "win32" ? describe : describe.skip;
const realPath = (p: string) => fs.realpathSync.native(p).toLowerCase();
const sha256 = (file: string) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

interface Event {
  step: string;
  status: string;
  detail: string;
  exitCode?: number;
  [key: string]: unknown;
}
interface Result {
  code: number;
  events: Event[];
  stdout: string;
  stderr: string;
  /** The registry key this run was told to use for its Settings -> Apps entry. */
  appsKey: string;
}

describeOnWindows("deploy/windows/mullion-install.ps1", () => {
  const dirs: string[] = [];
  const children: ChildProcess[] = [];
  // Every run gets its own Settings -> Apps key, so the suite never touches the
  // real entry of an installed Mullion.
  const appsKeys: string[] = [];
  // PowerShell writes its module-analysis cache to %LOCALAPPDATA% -- or, when
  // that does not resolve (this suite blanks it), to the current directory,
  // which is the checkout. Pointing it at a temp file keeps it out of the repo.
  const psCache = path.join(os.tmpdir(), "mullion-ps-cache", "ModuleAnalysisCache");
  fs.mkdirSync(path.dirname(psCache), { recursive: true });
  const psEnv = (): NodeJS.ProcessEnv => ({
    ...windowsPowerShellEnv(process.env),
    PSModuleAnalysisCachePath: psCache,
  });
  afterEach(async () => {
    for (const child of children.splice(0)) child.kill();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    for (const key of appsKeys.splice(0)) {
      await run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `try { Remove-Item -LiteralPath '${key}' -Recurse -Force -ErrorAction Stop } catch { }; exit 0`,
        ],
        { env: psEnv(), windowsHide: true, timeout: 60_000 },
      );
    }
  });

  /** The values of an Apps entry as an object, or null when there is none. */
  async function readAppsEntry(key: string): Promise<Record<string, unknown> | null> {
    const { stdout } = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `if (Test-Path -LiteralPath '${key}') { ` +
          `$p = Get-ItemProperty -LiteralPath '${key}'; ` +
          "$o = [ordered]@{ DisplayName = $p.DisplayName; DisplayVersion = $p.DisplayVersion; " +
          "Publisher = $p.Publisher; InstallLocation = $p.InstallLocation; " +
          "UninstallString = $p.UninstallString }; " +
          "ConvertTo-Json -InputObject $o -Compress } else { 'null' }",
      ],
      { env: psEnv(), windowsHide: true, timeout: 60_000 },
    );
    return JSON.parse(stdout.trim()) as Record<string, unknown> | null;
  }

  const tmp = (prefix: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };

  const gitBash = findGitBash(process.env);
  // The tests that expect an installed Node to be reused need one that is new
  // enough; on an older machine the script (rightly) downloads its own.
  const hasNode26 = Number(process.versions.node.split(".")[0]) >= 26;

  /**
   * Runs the script. `hideTools` points every directory the script searches for
   * Node and Git at an empty one and strips PATH down to System32, so a Node
   * and a Git installed on the machine running this test are not found.
   */
  async function bootstrap(
    args: string[],
    opts: {
      env?: Record<string, string>;
      hideTools?: boolean;
      input?: string;
      script?: string;
      asScriptBlock?: boolean;
    } = {},
  ): Promise<Result> {
    const env: NodeJS.ProcessEnv = { ...psEnv(), ...opts.env };
    if (opts.hideTools) {
      const empty = tmp("bootstrap-empty-");
      const system32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
      for (const key of Object.keys(env)) {
        if (/^(path|programfiles|programw6432|programfiles\(x86\)|localappdata)$/i.test(key)) {
          delete env[key];
        }
      }
      Object.assign(env, {
        ProgramFiles: empty,
        ProgramW6432: empty,
        "ProgramFiles(x86)": empty,
        LOCALAPPDATA: empty,
        PATH: [system32, path.join(system32, "WindowsPowerShell", "v1.0")].join(path.delimiter),
      });
    }
    let appsKey = `HKCU:\\Software\\MullionTest-${crypto.randomUUID()}`;
    const given = args.indexOf("-UninstallRegistryKey");
    if (given >= 0) appsKey = args[given + 1]!;
    else args = [...args, "-UninstallRegistryKey", appsKey];
    appsKeys.push(appsKey);
    try {
      // Parameter names stay bare (a quoted -Json is a string, not a switch).
      const quoted = args
        .map((a) => (/^-[A-Za-z]+$/.test(a) ? a : `'${a.replaceAll("'", "''")}'`))
        .join(" ");
      const psArgs = opts.asScriptBlock
        ? [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `& ([scriptblock]::Create([IO.File]::ReadAllText('${SCRIPT}'))) ${quoted}`,
          ]
        : [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            opts.script ?? SCRIPT,
            ...args,
          ];
      const child = run("powershell.exe", psArgs, { env, windowsHide: true, timeout: 180_000 });
      if (opts.input !== undefined) {
        child.child.stdin?.end(opts.input);
      }
      const { stdout, stderr } = await child;
      return { code: 0, ...parse(stdout), stdout, stderr, appsKey };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return {
        code: e.code ?? 1,
        ...parse(e.stdout ?? ""),
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
        appsKey,
      };
    }
  }

  function parse(stdout: string): { events: Event[] } {
    const events: Event[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (line.startsWith("{")) events.push(JSON.parse(line) as Event);
    }
    return { events };
  }

  /**
   * A release-shaped directory whose mullion-install.sh records how it was
   * called (arguments, the relevant environment, and whether the private Node
   * came first on PATH) and writes the install.json the real installer would.
   */
  function fakeRelease() {
    const dir = tmp("bootstrap-release-");
    const record = path.join(dir, "record.json");
    const recorder = path.join(dir, "record.js");
    fs.writeFileSync(
      recorder,
      [
        'const fs = require("fs");',
        "const e = process.env;",
        "fs.writeFileSync(process.argv[2], JSON.stringify({",
        "  args: process.argv.slice(3),",
        "  tag: e.MULLION_INSTALL_TAG || null,",
        "  base: e.MULLION_INSTALL_BASE_URL || null,",
        "  primary: e.MULLION_AGENT_PRIMARY_URL || null,",
        "  name: e.MULLION_AGENT_NAME || null,",
        "  projects: e.MULLION_AGENT_PROJECTS_ROOTS || null,",
        "  advertise: e.MULLION_AGENT_ADVERTISE_URL || null,",
        "  token: e.MULLION_AGENT_ENROLLMENT_TOKEN || null,",
        "  agentToken: e.MULLION_AGENT_TOKEN || null,",
        "  host: e.MULLION_AGENT_HOST || null,",
        "  port: e.MULLION_AGENT_PORT || null,",
        "  gitBash: e.MULLION_INSTALL_GIT_BASH || null,",
        "  nodeExe: process.execPath,",
        "}));",
        "",
      ].join("\n"),
    );
    const posix = (p: string) => p.replaceAll("\\", "/");
    fs.writeFileSync(
      path.join(dir, "mullion-install.sh"),
      [
        "#!/bin/sh",
        "set -eu",
        'echo "stub installer running"',
        `node "${posix(recorder)}" "${posix(record)}" "$@"`,
        'root="$3"',
        'mkdir -p "$root"',
        `printf '{"role":"agent","version":"9.9.9","home":"%s","taskName":"MullionTest-stub-${crypto.randomUUID()}"}' "$root" > "$root/install.json"`,
        "",
      ].join("\n"),
    );
    return { dir, url: pathToFileURL(dir).href, record };
  }

  const installRoot = () => path.join(tmp("bootstrap-root-"), "Mullion home");

  describe("install", () => {
    it.skipIf(!gitBash || !hasNode26)(
      "reuses the Node and Git Bash it finds, hands the install to the release, and reports install.json",
      async () => {
        const release = fakeRelease();
        const root = installRoot();
        const res = await bootstrap(
          [
            "-Json",
            "-InstallRoot",
            root,
            "-ReleaseBaseUrl",
            release.url,
            "-Version",
            "0.3.51",
            "-PrimaryUrl",
            "https://primary.example",
            "-AgentName",
            "my pc",
            "-ProjectsRoots",
            "C:/src,D:/work",
            "-AdvertiseUrl",
            "http://10.0.0.5:3000",
          ],
          {
            env: {
              CLAUDE_CODE_GIT_BASH_PATH: gitBash!,
              MULLION_AGENT_ENROLLMENT_TOKEN: "s3cr3t-token",
            },
          },
        );
        expect(res.stderr).toBe("");
        expect(res.code).toBe(0);

        const byStep = (step: string) =>
          res.events.filter((e) => e.step === step).map((e) => e.status);
        expect(byStep("node")).toEqual(["start", "skip"]);
        expect(byStep("git-bash")).toEqual(["start", "skip"]);
        expect(res.events.some((e) => e.detail.includes("stub installer running"))).toBe(true);
        expect(fs.existsSync(path.join(root, "runtime"))).toBe(false);

        const done = res.events.at(-1)!;
        expect(done).toMatchObject({ step: "done", status: "ok", role: "agent", version: "9.9.9" });
        expect(done.gitBash).toBe(gitBash);

        const rec = JSON.parse(fs.readFileSync(release.record, "utf8"));
        // Compared as real paths: a CI runner's temp dir is an 8.3 short name
        // (C:\Users\RUNNER~1) that the script is given and the OS reports long.
        expect(rec.args.slice(0, 2)).toEqual(["--role", "agent"]);
        expect(realPath(rec.args[2])).toBe(realPath(root));
        expect(rec.args).toHaveLength(3);
        expect(rec).toMatchObject({
          tag: "v0.3.51",
          base: release.url,
          primary: "https://primary.example",
          name: "my pc",
          projects: "C:/src,D:/work",
          advertise: "http://10.0.0.5:3000",
          token: "s3cr3t-token",
          // A Git Bash that was already installed is not pinned into the .env.
          gitBash: null,
        });
        // The token travels in the environment only, never in the command line
        // or in what the script prints.
        expect(res.stdout).not.toContain("s3cr3t-token");
      },
      180_000,
    );

    it.skipIf(!gitBash || !hasNode26)(
      "takes the enrollment token from the first line of stdin",
      async () => {
        const release = fakeRelease();
        const res = await bootstrap(
          [
            "-Json",
            "-InstallRoot",
            installRoot(),
            "-ReleaseBaseUrl",
            release.url,
            "-TokenFromStdin",
          ],
          { env: { CLAUDE_CODE_GIT_BASH_PATH: gitBash! }, input: "from-stdin\nignored\n" },
        );
        expect(res.code).toBe(0);
        expect(JSON.parse(fs.readFileSync(release.record, "utf8")).token).toBe("from-stdin");
      },
      180_000,
    );

    it.skipIf(!gitBash || !hasNode26)(
      "generates a per-agent token on a fresh install and reports it exactly once",
      async () => {
        const release = fakeRelease();
        const root = installRoot();
        const res = await bootstrap(
          [
            "-Json",
            "-InstallRoot",
            root,
            "-ReleaseBaseUrl",
            release.url,
            "-BindHost",
            "10.0.0.5",
            "-Port",
            "4000",
          ],
          { env: { CLAUDE_CODE_GIT_BASH_PATH: gitBash! } },
        );
        expect(res.code).toBe(0);
        const done = res.events.at(-1)!;
        const token = String(done.agentToken);
        expect(token).toMatch(/^[0-9a-f]{64}$/);

        const rec = JSON.parse(fs.readFileSync(release.record, "utf8"));
        // The installer got it through its environment, with the bind address,
        // and never on its command line.
        expect(rec).toMatchObject({
          agentToken: token,
          host: "10.0.0.5",
          port: "4000",
          token: null,
        });
        expect(JSON.stringify(rec.args)).not.toContain(token);
        // Reported once: the final line, and nowhere else in what is printed.
        expect(res.stdout.split(token)).toHaveLength(2);
      },
      180_000,
    );

    it.skipIf(!gitBash || !hasNode26)(
      "prints a generated token once as text without -Json",
      async () => {
        const release = fakeRelease();
        const res = await bootstrap(
          ["-InstallRoot", installRoot(), "-ReleaseBaseUrl", release.url],
          {
            env: { CLAUDE_CODE_GIT_BASH_PATH: gitBash! },
          },
        );
        expect(res.code).toBe(0);
        const token = JSON.parse(fs.readFileSync(release.record, "utf8")).agentToken as string;
        expect(token).toMatch(/^[0-9a-f]{64}$/);
        expect(res.stdout.split(token)).toHaveLength(2);
      },
      180_000,
    );

    it.skipIf(!gitBash || !hasNode26)(
      "generates nothing when a token, an enrollment path or an existing .env is there",
      async () => {
        const cases: Array<{
          name: string;
          args: string[];
          env: Record<string, string>;
          env0?: boolean;
        }> = [
          { name: "agent token", args: [], env: { MULLION_AGENT_TOKEN: "given-by-caller" } },
          {
            name: "enrollment token",
            args: [],
            env: { MULLION_AGENT_ENROLLMENT_TOKEN: "enroll-tok" },
          },
          { name: "primary url", args: ["-PrimaryUrl", "https://primary.example"], env: {} },
          { name: "existing .env with a credential", args: [], env: {}, env0: true },
        ];
        for (const c of cases) {
          const release = fakeRelease();
          const root = installRoot();
          if (c.env0) {
            fs.mkdirSync(root, { recursive: true });
            fs.writeFileSync(path.join(root, ".env"), "MULLION_AGENT_TOKEN=already-there\n");
          }
          const res = await bootstrap(
            ["-Json", "-InstallRoot", root, "-ReleaseBaseUrl", release.url, ...c.args],
            { env: { CLAUDE_CODE_GIT_BASH_PATH: gitBash!, ...c.env } },
          );
          expect(res.code, c.name).toBe(0);
          expect(res.events.at(-1)!.agentToken, c.name).toBeUndefined();
          const rec = JSON.parse(fs.readFileSync(release.record, "utf8"));
          expect(rec.agentToken, c.name).toBe(c.env.MULLION_AGENT_TOKEN ?? null);
        }
      },
      240_000,
    );

    it.skipIf(!gitBash || !hasNode26)(
      "generates a token for an existing .env that has no credential",
      async () => {
        const release = fakeRelease();
        const root = installRoot();
        fs.mkdirSync(root, { recursive: true });
        // What a first run that failed halfway leaves behind.
        fs.writeFileSync(
          path.join(root, ".env"),
          "MULLION_ROLE=agent\nMULLION_AGENT_TOKEN=\nMULLION_PRIMARY_URL=\n",
        );
        const res = await bootstrap(
          ["-Json", "-InstallRoot", root, "-ReleaseBaseUrl", release.url],
          { env: { CLAUDE_CODE_GIT_BASH_PATH: gitBash! } },
        );
        expect(res.code).toBe(0);
        const token = String(res.events.at(-1)!.agentToken);
        expect(token).toMatch(/^[0-9a-f]{64}$/);
        expect(JSON.parse(fs.readFileSync(release.record, "utf8")).agentToken).toBe(token);
      },
      180_000,
    );

    it.skipIf(!gitBash || !hasNode26)(
      "refuses a -Port outside 1..65535 before doing anything",
      async () => {
        for (const port of ["0", "70000", "-5"]) {
          const root = installRoot();
          const res = await bootstrap(["-Json", "-InstallRoot", root, "-Port", port]);
          expect(res.code, port).toBe(2);
          expect(res.events.at(-1), port).toMatchObject({ status: "fail", exitCode: 2 });
          expect(fs.existsSync(root), port).toBe(false);
        }
      },
      120_000,
    );

    it.skipIf(!gitBash || !hasNode26)(
      "keeps a copy of the script when it runs as a script block, the way the one-liner does",
      async () => {
        const release = fakeRelease();
        const root = installRoot();
        const res = await bootstrap(
          ["-Json", "-InstallRoot", root, "-ReleaseBaseUrl", release.url],
          { env: { CLAUDE_CODE_GIT_BASH_PATH: gitBash! }, asScriptBlock: true },
        );
        expect(res.code).toBe(0);
        const copy = fs.readFileSync(path.join(root, "mullion-install.ps1"), "utf8");
        expect(copy.length).toBeGreaterThan(1000);
        expect(copy.replaceAll("\r\n", "\n")).toBe(
          fs.readFileSync(SCRIPT, "utf8").replaceAll("\r\n", "\n"),
        );
        expect(await readAppsEntry(res.appsKey)).toMatchObject({ DisplayName: "Mullion agent" });
      },
      180_000,
    );

    it.skipIf(!gitBash || !hasNode26)(
      "warns when the advertise URL has no bind address behind it",
      async () => {
        const release = fakeRelease();
        const res = await bootstrap(
          [
            "-Json",
            "-InstallRoot",
            installRoot(),
            "-ReleaseBaseUrl",
            release.url,
            "-AdvertiseUrl",
            "http://192.168.1.20:4000",
          ],
          { env: { CLAUDE_CODE_GIT_BASH_PATH: gitBash! } },
        );
        expect(res.code).toBe(0);
        expect(
          res.events.some(
            (e) => e.status === "log" && e.detail.startsWith("warning: -AdvertiseUrl"),
          ),
        ).toBe(true);
      },
      180_000,
    );

    it.skipIf(!gitBash || !hasNode26)(
      "adds a Settings -> Apps entry that points at a kept copy of the script, and -Uninstall removes it",
      async () => {
        const release = fakeRelease();
        const root = installRoot();
        const res = await bootstrap(
          ["-Json", "-InstallRoot", root, "-ReleaseBaseUrl", release.url],
          { env: { CLAUDE_CODE_GIT_BASH_PATH: gitBash! } },
        );
        expect(res.code).toBe(0);

        const entry = await readAppsEntry(res.appsKey);
        expect(entry).toMatchObject({
          DisplayName: "Mullion agent",
          DisplayVersion: "9.9.9",
          Publisher: "Mullion",
        });
        expect(realPath(String(entry!.InstallLocation))).toBe(realPath(root));
        const copy = path.join(root, "mullion-install.ps1");
        expect(fs.existsSync(copy)).toBe(true);
        expect(String(entry!.UninstallString)).toContain("-Uninstall");
        expect(String(entry!.UninstallString)).toContain("mullion-install.ps1");

        // What Settings -> Apps runs: the kept copy, not the original script.
        const gone = await bootstrap(
          ["-Json", "-Uninstall", "-InstallRoot", root, "-UninstallRegistryKey", res.appsKey],
          { script: copy },
        );
        expect(gone.code).toBe(0);
        expect(await readAppsEntry(res.appsKey)).toBeNull();
        expect(fs.existsSync(copy)).toBe(false);
      },
      240_000,
    );

    it.skipIf(!gitBash || !hasNode26)(
      "downloads, verifies and uses a private Node when none is installed",
      async () => {
        const release = fakeRelease();
        const root = installRoot();

        // A "Node download": a zip with one folder holding a copy of this Node.
        const stage = tmp("bootstrap-nodezip-");
        const inner = path.join(stage, "node-v99.0.0-win-x64");
        fs.mkdirSync(inner);
        fs.copyFileSync(process.execPath, path.join(inner, "node.exe"));
        const zip = path.join(tmp("bootstrap-zip-"), "node.zip");
        await run(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `Compress-Archive -LiteralPath '${inner}' -DestinationPath '${zip}'`,
          ],
          { env: psEnv(), windowsHide: true, timeout: 120_000 },
        );

        const res = await bootstrap(
          [
            "-Json",
            "-InstallRoot",
            root,
            "-ReleaseBaseUrl",
            release.url,
            "-NodeZipUrl",
            pathToFileURL(zip).href,
            "-NodeZipSha256",
            sha256(zip),
          ],
          { env: { CLAUDE_CODE_GIT_BASH_PATH: gitBash! }, hideTools: true },
        );
        expect(res.stderr).toBe("");
        expect(res.code).toBe(0);
        const privateNode = path.join(root, "runtime", "node", "node.exe");
        expect(fs.existsSync(privateNode)).toBe(true);
        expect(res.events.filter((e) => e.step === "node").map((e) => e.status)).toContain("ok");
        // The release installer ran with the private Node first on PATH.
        const rec = JSON.parse(fs.readFileSync(release.record, "utf8"));
        expect(realPath(String(rec.nodeExe))).toBe(realPath(privateNode));
        // No leftovers from the download.
        expect(fs.readdirSync(path.join(root, "runtime"))).toEqual(["node"]);
      },
      240_000,
    );

    it("fails closed on a Node download whose checksum differs, and deletes it", async () => {
      const release = fakeRelease();
      const root = installRoot();
      const bogus = path.join(tmp("bootstrap-bogus-"), "node.zip");
      fs.writeFileSync(bogus, "not a zip");
      const res = await bootstrap(
        [
          "-Json",
          "-InstallRoot",
          root,
          "-ReleaseBaseUrl",
          release.url,
          "-NodeZipUrl",
          pathToFileURL(bogus).href,
          "-NodeZipSha256",
          "0".repeat(64),
        ],
        // Git Bash is found (or, on a machine without one, the Git step fails
        // first with its own download error -- so only run the Node step).
        { env: { CLAUDE_CODE_GIT_BASH_PATH: gitBash ?? "" }, hideTools: true },
      );
      if (!gitBash) return;
      expect(res.code).toBe(3);
      const fail = res.events.at(-1)!;
      expect(fail).toMatchObject({ step: "node", status: "fail", exitCode: 3 });
      expect(fail.detail).toMatch(/checksum mismatch/);
      expect(fs.existsSync(path.join(root, "runtime", "node.zip"))).toBe(false);
      expect(fs.existsSync(path.join(root, "runtime", "node"))).toBe(false);
    }, 180_000);

    it("fails closed on a Git download whose checksum differs", async () => {
      const release = fakeRelease();
      const root = installRoot();
      const bogus = path.join(tmp("bootstrap-bogus-"), "PortableGit.7z.exe");
      fs.writeFileSync(bogus, "not an executable");
      const res = await bootstrap(
        [
          "-Json",
          "-InstallRoot",
          root,
          "-ReleaseBaseUrl",
          release.url,
          "-GitUrl",
          pathToFileURL(bogus).href,
          "-GitSha256",
          "0".repeat(64),
        ],
        { hideTools: true },
      );
      expect(res.code).toBe(3);
      expect(res.events.at(-1)).toMatchObject({ step: "git-bash", status: "fail", exitCode: 3 });
      expect(fs.existsSync(path.join(root, "runtime", "PortableGit.7z.exe"))).toBe(false);
      // The bogus "installer" was never run.
      expect(fs.existsSync(path.join(root, "runtime", "git"))).toBe(false);
    }, 120_000);

    it.skipIf(!hasNode26)(
      "reports a release it cannot download, with the download exit code",
      async () => {
        const res = await bootstrap(
          [
            "-Json",
            "-InstallRoot",
            installRoot(),
            "-ReleaseBaseUrl",
            pathToFileURL(path.join(tmp("bootstrap-missing-"), "nowhere")).href,
          ],
          { env: { CLAUDE_CODE_GIT_BASH_PATH: gitBash ?? "" } },
        );
        if (!gitBash) return;
        expect(res.code).toBe(3);
        expect(res.events.at(-1)).toMatchObject({ step: "fetch", status: "fail", exitCode: 3 });
      },
      120_000,
    );

    it.skipIf(!gitBash || !hasNode26)(
      "exits 4 when the release's installer fails",
      async () => {
        const release = fakeRelease();
        fs.writeFileSync(path.join(release.dir, "mullion-install.sh"), "echo boom >&2\nexit 7\n");
        const res = await bootstrap(
          ["-Json", "-InstallRoot", installRoot(), "-ReleaseBaseUrl", release.url],
          { env: { CLAUDE_CODE_GIT_BASH_PATH: gitBash! } },
        );
        expect(res.code).toBe(4);
        expect(res.events.some((e) => e.step === "install" && e.detail === "boom")).toBe(true);
        expect(res.events.at(-1)).toMatchObject({ step: "install", status: "fail", exitCode: 4 });
      },
      120_000,
    );

    it.skipIf(!hasNode26)(
      "prints plain text, not JSON, without -Json",
      async () => {
        const res = await bootstrap(
          ["-InstallRoot", installRoot(), "-ReleaseBaseUrl", "file:///nope/"],
          {
            env: { CLAUDE_CODE_GIT_BASH_PATH: gitBash ?? "" },
          },
        );
        expect(res.events).toEqual([]);
        expect(res.stdout).toContain("==> platform");
      },
      120_000,
    );
  });

  describe("-Uninstall", () => {
    /** An install root shaped like a finished install, with `current` a junction to a release outside it. */
    function installed() {
      const root = installRoot();
      fs.mkdirSync(path.join(root, "data", "sessions"), { recursive: true });
      fs.mkdirSync(path.join(root, "runtime", "node"), { recursive: true });
      fs.mkdirSync(path.join(root, "logs"), { recursive: true });
      fs.writeFileSync(path.join(root, ".env"), "MULLION_ROLE=agent\n");
      fs.writeFileSync(path.join(root, "data", "sessions", "keep.txt"), "x");
      fs.writeFileSync(path.join(root, "logs", "mullion.log"), "x");
      fs.writeFileSync(
        path.join(root, "install.json"),
        JSON.stringify({ taskName: "MullionTest-none", role: "agent" }),
      );
      const release = tmp("bootstrap-release-target-");
      fs.writeFileSync(path.join(release, "server.js"), "// keep me\n");
      fs.symlinkSync(release, path.join(root, "current"), "junction");
      return { root, release };
    }

    it("removes what Mullion wrote, keeps data, .env and the runtime, and never follows the junction", async () => {
      const { root, release } = installed();
      const res = await bootstrap(["-Json", "-Uninstall", "-InstallRoot", root]);
      expect(res.code).toBe(0);
      expect(fs.existsSync(path.join(root, "current"))).toBe(false);
      expect(fs.existsSync(path.join(root, "logs"))).toBe(false);
      expect(fs.existsSync(path.join(root, "install.json"))).toBe(false);
      expect(fs.readdirSync(root).sort()).toEqual([".env", "data", "runtime"]);
      // The junction was removed as a link: its target is untouched.
      expect(fs.readFileSync(path.join(release, "server.js"), "utf8")).toBe("// keep me\n");
      expect(res.events.at(-1)).toMatchObject({
        step: "done",
        status: "ok",
        kept: [".env", "data", "runtime"],
      });
    }, 120_000);

    it("-Purge removes everything, down to the install root", async () => {
      const { root } = installed();
      const res = await bootstrap(["-Json", "-Uninstall", "-Purge", "-InstallRoot", root]);
      expect(res.code).toBe(0);
      expect(fs.existsSync(root)).toBe(false);
    }, 120_000);

    it("refuses a drive root as the install root, before touching anything", async () => {
      for (const extra of [[], ["-Uninstall"]]) {
        const res = await bootstrap(["-Json", ...extra, "-InstallRoot", "C:\\"]);
        expect(res.code).toBe(2);
        expect(res.events.at(-1)).toMatchObject({ step: "platform", status: "fail", exitCode: 2 });
      }
    }, 120_000);

    it("refuses a bare drive or a relative path as the install root", async () => {
      for (const root of ["C:", "relative\\folder"]) {
        const res = await bootstrap(["-Json", "-Uninstall", "-InstallRoot", root]);
        expect(res.code).toBe(2);
        expect(res.events.at(-1)).toMatchObject({ step: "platform", status: "fail", exitCode: 2 });
      }
    }, 120_000);

    it("ends a -Json run with a fail line even on an unexpected error", async () => {
      const res = await bootstrap(["-Json", "-Uninstall", "-InstallRoot", "C:\\bad|path"]);
      expect(res.code).toBe(1);
      expect(res.events.at(-1)).toMatchObject({ step: "unexpected", status: "fail", exitCode: 1 });
    }, 120_000);

    it("leaves the scheduled task registered when it refuses", async () => {
      const { root } = installed();
      const taskName = `MullionBootstrapTest-${process.pid}`;
      fs.writeFileSync(path.join(root, "install.json"), JSON.stringify({ taskName }));
      await run(
        "schtasks",
        [
          "/Create",
          "/TN",
          taskName,
          "/TR",
          `cmd /c rem "${path.join(root, "current", "scripts", "launcher.mjs")}"`,
          "/SC",
          "ONCE",
          "/ST",
          "23:59",
          "/F",
        ],
        {
          windowsHide: true,
        },
      );
      try {
        const script = path.join(root, "data", "sessions", "master.js");
        fs.writeFileSync(script, "setInterval(() => {}, 1000);\n");
        const master = spawn(process.execPath, [script], { stdio: "ignore", windowsHide: true });
        children.push(master);
        await new Promise((r) => setTimeout(r, 500));

        const refused = await bootstrap(["-Json", "-Uninstall", "-InstallRoot", root]);
        expect(refused.code).toBe(5);
        // Nothing was half-done: no "removed the scheduled task", and it is still there.
        expect(refused.events.some((e) => e.detail.includes("removed the scheduled task"))).toBe(
          false,
        );
        await run("schtasks", ["/Query", "/TN", taskName], { windowsHide: true });
      } finally {
        await run("schtasks", ["/Delete", "/TN", taskName, "/F"], { windowsHide: true }).catch(
          () => {},
        );
      }
    }, 180_000);

    it("leaves a scheduled task alone that does not run from this install root", async () => {
      // The task name comes from install.json (or the default, Mullion-agent), so
      // an uninstall of one root must not take down the agent of another.
      const { root } = installed();
      const taskName = `MullionBootstrapOther-${process.pid}`;
      fs.writeFileSync(path.join(root, "install.json"), JSON.stringify({ taskName }));
      await run(
        "schtasks",
        [
          "/Create",
          "/TN",
          taskName,
          "/TR",
          'cmd /c rem "C:\\somewhere\\else"',
          "/SC",
          "ONCE",
          "/ST",
          "23:59",
          "/F",
        ],
        { windowsHide: true },
      );
      try {
        const res = await bootstrap(["-Json", "-Uninstall", "-InstallRoot", root]);
        expect(res.code).toBe(0);
        expect(res.events.some((e) => e.detail.includes(`${taskName} does not run from`))).toBe(
          true,
        );
        expect(res.events.some((e) => e.detail.includes("removed the scheduled task"))).toBe(false);
        await run("schtasks", ["/Query", "/TN", taskName], { windowsHide: true });
      } finally {
        await run("schtasks", ["/Delete", "/TN", taskName, "/F"], { windowsHide: true }).catch(
          () => {},
        );
      }
    }, 180_000);

    it("removes the scheduled task that does run from the install root", async () => {
      const { root } = installed();
      const taskName = `MullionBootstrapOwn-${process.pid}`;
      fs.writeFileSync(path.join(root, "install.json"), JSON.stringify({ taskName }));
      await run(
        "schtasks",
        [
          "/Create",
          "/TN",
          taskName,
          "/TR",
          `cmd /c rem "${path.join(root, "current", "scripts", "launcher.mjs")}"`,
          "/SC",
          "ONCE",
          "/ST",
          "23:59",
          "/F",
        ],
        { windowsHide: true },
      );
      try {
        const res = await bootstrap(["-Json", "-Uninstall", "-InstallRoot", root]);
        expect(res.code).toBe(0);
        expect(res.events.some((e) => e.detail.includes("removed the scheduled task"))).toBe(true);
        await expect(
          run("schtasks", ["/Query", "/TN", taskName], { windowsHide: true }),
        ).rejects.toThrow();
      } finally {
        await run("schtasks", ["/Delete", "/TN", taskName, "/F"], { windowsHide: true }).catch(
          () => {},
        );
      }
    }, 180_000);

    it("has nothing to do for a root that does not exist", async () => {
      const res = await bootstrap(["-Json", "-Uninstall", "-InstallRoot", installRoot()]);
      expect(res.code).toBe(0);
      expect(res.events.at(-1)).toMatchObject({ step: "done", status: "ok" });
    }, 120_000);

    it("refuses while a process still runs from the install root, and ends it with -Force", async () => {
      const { root } = installed();
      // A stand-in for a session's pty-host master: a node process whose
      // command line names a file under the install root.
      const script = path.join(root, "data", "sessions", "master.js");
      fs.writeFileSync(script, "setInterval(() => {}, 1000);\n");
      const master = spawn(process.execPath, [script], { stdio: "ignore", windowsHide: true });
      children.push(master);
      await new Promise((r) => setTimeout(r, 500));

      const key = `HKCU:\\Software\\MullionTest-${crypto.randomUUID()}`;
      appsKeys.push(key);
      await run(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", `New-Item -Path '${key}' -Force | Out-Null`],
        { env: psEnv(), windowsHide: true, timeout: 60_000 },
      );

      const refused = await bootstrap([
        "-Json",
        "-Uninstall",
        "-InstallRoot",
        root,
        "-UninstallRegistryKey",
        key,
      ]);
      expect(refused.code).toBe(5);
      // The operator will click Uninstall again, so the entry must still be there.
      expect(await readAppsEntry(key)).not.toBeNull();
      expect(refused.events.at(-1)).toMatchObject({
        step: "uninstall",
        status: "fail",
        exitCode: 5,
      });
      expect(fs.existsSync(script)).toBe(true);

      const forced = await bootstrap([
        "-Json",
        "-Uninstall",
        "-Force",
        "-InstallRoot",
        root,
        "-UninstallRegistryKey",
        key,
      ]);
      expect(forced.code).toBe(0);
      expect(await readAppsEntry(key)).toBeNull();
      for (let i = 0; i < 50 && master.exitCode === null && master.signalCode === null; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(master.exitCode !== null || master.signalCode !== null).toBe(true);
    }, 180_000);
  });
});
