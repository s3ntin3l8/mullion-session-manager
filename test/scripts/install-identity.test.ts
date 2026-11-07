// Issue #2452 — an Ansible reconverge, a restart-driven rerun and an upgrade
// must leave the enrolled machine identity (SESSIONS_DIR's agent-identity.json)
// and the .env that owns the bootstrap credential alone, and must never put a
// secret in a process argument or an install log.
//
// Same sandbox rules as install.test.ts (issue #1469: an unsandboxed run of
// this script once overwrote a real user unit): $HOME is a temp dir and every
// command that could reach the network, a build or a real systemd manager is
// a shim on PATH, asserted before each run. The harness is deliberately
// minimal and separate so install.test.ts stays under its size ceiling.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const INSTALL_SCRIPT = fileURLToPath(new URL("../../deploy/install.sh", import.meta.url));
const describeOnLinux = process.platform === "linux" ? describe : describe.skip;

const ENROLL_TOKEN = "fixture-enroll-tok"; // pragma: allowlist secret
const ROTATED_TOKEN = "fixture-rotated-tok"; // pragma: allowlist secret
const IDENTITY = JSON.stringify({
  hostId: "host-fixture-1",
  machineCredential: "ab".repeat(32), // pragma: allowlist secret
});
// A headless Ansible role: self-registration inputs, no URL, host or port.
const ansibleEnv = {
  MULLION_AGENT_PROJECTS_ROOTS: "/srv/projects",
  MULLION_AGENT_PRIMARY_URL: "https://primary.example.com",
  MULLION_AGENT_ENROLLMENT_TOKEN: ENROLL_TOKEN,
  MULLION_AGENT_NAME: "agent-1",
};

function writeShim(binDir: string, name: string, script: string) {
  const p = path.join(binDir, name);
  fs.writeFileSync(p, script);
  fs.chmodSync(p, 0o755);
}

