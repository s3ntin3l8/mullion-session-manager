// Issue #1728 — tests for the Windows scope backend (a detached pty-host
// master standing in for dtach).
//
// Same three questions as the macOS backend (scope-detached.test.ts):
// liveness (the socket probe — "unknown" is never widened to "dead"), the
// master's process tree (from the CIM process table), and teardown
// (`taskkill /T /F` on the master). Every OS call is mocked, so these run on
// any platform.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
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
let spawnCalls: Array<{ file: string; args: string[] }> = [];
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
    spawn: vi.fn((file: string, args: string[]) => {
      spawnCalls.push({ file, args });
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

const SESSIONS_DIR = path.resolve("/data/sessions");
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
  });

  it("runs any other program as given", async () => {
    await backend().start({
      id: "5",
      argv: ["emulator.exe", "-avd", "x"],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 5_000,
      label: "device bootstrap",
    });
    expect(spawnCalls[0]).toEqual({ file: "emulator.exe", args: ["-avd", "x"] });
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

  it("explains a failed launch whose pipe is already served", async () => {
    spawnExitCode = 1;
    probeResults.set(endpoint("5"), "live");
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
  it("kills the master's whole tree", async () => {
    cimOutput = tableForSession("7", 100);
    await backend().stop("7");
    expect(taskkillCalls).toEqual([["/T", "/F", "/PID", "100"]]);
  });

  it("does nothing when no master serves the session", async () => {
    cimOutput = tableForSession("8");
    await backend().stop("7");
    expect(taskkillCalls).toEqual([]);
  });

  it("does nothing when the process table cannot be read", async () => {
    cimFails = true;
    await backend().stop("7");
    expect(taskkillCalls).toEqual([]);
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
