// Issue #1469 — deploy/install.sh had zero automated coverage before this.
// That issue's own history is the reason this suite is paranoid about
// sandboxing: a previous *manual* run of this exact script, verified by
// eyeballing output rather than an automated harness, was run unsandboxed
// against a real shared dev host and overwrote that host's real, running
// ~/.config/systemd/user/mullion.service — a host-global path independent
// of the script's own <mullion-home> argument. Every test below runs with
// $HOME redirected to a fresh temp dir and systemctl/systemd-run/npm/npx/
// curl/dtach stubbed on PATH, so the script can never reach a real
// systemd --user manager or the network. assertSandboxed() — exercised by
// its own dedicated test AND re-run before every single script invocation
// via runScript() — is what actually proves those shims resolve ahead of
// the real system binaries, rather than just assuming the PATH setup
// worked.
//
// Every test pre-creates releases/<version> so the download-and-build
// branch (curl asset download, sha256sum -c, tar, npm ci, playwright
// install) is never reached at all — that branch's *content* isn't this
// suite's concern (it's a real npm ci against a real tarball, which is
// exactly the kind of slow, network-dependent step this harness exists to
// avoid). What's covered here is the "reuses it" branch, the .env
// generation logic for both roles (including the #1458 regression this
// issue's own history references), the existing-.env passthrough, the
// systemd unit's CHANGEME substitution, argument validation, and the
// systemctl invocation sequence.
//
// Linux-only, like test/scripts/self-update.test.ts: GNU `mv -T`, `sed`
// BRE behavior, and the general systemd --user assumptions this script
// makes aren't portable to macOS/BSD.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const INSTALL_SCRIPT = fileURLToPath(new URL("../../deploy/install.sh", import.meta.url));
const LAUNCHER_SCRIPT = fileURLToPath(new URL("../../scripts/run-with-env.sh", import.meta.url));

const describeOnLinux = process.platform === "linux" ? describe : describe.skip;

function writeShim(binDir: string, name: string, script: string) {
  const p = path.join(binDir, name);
  fs.writeFileSync(p, script);
  fs.chmodSync(p, 0o755);
}

// Only the commands that could reach the network, run a slow real install,
// or touch the host's real systemd are stubbed — everything else (mkdir,
// tar, sed, grep, ln, mv, chmod, sha256sum) runs for real against real temp
// directories, same shape as self-update.test.ts's own writeShims.
function writeShims(binDir: string) {
  // Serves the one real curl call this suite ever lets through: the GitHub
  // "latest release" lookup. Every test pre-creates releases/<version>, so
  // the actual asset/checksum download branch is never reached — anything
  // else this shim sees is a bug in a test or in the script, so it fails
  // closed instead of silently reaching the real network.
  writeShim(
    binDir,
    "curl",
    `#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
for arg in "$@"; do
  case "$arg" in
    *api.github.com*)
      cat "$DIR/release.json"
      exit 0
      ;;
  esac
done
echo "unexpected curl invocation, refusing: $*" >&2
exit 1
`,
  );
  // npm/npx must never actually run in this suite — every test pre-creates
  // releases/<version> to skip the download-and-build branch entirely.
  // Exiting 1 (not 0) means an accidental real invocation fails the test
  // loudly instead of silently "succeeding".
  for (const name of ["npm", "npx"]) {
    writeShim(binDir, name, `#!/usr/bin/env bash\necho "unexpected $0 invocation" >&2\nexit 1\n`);
  }
  // Only ever \`command -v\`'d by the prerequisite check — never actually
  // invoked by install.sh itself (systemd-run is invoked at session-spawn
  // time by src/services/pty-manager.ts, not by this script; dtach is
  // invoked by that same runtime path). Real content doesn't matter, but a
  // stock CI runner doesn't have dtach installed at all, so without this
  // shim the prerequisite check fails in CI even though the real dtach
  // binary is never touched either way.
  for (const name of ["dtach", "systemd-run"]) {
    writeShim(binDir, name, "#!/usr/bin/env bash\nexit 0\n");
  }
  // systemctl — the command this repo's own history (issue #1469) got
  // burned by. Every invocation is appended to systemctl.log so tests can
  // assert on the exact sequence without ever touching a real systemd
  // --user manager. is-enabled/is-active report "not found" (exit 1) by
  // default, which keeps the disable-other-unit branch out of every test
  // that isn't specifically exercising it (a dedicated test overwrites this
  // shim to exercise that branch).
  writeShim(
    binDir,
    "systemctl",
    `#!/usr/bin/env bash
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
echo "$*" >> "$DIR/systemctl.log"
case "$*" in
  *is-enabled*|*is-active*)
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
`,
  );
  // launchctl — the macOS counterpart of the systemctl shim above (issue
  // #1718). Every invocation is appended to launchctl.log so the darwin
  // branch's exact sequence can be asserted without ever touching a real
  // launchd. `print` is the "is this job loaded?" probe — it reports "not
  // found" (exit 1) by default, which keeps the bootout-the-other-role
  // branch out of every test that isn't specifically exercising it.
  writeShim(
    binDir,
    "launchctl",
    `#!/usr/bin/env bash
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
echo "$*" >> "$DIR/launchctl.log"
case "$*" in
  *print*)
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
`,
  );
  // Copying (not symlinking) the real node binary — same reasoning as
  // self-update.test.ts's own writeShims: a symlinked binary can resolve
  // its own sibling paths differently, and this also gives the prereq
  // check's \`command -v node\` a binary that lives inside binDir, which the
  // CHANGEME-substitution assertions below rely on.
  fs.copyFileSync(process.execPath, path.join(binDir, "node"));
  fs.chmodSync(path.join(binDir, "node"), 0o755);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// This suite may itself be running inside a Mullion-hosted session, which
// injects its own MULLION_* vars (MULLION_TRUST_GATEWAY, MULLION_HOME,
// etc.) into every child process's environment. Those must never leak into
// the script under test — otherwise its behavior would depend on whichever
// session happens to run this suite instead of each test's own deliberately
// -set env.
function scrubbedEnv(): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("MULLION_")) continue;
    scrubbed[key] = value;
  }
  return scrubbed;
}