describeOnLinux("deploy/install.sh reruns keep the enrolled identity (issue #2452)", () => {
  let fakeHome: string;
  let binDir: string;
  let xdgRuntimeDir: string;
  let baseEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "install-id-home-"));
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-id-bin-"));
    xdgRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-id-xdg-"));
    // Every invocation (arguments only) is logged so a test can prove no secret
    // ever appears in a process argument.
    const log = (name: string) =>
      `#!/usr/bin/env bash\nDIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"\necho "${name} $*" >> "$DIR/commands.log"\n`;
    writeShim(
      binDir,
      "curl",
      `${log("curl")}for a in "$@"; do case "$a" in *api.github.com*) cat "$DIR/release.json"; exit 0;; esac; done\necho "unexpected curl" >&2\nexit 1\n`,
    );
    for (const name of ["npm", "npx"]) {
      writeShim(binDir, name, `${log(name)}echo "unexpected ${name}" >&2\nexit 1\n`);
    }
    for (const name of ["dtach", "systemd-run"]) writeShim(binDir, name, `${log(name)}exit 0\n`);
    // is-enabled/is-active report "not found" so the disable-other-unit branch stays out.
    writeShim(
      binDir,
      "systemctl",
      `${log("systemctl")}case "$*" in *is-enabled*|*is-active*) exit 1;; *) exit 0;; esac\n`,
    );
    fs.copyFileSync(process.execPath, path.join(binDir, "node"));
    fs.chmodSync(path.join(binDir, "node"), 0o755);
    fs.writeFileSync(
      path.join(binDir, "release.json"),
      JSON.stringify({
        tag_name: "v9.9.9",
        assets: [
          { name: "mullion-9.9.9.tgz", browser_download_url: "file:///unused.tgz" },
          { name: "mullion-9.9.9.tgz.sha256", browser_download_url: "file:///unused.sha256" },
        ],
      }),
    );

    baseEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!k.startsWith("MULLION_")) baseEnv[k] = v;
    }
    baseEnv.PATH = [
      binDir,
      "/usr/local/sbin",
      "/usr/local/bin",
      "/usr/sbin",
      "/usr/bin",
      "/sbin",
      "/bin",
    ].join(":");
    baseEnv.HOME = fakeHome;
    baseEnv.XDG_RUNTIME_DIR = xdgRuntimeDir;
    delete baseEnv.DBUS_SESSION_BUS_ADDRESS;
  });

  afterEach(() => {
    for (const d of [fakeHome, binDir, xdgRuntimeDir])
      fs.rmSync(d, { recursive: true, force: true });
  });

  async function assertSandboxed(env: NodeJS.ProcessEnv) {
    const dangerous = ["systemctl", "systemd-run", "curl", "npm", "npx", "dtach"];
    const { stdout } = await execFileAsync(
      "bash",
      ["-c", dangerous.map((c) => `command -v ${c}`).join("; ")],
      { env },
    );
    const resolved = stdout.trim().split("\n").filter(Boolean);
    expect(resolved).toHaveLength(dangerous.length);
    for (const p of resolved) expect(path.dirname(p)).toBe(binDir);
    expect(env.HOME).not.toBe(os.homedir());
  }

  async function run(
    mullionHome: string,
    env: Record<string, string> = ansibleEnv,
    stdin: string = "",
  ) {
    const full: NodeJS.ProcessEnv = { ...baseEnv, ...env };
    await assertSandboxed(full);
    const pending = execFileAsync("bash", [INSTALL_SCRIPT, "--role", "agent", mullionHome], {
      env: full,
      timeout: 20_000,
    });
    pending.child.stdin?.end(stdin);
    return pending;
  }

  // Pre-created releases skip the download-and-build branch (install.test.ts).
  function freshHome(): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-id-mullionhome-"));
    for (const v of ["9.9.9", "9.9.10"])
      fs.mkdirSync(path.join(home, "releases", v), { recursive: true });
    return home;
  }
  const identityFile = (home: string) => path.join(home, "data", "sessions", "agent-identity.json");
  const envFile = (home: string) => fs.readFileSync(path.join(home, ".env"), "utf8");

  it("leaves agent-identity.json byte- and mtime-identical across a rerun, an upgrade and a rotated variable", async () => {
    const home = freshHome();
    await run(home);

    // The agent enrolls after the first install. Pin the mtime in the past so
    // any rewrite, even a byte-identical one, is detectable.
    const file = identityFile(home);
    fs.writeFileSync(file, IDENTITY, { mode: 0o600 });
    const past = new Date("2024-01-01T00:00:00Z");
    fs.utimesSync(file, past, past);
    const envBefore = envFile(home);

    await run(home); // Ansible reconverge
    await run(home, { ...ansibleEnv, MULLION_INSTALL_TAG: "v9.9.10" }); // upgrade
    expect(fs.readlinkSync(path.join(home, "current"))).toMatch(/releases\/9\.9\.10$/);
    await run(home, { ...ansibleEnv, MULLION_AGENT_ENROLLMENT_TOKEN: ROTATED_TOKEN });

    expect(fs.readFileSync(file, "utf8")).toBe(IDENTITY);
    expect(fs.statSync(file).mtimeMs).toBe(past.getTime());
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // The .env keeps ownership of the bootstrap credential.
    expect(envFile(home)).toBe(envBefore);
    expect(envFile(home)).not.toContain(ROTATED_TOKEN);
  });

  it("writes no URL, host or port for a headless install, and keeps that on a rerun", async () => {
    const home = freshHome();
    await run(home);
    const env = envFile(home);
    expect(env).not.toMatch(/^(HOST|PORT|MULLION_AGENT_ADVERTISE_URL)=/m);
    fs.writeFileSync(identityFile(home), IDENTITY);
    await run(home);
    expect(fs.readFileSync(identityFile(home), "utf8")).toBe(IDENTITY);
    expect(envFile(home)).toBe(env);
  });

  it("keeps the enrollment secret out of every process argument and the install log", async () => {
    const home = freshHome();
    const first = await run(home);
    const second = await run(home, { ...ansibleEnv, MULLION_INSTALL_TAG: "v9.9.10" });
    const commands = fs.readFileSync(path.join(binDir, "commands.log"), "utf8");
    expect(commands).toContain("systemctl"); // the shims really were exercised
    expect(commands).not.toContain(ENROLL_TOKEN);
    expect(first.stdout + first.stderr + second.stdout + second.stderr).not.toContain(ENROLL_TOKEN);
    // It is only ever in the owner-only .env.
    expect(envFile(home)).toContain(`MULLION_ENROLLMENT_TOKEN=${ENROLL_TOKEN}`);
    expect(fs.statSync(path.join(home, ".env")).mode & 0o777).toBe(0o600);
  });

  it("changes the bootstrap credential only when Ansible removes the .env, and still leaves the identity", async () => {
    const home = freshHome();
    await run(home);
    fs.writeFileSync(identityFile(home), IDENTITY);

    fs.rmSync(path.join(home, ".env"));
    await run(home, { ...ansibleEnv, MULLION_AGENT_ENROLLMENT_TOKEN: ROTATED_TOKEN });

    expect(envFile(home)).toMatch(new RegExp(`^MULLION_ENROLLMENT_TOKEN=${ROTATED_TOKEN}$`, "m"));
    expect(fs.readFileSync(identityFile(home), "utf8")).toBe(IDENTITY);
  });

  it("keeps a legacy inbound install's settings on a rerun (advertised URL, host and port)", async () => {
    const home = freshHome();
    const legacy = {
      ...ansibleEnv,
      MULLION_AGENT_ADVERTISE_URL: "https://agent.example.com",
      MULLION_AGENT_HOST: "0.0.0.0",
      MULLION_AGENT_PORT: "4000",
    };
    await run(home, legacy);
    const env = envFile(home);
    expect(env).toMatch(/^MULLION_AGENT_ADVERTISE_URL=https:\/\/agent\.example\.com$/m);
    expect(env).toMatch(/^PORT=4000$/m);
    await run(home, legacy);
    // HOST/PORT are re-applied from the run (documented), never duplicated.
    const again = envFile(home);
    expect(again.match(/^HOST=/gm)).toHaveLength(1);
    expect(again).toMatch(/^HOST=0\.0\.0\.0$/m);
    expect(again).toMatch(/^PORT=4000$/m);
    expect(again).toMatch(/^MULLION_AGENT_ADVERTISE_URL=https:\/\/agent\.example\.com$/m);
    expect(again).toMatch(/^MULLION_ENROLLMENT_TOKEN=fixture-enroll-tok$/m);
  });

  // Issue #2703 — the stdin token input (the Windows bootstrap's -TokenFromStdin,
  // for the shell installer) and the restart of a running unit.
  const { MULLION_AGENT_ENROLLMENT_TOKEN: _omit, ...noTokenEnv } = ansibleEnv;

  it("reads the enrollment token from the first line of stdin, never from an argument or the log", async () => {
    const home = freshHome();
    const result = await run(
      home,
      { ...noTokenEnv, MULLION_AGENT_ENROLLMENT_TOKEN_STDIN: "1" },
      `${ROTATED_TOKEN}\r\nsecond line ignored\n`,
    );
    expect(envFile(home)).toMatch(new RegExp(`^MULLION_ENROLLMENT_TOKEN=${ROTATED_TOKEN}$`, "m"));
    expect(envFile(home)).not.toContain("second line");
    const commands = fs.readFileSync(path.join(binDir, "commands.log"), "utf8");
    expect(commands).not.toContain(ROTATED_TOKEN);
    expect(result.stdout + result.stderr).not.toContain(ROTATED_TOKEN);
  });

  it("refuses an empty stdin token instead of writing a credential-less .env", async () => {
    const home = freshHome();
    await expect(
      run(home, { ...noTokenEnv, MULLION_AGENT_ENROLLMENT_TOKEN_STDIN: "1" }, "\n"),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("stdin carried no token") });
    expect(fs.existsSync(path.join(home, ".env"))).toBe(false);
  });

  it("restarts a running unit when it rewrote the .env, and leaves an untouched .env's unit alone", async () => {
    const home = freshHome();
    await run(home);
    // From here on the unit reports active.
    writeShim(
      binDir,
      "systemctl",
      `#!/usr/bin/env bash\nDIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"\necho "systemctl $*" >> "$DIR/commands.log"\ncase "$*" in *"is-enabled mullion.service"*|*"is-active mullion.service"*) exit 1;; *is-enabled*|*is-active*) exit 0;; *) exit 0;; esac\n`,
    );
    const restarts = () =>
      fs
        .readFileSync(path.join(binDir, "commands.log"), "utf8")
        .split("\n")
        .filter((l) => l.includes("restart mullion-agent.service")).length;

    await run(home); // .env kept as is
    expect(restarts()).toBe(0);

    fs.rmSync(path.join(home, ".env")); // the revoked-agent recipe
    await run(home, { ...ansibleEnv, MULLION_AGENT_ENROLLMENT_TOKEN: ROTATED_TOKEN });
    expect(restarts()).toBe(1);
  });
});
