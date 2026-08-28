import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import {
  buildLaunchdPlist,
  buildSystemdUnit,
  launchdPlistPath,
  systemdUnitPath,
  xmlCommentSafe,
  LAUNCHD_LABEL,
  SYSTEMD_UNIT_NAME,
} from "../../src/cli/ssh-agent-helper-install.mjs";
// Dispatched through runHelper, not called directly — matches how
// mullion.mjs actually invokes install/uninstall, and (like pair/run)
// CliUsageError is only caught at this layer, not inside runInstall itself.
import { runHelper } from "../../src/cli/ssh-agent-helper.mjs";

function runInstall(args: string[], io: Record<string, unknown>) {
  return runHelper("install", args, io);
}

function runUninstall(args: string[], io: Record<string, unknown>) {
  return runHelper("uninstall", args, io);
}

// ---------------------------------------------------------------------------
// Pure builder / path-resolver functions — no fs/process access, so these
// don't need a temp dir at all.
// ---------------------------------------------------------------------------

describe("buildLaunchdPlist", () => {
  it("embeds the exact argv run needs, in order", () => {
    const xml = buildLaunchdPlist({
      execPath: "/usr/bin/node",
      scriptPath: "/opt/mullion/dist/cli/mullion.mjs",
      sshAuthSock: "/tmp/agent.sock",
      logPath: "/tmp/helper-run.log",
    });
    const argsBlock = xml.slice(xml.indexOf("<array>"), xml.indexOf("</array>"));
    const strings = [...argsBlock.matchAll(/<string>(.*?)<\/string>/g)].map((m) => m[1]);
    expect(strings).toEqual([
      "/usr/bin/node",
      "/opt/mullion/dist/cli/mullion.mjs",
      "helper",
      "run",
      "--ssh-auth-sock",
      "/tmp/agent.sock",
    ]);
  });

  it("XML-escapes a path containing special characters", () => {
    const xml = buildLaunchdPlist({
      execPath: "/usr/bin/node",
      scriptPath: "/opt/mullion/dist/cli/mullion.mjs",
      sshAuthSock: "/tmp/a & b/agent.sock",
      logPath: "/tmp/helper-run.log",
    });
    expect(xml).toContain("/tmp/a &amp; b/agent.sock");
    expect(xml).not.toContain("/tmp/a & b/agent.sock");
  });

  it("sets RunAtLoad, KeepAlive, and a non-zero ThrottleInterval", () => {
    const xml = buildLaunchdPlist({
      execPath: "/usr/bin/node",
      scriptPath: "/opt/mullion/dist/cli/mullion.mjs",
      sshAuthSock: "/tmp/agent.sock",
      logPath: "/tmp/helper-run.log",
    });
    expect(xml).toMatch(/<key>RunAtLoad<\/key><true\/>/);
    expect(xml).toMatch(/<key>KeepAlive<\/key><true\/>/);
    expect(xml).toMatch(/<key>ThrottleInterval<\/key><integer>\d+<\/integer>/);
  });

  it("documents the 24h credential deadline in a plist comment", () => {
    const xml = buildLaunchdPlist({
      execPath: "/usr/bin/node",
      scriptPath: "/opt/mullion/dist/cli/mullion.mjs",
      sshAuthSock: "/tmp/agent.sock",
      logPath: "/tmp/helper-run.log",
    });
    expect(xml).toMatch(/<!--[\s\S]*24h[\s\S]*-->/);
  });

  it("never emits a literal -- inside the comment body (invalid XML)", () => {
    const xml = buildLaunchdPlist({
      execPath: "/usr/bin/node",
      scriptPath: "/opt/mullion/dist/cli/mullion.mjs",
      sshAuthSock: "/tmp/agent.sock",
      logPath: "/tmp/helper-run.log",
    });
    const commentBody = xml.match(/<!--([\s\S]*?)-->/)?.[1] ?? "";
    expect(commentBody).not.toContain("--");
  });

  it("is valid, well-formed-enough XML (every opened tag closes)", () => {
    const xml = buildLaunchdPlist({
      execPath: "/usr/bin/node",
      scriptPath: "/opt/mullion/dist/cli/mullion.mjs",
      sshAuthSock: "/tmp/agent.sock",
      logPath: "/tmp/helper-run.log",
    });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml.trim().endsWith("</plist>")).toBe(true);
    expect((xml.match(/<dict>/g) ?? []).length).toBe((xml.match(/<\/dict>/g) ?? []).length);
    expect((xml.match(/<array>/g) ?? []).length).toBe((xml.match(/<\/array>/g) ?? []).length);
  });
});

