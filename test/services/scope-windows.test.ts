// Issue #1728 — tests for the Windows scope backend (a detached pty-host
// master standing in for dtach).
//
// Same three questions as the macOS backend (scope-detached.test.ts):
// liveness (the socket probe — "unknown" is never widened to "dead"), the
// master's process tree (from the CIM process table), and teardown
// (`taskkill /T /F` on the master). Every OS call is mocked, so these run on
// any platform.

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// --- the mocked socket probe ----------------------------------------------
let probeResults: Map<string, "live" | "dead" | "unknown">;
let probeThrows: Set<string>;

vi.mock("../../src/services/unix-socket.js", () => ({
  probeSocket: vi.fn(async (endpoint: string) => {
    if (probeThrows.has(endpoint)) throw new Error("probe exploded");
    return probeResults.get(endpoint) ?? "unknown";
  }),
}));

// --- the mocked process table / taskkill / launch ---------------------------
let cimOutput = "";
let cimFails = false;
let taskkillCalls: string[][] = [];
let spawnCalls: Array<{ file: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
let spawnExitCode = 0;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    execFile: vi.fn(
      (
        file: string,
        args: string[],
        _options: unknown,
        callback: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (file === "powershell.exe") {
          if (cimFails) callback(new Error("powershell: timed out"), "", "");
          else callback(null, cimOutput, "");
          return;
        }
        if (file === "taskkill") {
          taskkillCalls.push(args);
          callback(null, "", "");
          return;
        }
        callback(new Error(`unexpected execFile: ${file}`), "", "");
      },
    ),
    spawn: vi.fn((file: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      spawnCalls.push({ file, args, env: options?.env });
      const child = new EventEmitter() as EventEmitter & {
        kill: () => boolean;
        exitCode: number | null;
        signalCode: string | null;
      };
      child.kill = vi.fn(() => true);
      child.exitCode = null;
      child.signalCode = null;
      setImmediate(() => {
        child.exitCode = spawnExitCode;
        child.emit("exit", spawnExitCode);
      });
      return child;
    }),
  };
});

const {
  WindowsScopeBackend,
  parseCimProcessTable,
  isPtyHostMasterFor,
  splitCommandLine,
  resolvePtyHostPath,
} = await import("../../src/services/scope/windows.js");
const { sessionSocketPath } = await import("../../src/services/scope/dtach.js");
const { createPtyHostToken, ptyHostTokenPath, readPtyHostToken } =
  await import("../../src/services/pty-host-token.js");
const { TOKEN_ENV } = await import("../../src/pty-host/protocol.mjs");
const { EXIT_ENDPOINT_IN_USE } = await import("../../src/pty-host/master.mjs");

const SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "scope-windows-"));
afterAll(() => fs.rmSync(SESSIONS_DIR, { recursive: true, force: true }));
const endpoint = (id: string) => sessionSocketPath(SESSIONS_DIR, id);
const backend = () => new WindowsScopeBackend({ sessionsDir: SESSIONS_DIR });

/** One CIM row. */
function row(pid: number, ppid: number, name: string, commandLine: string | null) {
  return { ProcessId: pid, ParentProcessId: ppid, Name: name, CommandLine: commandLine };
}

/** A process table holding one session's master, shell and agent. */
function tableForSession(id: string, masterPid = 100): string {
  return JSON.stringify([
    row(4, 0, "System", null),
    row(
      masterPid,
      1,
      "node.exe",
      `"C:\\nodejs\\node.exe" C:\\mullion\\dist\\pty-host\\pty-host.mjs --serve ${endpoint(id)} "C:\\Program Files\\Git\\bin\\bash.exe" -lc claude`,
    ),
    row(masterPid + 1, masterPid, "conhost.exe", "\\??\\C:\\WINDOWS\\system32\\conhost.exe 0x4"),
    row(masterPid + 2, masterPid, "bash.exe", '"C:\\Program Files\\Git\\bin\\bash.exe" -lc claude'),
    row(masterPid + 3, masterPid + 2, "claude.exe", "claude"),
  ]);
}

