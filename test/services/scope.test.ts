// Issue #1715 (Phase 8) — tests for the platform-neutral scope seam.
//
// The seam's whole point is that the session spawn path no longer knows or
// cares that a Linux scope is a systemd transient scope. These tests pin the
// two halves of that claim:
//
//   1. the systemd backend still produces EXACTLY the argv and diagnostics
//      the pre-seam code produced (the "Linux behavior must be provably
//      identical" bar from the issue), and
//   2. the seam itself is platform-neutral and platform-SELECTED — the
//      backend is chosen on the host that owns the scope, from that host's
//      own platform.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { spawn as spawnChildProcess } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// How the mocked `systemd-run` should behave for the next spawn.
type SystemdRunBehavior = "ok" | "exit-nonzero" | "enoent" | "hang";
let systemdRunBehavior: SystemdRunBehavior = "ok";
// The argv of every `systemd-run` spawn, in order.
let systemdRunCalls: string[][] = [];
// The `systemctl --user show <unit>` reply describeScope() should see.
const showReplies: Record<string, { description: string; activeState: string }> = {};
// The `systemctl --user list-units` reply, one "UNIT LOAD ACTIVE SUB DESC"
// line per entry.
let listUnitsReply: string[] = [];
// Records every `systemctl --user stop <unit>.scope` invocation.
let stopCalls: string[][] = [];

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
    spawn: vi.fn((file: string, args: string[]) => {
      const ee = createMockChild();
      if (file === "systemd-run") {
        systemdRunCalls.push(args);
        if (systemdRunBehavior === "enoent") {
          setImmediate(() => {
            const err = new Error("spawn systemd-run ENOENT") as NodeJS.ErrnoException;
            err.code = "ENOENT";
            ee.emit("error", err);
          });
          return ee;
        }
        if (systemdRunBehavior === "hang") {
          // Never emits anything — the timeout escalation is the only thing
          // that can settle this.
          return ee;
        }
        const code = systemdRunBehavior === "exit-nonzero" ? 1 : 0;
        setImmediate(() => {
          ee.exitCode = code;
          ee.emit("exit", code);
        });
        return ee;
      }
      if (file === "systemctl" && args[1] === "list-units") {
        ee.stdout = new EventEmitter();
        setImmediate(() => {
          ee.exitCode = 0;
          ee.emit("exit", 0);
          setImmediate(() => {
            const lines = listUnitsReply.join("\n");
            ee.stdout?.emit("data", Buffer.from(lines ? `${lines}\n` : ""));
            ee.emit("close", 0);
          });
        });
        return ee;
      }
      if (file === "systemctl" && args[1] === "stop") {
        stopCalls.push(args);
        setImmediate(() => {
          ee.exitCode = 0;
          ee.emit("exit", 0);
        });
        return ee;
      }
      if (file === "systemctl" && args[1] === "show") {
        ee.stdout = new EventEmitter();
        const unit = args[2];
        const reply = showReplies[unit] ?? { description: unit, activeState: "inactive" };
        setImmediate(() => {
          ee.exitCode = 0;
          ee.emit("exit", 0);
          setImmediate(() => {
            ee.stdout?.emit(
              "data",
              Buffer.from(`Description=${reply.description}\nActiveState=${reply.activeState}\n`),
            );
            ee.emit("close", 0);
          });
        });
        return ee;
      }
      setImmediate(() => {
        ee.exitCode = 0;
        ee.emit("exit", 0);
      });
      return ee;
    }),
  };
});

vi.mock("../../src/services/cgroup-inventory.js", () => ({
  listScopeProcesses: vi.fn(async () => []),
}));

const { getScopeBackend } = await import("../../src/services/scope/index.js");
const { SystemdScopeBackend } = await import("../../src/services/scope/systemd.js");
const { isUsableCwd, spawnScopeProcess } = await import("../../src/services/scope/spawn.js");
const { scopeUnitName, deriveInstanceId } = await import("../../src/services/session-process.js");
const { listScopeProcesses } = await import("../../src/services/cgroup-inventory.js");

const INSTANCE_ID = "aaaaaaaa";
const SESSIONS_DIR = "/tmp/mullion-scope-test-sessions";

function backend(prefix?: string) {
  return new SystemdScopeBackend({
    sessionsDir: SESSIONS_DIR,
    instanceId: INSTANCE_ID,
    ...(prefix ? { prefix } : {}),
  });
}

function spec(overrides: Record<string, unknown> = {}) {
  return {
    id: "1",
    argv: ["dtach", "-n", `${SESSIONS_DIR}/1.sock`, "/bin/bash", "-lc", "claude"],
    cwd: os.tmpdir(),
    env: { PATH: "/usr/bin" },
    timeoutMs: 5_000,
    label: "master bootstrap",
    ...overrides,
  } as Parameters<SystemdScopeBackend["start"]>[0];
}

beforeEach(() => {
  systemdRunBehavior = "ok";
  systemdRunCalls = [];
  listUnitsReply = [];
  stopCalls = [];
  for (const key of Object.keys(showReplies)) delete showReplies[key];
  vi.mocked(spawnChildProcess).mockClear();
  vi.mocked(listScopeProcesses).mockClear();
});