describe("buildSystemdUnit", () => {
  it("builds an ExecStart line with the exact argv run needs", () => {
    const unit = buildSystemdUnit({
      execPath: "/usr/bin/node",
      scriptPath: "/opt/mullion/dist/cli/mullion.mjs",
      sshAuthSock: "/tmp/agent.sock",
    });
    expect(unit).toContain(
      "ExecStart=/usr/bin/node /opt/mullion/dist/cli/mullion.mjs helper run --ssh-auth-sock /tmp/agent.sock",
    );
  });

  it("quotes an ExecStart token containing whitespace", () => {
    const unit = buildSystemdUnit({
      execPath: "/usr/bin/node",
      scriptPath: "/opt/mullion/dist/cli/mullion.mjs",
      sshAuthSock: "/tmp/a path with spaces/agent.sock",
    });
    expect(unit).toContain('"/tmp/a path with spaces/agent.sock"');
  });

  it("escapes embedded quotes and backslashes in a quoted token", () => {
    const unit = buildSystemdUnit({
      execPath: "/usr/bin/node",
      scriptPath: "/opt/mullion/dist/cli/mullion.mjs",
      sshAuthSock: 'C:\\weird "path"\\agent.sock',
    });
    expect(unit).toContain('"C:\\\\weird \\"path\\"\\\\agent.sock"');
  });

  it("sets Restart=always with a calm (non-tight-loop) RestartSec", () => {
    const unit = buildSystemdUnit({
      execPath: "/usr/bin/node",
      scriptPath: "/opt/mullion/dist/cli/mullion.mjs",
      sshAuthSock: "/tmp/agent.sock",
    });
    expect(unit).toMatch(/^Restart=always$/m);
    const restartSecMatch = unit.match(/^RestartSec=(\d+)$/m);
    expect(restartSecMatch).not.toBeNull();
    expect(Number(restartSecMatch![1])).toBeGreaterThanOrEqual(10);
  });

  it("documents the 24h credential deadline in a unit-file comment", () => {
    const unit = buildSystemdUnit({
      execPath: "/usr/bin/node",
      scriptPath: "/opt/mullion/dist/cli/mullion.mjs",
      sshAuthSock: "/tmp/agent.sock",
    });
    expect(unit).toMatch(/^# .*24h/m);
  });
});

describe("xmlCommentSafe", () => {
  it("leaves ordinary text untouched", () => {
    expect(xmlCommentSafe("nothing special here")).toBe("nothing special here");
  });

  it("replaces a literal -- with an em dash (invalid inside an XML comment)", () => {
    expect(xmlCommentSafe("a--b")).toBe("a—b");
    expect(xmlCommentSafe("a--b--c")).not.toContain("--");
  });
});

describe("launchdPlistPath / systemdUnitPath", () => {
  it("places the plist under ~/Library/LaunchAgents, named by the label", () => {
    const p = launchdPlistPath({ env: {}, homedir: "/Users/alice" });
    expect(p).toBe(`/Users/alice/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
  });

  it("places the unit under ~/.config/systemd/user by default", () => {
    const p = systemdUnitPath({ env: {}, homedir: "/home/alice" });
    expect(p).toBe(`/home/alice/.config/systemd/user/${SYSTEMD_UNIT_NAME}`);
  });

  it("honors XDG_CONFIG_HOME for the systemd unit path", () => {
    const p = systemdUnitPath({
      env: { XDG_CONFIG_HOME: "/home/alice/.xdgconfig" },
      homedir: "/home/alice",
    });
    expect(p).toBe(`/home/alice/.xdgconfig/systemd/user/${SYSTEMD_UNIT_NAME}`);
  });
});

// ---------------------------------------------------------------------------
// runInstall / runUninstall — orchestration. Real fs writes to a throwaway
// temp dir; launchctl/systemctl themselves are stubbed via io.spawnSync so
// this suite runs the same on any CI platform without a real launchd or
// systemd.
// ---------------------------------------------------------------------------

describe("runInstall / runUninstall", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function baseIo(overrides: Record<string, unknown> = {}) {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-helper-install-"));
    const calls: string[][] = [];
    const io = {
      env: { SSH_AUTH_SOCK: "/tmp/agent.sock", MULLION_HELPER_STATE_DIR: path.join(dir, "state") },
      stdout: { write: () => true },
      stderr: { write: () => true },
      execPath: "/usr/bin/node",
      scriptPath: "/opt/mullion/dist/cli/mullion.mjs",
      spawnSync: (cmd: string, args: string[]) => {
        calls.push([cmd, ...args]);
        return { status: 0, stdout: "", stderr: "" };
      },
      ...overrides,
    };
    return { io, calls, dir };
  }

  it("refuses to install without SSH_AUTH_SOCK (flag or ambient)", async () => {
    const { io } = baseIo({ env: { MULLION_HELPER_STATE_DIR: "/irrelevant" }, platform: "linux" });
    const stderrLines: string[] = [];
    io.stderr = { write: (s: string) => stderrLines.push(s) };
    const code = await runInstall([], io);
    expect(code).toBe(2);
    expect(stderrLines.join("")).toMatch(/no SSH_AUTH_SOCK to install with/);
  });

  it("--ssh-auth-sock overrides the ambient env var", async () => {
    const { io, dir: d } = baseIo({
      platform: "linux",
      homedir: undefined,
    });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    const code = await runInstall(["--ssh-auth-sock", "/tmp/other.sock"], io);
    expect(code).toBe(0);
    const unitPath = systemdUnitPath(io);
    expect(readFileSync(unitPath, "utf8")).toContain("--ssh-auth-sock /tmp/other.sock");
  });

  it("linux: writes a systemd unit and enables it, idempotently on reinstall", async () => {
    const { io, calls, dir: d } = baseIo({ platform: "linux" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    const first = await runInstall([], io);
    expect(first).toBe(0);
    const unitPath = systemdUnitPath(io);
    expect(existsSync(unitPath)).toBe(true);
    expect(calls.map((c) => c.join(" "))).toEqual([
      "systemctl --user disable --now mullion-helper.service",
      "systemctl --user daemon-reload",
      "systemctl --user enable --now mullion-helper.service",
    ]);

    calls.length = 0;
    const second = await runInstall([], io);
    expect(second).toBe(0);
    // Re-install tears down the previous unit before re-enabling — the
    // real systemctl equivalent of launchctl bootstrap failing outright
    // over an already-loaded label.
    expect(calls[0]).toEqual(["systemctl", "--user", "disable", "--now", "mullion-helper.service"]);
  });

  it("linux: surfaces a non-zero systemctl enable exit as a failure", async () => {
    const { io, dir: d } = baseIo({ platform: "linux" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    io.spawnSync = (cmd: string, args: string[]) => {
      if (args.includes("enable"))
        return { status: 1, stdout: "", stderr: "Failed to enable unit" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const stderrLines: string[] = [];
    io.stderr = { write: (s: string) => stderrLines.push(s) };
    const code = await runInstall([], io);
    expect(code).toBe(1);
    expect(stderrLines.join("")).toMatch(/systemctl enable failed/);
  });

  it("darwin: writes a launchd plist under LaunchAgents and bootstraps it", async () => {
    const { io, calls, dir: d } = baseIo({ platform: "darwin", uid: 501 });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    const code = await runInstall([], io);
    expect(code).toBe(0);
    const plistPath = launchdPlistPath(io);
    expect(existsSync(plistPath)).toBe(true);
    expect(calls.map((c) => c.join(" "))).toEqual([
      "launchctl bootout gui/501/de.s3ntin3l8.mullion-helper",
      `launchctl bootstrap gui/501 ${plistPath}`,
    ]);
  });

  it("darwin: surfaces a non-zero launchctl bootstrap exit as a failure", async () => {
    const { io, dir: d } = baseIo({ platform: "darwin", uid: 501 });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    io.spawnSync = (cmd: string, args: string[]) => {
      if (args.includes("bootstrap"))
        return { status: 1, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const stderrLines: string[] = [];
    io.stderr = { write: (s: string) => stderrLines.push(s) };
    const code = await runInstall([], io);
    expect(code).toBe(1);
    expect(stderrLines.join("")).toMatch(/launchctl bootstrap failed/);
  });

  it("win32: refuses cleanly, no files written", async () => {
    const { io } = baseIo({ platform: "win32" });
    const stderrLines: string[] = [];
    io.stderr = { write: (s: string) => stderrLines.push(s) };
    const code = await runInstall([], io);
    expect(code).toBe(1);
    expect(stderrLines.join("")).toMatch(/isn't supported on Windows yet/);
  });

  it("an unrecognized platform is also refused cleanly", async () => {
    const { io } = baseIo({ platform: "sunos" });
    const code = await runInstall([], io);
    expect(code).toBe(1);
  });

  it("warns (but doesn't fail) when installing before pairing", async () => {
    const { io, dir: d } = baseIo({ platform: "linux" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    const stderrLines: string[] = [];
    io.stderr = { write: (s: string) => stderrLines.push(s) };
    const code = await runInstall([], io);
    expect(code).toBe(0);
    expect(stderrLines.join("")).toMatch(/not paired yet/);
  });

  it("does not warn when a valid credential is already present", async () => {
    const { io, dir: d } = baseIo({ platform: "linux" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    const stateDir = (io.env as Record<string, string>).MULLION_HELPER_STATE_DIR;
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "ssh-agent-bridge.json"),
      JSON.stringify({
        baseUrl: "https://mullion.example.com",
        bridgeId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        sessionId: "b".repeat(64),
        sessionSecret: "c".repeat(64),
      }),
    );
    const stderrLines: string[] = [];
    io.stderr = { write: (s: string) => stderrLines.push(s) };
    const code = await runInstall([], io);
    expect(code).toBe(0);
    expect(stderrLines.join("")).not.toMatch(/not paired yet/);
  });

  it("linux: uninstall removes the unit and disables it; a no-op is not an error", async () => {
    const { io, calls, dir: d } = baseIo({ platform: "linux" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    await runInstall([], io);
    const unitPath = systemdUnitPath(io);
    expect(existsSync(unitPath)).toBe(true);

    calls.length = 0;
    const code = await runUninstall([], io);
    expect(code).toBe(0);
    expect(existsSync(unitPath)).toBe(false);
    expect(calls.map((c) => c.join(" "))).toEqual([
      "systemctl --user disable --now mullion-helper.service",
      "systemctl --user daemon-reload",
    ]);

    // Uninstalling again (nothing installed) must not throw or fail.
    const second = await runUninstall([], io);
    expect(second).toBe(0);
  });

  it("darwin: uninstall removes the plist and boots it out", async () => {
    const { io, dir: d } = baseIo({ platform: "darwin", uid: 501 });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    await runInstall([], io);
    const plistPath = launchdPlistPath(io);
    expect(existsSync(plistPath)).toBe(true);

    const code = await runUninstall([], io);
    expect(code).toBe(0);
    expect(existsSync(plistPath)).toBe(false);
  });

  it("win32: uninstall is also refused cleanly", async () => {
    const { io } = baseIo({ platform: "win32" });
    const code = await runUninstall([], io);
    expect(code).toBe(1);
  });

  it("linux: a failed systemctl disable is surfaced, not swallowed — the unit file is left in place", async () => {
    const { io, dir: d } = baseIo({ platform: "linux" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    await runInstall([], io);
    const unitPath = systemdUnitPath(io);

    io.spawnSync = (cmd: string, args: string[]) => {
      if (args.includes("disable"))
        return { status: 1, stdout: "", stderr: "Failed: unit is busy" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const stderrLines: string[] = [];
    io.stderr = { write: (s: string) => stderrLines.push(s) };
    const code = await runUninstall([], io);
    expect(code).toBe(1);
    expect(stderrLines.join("")).toMatch(/systemctl disable failed/);
    // Must NOT silently claim success and delete the unit while the
    // supervised process could still be running.
    expect(existsSync(unitPath)).toBe(true);
  });

  it("darwin: a failed launchctl bootout is surfaced, not swallowed — the plist is left in place", async () => {
    const { io, dir: d } = baseIo({ platform: "darwin", uid: 501 });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    await runInstall([], io);
    const plistPath = launchdPlistPath(io);

    io.spawnSync = (cmd: string, args: string[]) => {
      if (args.includes("bootout"))
        return { status: 1, stdout: "", stderr: "Could not find service" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const stderrLines: string[] = [];
    io.stderr = { write: (s: string) => stderrLines.push(s) };
    const code = await runUninstall([], io);
    expect(code).toBe(1);
    expect(stderrLines.join("")).toMatch(/launchctl bootout failed/);
    expect(existsSync(plistPath)).toBe(true);
  });

  it("uninstall without ever installing calls neither launchctl nor systemctl", async () => {
    const { io, calls } = baseIo({ platform: "linux" });
    const code = await runUninstall([], io);
    expect(code).toBe(0);
    expect(calls).toEqual([]);
  });

  it("falls back to the real sibling mullion.mjs path when io.scriptPath is omitted", async () => {
    const { io, dir: d } = baseIo({ platform: "linux" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    delete (io as { scriptPath?: string }).scriptPath;
    const code = await runInstall([], io);
    expect(code).toBe(0);
    const unitPath = systemdUnitPath(io);
    const contents = readFileSync(unitPath, "utf8");
    const execStart = contents.match(/^ExecStart=(.*)$/m)?.[1] ?? "";
    expect(execStart).toMatch(/mullion\.mjs helper run --ssh-auth-sock \/tmp\/agent\.sock$/);
    // Resolved relative to ssh-agent-helper-install.mjs's own directory
    // (src/cli/), not some arbitrary cwd-relative guess.
    expect(execStart).toContain(path.join("src", "cli", "mullion.mjs"));
  });
});
