import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import {
  buildLaunchdPlist,
  buildSystemdUnit,
  buildWindowsRunCommand,
  launchdPlistPath,
  systemdUnitPath,
  windowsTaskXmlPath,
  xmlCommentSafe,
  LAUNCHD_LABEL,
  SYSTEMD_UNIT_NAME,
  WINDOWS_TASK_NAME,
  WINDOWS_RUN_KEY,
  WINDOWS_HELPER_EXE_NAME,
} from "../../src/cli/ssh-agent-helper-install.mjs";
// Dispatched through runHelper, not called directly — matches how
// mullion.mjs actually invokes install/uninstall, and (like pair/run)
// CliUsageError is only caught at this layer, not inside runInstall itself.
import { runHelper, credentialPath } from "../../src/cli/ssh-agent-helper.mjs";

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

describe("buildWindowsRunCommand", () => {
  it("embeds the exact argv run needs, in order, each token quoted, execPath included", () => {
    const command = buildWindowsRunCommand({
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      scriptPath: "C:\\Program Files\\Mullion\\dist\\cli\\mullion.mjs",
      sshAuthSock: "\\\\.\\pipe\\openssh-ssh-agent",
    });
    expect(command).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\Mullion\\dist\\cli\\mullion.mjs" "helper" "run" "--ssh-auth-sock" "\\\\.\\pipe\\openssh-ssh-agent"',
    );
  });

  // Self-review (mullion-reviewer, carried over from the retired Scheduled
  // Task generator) — an embedded `"` must round-trip through
  // CommandLineToArgvW-style parsing (what CreateProcess does with an HKCU
  // Run value at logon) rather than being silently truncated/corrupted.
  // Simpler than the XML generator's own version of this test: a REG_SZ
  // value has no XML-decode step first, so this exercises windowsArgEscape
  // directly against the real parsing rule.
  it("a value containing a literal double-quote round-trips through Windows-argv-parsing", () => {
    const command = buildWindowsRunCommand({
      execPath: "C:\\node.exe",
      scriptPath: "C:\\mullion.mjs",
      sshAuthSock: '\\\\.\\pipe\\foo"bar',
    });

    // Minimal CommandLineToArgvW-shaped tokenizer — splits on unquoted
    // whitespace, treats `\"` inside a quoted run as an embedded quote (not
    // a close), same rule windowsArgEscape's own doc comment describes.
    function parseWindowsArgv(commandLine: string): string[] {
      const args: string[] = [];
      let current = "";
      let inQuotes = false;
      let i = 0;
      while (i < commandLine.length) {
        const ch = commandLine[i];
        if (ch === "\\") {
          let backslashes = 0;
          while (commandLine[i] === "\\") {
            backslashes++;
            i++;
          }
          if (commandLine[i] === '"') {
            current += "\\".repeat(Math.floor(backslashes / 2));
            if (backslashes % 2 === 0) {
              inQuotes = !inQuotes;
            } else {
              current += '"';
            }
            i++;
          } else {
            current += "\\".repeat(backslashes);
          }
          continue;
        }
        if (ch === '"') {
          inQuotes = !inQuotes;
          i++;
          continue;
        }
        if (ch === " " && !inQuotes) {
          if (current.length > 0) {
            args.push(current);
            current = "";
          }
          i++;
          continue;
        }
        current += ch;
        i++;
      }
      if (current.length > 0) args.push(current);
      return args;
    }

    const argv = parseWindowsArgv(command);
    expect(argv).toEqual([
      "C:\\node.exe",
      "C:\\mullion.mjs",
      "helper",
      "run",
      "--ssh-auth-sock",
      '\\\\.\\pipe\\foo"bar',
    ]);
  });

  // Round 3 (PR2) — a SEA has no separate script file: `execPath` IS the
  // whole program. `scriptPath: null` (never `undefined` — see
  // runInstall's own comment) must collapse the argv, not embed a "null"
  // token or an empty quoted string.
  it("omits the script-path token entirely when scriptPath is null (SEA shape)", () => {
    const command = buildWindowsRunCommand({
      execPath: "C:\\Users\\me\\AppData\\Local\\Mullion\\mullion-helper.exe",
      scriptPath: null,
      sshAuthSock: "\\\\.\\pipe\\openssh-ssh-agent",
    });
    expect(command).toBe(
      '"C:\\Users\\me\\AppData\\Local\\Mullion\\mullion-helper.exe" "helper" "run" "--ssh-auth-sock" "\\\\.\\pipe\\openssh-ssh-agent"',
    );
    expect(command).not.toContain("null");
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
// temp dir; launchctl/systemctl/reg/schtasks/taskkill themselves are
// stubbed via io.spawnSync so this suite runs the same on any CI platform
// without a real launchd, systemd, or Windows registry.
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
      // Round 4 (issue #871) — installWindows spawns the helper detached
      // rather than relying on a Scheduled Task's own `/Run`. Stubbed the
      // same way spawnSync is: without this, a win32 test with no override
      // would fall through to the REAL node:child_process.spawn and launch
      // an actual (if harmless, detached, unref'd) process against
      // whatever `execPath` happens to be — never acceptable in a unit
      // test, and exactly the kind of environment-dependent flake this
      // seam convention exists to avoid.
      //
      // A minimal fake EventEmitter, not a plain object: spawnDetachedHelper
      // (ssh-agent-helper-install.mjs) awaits a real 'spawn' or 'error'
      // event — a stub with no `.once()` would throw the moment that code
      // runs. Fires 'spawn' on a microtask by default (a real spawn's
      // success signal is always asynchronous); override `io.spawn` per
      // test to fire 'error' instead for the failure-path tests.
      spawn: (cmd: string, args: string[]) => fakeChildProcess(calls, cmd, args, { fails: false }),
      ...overrides,
    };
    return { io, calls, dir };
  }

  // win32-only helper: installWindows/uninstallWindows issue several
  // `reg`/`schtasks`/`taskkill` calls per run (legacy cleanup plus the
  // real mechanism) — tests care about one specific one, not the exact
  // sequence, so find it by argv[0]/argv[1] rather than asserting the
  // whole `calls` array in order.
  function findCall(calls: string[][], cmd: string, subcommand?: string) {
    return calls.find((c) => c[0] === cmd && (subcommand === undefined || c[1] === subcommand));
  }

  // A minimal fake `child_process.ChildProcess` — just enough of the
  // `EventEmitter` surface spawnDetachedHelper (ssh-agent-helper-install.mjs)
  // actually calls (`.once()`, and `.unref()` once "spawned"). Fires its
  // event on a microtask, not synchronously, to match how a real 'spawn'/
  // 'error' event is always asynchronous — a synchronous stub would hide a
  // bug where the production code assumed synchronous delivery.
  function fakeChildProcess(
    calls: string[][],
    cmd: string,
    args: string[],
    opts: { fails: boolean; errorMessage?: string },
  ) {
    calls.push(["SPAWN", cmd, ...args]);
    const listeners: Record<string, Array<(...a: unknown[]) => void>> = { spawn: [], error: [] };
    queueMicrotask(() => {
      const event = opts.fails ? "error" : "spawn";
      const arg = opts.fails ? new Error(opts.errorMessage ?? "spawn failed") : undefined;
      for (const cb of listeners[event]) cb(arg);
    });
    return {
      once: (event: string, cb: (...a: unknown[]) => void) => {
        listeners[event]?.push(cb);
      },
      unref: () => {},
    };
  }

  // Same fixture shape as "does not warn when a valid credential is already
  // present" below — a minimal but real credential JSON, written straight
  // to credentialPath(io) rather than via runPair, since these tests are
  // exercising install/uninstall, not pairing itself.
  function writeCredential(io: Record<string, unknown>) {
    const file = credentialPath(io);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        baseUrl: "https://mullion.example.com",
        bridgeId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        sessionId: "b".repeat(64),
        sessionSecret: "c".repeat(64),
      }),
    );
    return file;
  }

  it("refuses to install without SSH_AUTH_SOCK (flag or ambient)", async () => {
    const { io } = baseIo({ env: { MULLION_HELPER_STATE_DIR: "/irrelevant" }, platform: "linux" });
    const stderrLines: string[] = [];
    io.stderr = { write: (s: string) => stderrLines.push(s) };
    const code = await runInstall([], io);
    expect(code).toBe(2);
    expect(stderrLines.join("")).toMatch(/no SSH_AUTH_SOCK to install with/);
  });

  // Round 3 (PR2) — the SAME "no flag, no ambient env" case as above, but
  // on win32, must succeed rather than refuse: this platform has an
  // empirically-confirmed default (issue #874) neither macOS nor Linux has
  // an equivalent for.
  it("win32: installs with no --ssh-auth-sock or ambient SSH_AUTH_SOCK, defaulting to the named pipe", async () => {
    const { io, calls, dir: d } = baseIo({ platform: "win32" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    // Real MULLION_HELPER_STATE_DIR from baseIo's own defaults, SSH_AUTH_SOCK
    // deliberately dropped — the same "no flag, no ambient env" case as the
    // refusing test above, but on win32.
    io.env = { MULLION_HELPER_STATE_DIR: io.env.MULLION_HELPER_STATE_DIR };
    const code = await runInstall([], io);
    expect(code).toBe(0);
    const regAdd = findCall(calls, "reg", "add");
    expect(regAdd).toBeDefined();
    expect(regAdd![regAdd!.indexOf("/d") + 1]).toContain("\\\\.\\pipe\\openssh-ssh-agent");
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

  it("win32: writes an HKCU Run value with the exact command and starts the helper immediately", async () => {
    const { io, calls, dir: d } = baseIo({ platform: "win32" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    const code = await runInstall([], io);
    expect(code).toBe(0);
    const regAdd = findCall(calls, "reg", "add");
    expect(regAdd).toBeDefined();
    expect(regAdd).toEqual(
      expect.arrayContaining([
        "reg",
        "add",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
        "/v",
        WINDOWS_TASK_NAME,
        "/t",
        "REG_SZ",
        "/f",
      ]),
    );
    const spawnCall = findCall(calls, "SPAWN");
    expect(spawnCall).toBeDefined();
    expect(spawnCall![1]).toBe(io.execPath);
  });

  // Round 3 (PR2) — under a Node SEA, `execPath` IS the whole program: no
  // sibling `mullion.mjs` exists to point a scriptPath at. `io.isSea: true`
  // + `scriptPath` deleted must produce the collapsed SEA argv, not fall
  // through to `defaultScriptPath()` (which resolves a real path on disk
  // relative to THIS test file's own install module — if that path leaked
  // into the XML, this assertion on "no mullion.mjs anywhere" would catch
  // it).
  it("win32 SEA: omits the script path and never falls back to defaultScriptPath()", async () => {
    const { io, calls, dir: d } = baseIo({ platform: "win32" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    (io as { isSea?: boolean }).isSea = true;
    delete (io as { scriptPath?: string }).scriptPath;
    io.execPath = "C:\\Users\\me\\AppData\\Local\\Mullion\\mullion-helper.exe";
    const code = await runInstall([], io);
    expect(code).toBe(0);
    const regAdd = findCall(calls, "reg", "add");
    expect(regAdd).toBeDefined();
    const command = regAdd![regAdd!.indexOf("/d") + 1];
    expect(command).not.toContain("mullion.mjs");
    expect(command).toBe(
      '"C:\\Users\\me\\AppData\\Local\\Mullion\\mullion-helper.exe" "helper" "run" "--ssh-auth-sock" "/tmp/agent.sock"',
    );
    const spawnCall = findCall(calls, "SPAWN");
    expect(spawnCall).toEqual([
      "SPAWN",
      io.execPath,
      "helper",
      "run",
      "--ssh-auth-sock",
      "/tmp/agent.sock",
    ]);
  });

  // Round 4 (issue #820, macOS SEA support) — buildLaunchdPlist now has the
  // same scriptPath-optional handling buildWindowsRunCommand already has.
  // Adapted from the win32 SEA test above: `execPath` IS the whole program
  // under a SEA, no sibling `mullion.mjs` to point a scriptPath at.
  it("darwin SEA: omits the script path and never falls back to defaultScriptPath()", async () => {
    const { io, dir: d } = baseIo({ platform: "darwin", uid: 501 });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    (io as { isSea?: boolean }).isSea = true;
    delete (io as { scriptPath?: string }).scriptPath;
    io.execPath = "/Users/me/Library/Application Support/Mullion/mullion-helper";
    const code = await runInstall([], io);
    expect(code).toBe(0);
    const plistPath = launchdPlistPath(io);
    const contents = readFileSync(plistPath, "utf8");
    expect(contents).not.toContain("mullion.mjs");
    const argsBlock = contents.slice(contents.indexOf("<array>"), contents.indexOf("</array>"));
    const strings = [...argsBlock.matchAll(/<string>(.*?)<\/string>/g)].map((m) => m[1]);
    expect(strings).toEqual([
      "/Users/me/Library/Application Support/Mullion/mullion-helper",
      "helper",
      "run",
      "--ssh-auth-sock",
      "/tmp/agent.sock",
    ]);
  });

  // Self-review — found by actually building and running a Linux SEA smoke
  // binary: `isSea` on any platform OTHER than win32 used to fall through
  // to `scriptPath: null`, which `buildLaunchdPlist`/`buildSystemdUnit`
  // (unlike buildWindowsRunCommand) had no null-handling for at all —
  // `systemdQuote(null)` threw "Cannot read properties of null" rather
  // than a clear error. Round 4 fixed buildLaunchdPlist and lifted the
  // refusal for darwin (test above); buildSystemdUnit still has no
  // null-handling, and no SEA is ever built for Linux
  // (scripts/build-helper-sea.mjs targets win32/darwin only), so Linux
  // alone stays refused.
  it("linux SEA: refuses cleanly instead of crashing (no Linux SEA is ever built)", async () => {
    const { io, dir: d } = baseIo({ platform: "linux" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    (io as { isSea?: boolean }).isSea = true;
    delete (io as { scriptPath?: string }).scriptPath;
    const stderrLines: string[] = [];
    io.stderr = { write: (s: string) => stderrLines.push(s) };
    const code = await runInstall([], io);
    expect(code).toBe(1);
    expect(stderrLines.join("")).toMatch(/not supported on 'linux'/);
  });

  // Hermes review, PR #879, on the mechanism this replaces (`schtasks
  // /Run`) — the invariant carries over: registering the autostart entry
  // must not by itself mean "running now". A failed immediate start must
  // not undo the successful registration.
  it("win32: a failed spawn degrades to a warning — the Run value is still registered", async () => {
    const { io, calls, dir: d } = baseIo({ platform: "win32" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    io.spawn = () => {
      throw new Error("EPERM: spawn C:\\...\\mullion-helper.exe");
    };
    const stderrLines: string[] = [];
    io.stderr = { write: (s: string) => stderrLines.push(s) };
    const code = await runInstall([], io);
    expect(code).toBe(0);
    expect(findCall(calls, "reg", "add")).toBeDefined();
    expect(stderrLines.join("")).toMatch(/could not start it immediately/);
  });

  // Round 4 (issue #871, mullion-reviewer round) — the REAL shape a spawn
  // failure takes (an AV/EDR product locking the just-written exe, a
  // transient ENOENT/EACCES): asynchronous, via an 'error' event on the
  // returned ChildProcess, never a synchronous throw from spawn() itself
  // (the test above covers that separate, less realistic case). Before
  // spawnDetachedHelper awaited this event, nothing observed it at all —
  // the install reported success while the helper silently never started.
  it("win32: an async spawn 'error' event (the realistic failure shape) also degrades to a warning, not silent success", async () => {
    const { io, calls, dir: d } = baseIo({ platform: "win32" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    io.spawn = (cmd: string, args: string[]) =>
      fakeChildProcess(calls, cmd, args, {
        fails: true,
        errorMessage: "EACCES: permission denied",
      });
    const stderrLines: string[] = [];
    io.stderr = { write: (s: string) => stderrLines.push(s) };
    const code = await runInstall([], io);
    expect(code).toBe(0);
    expect(findCall(calls, "reg", "add")).toBeDefined();
    expect(stderrLines.join("")).toMatch(
      /could not start it immediately \(EACCES: permission denied\)/,
    );
  });

  // Round 4 (issue #871, mullion-reviewer round) — re-running `helper
  // install` (a --ssh-auth-sock change, most plausibly) must not leave a
  // process from the PRIOR install still running, bound to the old value,
  // racing the new one on the same credential file. `reg add` alone only
  // ever replaces the registry entry, never the already-running process.
  it("win32: re-install kills a previously-running helper process before starting the new one", async () => {
    const { io, calls, dir: d } = baseIo({ platform: "win32" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    await runInstall(["--ssh-auth-sock", "\\\\.\\pipe\\first"], io);
    calls.length = 0;

    const code = await runInstall(["--ssh-auth-sock", "\\\\.\\pipe\\second"], io);
    expect(code).toBe(0);
    const taskkillIndex = calls.findIndex((c) => c[0] === "taskkill");
    const regAddIndex = calls.findIndex((c) => c[0] === "reg" && c[1] === "add");
    const spawnIndex = calls.findIndex((c) => c[0] === "SPAWN");
    expect(findCall(calls, "taskkill")).toEqual(["taskkill", "/IM", WINDOWS_HELPER_EXE_NAME, "/F"]);
    // Kill-old happens after the new registration succeeds (so a failed
    // re-registration never leaves the old, working process killed with
    // nothing in its place) and before the new process starts.
    expect(taskkillIndex).toBeGreaterThan(regAddIndex);
    expect(taskkillIndex).toBeLessThan(spawnIndex);
  });

  // Round 4 (issue #871) — installWindows best-effort tears down a
  // pre-round-4 Scheduled Task on EVERY install, not just the first, so a
  // laptop that once ran an older Mullion Helper version never ends up
  // with both mechanisms launching `helper run`.
  it("win32: each install best-effort cleans up a legacy Scheduled Task before registering the Run value", async () => {
    const { io, calls, dir: d } = baseIo({ platform: "win32" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    const code = await runInstall([], io);
    expect(code).toBe(0);
    expect(findCall(calls, "schtasks", "/End")).toEqual([
      "schtasks",
      "/End",
      "/TN",
      WINDOWS_TASK_NAME,
    ]);
    expect(findCall(calls, "schtasks", "/Delete")).toEqual([
      "schtasks",
      "/Delete",
      "/TN",
      WINDOWS_TASK_NAME,
      "/F",
    ]);
    const regAddIndex = calls.findIndex((c) => c[0] === "reg" && c[1] === "add");
    const scheduledTaskDeleteIndex = calls.findIndex(
      (c) => c[0] === "schtasks" && c[1] === "/Delete",
    );
    expect(scheduledTaskDeleteIndex).toBeLessThan(regAddIndex);
  });

  it("win32: surfaces a non-zero reg add exit as a failure", async () => {
    const { io, dir: d } = baseIo({ platform: "win32" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    io.spawnSync = (cmd: string, args: string[]) => {
      if (cmd === "reg" && args[0] === "add")
        return { status: 1, stdout: "", stderr: "ERROR: Access is denied." };
      return { status: 0, stdout: "", stderr: "" };
    };
    const stderrLines: string[] = [];
    io.stderr = { write: (s: string) => stderrLines.push(s) };
    const code = await runInstall([], io);
    expect(code).toBe(1);
    expect(stderrLines.join("")).toMatch(/reg add failed/);
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
    // Issue #904 — a real steady-state laptop is paired AND installed;
    // uninstall should forget both, not just the unit.
    const credFile = writeCredential(io);
    await runInstall([], io);
    const unitPath = systemdUnitPath(io);
    expect(existsSync(unitPath)).toBe(true);

    calls.length = 0;
    const code = await runUninstall([], io);
    expect(code).toBe(0);
    expect(existsSync(unitPath)).toBe(false);
    expect(existsSync(credFile)).toBe(false);
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
    const credFile = writeCredential(io);
    await runInstall([], io);
    const plistPath = launchdPlistPath(io);
    expect(existsSync(plistPath)).toBe(true);

    const code = await runUninstall([], io);
    expect(code).toBe(0);
    expect(existsSync(plistPath)).toBe(false);
    expect(existsSync(credFile)).toBe(false);
  });

  it("win32: uninstall removes the Run value and kills the running process; a no-op is not an error", async () => {
    const { io, calls, dir: d } = baseIo({ platform: "win32" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    const credFile = writeCredential(io);
    await runInstall([], io);

    calls.length = 0;
    const code = await runUninstall([], io);
    expect(code).toBe(0);
    expect(existsSync(credFile)).toBe(false);
    expect(findCall(calls, "reg", "query")).toBeDefined();
    expect(findCall(calls, "taskkill")).toEqual(["taskkill", "/IM", WINDOWS_HELPER_EXE_NAME, "/F"]);
    expect(findCall(calls, "reg", "delete")).toEqual([
      "reg",
      "delete",
      WINDOWS_RUN_KEY,
      "/v",
      WINDOWS_TASK_NAME,
      "/f",
    ]);

    // Uninstalling again (nothing installed) must not throw or fail.
    const second = await runUninstall([], io);
    expect(second).toBe(0);
  });

  // Round 4 (issue #871) — the "nothing installed" gate now checks the
  // Run key via `reg query`, not a file's existence, since installWindows
  // no longer writes one. A query returning non-zero (no such value) with
  // no legacy XML present either must report "nothing installed" and skip
  // straight past taskkill/reg delete, not just happen to also return 0.
  it("win32: uninstall reports nothing installed when the Run value was never registered", async () => {
    const { io, calls, dir: d } = baseIo({ platform: "win32" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    io.spawnSync = (cmd: string, args: string[]) => {
      if (cmd === "reg" && args[0] === "query") return { status: 1, stdout: "", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const stdoutLines: string[] = [];
    io.stdout = { write: (s: string) => stdoutLines.push(s) };
    const code = await runUninstall([], io);
    expect(code).toBe(0);
    expect(stdoutLines.join("")).toMatch(/nothing installed/);
    expect(findCall(calls, "reg", "delete")).toBeUndefined();
    expect(findCall(calls, "taskkill")).toBeUndefined();
  });

  // Round 4 (issue #871, mullion-reviewer round) — a laptop whose ONLY
  // artifact is a leftover pre-round-4 Scheduled Task/XML (no Run value
  // ever registered under this mechanism) must not claim a registry value
  // was "removed" — none ever existed for this install. This used to print
  // unconditionally regardless of `hadRunValue`.
  it("win32: uninstall with only a legacy XML present does not claim a Run value was removed", async () => {
    const { io, dir: d } = baseIo({ platform: "win32" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    io.spawnSync = (cmd: string, args: string[]) => {
      if (cmd === "reg" && args[0] === "query") return { status: 1, stdout: "", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const xmlPath = windowsTaskXmlPath(io);
    mkdirSync(path.dirname(xmlPath), { recursive: true });
    writeFileSync(xmlPath, "legacy task xml");

    const stdoutLines: string[] = [];
    io.stdout = { write: (s: string) => stdoutLines.push(s) };
    const code = await runUninstall([], io);
    expect(code).toBe(0);
    expect(existsSync(xmlPath)).toBe(false);
    expect(stdoutLines.join("")).not.toMatch(/removed .*MullionHelper/);
  });

  // Issue #904 — installWindows/runInstall never triggers this path (it
  // always pairs before saving, atomically), but a process killed between
  // saveCredential's own writeFileSync and renameSync (ssh-agent-helper.mjs)
  // leaves a `ssh-agent-bridge.json.<pid>.tmp` sibling holding the same
  // session_id — the same bearer credential under a different name, so
  // uninstall needs to sweep it too, not just the canonical filename.
  it("win32: uninstall also removes a stray write-to-temp-then-rename credential sibling", async () => {
    const { io, dir: d } = baseIo({ platform: "win32" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    const credFile = writeCredential(io);
    const staleTmp = `${credFile}.48291.tmp`;
    writeFileSync(staleTmp, "{}");
    await runInstall([], io);

    const code = await runUninstall([], io);
    expect(code).toBe(0);
    expect(existsSync(credFile)).toBe(false);
    expect(existsSync(staleTmp)).toBe(false);
  });

  // Issue #904 (self-review, PR #911) — a process killed before ITS OWN
  // renameSync ever ran (the canonical file was never created, only the
  // temp file it was about to become) must not print "removed
  // <canonical path>" — that path never existed. The message must name
  // whatever was actually removed.
  it("win32: uninstall reports the stray tmp path, not the canonical filename, when the main credential never existed", async () => {
    const { io, dir: d } = baseIo({ platform: "win32" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    const stateDir = path.join(d, "state");
    mkdirSync(stateDir, { recursive: true });
    const staleTmp = path.join(stateDir, "ssh-agent-bridge.json.48291.tmp");
    writeFileSync(staleTmp, "{}");
    await runInstall([], io);

    const stdoutLines: string[] = [];
    io.stdout = { write: (s: string) => stdoutLines.push(s) };
    const code = await runUninstall([], io);
    expect(code).toBe(0);
    expect(existsSync(staleTmp)).toBe(false);
    const output = stdoutLines.join("");
    expect(output).toMatch(/removed .*ssh-agent-bridge\.json\.48291\.tmp/);
    expect(output).not.toMatch(/removed .*[/\\]ssh-agent-bridge\.json\n/);
  });

  // Issue #904 (self-review, PR #911) — a failed delete (a real, non-exotic
  // occurrence on Windows: {app} IS stateDir(), and this runs from the
  // installer's own [UninstallRun], where a transient AV/indexer lock on a
  // just-renamed JSON file is ordinary) must be best-effort, like
  // saveCredential's own cleanup — reported to stderr, not thrown. An
  // uncaught throw here would turn an already-successful supervisor
  // teardown (the autostart entry really is gone, already reported below)
  // into a hard crash for a problem that isn't the teardown's fault. A
  // directory where the credential file should be is a real, portable,
  // deterministic way to force fs.rmSync to fail (EISDIR) without relying
  // on OS permission semantics that can behave differently across CI
  // runners.
  it("win32: a failed credential delete is reported, not thrown — the successful autostart teardown still counts", async () => {
    const { io, dir: d } = baseIo({ platform: "win32" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    await runInstall([], io);
    mkdirSync(credentialPath(io), { recursive: true });

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    io.stdout = { write: (s: string) => stdoutLines.push(s) };
    io.stderr = { write: (s: string) => stderrLines.push(s) };
    const code = await runUninstall([], io);
    expect(code).toBe(0);
    // The autostart teardown itself still succeeded and is still reported...
    expect(stdoutLines.join("")).toMatch(new RegExp(`removed .*${WINDOWS_TASK_NAME}`));
    // ...but the credential delete failure is reported as a warning, not a
    // "removed" claim, and definitely not an uncaught throw.
    expect(stderrLines.join("")).toMatch(/could not remove pairing credential/);
    expect(stdoutLines.join("")).not.toMatch(/removed .*ssh-agent-bridge\.json/);
  });

  // Issue #904 — the case per-platform placement would miss: a laptop that
  // ran `helper pair` but never `helper install` still needs uninstall to
  // forget the credential, even though every platform's own teardown
  // function early-returns 0 from its "nothing installed" gate before
  // touching anything.
  it("linux: uninstall removes a paired-but-never-installed credential without erroring", async () => {
    const { io } = baseIo({ platform: "linux" });
    const credFile = writeCredential(io);

    const code = await runUninstall([], io);
    expect(code).toBe(0);
    expect(existsSync(credFile)).toBe(false);
  });

  it("uninstall with no credential file present prints no 'removed' line", async () => {
    const { io } = baseIo({ platform: "linux" });
    const stdoutLines: string[] = [];
    io.stdout = { write: (s: string) => stdoutLines.push(s) };
    const code = await runUninstall([], io);
    expect(code).toBe(0);
    expect(stdoutLines.join("")).not.toMatch(/removed/);
  });

  it("win32: a failed taskkill (nothing running) does not block uninstall", async () => {
    const { io, dir: d } = baseIo({ platform: "win32" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    await runInstall([], io);

    io.spawnSync = (cmd: string) => {
      if (cmd === "taskkill")
        return {
          status: 1,
          stdout: "",
          stderr: 'ERROR: The process "mullion-helper.exe" not found.',
        };
      return { status: 0, stdout: "", stderr: "" };
    };
    const code = await runUninstall([], io);
    expect(code).toBe(0);
  });

  it("win32: a failed reg delete is surfaced, not swallowed", async () => {
    const { io, dir: d } = baseIo({ platform: "win32" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    const credFile = writeCredential(io);
    await runInstall([], io);

    io.spawnSync = (cmd: string, args: string[]) => {
      if (cmd === "reg" && args[0] === "delete")
        return { status: 1, stdout: "", stderr: "ERROR: Access is denied." };
      return { status: 0, stdout: "", stderr: "" };
    };
    const stderrLines: string[] = [];
    io.stderr = { write: (s: string) => stderrLines.push(s) };
    const code = await runUninstall([], io);
    expect(code).toBe(1);
    expect(stderrLines.join("")).toMatch(/reg delete failed/);
    // Issue #904 — a failed teardown must NOT delete the credential either:
    // a still-running, still-supervised `run` needs it to reconnect.
    expect(existsSync(credFile)).toBe(true);
  });
  it("linux: a failed systemctl disable is surfaced, not swallowed — the unit file is left in place", async () => {
    const { io, dir: d } = baseIo({ platform: "linux" });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    const credFile = writeCredential(io);
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
    // Issue #904 — nor the credential it'd need to reconnect with.
    expect(existsSync(credFile)).toBe(true);
  });

  it("darwin: a failed launchctl bootout is surfaced, not swallowed — the plist is left in place", async () => {
    const { io, dir: d } = baseIo({ platform: "darwin", uid: 501 });
    (io as { homedir?: string }).homedir = path.join(d, "home");
    const credFile = writeCredential(io);
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
    // Issue #904 — nor the credential it'd need to reconnect with.
    expect(existsSync(credFile)).toBe(true);
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
