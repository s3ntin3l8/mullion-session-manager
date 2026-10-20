// Issue #1716 (Phase 8) — tests for the macOS (detached) scope backend.
//
// The backend's whole job is to answer three questions about a session on a
// host that has no systemd:
//
//   1. is the session's dtach master still serving its socket?
//   2. which processes belong to it?
//   3. how do I stop it?
//
// Liveness is the delicate part, so it is pinned explicitly: "alive" /
// "dead" / "unknown", where "unknown" is never silently widened to "dead" —
// a false "dead" makes the reconciler mark a live session exited and
// terminate it.
//
// The process table is NOT how liveness is decided. It is how the master's
// PID is found (to terminate it) and how the process inventory is built. The
// two are deliberately separate, and these tests keep them separate.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// --- the mocked socket probe ----------------------------------------------
// What probeSocket() should answer for a given socket path.
let probeResults: Map<string, "live" | "dead" | "unknown">;
// Sockets whose probe should throw.
let probeThrows: Set<string>;
// Every probe, in order.
let probeCalls: string[] = [];

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

vi.mock("../../src/services/unix-socket.js", () => ({
  probeSocket: vi.fn(async (socketPath: string) => {
    probeCalls.push(socketPath);
    if (probeThrows.has(socketPath)) throw new Error("probe exploded");
    return probeResults.get(socketPath) ?? "unknown";
  }),
}));

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

/** One `ps -o pid=,ppid=,pgid=,command=` row. */
function psRow(pid: number, ppid: number, command: string, pgid: number = pid): string {
  return `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${String(pgid).padStart(5)} ${command}`;
}

/**
 * A `ps` table for one session, its master and the process tree beneath it.
 *
 * The group ids are realistic: dtach's master calls setsid(), so it LEADS a
 * process group of its own, and the processes it starts inherit that group.
 */
function tableForSession(
  socketPath: string,
  opts: { masterPid?: number; shellPid?: number; agentPid?: number } = {},
): string {
  const masterPid = opts.masterPid ?? 100;
  const shellPid = opts.shellPid ?? 101;
  const agentPid = opts.agentPid ?? 102;
  return [
    psRow(1, 0, "/sbin/launchd", 1),
    psRow(masterPid, 1, `dtach -n ${socketPath} /bin/zsh -lc claude`, masterPid),
    psRow(shellPid, masterPid, "/bin/zsh -lc claude", masterPid),
    psRow(agentPid, shellPid, "claude --resume", masterPid),
  ].join("\n");
}

let sessionsDir: string;

