import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { spawn as spawnChildProcess } from "node:child_process";
import type * as ChildProcess from "node:child_process";

// This module owns only the systemd `--user` scope naming/lifecycle glue
// (scopeUnitName, stopScope, isMasterAlive, isMasterAliveBatch,
// listSessionProcesses) extracted out of pty-manager.ts — see that file's
// own header comment for why these are plain functions (no per-Session
// state) rather than a class, and session-process.ts's header for the full
// boundary. The end-to-end behavior tests that exercise these through
// PtyManager's own delegating methods (manager.isMasterAlive(),
// manager.terminate() calling stopScope(), etc.) already live in
// pty-manager.test.ts and are unchanged by this extraction; these tests
// exercise the extracted functions directly.

// Maps a scope unit name (e.g. "crs-session-1.scope") to the `systemctl
// is-active` reply isMasterAlive() should see for it — mirrors
// pty-manager.test.ts's own isActiveReplies convention.
const isActiveReplies: Record<string, string> = {};

// The fake `systemctl --user list-units` reply isMasterAliveBatch() should
// see: a list of unit names to report as active, in the real `--plain
// --no-legend` output shape.
let listUnitsReply: string[] = [];

// The fake `systemctl --user show <unit> -p Description -p ActiveState`
// reply describeScope() should see, keyed by unit name — mirrors
// isActiveReplies' shape. Defaults (unit absent from this map) to a unit
// that doesn't exist: systemd's own fallback Description equal to the unit
// name itself, ActiveState "inactive" — see describeScope's own doc comment
// for why Description alone can't be trusted without also checking this.
const showReplies: Record<string, { description: string; activeState: string }> = {};

// Records every `systemctl --user stop <unit>.scope` invocation so
// stopScope() tests can assert on the exact spawn args without depending on
// its resolution timing.
const stopCalls: string[][] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((file: string, args: string[]) => {
      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };
      if (file === "systemctl" && args[1] === "is-active") {
        ee.stdout = new EventEmitter();
        const unit = args[2];
        const reply = isActiveReplies[unit] ?? "active";
        // 'exit' fires before 'data'/'close' — the exact real race
        // isMasterAlive() must resolve off 'close' to survive; mirrors
        // pty-manager.test.ts's own mock for the identical reason.
        setImmediate(() => {
          ee.emit("exit", 0);
          setImmediate(() => {
            ee.stdout?.emit("data", Buffer.from(`${reply}\n`));
            ee.emit("close", 0);
          });
        });
        return ee;
      }
      if (file === "systemctl" && args[1] === "list-units") {
        ee.stdout = new EventEmitter();
        setImmediate(() => {
          ee.emit("exit", 0);
          setImmediate(() => {
            const lines = listUnitsReply
              .map((unit) => `${unit} loaded active running ${unit}`)
              .join("\n");
            ee.stdout?.emit("data", Buffer.from(lines ? `${lines}\n` : ""));
            ee.emit("close", 0);
          });
        });
        return ee;
      }
      if (file === "systemctl" && args[1] === "stop") {
        stopCalls.push(args);
        setImmediate(() => ee.emit("exit", 0));
        return ee;
      }
      if (file === "systemctl" && args[1] === "show") {
        ee.stdout = new EventEmitter();
        const unit = args[2];
        const reply = showReplies[unit] ?? { description: unit, activeState: "inactive" };
        setImmediate(() => {
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
      setImmediate(() => ee.emit("exit", 0));
      return ee;
    }),
  };
});

vi.mock("../../src/services/cgroup-inventory.js", () => ({
  listScopeProcesses: vi.fn(async () => []),
}));

const {
  scopeUnitName,
  stopScope,
  describeScope,
  isMasterAlive,
  isMasterAliveBatch,
  listSessionProcesses,
  parseScopeUnitsListing,
  extractDtachSocketPath,
} = await import("../../src/services/session-process.js");
const { listScopeProcesses } = await import("../../src/services/cgroup-inventory.js");

beforeEach(() => {
  for (const key of Object.keys(isActiveReplies)) delete isActiveReplies[key];
  for (const key of Object.keys(showReplies)) delete showReplies[key];
  listUnitsReply = [];
  stopCalls.length = 0;
  vi.mocked(spawnChildProcess).mockClear();
  vi.mocked(listScopeProcesses).mockClear();
});