describeOnLinux("deploy/install.sh", () => {
  let fakeHome: string;
  let binDir: string;
  let xdgRuntimeDir: string;
  let baseEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "install-test-home-"));
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-test-bin-"));
    xdgRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-test-xdg-"));
    writeShims(binDir);
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

    baseEnv = scrubbedEnv();
    baseEnv.PATH = `${binDir}:${process.env.PATH}`;
    // The actual safety-critical override: install.sh's ~/.config and
    // ~/.local/bin writes are bash tilde-expansions of $HOME.
    baseEnv.HOME = fakeHome;
    // Defense in depth beyond the systemctl shim above: even a leaked real
    // `systemctl --user` invocation can't reach a real user manager without
    // a real bus to talk to.
    baseEnv.XDG_RUNTIME_DIR = xdgRuntimeDir;
    delete baseEnv.DBUS_SESSION_BUS_ADDRESS;
  });

  afterEach(() => {
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(xdgRuntimeDir, { recursive: true, force: true });
  });

  function freshMullionHome(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "install-test-mullionhome-"));
  }

  // Pre-creates releases/<version> so install.sh's own "already exists,
  // reusing it" branch (deploy/install.sh L197-198) is taken, which is what
  // lets every test below skip the real curl download / sha256sum / tar /
  // npm ci / playwright install branch entirely.
  function skipDownload(mullionHome: string, opts: { withCli?: boolean } = {}) {
    const releaseDir = path.join(mullionHome, "releases", "9.9.9");
    fs.mkdirSync(releaseDir, { recursive: true });
    if (opts.withCli) {
      fs.mkdirSync(path.join(releaseDir, "dist", "cli"), { recursive: true });
      fs.writeFileSync(path.join(releaseDir, "dist", "cli", "mullion.mjs"), "// fake cli\n");
    }
    return releaseDir;
  }

  function readEnvFile(mullionHome: string): string {
    return fs.readFileSync(path.join(mullionHome, ".env"), "utf8");
  }

  function readSystemctlLog(): string[] {
    const p = path.join(binDir, "systemctl.log");
    if (!fs.existsSync(p)) return [];
    return fs
      .readFileSync(p, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
  }

  // The load-bearing safety check: proves the dangerous commands actually
  // resolve into the temp shim dir under the exact env runScript() is about
  // to hand the real script, not into /usr/bin or wherever the real system
  // binaries live. Also asserted as its own test below, per this issue's
  // own "verify this works before trusting any test result" requirement.
  async function assertSandboxed(env: NodeJS.ProcessEnv) {
    const dangerous = ["systemctl", "systemd-run", "curl", "npm", "npx", "dtach", "launchctl"];
    const { stdout } = await execFileAsync(
      "bash",
      ["-c", dangerous.map((cmd) => `command -v ${cmd}`).join("; ")],
      { env },
    );
    const resolved = stdout.trim().split("\n").filter(Boolean);
    expect(resolved).toHaveLength(dangerous.length);
    for (const resolvedPath of resolved) {
      expect(path.dirname(resolvedPath)).toBe(binDir);
    }
    expect(env.HOME).not.toBe(os.homedir());
  }

  function runScript(args: string[], opts: { env?: Record<string, string> } = {}) {
    const env: NodeJS.ProcessEnv = { ...baseEnv, ...opts.env };
    return assertSandboxed(env).then(() =>
      execFileAsync("bash", [INSTALL_SCRIPT, ...args], { env, timeout: 20_000 }),
    );
  }

  it("resolves every dangerous command into the shim dir, not the real system binaries", async () => {
    await assertSandboxed(baseEnv);
  });

  describe("argument validation", () => {
    it("--help exits 0, prints usage, and touches nothing", async () => {
      // usage() writes to stderr (see deploy/install.sh's own usage()), not
      // stdout.
      const { stderr } = await runScript(["--help"]);
      expect(stderr).toMatch(/^usage: deploy\/install\.sh/m);
      expect(stderr).toContain("--no-systemd");
      expect(readSystemctlLog()).toEqual([]);
    });

    it("rejects an unknown flag before touching the install root", async () => {
      const unusedHome = path.join(fakeHome, "would-be-mullion-home");
      await expect(runScript(["--bogus", unusedHome])).rejects.toThrow();
      expect(fs.existsSync(unusedHome)).toBe(false);
      expect(readSystemctlLog()).toEqual([]);
    });

    it("rejects an invalid --role before touching the install root", async () => {
      const unusedHome = path.join(fakeHome, "would-be-mullion-home");
      await expect(runScript(["--role=bogus", unusedHome])).rejects.toThrow();
      expect(fs.existsSync(unusedHome)).toBe(false);
      expect(readSystemctlLog()).toEqual([]);
    });

    it("rejects a missing <mullion-home> positional", async () => {
      await expect(runScript(["--role", "primary"])).rejects.toThrow();
      expect(readSystemctlLog()).toEqual([]);
    });
  });

  it("refuses to run when --role conflicts with an existing .env's MULLION_ROLE, before any download", async () => {
    const mullionHome = freshMullionHome();
    const original = "MULLION_ROLE=agent\nFOO=bar\n";
    fs.writeFileSync(path.join(mullionHome, ".env"), original);
    await expect(runScript(["--role", "primary", mullionHome])).rejects.toThrow();
    expect(fs.readFileSync(path.join(mullionHome, ".env"), "utf8")).toBe(original);
    expect(fs.existsSync(path.join(mullionHome, "releases"))).toBe(false);
    expect(readSystemctlLog()).toEqual([]);
  });

  it("leaves an existing .env's content byte-for-byte untouched but tightens its mode to 600", async () => {
    const mullionHome = freshMullionHome();
    skipDownload(mullionHome);
    const envPath = path.join(mullionHome, ".env");
    const original = "MULLION_ROLE=primary\nCUSTOM_KEY=keep-me\n"; // pragma: allowlist secret
    fs.writeFileSync(envPath, original, { mode: 0o644 });

    const { stdout } = await runScript(["--role", "primary", mullionHome]);

    expect(fs.readFileSync(envPath, "utf8")).toBe(original);
    expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
    expect(stdout).toMatch(/already exists, leaving it as-is/);
  });

  describe("primary .env generation", () => {
    it("warns when neither trust-gateway nor the auth token pair is set", async () => {
      const mullionHome = freshMullionHome();
      skipDownload(mullionHome);
      const { stderr } = await runScript(["--role", "primary", mullionHome]);
      const env = readEnvFile(mullionHome);
      expect(env).not.toMatch(/^MULLION_TRUST_GATEWAY=/m);
      expect(env).not.toMatch(/^MULLION_AUTH_TOKEN=/m);
      expect(env).not.toMatch(/^MULLION_SESSION_SECRET=/m);
      expect(stderr).toMatch(/WARNING: this primary has no auth configured/);
      expect(fs.statSync(path.join(mullionHome, ".env")).mode & 0o777).toBe(0o600);
    });

    it("writes MULLION_TRUST_GATEWAY=true when MULLION_INSTALL_TRUST_GATEWAY is set", async () => {
      const mullionHome = freshMullionHome();
      skipDownload(mullionHome);
      const { stderr } = await runScript(["--role", "primary", mullionHome], {
        env: { MULLION_INSTALL_TRUST_GATEWAY: "true" },
      });
      const env = readEnvFile(mullionHome);
      expect(env).toMatch(/^MULLION_TRUST_GATEWAY=true$/m);
      expect(env).not.toMatch(/^MULLION_AUTH_TOKEN=/m);
      expect(env).not.toMatch(/^MULLION_SESSION_SECRET=/m);
      expect(stderr).not.toMatch(/WARNING/);
      expect(stderr).not.toMatch(/NOTICE/);
    });

    it("writes the token pair when both MULLION_INSTALL_AUTH_TOKEN and MULLION_INSTALL_SESSION_SECRET are set", async () => {
      const mullionHome = freshMullionHome();
      skipDownload(mullionHome);
      const { stderr } = await runScript(["--role", "primary", mullionHome], {
        env: {
          MULLION_INSTALL_AUTH_TOKEN: "fixture-auth-tok", // pragma: allowlist secret
          MULLION_INSTALL_SESSION_SECRET: "fixture-session-sec", // pragma: allowlist secret
        },
      });
      const env = readEnvFile(mullionHome);
      expect(env).toMatch(/^MULLION_AUTH_TOKEN=fixture-auth-tok$/m);
      expect(env).toMatch(/^MULLION_SESSION_SECRET=fixture-session-sec$/m);
      expect(env).not.toMatch(/^MULLION_TRUST_GATEWAY=/m);
      expect(stderr).not.toMatch(/WARNING/);
    });

    it("prefers trust-gateway and emits a NOTICE when both auth paths are set", async () => {
      const mullionHome = freshMullionHome();
      skipDownload(mullionHome);
      const { stderr } = await runScript(["--role", "primary", mullionHome], {
        env: {
          MULLION_INSTALL_TRUST_GATEWAY: "true",
          MULLION_INSTALL_AUTH_TOKEN: "fixture-auth-tok", // pragma: allowlist secret
          MULLION_INSTALL_SESSION_SECRET: "fixture-session-sec", // pragma: allowlist secret
        },
      });
      const env = readEnvFile(mullionHome);
      expect(env).toMatch(/^MULLION_TRUST_GATEWAY=true$/m);
      expect(env).not.toMatch(/^MULLION_AUTH_TOKEN=/m);
      expect(env).not.toMatch(/^MULLION_SESSION_SECRET=/m);
      expect(stderr).toMatch(
        /NOTICE: MULLION_INSTALL_AUTH_TOKEN\/MULLION_INSTALL_SESSION_SECRET are set but ignored/,
      );
    });

    // Issue #1458's own regression: AUTH_TOKEN alone (no SESSION_SECRET) is
    // a "half-configured" state that src/app.ts still refuses to boot, so
    // install.sh must treat it exactly like "neither is set" — write
    // neither line, and still warn — rather than writing a lone
    // MULLION_AUTH_TOKEN that silently crash-loops the unit.
    it("writes neither auth line and still warns when the auth token is set without the session secret", async () => {
      const mullionHome = freshMullionHome();
      skipDownload(mullionHome);
      const { stderr } = await runScript(["--role", "primary", mullionHome], {
        env: { MULLION_INSTALL_AUTH_TOKEN: "fixture-auth-tok-only" }, // pragma: allowlist secret
      });
      const env = readEnvFile(mullionHome);
      expect(env).not.toMatch(/^MULLION_AUTH_TOKEN=/m);
      expect(env).not.toMatch(/^MULLION_SESSION_SECRET=/m);
      expect(stderr).toMatch(/WARNING: this primary has no auth configured/);
    });
  });

  describe("agent .env generation", () => {
    it("warns about an empty PROJECTS_ROOTS and no complete credential path", async () => {
      const mullionHome = freshMullionHome();
      skipDownload(mullionHome);
      const { stderr } = await runScript(["--role", "agent", mullionHome]);
      const env = readEnvFile(mullionHome);
      expect(env).toMatch(/^PROJECTS_ROOTS=$/m);
      expect(stderr).toMatch(/WARNING: PROJECTS_ROOTS is empty/);
      expect(stderr).toMatch(/WARNING: this agent has no complete credential path/);
    });

    it("writes PROJECTS_ROOTS and the manual token path with no warnings", async () => {
      const mullionHome = freshMullionHome();
      skipDownload(mullionHome);
      const { stderr } = await runScript(["--role", "agent", mullionHome], {
        env: {
          MULLION_AGENT_PROJECTS_ROOTS: "/home/dev/projects",
          MULLION_AGENT_TOKEN: "fixture-agent-tok", // pragma: allowlist secret
        },
      });
      const env = readEnvFile(mullionHome);
      expect(env).toMatch(/^PROJECTS_ROOTS=\/home\/dev\/projects$/m);
      expect(env).toMatch(/^MULLION_AGENT_TOKEN=fixture-agent-tok$/m);
      expect(env).toMatch(/^MULLION_PRIMARY_URL=$/m);
      expect(env).toMatch(/^MULLION_ENROLLMENT_TOKEN=$/m);
      expect(stderr).not.toMatch(/WARNING/);
    });

    it("writes the self-registration credential path with no warnings", async () => {
      const mullionHome = freshMullionHome();
      skipDownload(mullionHome);
      const { stderr } = await runScript(["--role", "agent", mullionHome], {
        env: {
          MULLION_AGENT_PROJECTS_ROOTS: "/srv/projects",
          MULLION_AGENT_PRIMARY_URL: "https://primary.example.com",
          MULLION_AGENT_ENROLLMENT_TOKEN: "fixture-enroll-tok", // pragma: allowlist secret
          MULLION_AGENT_ADVERTISE_URL: "https://agent.example.com",
          MULLION_AGENT_NAME: "agent-1",
        },
      });
      const env = readEnvFile(mullionHome);
      expect(env).toMatch(/^MULLION_PRIMARY_URL=https:\/\/primary\.example\.com$/m);
      expect(env).toMatch(/^MULLION_ENROLLMENT_TOKEN=fixture-enroll-tok$/m);
      expect(env).toMatch(/^MULLION_AGENT_ADVERTISE_URL=https:\/\/agent\.example\.com$/m);
      expect(env).toMatch(/^MULLION_AGENT_NAME=agent-1$/m);
      expect(env).toMatch(/^MULLION_AGENT_TOKEN=$/m);
      expect(stderr).not.toMatch(/WARNING/);
    });

    // Mirrors src/app.ts's actual boot condition (hasManualToken ||
    // (hasPrimaryUrl && hasEnrollmentToken)) rather than "is anything set at
    // all" — an enrollment token with no primary URL is still an incomplete
    // path that fails to boot, so the warning must still fire.
    it("still warns when only the enrollment token is set, without a primary URL", async () => {
      const mullionHome = freshMullionHome();
      skipDownload(mullionHome);
      const { stderr } = await runScript(["--role", "agent", mullionHome], {
        env: {
          MULLION_AGENT_PROJECTS_ROOTS: "/srv/projects",
          MULLION_AGENT_ENROLLMENT_TOKEN: "fixture-enroll-tok", // pragma: allowlist secret
        },
      });
      expect(stderr).toMatch(/WARNING: this agent has no complete credential path/);
      expect(stderr).not.toMatch(/WARNING: PROJECTS_ROOTS is empty/);
    });

    it("writes a value containing shell metacharacters literally, without executing it", async () => {
      const mullionHome = freshMullionHome();
      skipDownload(mullionHome);
      const marker = path.join(mullionHome, "pwned");
      const evilToken = `$(touch ${marker})`;
      await runScript(["--role", "agent", mullionHome], {
        env: {
          MULLION_AGENT_PROJECTS_ROOTS: "/srv/projects",
          MULLION_AGENT_TOKEN: evilToken,
        },
      });
      expect(fs.existsSync(marker)).toBe(false);
      expect(readEnvFile(mullionHome)).toContain(`MULLION_AGENT_TOKEN=${evilToken}`);
    });
  });

  describe("the launchd launcher (scripts/run-with-env.sh)", () => {
    it("PARSES the .env instead of executing it", async () => {
      // systemd's EnvironmentFile= parses KEY=VALUE literally; sourcing the
      // file would EXECUTE it — so `MULLION_AGENT_NAME=Studio Mac` would run
      // `Mac` and leave the variable unset, and a secret holding `$` or a
      // backtick would be expanded or executed. The launcher must behave
      // like EnvironmentFile=, not like `. .env`.
      const envFile = path.join(fakeHome, ".env");
      fs.writeFileSync(
        envFile,
        // The values are fixtures, not secrets — the point is that a value
        // with a space, and one holding `$` and a backtick, survive parsing.
        "MULLION_AGENT_NAME=Studio Mac\nMULLION_TOKEN='a$b`c`d'\n# a comment\n\n", // pragma: allowlist secret
      );
      const outFile = path.join(fakeHome, "env.out");
      writeShim(
        binDir,
        "fake-node",
        `#!/usr/bin/env bash
env > "$OUT"
`,
      );

      await execFileAsync("sh", [LAUNCHER_SCRIPT], {
        env: {
          ...baseEnv,
          HOME: fakeHome,
          MULLION_HOME: fakeHome,
          MULLION_NODE_BIN: path.join(binDir, "fake-node"),
          OUT: outFile,
        },
      });

      const printed = fs.readFileSync(outFile, "utf8");
      expect(printed).toMatch(/^MULLION_AGENT_NAME=Studio Mac$/m);
      expect(printed).toMatch(/^MULLION_TOKEN=a\$b`c`d$/m);
      // The comment line and the blank one are not variables.
      expect(printed).not.toMatch(/^# a comment$/m);
    });
  });

  describe("systemd unit generation", () => {
    it("substitutes every CHANGEME placeholder in the generated primary unit and links the CLI", async () => {
      const mullionHome = freshMullionHome();
      skipDownload(mullionHome, { withCli: true });
      await runScript(["--role", "primary", mullionHome]);

      const unitPath = path.join(fakeHome, ".config", "systemd", "user", "mullion.service");
      const unit = fs.readFileSync(unitPath, "utf8");
      const nonCommentLines = unit.split("\n").filter((line) => !line.trimStart().startsWith("#"));
      for (const line of nonCommentLines) {
        expect(line).not.toContain("CHANGEME");
      }

      const homeReal = fs.realpathSync(mullionHome);
      expect(unit).toMatch(
        new RegExp(`^WorkingDirectory=${escapeRegExp(path.join(homeReal, "current"))}$`, "m"),
      );
      expect(unit).toMatch(
        new RegExp(`^ExecStart=${escapeRegExp(path.join(binDir, "node"))} dist/server\\.js$`, "m"),
      );
      expect(unit).toMatch(
        new RegExp(`^EnvironmentFile=${escapeRegExp(path.join(homeReal, ".env"))}$`, "m"),
      );

      expect(fs.readlinkSync(path.join(mullionHome, "current"))).toBe(
        path.join(homeReal, "releases", "9.9.9"),
      );
      expect(fs.realpathSync(path.join(fakeHome, ".local", "bin", "mullion"))).toBe(
        fs.realpathSync(path.join(mullionHome, "releases", "9.9.9", "dist", "cli", "mullion.mjs")),
      );
    });

    it("substitutes every CHANGEME placeholder in the generated agent unit", async () => {
      const mullionHome = freshMullionHome();
      skipDownload(mullionHome);
      await runScript(["--role", "agent", mullionHome], {
        env: {
          MULLION_AGENT_PROJECTS_ROOTS: "/srv/projects",
          MULLION_AGENT_TOKEN: "fixture-agent-tok", // pragma: allowlist secret
        },
      });

      const unitPath = path.join(fakeHome, ".config", "systemd", "user", "mullion-agent.service");
      const unit = fs.readFileSync(unitPath, "utf8");
      const nonCommentLines = unit.split("\n").filter((line) => !line.trimStart().startsWith("#"));
      for (const line of nonCommentLines) {
        expect(line).not.toContain("CHANGEME");
      }
    });
  });

  // The macOS branch (issue #1718, roadmap 8.4). The platform detection goes
  // through `uname -s`, so a shimmed `uname` exercises the launchd branch on
  // a Linux runner — the same trick the systemctl shim plays for the
  // systemd branch. The shim is removed after each test, so the Linux tests
  // above still see the real platform.
  describe("macOS launchd branch", () => {
    function writeDarwinShim(): void {
      writeShim(
        binDir,
        "uname",
        `#!/usr/bin/env bash
if [ "$1" = "-s" ]; then echo Darwin; else echo Linux; fi
`,
      );
    }

    function readLaunchctlLog(): string[] {
      const p = path.join(binDir, "launchctl.log");
      if (!fs.existsSync(p)) return [];
      return fs
        .readFileSync(p, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0);
    }

    afterEach(() => {
      fs.rmSync(path.join(binDir, "uname"), { force: true });
    });

    it("writes a launchd plist (not a systemd unit) with every CHANGEME substituted", async () => {
      writeDarwinShim();
      const mullionHome = freshMullionHome();
      skipDownload(mullionHome, { withCli: true });
      await runScript(["--role", "primary", mullionHome]);

      // No systemd unit on darwin.
      expect(
        fs.existsSync(path.join(fakeHome, ".config", "systemd", "user", "mullion.service")),
      ).toBe(false);

      const plistPath = path.join(fakeHome, "Library", "LaunchAgents", "com.mullion.primary.plist");
      const plist = fs.readFileSync(plistPath, "utf8");
      // The plist's own header comment mentions the CHANGEME placeholders
      // (like the systemd unit's header comment mentions its own) — the
      // assertion is about the VALUES, so the comment is stripped first. The
      // comment is the file's FIRST element, so everything after its closing
      // "-->" is the part under test.
      const withoutComments = plist.slice(plist.indexOf("-->") + 3);
      expect(withoutComments).not.toContain("CHANGEME");

      const homeReal = fs.realpathSync(mullionHome);
      expect(plist).toContain(path.join(homeReal, "current"));
      expect(plist).toContain(path.join(binDir, "node"));
      expect(plist).toContain("com.mullion.primary");
      expect(plist).toContain("run-with-env.sh");
    });

    it("keeps the dtach masters alive across a restart (AbandonProcessGroup)", async () => {
      // Load-bearing: launchd otherwise SIGTERMs "all child processes of the
      // job" when the job stops, which would take every live dtach master —
      // and every live session — down with it on each app restart.
      writeDarwinShim();
      const mullionHome = freshMullionHome();
      skipDownload(mullionHome);
      await runScript(["--role", "primary", mullionHome]);
      const plist = fs.readFileSync(
        path.join(fakeHome, "Library", "LaunchAgents", "com.mullion.primary.plist"),
        "utf8",
      );
      expect(plist).toMatch(/<key>AbandonProcessGroup<\/key>\s*<true\/>/);
    });

    it("bootstraps and enables the job, and leaves the other role's job alone", async () => {
      writeDarwinShim();
      const mullionHome = freshMullionHome();
      skipDownload(mullionHome);
      await runScript(["--role", "primary", mullionHome]);
      const log = readLaunchctlLog();
      const domain = `gui/${process.getuid?.() ?? 501}`;
      expect(log.some((line) => line.startsWith(`bootstrap ${domain} `))).toBe(true);
      expect(log).toContainEqual(`enable ${domain}/com.mullion.primary`);
      // The other role's job was never loaded, so it is never booted out.
      // (This role's OWN label IS booted out first — that is what makes a
      // re-run work, since `launchctl bootstrap` refuses an already-loaded
      // label.)
      expect(
        log.some((line) => line.includes("bootout") && line.includes("com.mullion.agent")),
      ).toBe(false);
    });

    it("gives the job a PATH that can resolve dtach", async () => {
      // The app spawns `dtach` by bare name (and passes its inherited PATH
      // into every session), but a launchd job's default PATH is only
      // /usr/bin:/bin:/usr/sbin:/sbin — where a Homebrew dtach is not. The
      // install resolves dtach's real directory and writes it into the job.
      writeDarwinShim();
      const mullionHome = freshMullionHome();
      skipDownload(mullionHome);
      await runScript(["--role", "primary", mullionHome]);
      const plist = fs.readFileSync(
        path.join(fakeHome, "Library", "LaunchAgents", "com.mullion.primary.plist"),
        "utf8",
      );
      expect(plist).toMatch(/<key>PATH<\/key>/);
      expect(plist).toContain(binDir);
    });

    it("boots the label out before bootstrapping it, so a re-run works", async () => {
      // `launchctl bootstrap` refuses an already-loaded label ("Bootstrap
      // failed: 5: Input/output error"), so without this the second run
      // would abort — after the plist was already overwritten, leaving the
      // old definition loaded.
      writeDarwinShim();
      const mullionHome = freshMullionHome();
      skipDownload(mullionHome);
      await runScript(["--role", "primary", mullionHome]);
      const log = readLaunchctlLog();
      const domain = `gui/${process.getuid?.() ?? 501}`;
      const bootout = log.indexOf(`bootout ${domain}/com.mullion.primary`);
      const bootstrap = log.findIndex((line) => line.startsWith(`bootstrap ${domain} `));
      expect(bootout).toBeGreaterThanOrEqual(0);
      expect(bootstrap).toBeGreaterThan(bootout);
    });

    it("boots out the other role's job when launchd reports it loaded", async () => {
      writeDarwinShim();
      // Overrides the default shim (which reports `print` as "not found") so
      // the bootout-the-other-role branch is exercised specifically.
      writeShim(
        binDir,
        "launchctl",
        `#!/usr/bin/env bash
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
echo "$*" >> "$DIR/launchctl.log"
exit 0
`,
      );
      const mullionHome = freshMullionHome();
      skipDownload(mullionHome);
      await runScript(["--role", "primary", mullionHome]);
      const log = readLaunchctlLog();
      const domain = `gui/${process.getuid?.() ?? 501}`;
      expect(log).toContainEqual(`bootout ${domain}/com.mullion.agent`);
    });

    it("writes the agent plist for --role agent", async () => {
      writeDarwinShim();
      const mullionHome = freshMullionHome();
      skipDownload(mullionHome);
      await runScript(["--role", "agent", mullionHome], {
        env: {
          MULLION_AGENT_PROJECTS_ROOTS: "/srv/projects",
          MULLION_AGENT_TOKEN: "fixture-agent-tok", // pragma: allowlist secret
        },
      });
      const plistPath = path.join(fakeHome, "Library", "LaunchAgents", "com.mullion.agent.plist");
      const plist = fs.readFileSync(plistPath, "utf8");
      expect(plist.slice(plist.indexOf("-->") + 3)).not.toContain("CHANGEME");
      expect(plist).toContain("com.mullion.agent");
      expect(plist).toContain("<string>agent</string>");
    });
  });

  describe("systemctl invocation sequence", () => {
    it("runs daemon-reload and enable --now for the primary unit", async () => {
      const mullionHome = freshMullionHome();
      skipDownload(mullionHome);
      await runScript(["--role", "primary", mullionHome]);
      const log = readSystemctlLog();
      expect(log).toContainEqual("--user daemon-reload");
      expect(log.some((line) => line.includes("is-enabled mullion-agent.service"))).toBe(true);
      expect(log).toContainEqual("--user enable --now mullion.service");
    });

    it("disables the other role's unit when it reports active", async () => {
      const mullionHome = freshMullionHome();
      skipDownload(mullionHome);
      // Overrides the default shim (which always reports is-enabled/
      // is-active as "not found") for this one test, to exercise the
      // disable-other-unit branch (deploy/install.sh's "Disabling
      // $OTHER_UNIT_NAME" step) specifically.
      writeShim(
        binDir,
        "systemctl",
        `#!/usr/bin/env bash
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
echo "$*" >> "$DIR/systemctl.log"
case "$*" in
  *"is-active mullion-agent.service"*)
    exit 0
    ;;
  *is-enabled*|*is-active*)
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
`,
      );
      await runScript(["--role", "primary", mullionHome]);
      const log = readSystemctlLog();
      expect(log).toContainEqual("--user disable --now mullion-agent.service");
    });
  });

  describe("systemd unit installation skipping", () => {
    it("skips systemd installation and systemctl calls when --no-systemd is passed", async () => {
      const mullionHome = freshMullionHome();
      skipDownload(mullionHome);
      const { stdout } = await runScript(["--no-systemd", "--role", "primary", mullionHome]);
      expect(stdout).toMatch(/Skipping systemd user unit installation/);
      expect(readSystemctlLog()).toEqual([]);
      const unitPath = path.join(fakeHome, ".config", "systemd", "user", "mullion.service");
      expect(fs.existsSync(unitPath)).toBe(false);
    });

    it("skips systemd installation and systemctl calls when MULLION_SKIP_SYSTEMD=1 is set", async () => {
      const mullionHome = freshMullionHome();
      skipDownload(mullionHome);
      const { stdout } = await runScript(["--role", "primary", mullionHome], {
        env: { MULLION_SKIP_SYSTEMD: "1" },
      });
      expect(stdout).toMatch(/Skipping systemd user unit installation/);
      expect(readSystemctlLog()).toEqual([]);
      const unitPath = path.join(fakeHome, ".config", "systemd", "user", "mullion.service");
      expect(fs.existsSync(unitPath)).toBe(false);
    });
  });
});
