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
}

describeOnWindows("deploy/windows/mullion-install.ps1", () => {
  const dirs: string[] = [];
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) child.kill();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

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
    opts: { env?: Record<string, string>; hideTools?: boolean; input?: string } = {},
  ): Promise<Result> {
    const env: NodeJS.ProcessEnv = { ...windowsPowerShellEnv(process.env), ...opts.env };
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
    try {
      const child = run(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, ...args],
        { env, windowsHide: true, timeout: 180_000 },
      );
      if (opts.input !== undefined) {
        child.child.stdin?.end(opts.input);
      }
      const { stdout, stderr } = await child;
      return { code: 0, ...parse(stdout), stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return {
        code: e.code ?? 1,
        ...parse(e.stdout ?? ""),
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
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
        `printf '{"role":"agent","version":"9.9.9","home":"%s","taskName":"Mullion-agent"}' "$root" > "$root/install.json"`,
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
        expect(rec.args).toEqual(["--role", "agent", root.replace(/\\/g, "/")]);
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
          { env: windowsPowerShellEnv(process.env), windowsHide: true, timeout: 120_000 },
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
        expect(String(rec.nodeExe).toLowerCase()).toBe(privateNode.toLowerCase());
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

      const refused = await bootstrap(["-Json", "-Uninstall", "-InstallRoot", root]);
      expect(refused.code).toBe(5);
      expect(refused.events.at(-1)).toMatchObject({
        step: "uninstall",
        status: "fail",
        exitCode: 5,
      });
      expect(fs.existsSync(script)).toBe(true);

      const forced = await bootstrap(["-Json", "-Uninstall", "-Force", "-InstallRoot", root]);
      expect(forced.code).toBe(0);
      for (let i = 0; i < 50 && master.exitCode === null && master.signalCode === null; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(master.exitCode !== null || master.signalCode !== null).toBe(true);
    }, 180_000);
  });
});
