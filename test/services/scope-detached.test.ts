// Issue #1716 (Phase 8) — tests for the macOS (detached) scope backend.
//
// The backend's whole job is to answer three questions about a session on a
// host that has no systemd:
//
//   1. is the session's dtach master still running?
//   2. which processes belong to it?
//   3. how do I stop it?
//
// and to answer them WITHOUT the two things that would make the answer
// wrong or destructive: connecting to the dtach socket (dtach serves one
// client at a time — a probe would DISPLACE the browser's live attach), and
// reading the process table in a way that mistakes some other process for
// the master.
//
// The liveness rules are the delicate part, so they are pinned here
// explicitly: "alive" / "dead" / "unknown", where "unknown" is never
// silently widened to "dead" — a false "dead" makes the reconciler mark a
// live session exited and terminate it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// --- the mocked `ps` ------------------------------------------------------
// The output the next `ps` call should produce.
let psOutput = "";
// Whether the next `ps` call should fail (a missing ps, a timeout, ...).
let psFails = false;
// Every `ps` invocation, in order.
let psCalls: string[][] = [];

// --- the mocked program spawn --------------------------------------------
// The argv of every program spawn, in order.
let spawnCalls: Array<{ file: string; args: string[] }> = [];
// How the next program spawn should end.
let spawnExitCode = 0;

type MockChild = EventEmitter & {
  stdout?: EventEmitter;
  kill: (signal?: string) => boolean;
  exitCode: number | null;
  signalCode: string | null;
};
function createMockChild(): MockChild {
  const ee = new EventEmitter() as MockChild;
  ee.exitCode = null;
  ee.signalCode = null;
  ee.kill = vi.fn(() => true);
  return ee;
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    // The process-table read. Called back SYNCHRONOUSLY so the tests never
    // depend on the event loop's timing.
    execFile: vi.fn(
      (
        file: string,
        args: string[],
        _options: unknown,
        callback: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (file !== "ps") {
          callback(new Error(`unexpected execFile: ${file}`), "", "");
          return;
        }
        psCalls.push(args);
        if (psFails) {
          callback(new Error("ps: command not found"), "", "");
          return;
        }
        callback(null, psOutput, "");
      },
    ),
    // The program launch (`dtach -n ...`).
    spawn: vi.fn((file: string, args: string[]) => {
      spawnCalls.push({ file, args });
      const ee = createMockChild();
      setImmediate(() => {
        ee.exitCode = spawnExitCode;
        ee.emit("exit", spawnExitCode);
      });
      return ee;
    }),
  };
});

const { DetachedScopeBackend, parseProcessTable, dtachMasters, descendantsOf } =
  await import("../../src/services/scope/detached.js");

// --- helpers --------------------------------------------------------------

/** One `ps -o pid=,ppid=,command=` row. */
function psRow(pid: number, ppid: number, command: string): string {
  return `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${command}`;
}

/** A `ps` table for one session, its master and the process tree beneath it. */
function tableForSession(
  socketPath: string,
  opts: { masterPid?: number; shellPid?: number; agentPid?: number } = {},
): string {
  const masterPid = opts.masterPid ?? 100;
  const shellPid = opts.shellPid ?? 101;
  const agentPid = opts.agentPid ?? 102;
  return [
    psRow(1, 0, "/sbin/launchd"),
    psRow(masterPid, 1, `dtach -n ${socketPath} /bin/zsh -lc claude`),
    psRow(shellPid, masterPid, "/bin/zsh -lc claude"),
    psRow(agentPid, shellPid, "claude --resume"),
  ].join("\n");
}

let sessionsDir: string;

beforeEach(() => {
  psOutput = "";
  psFails = false;
  psCalls = [];
  spawnCalls = [];
  spawnExitCode = 0;
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-detached-"));
});