beforeEach(() => {
  probeResults = new Map();
  probeThrows = new Set();
  cimOutput = "";
  cimFails = false;
  taskkillCalls = [];
  spawnCalls = [];
  spawnExitCode = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseCimProcessTable", () => {
  it("reads a list of processes, keeping the command line", () => {
    const table = parseCimProcessTable(tableForSession("7"));
    expect(table.map((e) => e.pid)).toEqual([4, 100, 101, 102, 103]);
    expect(table[1].ppid).toBe(1);
    expect(table[1].command).toContain("--serve");
  });

  it("accepts the bare object ConvertTo-Json renders for a one-row table", () => {
    expect(parseCimProcessTable(JSON.stringify(row(9, 1, "x.exe", "x")))).toEqual([
      { pid: 9, ppid: 1, pgid: 0, command: "x" },
    ]);
  });

  it("falls back to the process name when the command line is not readable", () => {
    expect(parseCimProcessTable(JSON.stringify([row(9, 1, "secret.exe", null)]))[0].command).toBe(
      "secret.exe",
    );
  });

  it("skips rows without a pid, and reads empty output as an empty table", () => {
    expect(parseCimProcessTable(JSON.stringify([{ Name: "ghost" }]))).toEqual([]);
    expect(parseCimProcessTable("  ")).toEqual([]);
  });
});

describe("isPtyHostMasterFor", () => {
  const pipe = "\\\\.\\pipe\\mullion-abc-1";

  it("matches the master serving the endpoint", () => {
    expect(isPtyHostMasterFor(`node pty-host.mjs --serve ${pipe} bash -lc x`, pipe)).toBe(true);
    expect(isPtyHostMasterFor(`node pty-host.mjs --serve ${pipe}`, pipe)).toBe(true);
  });

  it("does not match the -n launcher, another session, or an unrelated process", () => {
    expect(isPtyHostMasterFor(`node pty-host.mjs -n ${pipe} bash`, pipe)).toBe(false);
    expect(isPtyHostMasterFor(`node pty-host.mjs --serve ${pipe}1 bash`, pipe)).toBe(false);
    expect(isPtyHostMasterFor(`other.exe --serve ${pipe} bash`, pipe)).toBe(false);
  });
});

describe("splitCommandLine", () => {
  it("groups double-quoted arguments and drops the quotes", () => {
    expect(splitCommandLine('"C:\\Program Files\\Git\\bin\\bash.exe" -lc "a b"')).toEqual([
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "-lc",
      "a b",
    ]);
  });

  it("collapses runs of whitespace and keeps an empty quoted argument", () => {
    expect(splitCommandLine('  a   ""  b ')).toEqual(["a", "", "b"]);
  });
});

describe("resolvePtyHostPath", () => {
  it("uses the stable install path under MULLION_HOME", () => {
    vi.stubEnv("MULLION_HOME", "/opt/mullion");
    expect(resolvePtyHostPath()).toBe(
      path.join("/opt/mullion", "current", "dist", "pty-host", "pty-host.mjs"),
    );
  });

  it("falls back to the script next to the source tree", () => {
    vi.stubEnv("MULLION_HOME", "");
    expect(resolvePtyHostPath()).toBe(
      path.resolve(import.meta.dirname, "..", "..", "src", "pty-host", "pty-host.mjs"),
    );
  });
});