describe("getScopeBackend — platform selection", () => {
  it("returns the systemd backend on linux", () => {
    expect(getScopeBackend({ sessionsDir: SESSIONS_DIR, instanceId: INSTANCE_ID }).kind).toBe(
      "systemd",
    );
  });

  // The backend is chosen on the host that OWNS the scope, from that host's
  // own platform — a primary and its remote agents each pick their own and
  // never negotiate. A platform with no backend has no way to run a session
  // at all, so this says so plainly rather than letting every session fail
  // later with a confusing "spawn systemd-run ENOENT".
  it("throws a plain, actionable error on a platform with no backend", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      expect(() => getScopeBackend({ sessionsDir: SESSIONS_DIR, instanceId: INSTANCE_ID })).toThrow(
        /no scope backend for platform "darwin"/,
      );
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });
});

describe("SystemdScopeBackend.start — argv shape", () => {
  it("wraps the program in a transient scope, exactly as the pre-seam code did", async () => {
    await backend().start(spec());
    expect(systemdRunCalls).toHaveLength(1);
    expect(systemdRunCalls[0]).toEqual([
      "--user",
      "--scope",
      "--collect",
      "-u",
      `crs-session-${INSTANCE_ID}-1`,
      "--",
      "dtach",
      "-n",
      `${SESSIONS_DIR}/1.sock`,
      "/bin/bash",
      "-lc",
      "claude",
    ]);
  });

  it("renders the constraints as systemd cgroup properties", async () => {
    await backend().start(
      spec({ constraints: { cpuWeight: 25, ioWeight: 25, cpuQuotaPercent: 300 } }),
    );
    expect(systemdRunCalls[0]).toEqual([
      "--user",
      "--scope",
      "--collect",
      "-u",
      `crs-session-${INSTANCE_ID}-1`,
      "-p",
      "CPUWeight=25",
      "-p",
      "IOWeight=25",
      "-p",
      "CPUQuota=300%",
      "--",
      "dtach",
      "-n",
      `${SESSIONS_DIR}/1.sock`,
      "/bin/bash",
      "-lc",
      "claude",
    ]);
  });

  it("emits no cgroup property for a constraint that was not specified", async () => {
    await backend().start(spec({ constraints: { cpuWeight: 100 } }));
    expect(systemdRunCalls[0]).not.toContain("IOWeight=100");
    expect(systemdRunCalls[0].some((a) => a.startsWith("CPUQuota="))).toBe(false);
  });

  it("uses the configured scope-name prefix in the unit name", async () => {
    await backend("crs-device").start(spec());
    expect(systemdRunCalls[0]).toContain(`crs-device-${INSTANCE_ID}-1`);
  });
});

describe("SystemdScopeBackend.start — failure diagnostics", () => {
  it("reports a timeout with the label, budget and scope name", async () => {
    systemdRunBehavior = "hang";
    await expect(backend().start(spec({ timeoutMs: 20 }))).rejects.toThrow(
      `master bootstrap timed out after 20ms (unit crs-session-${INSTANCE_ID}-1)`,
    );
  });

  // Node's own spawn ENOENT blames whichever binary it was trying to exec,
  // even when the REAL cause is the cwd having vanished — the misleading
  // message sent a prior incident's investigation looking at the wrong
  // binary.
  it("classifies an ENOENT from a vanished cwd as a cwd failure", async () => {
    systemdRunBehavior = "enoent";
    await expect(
      backend().start(spec({ cwd: path.join(os.tmpdir(), "mullion-no-such-dir-xyz") })),
    ).rejects.toThrow(/master bootstrap failed: cwd does not exist:/);
  });

  it("reports a non-zero exit with the exit code and scope name", async () => {
    systemdRunBehavior = "exit-nonzero";
    await expect(backend().start(spec())).rejects.toThrow(
      `master bootstrap exited with code 1 (unit crs-session-${INSTANCE_ID}-1)`,
    );
  });

  // Issue #1137 — `systemd-run --collect` refuses to create a scope whose
  // name already exists, and that is the far more likely cause of a
  // non-zero exit than a genuine systemd-run/dtach problem.
  it("names the squatter when the scope name is already taken", async () => {
    systemdRunBehavior = "exit-nonzero";
    showReplies[`crs-session-${INSTANCE_ID}-1.scope`] = {
      description: "dtach -n /tmp/x.sock /bin/bash -lc claude",
      activeState: "active",
    };
    await expect(backend().start(spec())).rejects.toThrow(
      /a scope named crs-session-aaaaaaaa-1\.scope already exists and is running/,
    );
  });

  it("keeps the plain message when the squatter probe finds nothing", async () => {
    systemdRunBehavior = "exit-nonzero";
    await expect(backend().start(spec())).rejects.toThrow(
      /^master bootstrap exited with code 1 \(unit crs-session-aaaaaaaa-1\)$/,
    );
  });
});