describe("scopeUnitName", () => {
  it("is deterministic, id-derived, and not timestamped", () => {
    expect(scopeUnitName("1")).toBe("crs-session-1");
    expect(scopeUnitName("1")).toBe(scopeUnitName("1"));
    expect(scopeUnitName("abc-def")).toBe("crs-session-abc-def");
  });
});

describe("stopScope", () => {
  it("spawns systemctl --user stop <unit>.scope with stdio ignored", async () => {
    await stopScope("1");
    expect(stopCalls).toEqual([["--user", "stop", "crs-session-1.scope"]]);
    expect(vi.mocked(spawnChildProcess)).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "stop", "crs-session-1.scope"],
      expect.objectContaining({ stdio: "ignore" }),
    );
  });

  it("resolves (does not reject) even when the scope doesn't exist / spawn errors", async () => {
    vi.mocked(spawnChildProcess).mockImplementationOnce(() => {
      const ee = new EventEmitter();
      setImmediate(() => ee.emit("error", new Error("ENOENT")));
      return ee as unknown as ReturnType<typeof spawnChildProcess>;
    });
    await expect(stopScope("1")).resolves.toBeUndefined();
  });

  // test/routes/internal.test.ts:145 documents the same thing from the
  // route side: unlike isMasterAlive()/isMasterAliveBatch() (which
  // deliberately wait on 'close' to survive the stdout-delivery race — see
  // their own doc comments), stopScope() has no stdout to wait for and
  // resolves off plain 'exit'. Pin that choice explicitly: a fake child
  // that emits 'exit' and NEVER emits 'close' must still resolve.
  it("resolves off 'exit', not 'close' — has no stdout to wait for, unlike isMasterAlive()", async () => {
    vi.mocked(spawnChildProcess).mockImplementationOnce(() => {
      const ee = new EventEmitter();
      setImmediate(() => ee.emit("exit", 0));
      return ee as unknown as ReturnType<typeof spawnChildProcess>;
    });
    await expect(stopScope("1")).resolves.toBeUndefined();
  });
});

describe("isMasterAlive", () => {
  it("resolves true when the scope is active", async () => {
    isActiveReplies["crs-session-1.scope"] = "active";
    await expect(isMasterAlive("1")).resolves.toBe(true);
    expect(vi.mocked(spawnChildProcess)).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "is-active", "crs-session-1.scope"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "ignore"] }),
    );
  });

  it("resolves false when the scope is inactive (program exited on its own)", async () => {
    isActiveReplies["crs-session-1.scope"] = "inactive";
    await expect(isMasterAlive("1")).resolves.toBe(false);
  });

  // Issue #988 — a scope Mullion itself asked systemd to stop sits in
  // "deactivating" for up to systemd's own DefaultTimeoutStopSec before
  // settling; that is NOT "the program exited on its own," the only thing
  // this function exists to catch, so it must not read as dead mid-stop.
  it("resolves true when the scope is deactivating (Mullion's own stop is in flight)", async () => {
    isActiveReplies["crs-session-1.scope"] = "deactivating";
    await expect(isMasterAlive("1")).resolves.toBe(true);
  });

  it("resolves false when the scope failed or never existed", async () => {
    isActiveReplies["crs-session-1.scope"] = "failed";
    await expect(isMasterAlive("1")).resolves.toBe(false);
    isActiveReplies["crs-session-1.scope"] = "unknown";
    await expect(isMasterAlive("1")).resolves.toBe(false);
  });

  it("never rejects, even if the probe itself fails to spawn", async () => {
    vi.mocked(spawnChildProcess).mockImplementationOnce(() => {
      const ee = new EventEmitter();
      setImmediate(() => ee.emit("error", new Error("ENOENT")));
      return ee as unknown as ReturnType<typeof spawnChildProcess>;
    });
    await expect(isMasterAlive("1")).resolves.toBe(false);
  });

  it("resolves off 'close', not 'exit' — survives 'exit' firing before stdout 'data' is delivered", async () => {
    isActiveReplies["crs-session-1.scope"] = "active";
    const result = await isMasterAlive("1");
    // The mock above deliberately emits 'exit' a full tick before 'data'
    // and 'close' — if isMasterAlive() resolved off 'exit' it would read
    // an empty `stdout` and report false instead of true.
    expect(result).toBe(true);
  });
});

