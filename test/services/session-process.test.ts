import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { spawn as spawnChildProcess } from "node:child_process";
import type * as ChildProcess from "node:child_process";

// This module owns only the systemd `--user` scope naming/lifecycle glue
// (scopeUnitName, stopScope, isMasterAlive, isMasterAliveBatch,
// listSessionProcesses, and — issue #1140 — the socket-path ownership check
// they're all built on, listOwnedScopes/deriveInstanceId) extracted out of
// pty-manager.ts — see that file's own header comment for why these are
// plain functions (no per-Session state) rather than a class, and
// session-process.ts's header for the full boundary. The end-to-end
// behavior tests that exercise these through PtyManager's own delegating
// methods (manager.isMasterAlive(), manager.terminate() calling
// stopScope(), etc.) already live in pty-manager.test.ts and are unchanged
// by this extraction; these tests exercise the extracted functions
// directly.

const SESSIONS_DIR = "/tmp/some-sessions";
const INSTANCE_ID = "aaaaaaaa";

// The fake `systemctl --user list-units` reply listOwnedScopes() should
// see, as raw `--plain --no-legend` output lines ("UNIT LOAD ACTIVE SUB
// DESCRIPTION"). Full lines (not just unit names) so a test controls the
// Description systemd would render — the ownership check below reads the
// dtach socket path OUT of that Description, not the unit name.
let listUnitsReply: string[] = [];
let listUnitsShouldError = false;

// The fake `systemctl --user show <unit> -p Description -p ActiveState`
// reply describeScope() should see, keyed by unit name. Defaults (unit
// absent from this map) to a unit that doesn't exist: systemd's own
// fallback Description equal to the unit name itself, ActiveState
// "inactive" — see describeScope's own doc comment for why Description
// alone can't be trusted without also checking this.
const showReplies: Record<string, { description: string; activeState: string }> = {};