describe("WindowsScopeBackend.start", () => {
  it("runs the dtach-shaped program with the pty-host master standing in for dtach", async () => {
    await backend().start({
      id: "5",
      argv: ["dtach", "-n", endpoint("5"), "bash.exe", "-lc", "claude"],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 5_000,
      label: "master bootstrap",
    });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].file).toBe(process.execPath);
    expect(spawnCalls[0].args).toEqual([
      resolvePtyHostPath(),
      "-n",
      endpoint("5"),
      "bash.exe",
      "-lc",
      "claude",
    ]);
    // A fresh session token: handed to the master in its environment, and
    // kept where Session.attachClient() reads it back.
    const token = spawnCalls[0].env?.[TOKEN_ENV];
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(readPtyHostToken(SESSIONS_DIR, "5")).toBe(token);
  });

  it("runs any other program as given", async () => {
    await backend().start({
      id: "6",
      argv: ["emulator.exe", "-avd", "x"],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 5_000,
      label: "device bootstrap",
    });
    expect(spawnCalls[0]).toMatchObject({ file: "emulator.exe", args: ["-avd", "x"] });
    // Only a session master gets a token.
    expect(spawnCalls[0].env?.[TOKEN_ENV]).toBeUndefined();
    expect(fs.existsSync(ptyHostTokenPath(SESSIONS_DIR, "6"))).toBe(false);
  });

  it("refuses an empty argv", async () => {
    await expect(
      backend().start({
        id: "5",
        argv: [],
        cwd: process.cwd(),
        env: {},
        timeoutMs: 5_000,
        label: "master bootstrap",
      }),
    ).rejects.toThrow(/no program to launch/);
  });

  it("explains a launch refused because another master already serves the pipe", async () => {
    spawnExitCode = EXIT_ENDPOINT_IN_USE;
    await expect(
      backend().start({
        id: "5",
        argv: ["dtach", "-n", endpoint("5"), "bash.exe"],
        cwd: process.cwd(),
        env: {},
        timeoutMs: 5_000,
        label: "master bootstrap",
      }),
    ).rejects.toThrow(/already in use/);
  });

  it("adds nothing to a failed launch whose pipe is not served", async () => {
    spawnExitCode = 1;
    probeThrows.add(endpoint("5"));
    const err = await backend()
      .start({
        id: "5",
        argv: ["dtach", "-n", endpoint("5"), "bash.exe"],
        cwd: process.cwd(),
        env: {},
        timeoutMs: 5_000,
        label: "master bootstrap",
      })
      .catch((e: Error) => e);
    expect(String(err)).toMatch(/master bootstrap exited with code 1/);
    expect(String(err)).not.toMatch(/already in use/);
  });
});

describe("WindowsScopeBackend.isAliveBatch", () => {
  it("maps the probe onto alive/dead/unknown and answers for every id", async () => {
    probeResults.set(endpoint("1"), "live");
    probeResults.set(endpoint("2"), "dead");
    probeThrows.add(endpoint("4"));
    expect({ ...(await backend().isAliveBatch(["1", "2", "3", "4"])) }).toEqual({
      "1": "alive",
      "2": "dead",
      "3": "unknown",
      "4": "unknown",
    });
  });
});

describe("WindowsScopeBackend.stop", () => {
  it("kills the master's whole tree, then removes the session token", async () => {
    createPtyHostToken(SESSIONS_DIR, "7");
    cimOutput = tableForSession("7", 100);
    await backend().stop("7");
    expect(taskkillCalls).toEqual([["/T", "/F", "/PID", "100"]]);
    expect(readPtyHostToken(SESSIONS_DIR, "7")).toBe("");
  });

  it("kills nothing when no master serves the session, and clears a stale token", async () => {
    createPtyHostToken(SESSIONS_DIR, "7");
    cimOutput = tableForSession("8");
    await backend().stop("7");
    expect(taskkillCalls).toEqual([]);
    expect(readPtyHostToken(SESSIONS_DIR, "7")).toBe("");
  });

  it("does nothing when the process table cannot be read — the token stays", async () => {
    const token = createPtyHostToken(SESSIONS_DIR, "7");
    cimFails = true;
    await backend().stop("7");
    expect(taskkillCalls).toEqual([]);
    // The master may still be running; it must stay attachable.
    expect(readPtyHostToken(SESSIONS_DIR, "7")).toBe(token);
  });

  it("does nothing when the process table is not valid JSON", async () => {
    cimOutput = "not json";
    await backend().stop("7");
    expect(taskkillCalls).toEqual([]);
  });
});