describe("describeScope", () => {
  it("resolves the unit's Description when it is active", async () => {
    showReplies["crs-session-1.scope"] = {
      description: "/usr/bin/dtach -n /tmp/some-sessions/1.sock /bin/bash",
      activeState: "active",
    };
    await expect(describeScope("1")).resolves.toBe(
      "/usr/bin/dtach -n /tmp/some-sessions/1.sock /bin/bash",
    );
    expect(vi.mocked(spawnChildProcess)).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "show", "crs-session-1.scope", "-p", "Description", "-p", "ActiveState"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "ignore"] }),
    );
  });

  // Issue #988's same "deactivating is not yet gone" trust window
  // isMasterAlive() relies on — a scope Mullion itself just asked to stop
  // is still the genuine occupant of the name for a bootstrap collision's
  // purposes.
  it("resolves the Description when the unit is deactivating", async () => {
    showReplies["crs-session-1.scope"] = {
      description: "/usr/bin/dtach -n /tmp/some-sessions/1.sock /bin/bash",
      activeState: "deactivating",
    };
    await expect(describeScope("1")).resolves.toBe(
      "/usr/bin/dtach -n /tmp/some-sessions/1.sock /bin/bash",
    );
  });

  // systemd's own fallback for a unit that never existed: `show` still
  // exits 0 with Description equal to the bare unit name and ActiveState
  // "inactive" — verified empirically against a real systemd --user while
  // writing this. Description alone can't distinguish "genuinely occupied"
  // from "never existed"; ActiveState is what does.
  it("resolves null for a unit that doesn't exist (systemd's own fallback reply)", async () => {
    await expect(describeScope("999999999")).resolves.toBeNull();
  });

  it("resolves null when the unit is inactive/failed, even with a real Description left over", async () => {
    showReplies["crs-session-1.scope"] = {
      description: "/usr/bin/dtach -n /tmp/some-sessions/1.sock /bin/bash",
      activeState: "failed",
    };
    await expect(describeScope("1")).resolves.toBeNull();
  });

  it("never rejects, even if the probe itself fails to spawn", async () => {
    vi.mocked(spawnChildProcess).mockImplementationOnce(() => {
      const ee = new EventEmitter();
      setImmediate(() => ee.emit("error", new Error("ENOENT")));
      return ee as unknown as ReturnType<typeof spawnChildProcess>;
    });
    await expect(describeScope("1")).resolves.toBeNull();
  });
});

describe("isMasterAliveBatch", () => {
  it("resolves true only for ids whose scope unit is in the active list", async () => {
    listUnitsReply = ["crs-session-1.scope", "crs-session-3.scope"];
    await expect(isMasterAliveBatch(["1", "2", "3"])).resolves.toEqual({
      "1": true,
      "2": false,
      "3": true,
    });
  });

  it("spawns exactly one systemctl call for the whole batch, not one per id", async () => {
    listUnitsReply = ["crs-session-1.scope", "crs-session-2.scope"];
    await isMasterAliveBatch(["1", "2", "3", "4", "5"]);
    expect(vi.mocked(spawnChildProcess)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawnChildProcess)).toHaveBeenCalledWith(
      "systemctl",
      [
        "--user",
        "list-units",
        "--type=scope",
        // Issue #988 — "deactivating" alongside "active": a scope Mullion
        // itself asked systemd to stop must not read as exited for the
        // whole window it takes to settle. This relies on systemctl's own
        // `--state` filter, not any client-side parsing here — a matched
        // unit's SUB field isn't inspected, only its presence in the list.
        "--state=active,deactivating",
        "--no-legend",
        "--plain",
        "crs-session-*.scope",
      ],
      expect.objectContaining({ stdio: ["ignore", "pipe", "ignore"] }),
    );
  });

  it("resolves an empty record for an empty id list without spawning anything", async () => {
    await expect(isMasterAliveBatch([])).resolves.toEqual({});
    expect(vi.mocked(spawnChildProcess)).not.toHaveBeenCalled();
  });

  it("resolves every id false when nothing is active", async () => {
    listUnitsReply = [];
    await expect(isMasterAliveBatch(["1", "2"])).resolves.toEqual({
      "1": false,
      "2": false,
    });
  });

  // Trust rule (see isMasterAliveBatch's own doc comment in
  // session-process.ts) — a spawn failure means "unknown," not "confirmed
  // not alive": resolving with false for every id would tell
  // session-reconciler.ts to mass-exit every active session on a single
  // transient systemctl error. An empty record hits the reconciler's own
  // "host omitted liveness, skip" branch instead.
  it("resolves an empty record (not all-false) when the spawn itself fails", async () => {
    vi.mocked(spawnChildProcess).mockImplementationOnce(() => {
      const ee = new EventEmitter();
      setImmediate(() => ee.emit("error", new Error("ENOENT")));
      return ee as unknown as ReturnType<typeof spawnChildProcess>;
    });
    await expect(isMasterAliveBatch(["1", "2"])).resolves.toEqual({});
  });

  it("resolves an empty record (not all-false) when systemctl exits non-zero", async () => {
    vi.mocked(spawnChildProcess).mockImplementationOnce(() => {
      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };
      ee.stdout = new EventEmitter();
      setImmediate(() => {
        ee.emit("exit", 1);
        setImmediate(() => ee.emit("close", 1));
      });
      return ee as unknown as ReturnType<typeof spawnChildProcess>;
    });
    await expect(isMasterAliveBatch(["1", "2"])).resolves.toEqual({});
  });
});