beforeEach(() => {
  probeResults = new Map();
  probeThrows = new Set();
  probeCalls = [];
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
      pgid: 100,
      command: "dtach -n /tmp/1.sock /bin/zsh -lc claude",
    });
    expect(table[1]).toEqual({ pid: 101, ppid: 100, pgid: 101, command: "/bin/zsh" });
  });

  it("keeps the spaces inside a command line", () => {
    const table = parseProcessTable(psRow(100, 1, "claude --resume 'a b c' --model opus"));
    expect(table[0]?.command).toBe("claude --resume 'a b c' --model opus");
  });

  it("skips blank and malformed rows instead of producing NaN entries", () => {
    const table = parseProcessTable(
      ["", "   ", "not-a-pid 1 1 /bin/sh", "100 1 1 /bin/sh", "100 1 1"].join("\n"),
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
    const table = parseProcessTable(psRow(100, 1, "dtach -n /tmp/1.sock /bin/zsh"));
    expect(dtachMasters(table, ["/tmp/1.sock"]).get("/tmp/1.sock")).toBe(100);
  });

  it("ignores an attach client — it names the socket but does not own it", () => {
    const table = parseProcessTable(psRow(100, 1, "dtach -a /tmp/1.sock -E -z -r winch"));
    expect(dtachMasters(table, ["/tmp/1.sock"]).size).toBe(0);
  });

  it("ignores a process that merely MENTIONS a dtach invocation", () => {
    // A shell running the invocation as a string is not the master — and
    // mistaking it for one would make stop() signal the wrong process.
    const table = parseProcessTable(psRow(100, 1, 'sh -c "dtach -n /tmp/1.sock /bin/zsh"'));
    expect(dtachMasters(table, ["/tmp/1.sock"]).size).toBe(0);
  });

  it("accepts a dtach invoked by absolute path", () => {
    const table = parseProcessTable(
      psRow(100, 1, "/opt/homebrew/bin/dtach -n /tmp/1.sock /bin/zsh"),
    );
    expect(dtachMasters(table, ["/tmp/1.sock"]).get("/tmp/1.sock")).toBe(100);
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
    expect(dtachMasters(table, ["/tmp/1.sock"]).get("/tmp/1.sock")).toBe(101);
  });

  it("does not confuse one session's socket with another's", () => {
    const table = parseProcessTable(
      [
        psRow(100, 1, "dtach -n /tmp/1.sock /bin/zsh"),
        psRow(200, 1, "dtach -n /tmp/11.sock /bin/zsh"),
      ].join("\n"),
    );
    expect(dtachMasters(table, ["/tmp/1.sock"]).get("/tmp/1.sock")).toBe(100);
    expect(dtachMasters(table, ["/tmp/1.sock"]).has("/tmp/11.sock")).toBe(false);
  });

  it("finds a master whose socket path contains a space", () => {
    // `ps` renders argv joined by spaces and UNQUOTED, so the path is not a
    // single token here — it has to be MATCHED, not tokenized.
    const table = parseProcessTable(psRow(100, 1, "dtach -n /tmp/sp ace/1.sock /bin/zsh"));
    expect(dtachMasters(table, ["/tmp/sp ace/1.sock"]).get("/tmp/sp ace/1.sock")).toBe(100);
  });

  it("finds a master that carries dtach options ahead of the flag", () => {
    // argv[0] is the FIRST token; everything between it and the flag is
    // options, not the program. Reading argv[0] from the flag's position
    // would make `dtach -E -n <socket>` look like a program called
    // "dtach -E" — and the master would never be found, so teardown would
    // silently no-op and leave the agent running.
    const table = parseProcessTable(psRow(100, 1, "dtach -E -n /tmp/1.sock /bin/zsh"));
    expect(dtachMasters(table, ["/tmp/1.sock"]).get("/tmp/1.sock")).toBe(100);
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
  it("reports a session alive when its socket is being served", async () => {
    const backend = new DetachedScopeBackend({ sessionsDir });
    probeResults.set(socketOf("1"), "live");
    const state = await backend.isAliveBatch(["1"]);
    expect(state).toEqual({ 1: "alive" });
  });

  it("reports a session dead when nothing is serving its socket", async () => {
    const backend = new DetachedScopeBackend({ sessionsDir });
    probeResults.set(socketOf("1"), "dead");
    const state = await backend.isAliveBatch(["1"]);
    expect(state).toEqual({ 1: "dead" });
  });

  it("reports UNKNOWN — not dead — when the probe cannot tell", async () => {
    const backend = new DetachedScopeBackend({ sessionsDir });
    probeResults.set(socketOf("1"), "unknown");
    const state = await backend.isAliveBatch(["1"]);
    expect(state).toEqual({ 1: "unknown" });
  });

  it("reports UNKNOWN — not dead — when the probe itself fails", async () => {
    // A probe that threw knows nothing. Reading that as "dead" would make
    // the reconciler mark a live session exited and terminate it.
    const backend = new DetachedScopeBackend({ sessionsDir });
    probeThrows.add(socketOf("1"));
    const state = await backend.isAliveBatch(["1"]);
    expect(state).toEqual({ 1: "unknown" });
  });

  it("answers for every requested id, even one that was never probed", async () => {
    const backend = new DetachedScopeBackend({ sessionsDir });
    probeResults.set(socketOf("1"), "live");
    const state = await backend.isAliveBatch(["1", "2"]);
    expect(Object.keys(state).sort()).toEqual(["1", "2"]);
    expect(state["1"]).toBe("alive");
    expect(state["2"]).toBe("unknown");
  });

  it("returns an empty map for an empty request without probing anything", async () => {
    const backend = new DetachedScopeBackend({ sessionsDir });
    const state = await backend.isAliveBatch([]);
    expect(state).toEqual({});
    expect(probeCalls).toHaveLength(0);
  });

  it("does not read the process table to decide liveness", async () => {
    // The process table says nothing about whether the master is serving
    // its socket — and dtach does not clean its socket up, so the file's
    // presence proves nothing either. The probe is the only honest answer.
    const backend = new DetachedScopeBackend({ sessionsDir });
    probeResults.set(socketOf("1"), "live");
    await backend.isAliveBatch(["1"]);
    expect(psCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

describe("DetachedScopeBackend.stop", () => {
  let alivePids: Set<number>;
  let signals: Array<{ pid: number; signal: string | number }>;
  let groupSignals: Array<{ pgid: number; signal: string | number }>;
  let killOnSigterm: boolean;

  beforeEach(() => {
    alivePids = new Set<number>();
    signals = [];
    groupSignals = [];
    killOnSigterm = true;
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      // A NEGATIVE pid addresses a whole process group — that is how
      // kill(2) spells "every process in this group".
      if (pid < 0) {
        if (signal === 0) return true;
        groupSignals.push({ pgid: -pid, signal: signal as string });
        return true;
      }
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

  it("removes the socket file dtach left behind", async () => {
    // dtach does not clean its socket up, so the file outlives the master.
    // Left in place, the next session at this id could not bind it.
    const backend = new DetachedScopeBackend({ sessionsDir });
    psOutput = tableForSession(socketOf("1"));
    fs.writeFileSync(socketOf("1"), "");
    alivePids = new Set([100, 101, 102]);
    await backend.stop("1");
    expect(fs.existsSync(socketOf("1"))).toBe(false);
  });

  it("removes a stale socket when the master is gone and nothing is serving it", async () => {
    const backend = new DetachedScopeBackend({ sessionsDir });
    psOutput = psRow(1, 0, "/sbin/launchd");
    fs.writeFileSync(socketOf("1"), "");
    probeResults.set(socketOf("1"), "dead");
    await backend.stop("1");
    expect(fs.existsSync(socketOf("1"))).toBe(false);
  });

  it("signals the master's process group, so a child forked during the grace window is caught", async () => {
    // dtach's master calls setsid(), so it LEADS a group of its own. The
    // tree is a snapshot; the group is not, so the group is what catches a
    // child the master forks while the grace window is open.
    const backend = new DetachedScopeBackend({ sessionsDir });
    psOutput = tableForSession(socketOf("1"));
    alivePids = new Set([100, 101, 102]);
    await backend.stop("1");
    expect(groupSignals.map((entry) => entry.pgid)).toContain(100);
    expect(groupSignals.some((entry) => entry.signal === "SIGTERM")).toBe(true);
  });

  it("does not signal a group the master does not lead", async () => {
    // "The group with this id" is only ours to signal when the master
    // actually leads it — otherwise it could be some other process's group.
    const backend = new DetachedScopeBackend({ sessionsDir });
    psOutput = [
      psRow(1, 0, "/sbin/launchd", 1),
      psRow(100, 1, `dtach -n ${socketOf("1")} /bin/zsh -lc claude`, 999),
      psRow(101, 100, "/bin/zsh -lc claude", 999),
    ].join("\n");
    alivePids = new Set([100, 101]);
    await backend.stop("1");
    expect(groupSignals).toEqual([]);
  });

  it("re-reads the process table before escalating, to catch a late-forked child", async () => {
    // A child the master forks DURING the grace window is in neither the
    // snapshot nor the first table read; the only way to see it is to look
    // again, while the master is still alive to attribute it to.
    const backend = new DetachedScopeBackend({ sessionsDir });
    const original = tableForSession(socketOf("1"));
    psOutput = original;
    // 103 is alive: the master forked it during the grace window, so the
    // first table read did not know about it.
    alivePids = new Set([100, 101, 102, 103]);
    // The SECOND read (the one before the SIGKILL pass) shows a new child.
    vi.mocked(execFile)
      .mockImplementationOnce(((
        file: string,
        args: string[],
        _options: unknown,
        callback: (err: Error | null, stdout: string) => void,
      ) => {
        callback(null, original);
      }) as never)
      .mockImplementationOnce(((
        file: string,
        args: string[],
        _options: unknown,
        callback: (err: Error | null, stdout: string) => void,
      ) => {
        callback(null, [original, psRow(103, 100, "/bin/sh -c some-late-fork", 100)].join("\n"));
      }) as never);
    await backend.stop("1");
    expect(signals.some((entry) => entry.pid === 103)).toBe(true);
  });

  it("keeps the socket when the probe itself fails", async () => {
    // A probe that threw tells us nothing, so the socket file stays
    // (fail-closed: unlinking the socket of a live session would break its
    // attach) and the teardown still completes.
    const backend = new DetachedScopeBackend({ sessionsDir });
    psOutput = psRow(1, 0, "/sbin/launchd");
    fs.writeFileSync(socketOf("1"), "");
    probeThrows.add(socketOf("1"));
    await backend.stop("1");
    expect(fs.existsSync(socketOf("1"))).toBe(true);
  });

  it("keeps the socket of a session that is still being served", async () => {
    // The master is not visible in the process table, but something IS
    // serving the socket — so unlinking it would break a live session.
    const backend = new DetachedScopeBackend({ sessionsDir });
    psOutput = psRow(1, 0, "/sbin/launchd");
    fs.writeFileSync(socketOf("1"), "");
    probeResults.set(socketOf("1"), "live");
    await backend.stop("1");
    expect(fs.existsSync(socketOf("1"))).toBe(true);
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