describe("WindowsScopeBackend.listProcesses", () => {
  it("lists the master and everything under it, named by executable", async () => {
    cimOutput = tableForSession("7", 100);
    const procs = await backend().listProcesses("7");
    expect(procs.map((p) => [p.pid, p.comm])).toEqual([
      [100, "node.exe"],
      [101, "conhost.exe"],
      [102, "bash.exe"],
      [103, "claude"],
    ]);
    expect(procs[2].cmdline).toEqual(["C:\\Program Files\\Git\\bin\\bash.exe", "-lc", "claude"]);
  });

  it("is empty when no master serves the session, or the table cannot be read", async () => {
    cimOutput = tableForSession("8");
    expect(await backend().listProcesses("7")).toEqual([]);
    cimFails = true;
    expect(await backend().listProcesses("7")).toEqual([]);
  });
});

describe("WindowsScopeBackend.start — the token after a failed launch", () => {
  const failLaunch = (id: string) =>
    backend().start({
      id,
      argv: ["dtach", "-n", endpoint(id), "bash.exe"],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 5_000,
      label: "master bootstrap",
    });

  it("puts the previous token back when another master already serves the pipe", async () => {
    const previous = createPtyHostToken(SESSIONS_DIR, "21");
    spawnExitCode = EXIT_ENDPOINT_IN_USE;
    await expect(failLaunch("21")).rejects.toThrow(/already in use/);
    // That master holds the previous token — the session stays attachable.
    expect(readPtyHostToken(SESSIONS_DIR, "21")).toBe(previous);
  });

  it("removes the unused token when the pipe is in use but there was no previous one", async () => {
    spawnExitCode = EXIT_ENDPOINT_IN_USE;
    await expect(failLaunch("22")).rejects.toThrow();
    expect(readPtyHostToken(SESSIONS_DIR, "22")).toBe("");
  });

  it("keeps the NEW token when the launch failed but its own master answers", async () => {
    // e.g. -n's readiness timeout fired while the master it started was still
    // binding: the master now serving holds the token this launch wrote.
    createPtyHostToken(SESSIONS_DIR, "23");
    spawnExitCode = 1;
    probeResults.set(endpoint("23"), "live");
    await expect(failLaunch("23")).rejects.toThrow(/exited with code 1/);
    const fresh = spawnCalls[0].env?.[TOKEN_ENV];
    expect(readPtyHostToken(SESSIONS_DIR, "23")).toBe(fresh);
  });

  it("keeps the new token when the probe cannot tell", async () => {
    createPtyHostToken(SESSIONS_DIR, "24");
    spawnExitCode = 1;
    await expect(failLaunch("24")).rejects.toThrow();
    expect(readPtyHostToken(SESSIONS_DIR, "24")).toBe(spawnCalls[0].env?.[TOKEN_ENV]);
  });

  it("removes the unused token when nothing serves the pipe", async () => {
    createPtyHostToken(SESSIONS_DIR, "25");
    spawnExitCode = 1;
    probeResults.set(endpoint("25"), "dead");
    await expect(failLaunch("25")).rejects.toThrow();
    expect(readPtyHostToken(SESSIONS_DIR, "25")).toBe("");
  });

  it("reports the launch error even when settling the token fails", async () => {
    spawnExitCode = EXIT_ENDPOINT_IN_USE;
    // Restoring the previous token will fail: its "file" is now a directory.
    createPtyHostToken(SESSIONS_DIR, "26");
    const launching = failLaunch("26");
    fs.rmSync(ptyHostTokenPath(SESSIONS_DIR, "26"), { force: true });
    fs.mkdirSync(ptyHostTokenPath(SESSIONS_DIR, "26"));
    await expect(launching).rejects.toThrow(/already in use/);
    fs.rmSync(ptyHostTokenPath(SESSIONS_DIR, "26"), { recursive: true, force: true });
  });

  it("does not touch tokens for a program that is not a session master", async () => {
    const previous = createPtyHostToken(SESSIONS_DIR, "27");
    spawnExitCode = 1;
    await expect(
      backend().start({
        id: "27",
        argv: ["emulator.exe"],
        cwd: process.cwd(),
        env: {},
        timeoutMs: 5_000,
        label: "device bootstrap",
      }),
    ).rejects.toThrow();
    expect(readPtyHostToken(SESSIONS_DIR, "27")).toBe(previous);
  });
});