afterEach(() => {
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** The socket path of a session in the temp sessions dir. */
function socketOf(id: string): string {
  return path.join(sessionsDir, `${id}.sock`);
}

// ---------------------------------------------------------------------------
// parseProcessTable
// ---------------------------------------------------------------------------

describe("parseProcessTable", () => {
  it("reads pid, ppid and the command line from each row", () => {
    const table = parseProcessTable(
      [psRow(100, 1, "dtach -n /tmp/1.sock /bin/zsh -lc claude"), psRow(101, 100, "/bin/zsh")].join(
        "\n",
      ),
    );
    expect(table).toHaveLength(2);
    expect(table[0]).toEqual({
      pid: 100,
      ppid: 1,
      command: "dtach -n /tmp/1.sock /bin/zsh -lc claude",
    });
    expect(table[1]).toEqual({ pid: 101, ppid: 100, command: "/bin/zsh" });
  });

  it("keeps the spaces inside a command line", () => {
    const table = parseProcessTable(psRow(100, 1, "claude --resume 'a b c' --model opus"));
    expect(table[0]?.command).toBe("claude --resume 'a b c' --model opus");
  });

  it("skips blank and malformed rows instead of producing NaN entries", () => {
    const table = parseProcessTable(
      ["", "   ", "not-a-pid 1 /bin/sh", "100 1 /bin/sh", "100 1"].join("\n"),
    );
    expect(table).toHaveLength(1);
    expect(table[0]?.pid).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// dtachMasters
// ---------------------------------------------------------------------------

describe("dtachMasters", () => {
  it("maps a dtach master to the socket it serves", () => {
    const masters = dtachMasters(parseProcessTable(psRow(100, 1, "dtach -n /tmp/1.sock /bin/zsh")));
    expect(masters.get("/tmp/1.sock")).toBe(100);
  });

  it("ignores an attach client — it names the socket but does not own it", () => {
    const masters = dtachMasters(parseProcessTable(psRow(100, 1, "dtach -a /tmp/1.sock -E -z")));
    expect(masters.size).toBe(0);
  });

  it("ignores a process that merely MENTIONS a dtach invocation", () => {
    // A shell running the invocation as a string is not the master — and
    // mistaking it for one would make stop() signal the wrong process.
    const masters = dtachMasters(
      parseProcessTable(psRow(100, 1, 'sh -c "dtach -n /tmp/1.sock /bin/zsh"')),
    );
    expect(masters.size).toBe(0);
  });

  it("accepts a dtach invoked by absolute path", () => {
    const masters = dtachMasters(
      parseProcessTable(psRow(100, 1, "/opt/homebrew/bin/dtach -n /tmp/1.sock /bin/zsh")),
    );
    expect(masters.get("/tmp/1.sock")).toBe(100);
  });

  it("prefers the highest pid when the daemonizing parent and the master both claim the socket", () => {
    // `dtach -n` forks: the process Mullion spawned exits once the forked
    // child is ready, so both carry the same argv for a moment. A fork
    // always gives the child the higher pid, and the child is the survivor.
    const table = parseProcessTable(
      [
        psRow(100, 1, "dtach -n /tmp/1.sock /bin/zsh"),
        psRow(101, 1, "dtach -n /tmp/1.sock /bin/zsh"),
      ].join("\n"),
    );
    expect(dtachMasters(table).get("/tmp/1.sock")).toBe(101);
  });
});

// ---------------------------------------------------------------------------
// descendantsOf
// ---------------------------------------------------------------------------

describe("descendantsOf", () => {
  it("returns every process below the root", () => {
    const table = parseProcessTable(
      [
        psRow(100, 1, "dtach -n /tmp/1.sock /bin/zsh"),
        psRow(101, 100, "/bin/zsh -lc claude"),
        psRow(102, 101, "claude"),
        psRow(103, 102, "mcp-server"),
        psRow(200, 1, "unrelated"),
      ].join("\n"),
    );
    const descendants = descendantsOf(table, 100).map((entry) => entry.pid);
    expect(descendants).toEqual([101, 102, 103]);
  });

  it("returns nothing for a process with no children", () => {
    const table = parseProcessTable(psRow(100, 1, "dtach -n /tmp/1.sock /bin/zsh"));
    expect(descendantsOf(table, 100)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isAliveBatch
// ---------------------------------------------------------------------------

describe("DetachedScopeBackend.isAliveBatch", () => {
  it("reports a session alive when its master is visible", async () => {
    const backend = new DetachedScopeBackend({ sessionsDir });
    psOutput = tableForSession(socketOf("1"));
    const state = await backend.isAliveBatch(["1"]);
    expect(state).toEqual({ 1: "alive" });
  });

  it("reports a session dead when neither the master nor its socket is left", async () => {
    const backend = new DetachedScopeBackend({ sessionsDir });
    psOutput = psRow(1, 0, "/sbin/launchd");
    const state = await backend.isAliveBatch(["1"]);
    expect(state).toEqual({ 1: "dead" });
  });

  it("reports UNKNOWN — not dead — when the socket is still there but the master is not visible", async () => {
    // A stale socket, or a process table this backend cannot interpret.
    // "dead" here would make the reconciler terminate a live session.
    const backend = new DetachedScopeBackend({ sessionsDir });
    fs.writeFileSync(socketOf("1"), "");
    psOutput = psRow(1, 0, "/sbin/launchd");
    const state = await backend.isAliveBatch(["1"]);
    expect(state).toEqual({ 1: "unknown" });
  });

  it("reports UNKNOWN for every id when the process table cannot be read", async () => {
    const backend = new DetachedScopeBackend({ sessionsDir });
    psFails = true;
    const state = await backend.isAliveBatch(["1", "2", "3"]);
    expect(state).toEqual({ 1: "unknown", 2: "unknown", 3: "unknown" });
  });

  it("answers for every requested id, even one that is not in the table", async () => {
    const backend = new DetachedScopeBackend({ sessionsDir });
    psOutput = tableForSession(socketOf("1"));
    const state = await backend.isAliveBatch(["1", "2"]);
    expect(Object.keys(state).sort()).toEqual(["1", "2"]);
    expect(state["1"]).toBe("alive");
    expect(state["2"]).toBe("dead");
  });

  it("returns an empty map for an empty request without reading the process table", async () => {
    const backend = new DetachedScopeBackend({ sessionsDir });
    const state = await backend.isAliveBatch([]);
    expect(state).toEqual({});
    expect(psCalls).toHaveLength(0);
  });

  it("reads the process table ONCE for a whole batch", async () => {
    const backend = new DetachedScopeBackend({ sessionsDir });
    psOutput = tableForSession(socketOf("1"));
    await backend.isAliveBatch(["1", "2", "3", "4", "5"]);
    expect(psCalls).toHaveLength(1);
  });

  it("asks `ps` for a portable, untruncated process table", async () => {
    const backend = new DetachedScopeBackend({ sessionsDir });
    psOutput = "";
    await backend.isAliveBatch(["1"]);
    // `command=` is the keyword BSD (macOS) and procps (Linux) both spell
    // the same way; `args=` is procps-only.
    expect(psCalls[0]).toEqual(["-ax", "-o", "pid=,ppid=,command="]);
  });
});

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

describe("DetachedScopeBackend.stop", () => {
  let alivePids: Set<number>;
  let signals: Array<{ pid: number; signal: string | number }>;
  let killOnSigterm: boolean;

  beforeEach(() => {
    alivePids = new Set<number>();
    signals = [];
    killOnSigterm = true;
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === 0) {
        if (!alivePids.has(pid)) {
          const err = new Error("ESRCH") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
        return true;
      }
      signals.push({ pid, signal: signal as string });
      if (signal === "SIGTERM" && killOnSigterm) alivePids.delete(pid);
      if (signal === "SIGKILL") alivePids.delete(pid);
      return true;
    }) as typeof process.kill);
  });

  it("terminates the master AND the processes beneath it", async () => {
    const backend = new DetachedScopeBackend({ sessionsDir });
    psOutput = tableForSession(socketOf("1"));
    alivePids = new Set([100, 101, 102]);
    await backend.stop("1");
    const signalled = signals
      .filter((entry) => entry.signal === "SIGTERM")
      .map((entry) => entry.pid);
    expect(signalled.sort()).toEqual([100, 101, 102]);
  });

  it("leaves a session it does not own alone", async () => {
    const backend = new DetachedScopeBackend({ sessionsDir });
    psOutput = tableForSession(socketOf("1"));
    alivePids = new Set([100, 101, 102]);
    await backend.stop("2");
    expect(signals).toEqual([]);
  });

  it("does nothing when the master is already gone", async () => {
    const backend = new DetachedScopeBackend({ sessionsDir });
    psOutput = psRow(1, 0, "/sbin/launchd");
    await backend.stop("1");
    expect(signals).toEqual([]);
  });

  it("escalates to SIGKILL when the tree does not exit on SIGTERM", async () => {
    const backend = new DetachedScopeBackend({ sessionsDir });
    psOutput = tableForSession(socketOf("1"));
    alivePids = new Set([100, 101, 102]);
    killOnSigterm = false;
    await backend.stop("1");
    const killed = signals.filter((entry) => entry.signal === "SIGKILL").map((entry) => entry.pid);
    expect(killed.sort()).toEqual([100, 101, 102]);
  }, 15_000);

  it("does nothing when the process table cannot be read", async () => {
    const backend = new DetachedScopeBackend({ sessionsDir });
    psFails = true;
    await backend.stop("1");
    expect(signals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listProcesses
// ---------------------------------------------------------------------------

describe("DetachedScopeBackend.listProcesses", () => {
  it("lists the master and the processes beneath it", async () => {
    const backend = new DetachedScopeBackend({ sessionsDir });
    psOutput = tableForSession(socketOf("1"));
    const processes = await backend.listProcesses("1");
    expect(processes.map((p) => p.pid)).toEqual([100, 101, 102]);
    expect(processes[0]?.comm).toBe("dtach");
    expect(processes[0]?.cmdline[0]).toBe("dtach");
    expect(processes[2]?.comm).toBe("claude");
  });

  it("returns nothing for a session this host does not own", async () => {
    const backend = new DetachedScopeBackend({ sessionsDir });
    psOutput = tableForSession(socketOf("1"));
    expect(await backend.listProcesses("2")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

describe("DetachedScopeBackend.start", () => {
  const spec = {
    id: "1",
    argv: ["dtach", "-n", "/tmp/1.sock", "/bin/zsh", "-lc", "claude"],
    cwd: "/tmp",
    env: { PATH: "/usr/bin" },
    timeoutMs: 5_000,
    label: "master bootstrap",
  };

  it("runs the program directly — no supervisor, no cgroup properties", async () => {
    const backend = new DetachedScopeBackend({ sessionsDir });
    await backend.start({
      ...spec,
      argv: ["dtach", "-n", socketOf("1"), "/bin/zsh", "-lc", "claude"],
    });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.file).toBe("dtach");
    expect(spawnCalls[0]?.args).toEqual(["-n", socketOf("1"), "/bin/zsh", "-lc", "claude"]);
  });

  it("names the socket in the failure diagnostic when the socket is already taken", async () => {
    const backend = new DetachedScopeBackend({ sessionsDir });
    fs.writeFileSync(socketOf("1"), "");
    spawnExitCode = 1;
    await expect(
      backend.start({ ...spec, argv: ["dtach", "-n", socketOf("1"), "/bin/zsh", "-lc", "claude"] }),
    ).rejects.toThrow(/socket .*1\.sock.*already in use/);
  });

  it('says "socket", not "unit", in its diagnostics', async () => {
    const backend = new DetachedScopeBackend({ sessionsDir });
    spawnExitCode = 1;
    await expect(
      backend.start({ ...spec, argv: ["dtach", "-n", socketOf("1"), "/bin/zsh", "-lc", "claude"] }),
    ).rejects.toThrow(`(socket ${socketOf("1")})`);
  });

  it("rejects a launch with nothing to run", async () => {
    const backend = new DetachedScopeBackend({ sessionsDir });
    await expect(backend.start({ ...spec, argv: [] })).rejects.toThrow(/no program to launch/);
  });
});

// ---------------------------------------------------------------------------
// the Linux path must not have moved
// ---------------------------------------------------------------------------

describe("the systemd backend's diagnostics are unchanged", () => {
  it('still says "unit" when no scopeKind is given', async () => {
    // The detached backend introduced `scopeKind`; the systemd backend must
    // keep saying "unit" so its messages stay byte-for-byte what they were.
    const { spawnScopeProcess } = await import("../../src/services/scope/spawn.js");
    spawnExitCode = 1;
    await expect(
      spawnScopeProcess({
        command: "systemd-run",
        argv: ["--scope", "true"],
        cwd: "/tmp",
        env: {},
        timeoutMs: 5_000,
        label: "master bootstrap",
        scopeName: "crs-session-aaaaaaaa-1",
      }),
    ).rejects.toThrow("master bootstrap exited with code 1 (unit crs-session-aaaaaaaa-1)");
  });
});