describe("parseScopeUnitsListing", () => {
  it("parses one unit per line into {unit, description}", () => {
    const stdout =
      "crs-session-2.scope   loaded active running /usr/bin/dtach -n /tmp/voice-verify-sessions/2.sock /usr/bin/zsh -lc bash\n" +
      'crs-session-3.scope   loaded active running /usr/bin/dtach -n /tmp/ms-1437a948/3.sock /usr/bin/zsh -lc "claude"\n';

    expect(parseScopeUnitsListing(stdout)).toEqual([
      {
        unit: "crs-session-2.scope",
        description: "/usr/bin/dtach -n /tmp/voice-verify-sessions/2.sock /usr/bin/zsh -lc bash",
      },
      {
        unit: "crs-session-3.scope",
        description: '/usr/bin/dtach -n /tmp/ms-1437a948/3.sock /usr/bin/zsh -lc "claude"',
      },
    ]);
  });

  it("returns an empty array for empty output (no matching units)", () => {
    expect(parseScopeUnitsListing("")).toEqual([]);
  });

  it("skips a blank trailing line without producing a bogus row", () => {
    const stdout = "crs-session-1.scope loaded active running /bin/true\n\n";
    expect(parseScopeUnitsListing(stdout)).toEqual([
      { unit: "crs-session-1.scope", description: "/bin/true" },
    ]);
  });
});

describe("extractDtachSocketPath", () => {
  it("extracts the socket path from a real dtach description", () => {
    expect(
      extractDtachSocketPath(
        "/usr/bin/dtach -n /tmp/voice-verify-sessions/2.sock /usr/bin/zsh -lc bash",
      ),
    ).toBe("/tmp/voice-verify-sessions/2.sock");
  });

  it("returns null for a description that isn't a dtach invocation", () => {
    expect(extractDtachSocketPath("crs-session-999999999.scope")).toBeNull();
  });
});

describe("listSessionProcesses", () => {
  it("derives the scope unit name and delegates to cgroup-inventory's listScopeProcesses", async () => {
    await listSessionProcesses("1");
    expect(vi.mocked(listScopeProcesses)).toHaveBeenCalledWith("crs-session-1.scope");
  });

  it("returns whatever listScopeProcesses resolves with (no active scope -> [])", async () => {
    vi.mocked(listScopeProcesses).mockResolvedValueOnce([]);
    await expect(listSessionProcesses("1")).resolves.toEqual([]);
  });

  it("passes through a populated process list unchanged", async () => {
    const processes = [{ pid: 123, ppid: 1, comm: "dtach", cmdline: ["dtach", "-n"] }];
    vi.mocked(listScopeProcesses).mockResolvedValueOnce(processes);
    await expect(listSessionProcesses("1")).resolves.toEqual(processes);
  });
});