// Records every `systemctl --user stop <unit>.scope` invocation so
// stopScope() tests can assert on the exact spawn args without depending on
// its resolution timing.
const stopCalls: string[][] = [];
let stopShouldError = false;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((file: string, args: string[]) => {
      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };
      if (file === "systemctl" && args[1] === "list-units") {
        if (listUnitsShouldError) {
          setImmediate(() => ee.emit("error", new Error("ENOENT")));
          return ee;
        }
        ee.stdout = new EventEmitter();
        setImmediate(() => {
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
        if (stopShouldError) {
          setImmediate(() => ee.emit("error", new Error("ENOENT")));
          return ee;
        }
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
  deriveInstanceId,
  listOwnedScopes,
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
  for (const key of Object.keys(showReplies)) delete showReplies[key];
  listUnitsReply = [];
  listUnitsShouldError = false;
  stopCalls.length = 0;
  stopShouldError = false;
  vi.mocked(spawnChildProcess).mockClear();
  vi.mocked(listScopeProcesses).mockClear();
});

// "UNIT LOAD ACTIVE SUB DESCRIPTION" — the real `--plain --no-legend` shape
// parseScopeUnitsListing()/listOwnedScopes() parse. `description` is
// whatever the rest of the line renders as; a real systemd renders it as
// the unit's exact launch argv (dtach -n <socket> ...) — see
// extractDtachSocketPath's own doc comment.
function line(unit: string, description: string, state = "active"): string {
  return `${unit} loaded ${state} running ${description}`;
}

// A row for a legacy-shaped `crs-session-<id>.scope` whose socket resolves
// under `dir` — the shape every one of this host's own live scopes has
// today (verified during #1140's planning: all 7 resolve this way).
function ownedLine(id: string, dir: string = SESSIONS_DIR): string {
  return line(
    `crs-session-${id}.scope`,
    `/usr/bin/dtach -n ${dir}/${id}.sock /usr/bin/zsh -lc bash`,
  );
}

describe("scopeUnitName", () => {
  it("is deterministic, id-derived, and not timestamped", () => {
    expect(scopeUnitName("1")).toBe("crs-session-1");
    expect(scopeUnitName("1")).toBe(scopeUnitName("1"));
    expect(scopeUnitName("abc-def")).toBe("crs-session-abc-def");
  });
});

describe("deriveInstanceId", () => {
  it("is stable across repeated calls for the same sessionsDir", () => {
    expect(deriveInstanceId("/a/b")).toBe(deriveInstanceId("/a/b"));
  });

  it("differs for different sessionsDir values — the whole point of #1140", () => {
    expect(deriveInstanceId("/a/b")).not.toBe(deriveInstanceId("/a/c"));
  });

  it("resolves a trailing slash the same as none (path.resolve normalizes it)", () => {
    expect(deriveInstanceId("/a/b")).toBe(deriveInstanceId("/a/b/"));
  });

  it("is 8 lowercase hex characters — short enough for a systemd unit name", () => {
    expect(deriveInstanceId("/a/b")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("listOwnedScopes", () => {
  const INSTANCE_A = "aaaaaaaa";
  const INSTANCE_B = "bbbbbbbb";

  it("owns an id whose socket resolves directly under sessionsDir, from a legacy-shaped unit name", async () => {
    listUnitsReply = [ownedLine("5", "/inst-a")];
    const result = await listOwnedScopes("/inst-a", INSTANCE_A, { all: true });
    expect(result.failed).toBe(false);
    expect(result.owned).toEqual(new Map([["5", "crs-session-5.scope"]]));
  });

  it("also owns an id from a future per-instance-namespaced unit name for THIS instance — #1140's point: PR1 already understands PR2's shape", async () => {
    listUnitsReply = [
      line(
        `crs-session-${INSTANCE_A}-6.scope`,
        "/usr/bin/dtach -n /inst-a/6.sock /usr/bin/zsh -lc bash",
      ),
    ];
    const result = await listOwnedScopes("/inst-a", INSTANCE_A, { all: true });
    expect(result.owned).toEqual(new Map([["6", `crs-session-${INSTANCE_A}-6.scope`]]));
  });

  it("recovers the id from the socket basename, never by parsing the unit name — an id containing '-' is not ambiguous", async () => {
    listUnitsReply = [ownedLine("abc-def", "/inst-a")];
    const result = await listOwnedScopes("/inst-a", INSTANCE_A, { all: true });
    expect(result.owned).toEqual(new Map([["abc-def", "crs-session-abc-def.scope"]]));
  });

  it("does not own a legacy-named unit whose socket lives under a DIFFERENT sessionsDir", async () => {
    listUnitsReply = [ownedLine("7", "/inst-b")];
    const result = await listOwnedScopes("/inst-a", INSTANCE_A, { all: true });
    expect(result.owned.has("7")).toBe(false);
    expect(result.unverifiable.has("7")).toBe(false);
  });

  it("marks an id unverifiable (not owned, not denied) when a candidate row's Description doesn't parse to a socket path", async () => {
    listUnitsReply = [line("crs-session-9.scope", "some other process, not dtach")];
    const result = await listOwnedScopes("/inst-a", INSTANCE_A, { all: true });
    expect(result.owned.has("9")).toBe(false);
    expect(result.unverifiable.has("9")).toBe(true);
  });

  it("does not treat another instance's namespaced unit as a candidate for this instance's ids", async () => {
    listUnitsReply = [line(`crs-session-${INSTANCE_B}-9.scope`, "some other process, not dtach")];
    const result = await listOwnedScopes("/inst-a", INSTANCE_A, { all: true });
    expect(result.unverifiable.has("9")).toBe(false);
  });

  it("extracts the full socket path (and thus the right owner) when SESSIONS_DIR itself contains a space", async () => {
    listUnitsReply = [
      line("crs-session-2.scope", '/usr/bin/dtach -n "/space test dir/2.sock" sleep 300'),
    ];
    const result = await listOwnedScopes("/space test dir", INSTANCE_A, { all: true });
    expect(result.owned).toEqual(new Map([["2", "crs-session-2.scope"]]));
  });

  it("resolves failed:true, both maps empty, on a listing spawn error", async () => {
    listUnitsShouldError = true;
    const result = await listOwnedScopes("/inst-a", INSTANCE_A, { all: true });
    expect(result).toEqual({ owned: new Map(), unverifiable: new Set(), failed: true });
  });

  it("resolves failed:true when systemctl exits non-zero", async () => {
    vi.mocked(spawnChildProcess).mockImplementationOnce(() => {
      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };
      ee.stdout = new EventEmitter();
      setImmediate(() => {
        ee.emit("exit", 1);
        setImmediate(() => ee.emit("close", 1));
      });
      return ee as unknown as ReturnType<typeof spawnChildProcess>;
    });
    const result = await listOwnedScopes("/inst-a", INSTANCE_A, { all: true });
    expect(result.failed).toBe(true);
  });

  it("passes opts.states/opts.all straight through to the systemctl argv", async () => {
    await listOwnedScopes("/inst-a", INSTANCE_A, { states: "active,deactivating" });
    expect(vi.mocked(spawnChildProcess)).toHaveBeenCalledWith(
      "systemctl",
      [
        "--user",
        "list-units",
        "--type=scope",
        "--state=active,deactivating",
        "--no-legend",
        "--plain",
        "crs-session-*.scope",
      ],
      expect.objectContaining({ stdio: ["ignore", "pipe", "ignore"] }),
    );

    await listOwnedScopes("/inst-a", INSTANCE_A, { all: true });
    expect(vi.mocked(spawnChildProcess)).toHaveBeenCalledWith(
      "systemctl",
      [
        "--user",
        "list-units",
        "--type=scope",
        "--all",
        "--no-legend",
        "--plain",
        "crs-session-*.scope",
      ],
      expect.objectContaining({ stdio: ["ignore", "pipe", "ignore"] }),
    );
  });
});

describe("stopScope", () => {
  it("resolves the owning unit via the listing, then spawns systemctl --user stop <unit>.scope", async () => {
    listUnitsReply = [ownedLine("1")];
    await stopScope(SESSIONS_DIR, INSTANCE_ID, "1");
    // Two spawns — the ownership listing, then the stop itself. See
    // stopScope's own doc comment on why this is an intentional, accepted
    // latency increase over the single spawn it used to be.
    expect(vi.mocked(spawnChildProcess)).toHaveBeenCalledTimes(2);
    expect(stopCalls).toEqual([["--user", "stop", "crs-session-1.scope"]]);
    expect(vi.mocked(spawnChildProcess)).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "stop", "crs-session-1.scope"],
      expect.objectContaining({ stdio: "ignore" }),
    );
  });

  it("does nothing when the listing succeeds but doesn't claim this id (not owned, or already gone)", async () => {
    listUnitsReply = [];
    await expect(stopScope(SESSIONS_DIR, INSTANCE_ID, "1")).resolves.toBeUndefined();
    expect(stopCalls).toEqual([]);
  });

  // Issue #1140's own inverted-#1137 case: stopping a unit this instance
  // hasn't confirmed it owns would kill a live session belonging to a
  // DIFFERENT instance on the same host. The listing here succeeds and
  // returns a real crs-session-1.scope row — just not one whose socket is
  // under THIS instance's sessionsDir.
  it("never stops another instance's legacy-named scope, even though the name matches", async () => {
    listUnitsReply = [ownedLine("1", "/some/other/instances/sessions")];
    await expect(stopScope(SESSIONS_DIR, INSTANCE_ID, "1")).resolves.toBeUndefined();
    expect(stopCalls).toEqual([]);
  });

  // resolveOwningUnit's third case: the listing succeeded (not `failed`)
  // and a row's unit NAME could plausibly be this id, but its Description
  // didn't parse to a socket path at all — ownership is unverifiable, not
  // confirmed, so this must resolve exactly like "not ours" above: do
  // nothing, never fall back to stopping the bare name.
  it("does not stop a scope whose ownership is unverifiable (a row names the id but its Description doesn't parse)", async () => {
    listUnitsReply = [line("crs-session-1.scope", "not a dtach invocation")];
    await expect(stopScope(SESSIONS_DIR, INSTANCE_ID, "1")).resolves.toBeUndefined();
    expect(stopCalls).toEqual([]);
  });

  // Hermes review, this PR — the read path (isMasterAlive/isMasterAliveBatch)
  // already fails open to "unknown" on a listing failure; stopScope must
  // mirror that instead of falling back to an un-confirmed unit name, or it
  // becomes the one path that can still stop a DIFFERENT instance's session
  // under the exact degraded-bus conditions the read path refuses to answer
  // under. The session leaks (keeps running) instead — accepted, since
  // scripts/check-scope-leaks.ts is the tool that catches a leak, and
  // that's a better failure mode than risking a cross-instance kill.
  it("does nothing (does not fall back to the legacy name) when the listing itself fails", async () => {
    listUnitsShouldError = true;
    await expect(stopScope(SESSIONS_DIR, INSTANCE_ID, "1")).resolves.toBeUndefined();
    expect(stopCalls).toEqual([]);
  });

  it("resolves (does not reject) even when the stop spawn itself errors", async () => {
    listUnitsReply = [ownedLine("1")];
    stopShouldError = true;
    await expect(stopScope(SESSIONS_DIR, INSTANCE_ID, "1")).resolves.toBeUndefined();
  });
});

describe("isMasterAlive", () => {
  it("resolves true when this instance's scope for the id is owned and listed", async () => {
    listUnitsReply = [ownedLine("1")];
    await expect(isMasterAlive(SESSIONS_DIR, INSTANCE_ID, "1")).resolves.toBe(true);
  });

  it("resolves false when nothing in the listing claims this id", async () => {
    listUnitsReply = [];
    await expect(isMasterAlive(SESSIONS_DIR, INSTANCE_ID, "1")).resolves.toBe(false);
  });

  // Single-id posture, preserved on top of isMasterAliveBatch's batch-level
  // "unknown stays unknown" — see isMasterAlive's own doc comment.
  it("resolves false (not unknown) when a row names this id but ownership can't be confirmed", async () => {
    listUnitsReply = [line("crs-session-1.scope", "not a dtach invocation")];
    await expect(isMasterAlive(SESSIONS_DIR, INSTANCE_ID, "1")).resolves.toBe(false);
  });

  it("resolves false (not unknown), never rejects, when the underlying listing spawn fails", async () => {
    listUnitsShouldError = true;
    await expect(isMasterAlive(SESSIONS_DIR, INSTANCE_ID, "1")).resolves.toBe(false);
  });

  it("delegates to a single list-units spawn, not a per-unit is-active spawn", async () => {
    listUnitsReply = [ownedLine("1")];
    await isMasterAlive(SESSIONS_DIR, INSTANCE_ID, "1");
    expect(vi.mocked(spawnChildProcess)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawnChildProcess)).toHaveBeenCalledWith(
      "systemctl",
      [
        "--user",
        "list-units",
        "--type=scope",
        "--state=active,deactivating",
        "--no-legend",
        "--plain",
        "crs-session-*.scope",
      ],
      expect.objectContaining({ stdio: ["ignore", "pipe", "ignore"] }),
    );
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
  it("resolves true only for ids whose scope this instance owns", async () => {
    listUnitsReply = [ownedLine("1"), ownedLine("3")];
    await expect(isMasterAliveBatch(SESSIONS_DIR, INSTANCE_ID, ["1", "2", "3"])).resolves.toEqual({
      "1": true,
      "2": false,
      "3": true,
    });
  });

  it("spawns exactly one systemctl call for the whole batch, not one per id", async () => {
    listUnitsReply = [ownedLine("1"), ownedLine("2")];
    await isMasterAliveBatch(SESSIONS_DIR, INSTANCE_ID, ["1", "2", "3", "4", "5"]);
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
        // `--state` filter, not any client-side parsing here.
        "--state=active,deactivating",
        "--no-legend",
        "--plain",
        "crs-session-*.scope",
      ],
      expect.objectContaining({ stdio: ["ignore", "pipe", "ignore"] }),
    );
  });

  it("resolves an empty record for an empty id list without spawning anything", async () => {
    await expect(isMasterAliveBatch(SESSIONS_DIR, INSTANCE_ID, [])).resolves.toEqual({});
    expect(vi.mocked(spawnChildProcess)).not.toHaveBeenCalled();
  });

  // Hermes review, this PR — locking in a deliberate outcome: a row whose
  // socket parses CLEANLY (unlike the "unverifiable" case below) but
  // resolves under a DIFFERENT instance's sessionsDir is neither owned nor
  // unverifiable, so it resolves to a confident `false`, not omitted. This
  // is correct, not a collision mishandled: systemd forbids two units
  // sharing a name, so if this instance's own session "1" were still
  // alive, it would hold this exact unit name itself — a foreign-owned
  // crs-session-1.scope existing at all means this instance's own session
  // "1" has already ended.
  it("resolves a confident false (not omitted) for a same-named unit owned by a different instance", async () => {
    listUnitsReply = [ownedLine("1", "/some/other/instances/sessions")];
    const result = await isMasterAliveBatch(SESSIONS_DIR, INSTANCE_ID, ["1"]);
    expect(result).toEqual({ "1": false });
  });

  it("resolves every id false when nothing is owned", async () => {
    listUnitsReply = [];
    await expect(isMasterAliveBatch(SESSIONS_DIR, INSTANCE_ID, ["1", "2"])).resolves.toEqual({
      "1": false,
      "2": false,
    });
  });

  // Trust rule (see isMasterAliveBatch's own doc comment in
  // session-process.ts) — a candidate row whose ownership can't be
  // confirmed is OMITTED, not false: resolving false here would tell
  // session-reconciler.ts a session has exited when it might well still be
  // alive under a different instance's ownership.
  it("omits (does not resolve false for) an id a row names but can't confirm ownership of", async () => {
    listUnitsReply = [line("crs-session-1.scope", "not a dtach invocation")];
    const result = await isMasterAliveBatch(SESSIONS_DIR, INSTANCE_ID, ["1", "2"]);
    expect(result).toEqual({ "2": false });
    expect("1" in result).toBe(false);
  });

  // Trust rule — a spawn failure means "unknown," not "confirmed not
  // alive": resolving with false for every id would tell
  // session-reconciler.ts to mass-exit every active session on a single
  // transient systemctl error. An empty record hits the reconciler's own
  // "host omitted liveness, skip" branch instead.
  it("resolves an empty record (not all-false) when the spawn itself fails", async () => {
    listUnitsShouldError = true;
    await expect(isMasterAliveBatch(SESSIONS_DIR, INSTANCE_ID, ["1", "2"])).resolves.toEqual({});
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
    await expect(isMasterAliveBatch(SESSIONS_DIR, INSTANCE_ID, ["1", "2"])).resolves.toEqual({});
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

  // Verified empirically against a real systemd --user: an argument
  // containing a space renders double-quoted in the unit's Description. A
  // bare `\S+` match would truncate at the first space and silently recover
  // the wrong (truncated) path.
  it("extracts the full socket path when SESSIONS_DIR itself contains a space", () => {
    expect(extractDtachSocketPath('/usr/bin/dtach -n "/tmp/space test dir/x.sock" sleep 300')).toBe(
      "/tmp/space test dir/x.sock",
    );
  });
});

describe("listSessionProcesses", () => {
  it("resolves the owning unit via the listing and delegates to cgroup-inventory's listScopeProcesses", async () => {
    listUnitsReply = [ownedLine("1")];
    await listSessionProcesses(SESSIONS_DIR, INSTANCE_ID, "1");
    expect(vi.mocked(listScopeProcesses)).toHaveBeenCalledWith("crs-session-1.scope");
  });

  it("returns [] without calling listScopeProcesses when nothing owns this id", async () => {
    listUnitsReply = [];
    await expect(listSessionProcesses(SESSIONS_DIR, INSTANCE_ID, "1")).resolves.toEqual([]);
    expect(vi.mocked(listScopeProcesses)).not.toHaveBeenCalled();
  });

  it("returns [] without calling listScopeProcesses when ownership is unverifiable", async () => {
    listUnitsReply = [line("crs-session-1.scope", "not a dtach invocation")];
    await expect(listSessionProcesses(SESSIONS_DIR, INSTANCE_ID, "1")).resolves.toEqual([]);
    expect(vi.mocked(listScopeProcesses)).not.toHaveBeenCalled();
  });

  it("falls back to the legacy unit name and still delegates when the listing itself fails", async () => {
    listUnitsShouldError = true;
    await listSessionProcesses(SESSIONS_DIR, INSTANCE_ID, "1");
    expect(vi.mocked(listScopeProcesses)).toHaveBeenCalledWith("crs-session-1.scope");
  });

  it("passes through a populated process list unchanged", async () => {
    listUnitsReply = [ownedLine("1")];
    const processes = [{ pid: 123, ppid: 1, comm: "dtach", cmdline: ["dtach", "-n"] }];
    vi.mocked(listScopeProcesses).mockResolvedValueOnce(processes);
    await expect(listSessionProcesses(SESSIONS_DIR, INSTANCE_ID, "1")).resolves.toEqual(processes);
  });
});