describe("SystemdScopeBackend — tracking operations", () => {
  it("reports liveness as a TOTAL map, with 'unknown' for an unlisted id", async () => {
    listUnitsReply = [
      `crs-session-${INSTANCE_ID}-1.scope loaded active active dtach -n ${SESSIONS_DIR}/1.sock /bin/bash -lc claude`,
    ];
    const result = await backend().isAliveBatch(["1", "2"]);
    expect(result["1"]).toBe("alive");
    expect(result["2"]).toBe("dead");
    expect(Object.keys(result).sort()).toEqual(["1", "2"]);
  });

  it("lists only the scopes of its own prefix", async () => {
    listUnitsReply = [];
    await backend("crs-device").isAliveBatch(["1"]);
    const call = vi
      .mocked(spawnChildProcess)
      .mock.calls.find((c) => c[0] === "systemctl" && (c[1] as string[])[1] === "list-units");
    expect((call?.[1] as string[]).at(-1)).toBe("crs-device-*.scope");
  });

  // The ownership rule (issue #1140) is preserved through the seam: a scope
  // is only stopped when this instance can CONFIRM it owns it, by the
  // dtach socket path in the scope's own description.
  it("stops the scope it owns, by unit name", async () => {
    listUnitsReply = [
      `crs-session-${INSTANCE_ID}-7.scope loaded active active dtach -n ${SESSIONS_DIR}/7.sock /bin/bash -lc claude`,
    ];
    await backend().stop("7");
    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0]).toEqual(["--user", "stop", `crs-session-${INSTANCE_ID}-7.scope`]);
  });

  it("does not stop a scope it cannot confirm it owns", async () => {
    listUnitsReply = [];
    await backend().stop("7");
    expect(stopCalls).toHaveLength(0);
  });

  it("returns an empty process list for an unowned scope", async () => {
    await expect(backend().listProcesses("7")).resolves.toEqual([]);
  });
});

describe("spawnScopeProcess — the shared spawn orchestration", () => {
  // The spawn orchestration is shared by every backend, so it is exercised
  // directly here rather than only through the systemd backend — the
  // branches a backend without a failure-detail probe takes are otherwise
  // unreachable.
  function spawnOpts(overrides: Record<string, unknown> = {}) {
    return {
      command: "systemd-run",
      argv: ["--user", "scope"],
      cwd: os.tmpdir(),
      env: { PATH: "/usr/bin" },
      timeoutMs: 5_000,
      label: "master bootstrap",
      scopeName: `crs-session-${INSTANCE_ID}-1`,
      ...overrides,
    } as Parameters<typeof spawnScopeProcess>[0];
  }

  it("reports a non-zero exit with the plain message when there is no failure detail", async () => {
    systemdRunBehavior = "exit-nonzero";
    await expect(spawnScopeProcess(spawnOpts())).rejects.toThrow(
      `master bootstrap exited with code 1 (unit crs-session-${INSTANCE_ID}-1)`,
    );
  });

  it("falls back to the plain message when the failure-detail probe itself fails", async () => {
    systemdRunBehavior = "exit-nonzero";
    await expect(
      spawnScopeProcess(
        spawnOpts({
          describeFailure: async () => {
            throw new Error("probe failed");
          },
        }),
      ),
    ).rejects.toThrow(
      new RegExp(`^master bootstrap exited with code 1 \\(unit crs-session-${INSTANCE_ID}-1\\)$`),
    );
  });

  it("appends the failure detail the backend supplies", async () => {
    systemdRunBehavior = "exit-nonzero";
    await expect(
      spawnScopeProcess(spawnOpts({ describeFailure: async () => "something specific" })),
    ).rejects.toThrow(
      `master bootstrap exited with code 1 (unit crs-session-${INSTANCE_ID}-1): something specific`,
    );
  });
});

describe("scope naming", () => {
  it("defaults to the crs-session prefix", () => {
    expect(scopeUnitName(INSTANCE_ID, "1")).toBe(`crs-session-${INSTANCE_ID}-1`);
  });

  it("honors an explicit prefix", () => {
    expect(scopeUnitName(INSTANCE_ID, "1", "crs-device")).toBe(`crs-device-${INSTANCE_ID}-1`);
  });

  it("keeps two instances' scopes apart for the same id (issue #1140)", () => {
    expect(scopeUnitName("aaaaaaaa", "1")).not.toBe(scopeUnitName("bbbbbbbb", "1"));
  });

  it("derives the instance id from the sessions dir, not the other way round", () => {
    expect(deriveInstanceId("/tmp/a")).not.toBe(deriveInstanceId("/tmp/b"));
  });
});

describe("isUsableCwd", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-cwd-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a directory", () => {
    expect(isUsableCwd(dir)).toBe(true);
  });

  it("rejects a path that does not exist", () => {
    expect(isUsableCwd(path.join(dir, "nope"))).toBe(false);
  });

  // A path that exists but is a plain file spawns with an identical ENOENT
  // yet would still surface the misleading raw error.
  it("rejects a path that exists but is not a directory", () => {
    const file = path.join(dir, "a-file");
    fs.writeFileSync(file, "x");
    expect(isUsableCwd(file)).toBe(false);
  });
});
