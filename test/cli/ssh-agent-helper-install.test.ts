import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import {
  buildLaunchdPlist,
  buildSystemdUnit,
  buildWindowsTaskXml,
  launchdPlistPath,
  systemdUnitPath,
  windowsTaskXmlPath,
  xmlCommentSafe,
  LAUNCHD_LABEL,
  SYSTEMD_UNIT_NAME,
  WINDOWS_TASK_NAME,
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

  it("escapes a literal % so systemd doesn't expand it as a specifier", () => {
    const unit = buildSystemdUnit({
      execPath: "/usr/bin/node",
      scriptPath: "/opt/mullion/dist/cli/mullion.mjs",
      sshAuthSock: "/tmp/100%-sure/agent.sock",
    });
    expect(unit).toContain("/tmp/100%%-sure/agent.sock");
    expect(unit).not.toContain("/tmp/100%-sure/agent.sock");
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

describe("buildWindowsTaskXml", () => {
  it("embeds the exact argv run needs, in order, each token quoted", () => {
    const xml = buildWindowsTaskXml({
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      scriptPath: "C:\\Program Files\\Mullion\\dist\\cli\\mullion.mjs",
      sshAuthSock: "\\\\.\\pipe\\openssh-ssh-agent",
    });
    const argsMatch = xml.match(/<Arguments>(.*?)<\/Arguments>/);
    expect(argsMatch).not.toBeNull();
    expect(argsMatch![1]).toBe(
      '"C:\\Program Files\\Mullion\\dist\\cli\\mullion.mjs" "helper" "run" "--ssh-auth-sock" "\\\\.\\pipe\\openssh-ssh-agent"',
    );
    expect(xml).toContain("<Command>C:\\Program Files\\nodejs\\node.exe</Command>");
  });

  it("XML-escapes a value containing special characters", () => {
    const xml = buildWindowsTaskXml({
      execPath: "C:\\node.exe",
      scriptPath: "C:\\mullion.mjs",
      sshAuthSock: "\\\\.\\pipe\\a & b",
    });
    expect(xml).toContain("a &amp; b");
    expect(xml).not.toMatch(/a & b(?!amp)/);
  });

  it("sets a LogonTrigger, RestartOnFailure with a calm (>=1 minute) interval, and an unlimited execution time", () => {
    const xml = buildWindowsTaskXml({
      execPath: "C:\\node.exe",
      scriptPath: "C:\\mullion.mjs",
      sshAuthSock: "\\\\.\\pipe\\openssh-ssh-agent",
    });
    expect(xml).toContain("<LogonTrigger>");
    expect(xml).toMatch(/<RestartOnFailure>\s*<Interval>PT\d+M<\/Interval>/);
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
  });

  it("runs with least-privilege, not elevated", () => {
    const xml = buildWindowsTaskXml({
      execPath: "C:\\node.exe",
      scriptPath: "C:\\mullion.mjs",
      sshAuthSock: "\\\\.\\pipe\\openssh-ssh-agent",
    });
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
  });

  it("documents the 24h credential deadline in the task description", () => {
    const xml = buildWindowsTaskXml({
      execPath: "C:\\node.exe",
      scriptPath: "C:\\mullion.mjs",
      sshAuthSock: "\\\\.\\pipe\\openssh-ssh-agent",
    });
    expect(xml).toMatch(/<Description>[\s\S]*24h[\s\S]*<\/Description>/);
  });

  it("is valid, well-formed-enough XML (every opened tag closes)", () => {
    const xml = buildWindowsTaskXml({
      execPath: "C:\\node.exe",
      scriptPath: "C:\\mullion.mjs",
      sshAuthSock: "\\\\.\\pipe\\openssh-ssh-agent",
    });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>')).toBe(true);
    expect(xml.trim().endsWith("</Task>")).toBe(true);
    for (const tag of ["Task", "Triggers", "Principals", "Settings", "Actions", "Exec"]) {
      const opens = (xml.match(new RegExp(`<${tag}[ >]`, "g")) ?? []).length;
      const closes = (xml.match(new RegExp(`</${tag}>`, "g")) ?? []).length;
      expect(opens, `<${tag}> open/close mismatch`).toBe(closes);
    }
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

describe("windowsTaskXmlPath", () => {
  it("honors XDG_STATE_HOME like the credential file's stateDir() does", () => {
    const p = windowsTaskXmlPath({ env: { XDG_STATE_HOME: "C:\\Users\\alice\\.state" } });
    expect(p).toBe(path.join("C:\\Users\\alice\\.state", "mullion", "mullion-helper-task.xml"));
  });

  it("honors MULLION_HELPER_STATE_DIR like the credential file does", () => {
    const p = windowsTaskXmlPath({ env: { MULLION_HELPER_STATE_DIR: "C:\\custom\\state" } });
    expect(p).toBe(path.join("C:\\custom\\state", "mullion-helper-task.xml"));
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

    // Rollback: a failed install must not leave an orphaned unit file
    // behind — otherwise uninstall later finds a file for a job that was
    // never actually enabled, runs disable against it, and (depending on
    // platform) can get wedged (Hermes review).
    const unitPath = systemdUnitPath(io);
    expect(existsSync(unitPath)).toBe(false);
    const postRollbackCalls: string[][] = [];
    io.spawnSync = (cmd: string, args: string[]) => {
      postRollbackCalls.push([cmd, ...args]);
      return { status: 0, stdout: "", stderr: "" };
    };
    const uninstallCode = await runUninstall([], io);
    expect(uninstallCode).toBe(0);
    expect(postRollbackCalls).toEqual([]);
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

    // Rollback: this is the exact scenario Hermes flagged — without it, a
    // subsequent uninstall would find the orphaned plist, run bootout
    // against a job that was never bootstrapped, get launchd's "could not
    // find service" non-zero exit, and refuse to clean up.
    const plistPath = launchdPlistPath(io);
    expect(existsSync(plistPath)).toBe(false);
    io.spawnSync = () => {
      throw new Error("uninstall should have nothing to tear down and must not shell out");
    };
    const uninstallCode = await runUninstall([], io);
    expect(uninstallCode).toBe(0);
  });

  it("darwin: does NOT roll back the plist if the pre-install teardown itself failed (ambiguous — an old job may still be running)", async () => {
    const { io, dir: d } = baseIo({ platform: "darwin", uid: 501 });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    io.spawnSync = (cmd: string, args: string[]) => {
      if (args.includes("bootout"))
        return { status: 1, stdout: "", stderr: "Could not find service" };
      if (args.includes("bootstrap"))
        return { status: 1, stdout: "", stderr: "Service already loaded" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const code = await runInstall([], io);
    expect(code).toBe(1);
    // Deleting the plist here would be the inverse of the earlier bug: an
    // old job could genuinely still be running with no on-disk plist left
    // for a later uninstall to find and stop it (Hermes review, round 2).
    const plistPath = launchdPlistPath(io);
    expect(existsSync(plistPath)).toBe(true);
  });

  it("win32: writes a Scheduled Task XML and creates it with /F", async () => {
    const { io, calls, dir: d } = baseIo({ platform: "win32" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    const code = await runInstall([], io);
    expect(code).toBe(0);
    const xmlPath = windowsTaskXmlPath(io);
    expect(existsSync(xmlPath)).toBe(true);
    expect(calls.map((c) => c.join(" "))).toEqual([
      `schtasks /Create /TN ${WINDOWS_TASK_NAME} /XML ${xmlPath} /F`,
    ]);
  });

  it("win32: re-install overwrites the previous task via /F, no separate teardown call", async () => {
    const { io, calls, dir: d } = baseIo({ platform: "win32" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    await runInstall([], io);
    calls.length = 0;
    const code = await runInstall([], io);
    expect(code).toBe(0);
    // Unlike launchd/systemd, schtasks /Create /F is unconditionally
    // idempotent — no pre-teardown call, no "was preTeardown ambiguous"
    // rollback judgment needed.
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("/F");
  });

  it("win32: surfaces a non-zero schtasks /Create exit as a failure and rolls back the XML", async () => {
    const { io, dir: d } = baseIo({ platform: "win32" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    io.spawnSync = (cmd: string, args: string[]) => {
      if (args.includes("/Create"))
        return { status: 1, stdout: "", stderr: "ERROR: Access is denied." };
      return { status: 0, stdout: "", stderr: "" };
    };
    const stderrLines: string[] = [];
    io.stderr = { write: (s: string) => stderrLines.push(s) };
    const code = await runInstall([], io);
    expect(code).toBe(1);
    expect(stderrLines.join("")).toMatch(/schtasks \/Create failed/);
    const xmlPath = windowsTaskXmlPath(io);
    expect(existsSync(xmlPath)).toBe(false);
  });

  it("win32: does not warn about a missing --ssh-auth-sock path — named pipes aren't statSync-able files", async () => {
    const { io, dir: d } = baseIo({ platform: "win32" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    io.env = {
      ...(io.env as Record<string, string>),
      SSH_AUTH_SOCK: "\\\\.\\pipe\\openssh-ssh-agent",
    };
    io.statSync = () => {
      throw new Error("statSync should not be called for a win32 named pipe path");
    };
    const stderrLines: string[] = [];
    io.stderr = { write: (s: string) => stderrLines.push(s) };
    const code = await runInstall([], io);
    expect(code).toBe(0);
    expect(stderrLines.join("")).not.toMatch(/doesn't exist right now/);
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

  it("warns (but doesn't fail) when --ssh-auth-sock doesn't exist on disk yet", async () => {
    // baseIo's default SSH_AUTH_SOCK ("/tmp/agent.sock") is itself a
    // nonexistent path, same as most other tests in this file — this test
    // just makes that existing default's warning behavior explicit.
    const { io, dir: d } = baseIo({ platform: "linux" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    const stderrLines: string[] = [];
    io.stderr = { write: (s: string) => stderrLines.push(s) };
    const code = await runInstall([], io);
    expect(code).toBe(0);
    expect(stderrLines.join("")).toMatch(/doesn't exist right now/);
  });

  it("does not warn about a --ssh-auth-sock that does exist on disk", async () => {
    const { io, dir: d } = baseIo({ platform: "linux" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    const realSockPath = path.join(d, "real.sock");
    writeFileSync(realSockPath, "");
    io.env = { ...(io.env as Record<string, string>), SSH_AUTH_SOCK: realSockPath };
    const stderrLines: string[] = [];
    io.stderr = { write: (s: string) => stderrLines.push(s) };
    const code = await runInstall([], io);
    expect(code).toBe(0);
    expect(stderrLines.join("")).not.toMatch(/doesn't exist right now/);
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

  it("win32: uninstall removes the task XML and deletes it via schtasks; a no-op is not an error", async () => {
    const { io, calls, dir: d } = baseIo({ platform: "win32" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    await runInstall([], io);
    const xmlPath = windowsTaskXmlPath(io);
    expect(existsSync(xmlPath)).toBe(true);

    calls.length = 0;
    const code = await runUninstall([], io);
    expect(code).toBe(0);
    expect(existsSync(xmlPath)).toBe(false);
    expect(calls.map((c) => c.join(" "))).toEqual([`schtasks /Delete /TN ${WINDOWS_TASK_NAME} /F`]);

    // Uninstalling again (nothing installed) must not throw or fail.
    const second = await runUninstall([], io);
    expect(second).toBe(0);
  });

  it("win32: a failed schtasks /Delete is surfaced, not swallowed — the task XML is left in place", async () => {
    const { io, dir: d } = baseIo({ platform: "win32" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    await runInstall([], io);
    const xmlPath = windowsTaskXmlPath(io);

    io.spawnSync = (cmd: string, args: string[]) => {
      if (args.includes("/Delete"))
        return { status: 1, stdout: "", stderr: "ERROR: Access is denied." };
      return { status: 0, stdout: "", stderr: "" };
    };
    const stderrLines: string[] = [];
    io.stderr = { write: (s: string) => stderrLines.push(s) };
    const code = await runUninstall([], io);
    expect(code).toBe(1);
    expect(stderrLines.join("")).toMatch(/schtasks \/Delete failed/);
    expect(existsSync(xmlPath)).toBe(true);
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
