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
// Issue #1232 — a child that never emits 'close'/'error'/'exit' at all,
// simulating a wedged `--user` D-Bus bus. Distinct from `*ShouldError`
// (which resolves promptly with a spawn error): this one never resolves on
// its own, so only the new SYSTEMCTL_TIMEOUT_MS/KILL_ESCALATION_MS timers in
// session-process.ts can ever settle a promise built on it — exactly the
// case those timers exist for.
let listUnitsShouldHang = false;
let stopShouldHang = false;

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

// Issue #1232 — the shape a real `child_process.ChildProcess` exposes that
// the escalation-timer code in session-process.ts now reads/calls:
// `kill()` (spied so a test can assert SIGTERM-then-SIGKILL) and
// `exitCode`/`signalCode` (which the escalation check reads directly,
// *not* `killed` — see session-process.ts's own comment on why). Every
// branch below sets `exitCode = 0` right before its own natural
// exit/close, mirroring a real child process; the hang branches leave both
// `null` forever, exactly like a wedged process that never received or
// acted on a signal.
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
  // Records calls only — does NOT itself flip exitCode/signalCode. A real
  // `kill()` merely SENDS a signal; the process might ignore it, so
  // `signalCode` only becomes non-null once the process actually
  // terminates (Node sets it alongside 'exit', not synchronously here).
  // A test that wants "the child ignored SIGTERM" leaves these `null` and
  // lets the escalation fire; a test that wants "the child died from it"
  // sets `exitCode`/`signalCode` and/or emits 'exit'/'close' itself.
  ee.kill = vi.fn(() => true);
  return ee;
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((file: string, args: string[]) => {
      const ee = createMockChild();
      if (file === "systemctl" && args[1] === "list-units") {
        if (listUnitsShouldError) {
          setImmediate(() => ee.emit("error", new Error("ENOENT")));
          return ee;
        }
        if (listUnitsShouldHang) {
          // Never emits anything — see this flag's own comment above.
          return ee;
        }
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
        if (stopShouldError) {
          setImmediate(() => ee.emit("error", new Error("ENOENT")));
          return ee;
        }
        if (stopShouldHang) {
          // Never emits anything — see listUnitsShouldHang's own comment.
          return ee;
        }
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

const {
  scopeUnitName,
  deriveInstanceId,
  listOwnedScopes,
  stopScope,
  describeScope,
  isMasterAlive,
  isMasterAliveState,
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
  listUnitsShouldHang = false;
  stopCalls.length = 0;
  stopShouldError = false;
  stopShouldHang = false;
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
  it("is deterministic, instance- and id-derived, and not timestamped", () => {
    expect(scopeUnitName(INSTANCE_ID, "1")).toBe(`crs-session-${INSTANCE_ID}-1`);
    expect(scopeUnitName(INSTANCE_ID, "1")).toBe(scopeUnitName(INSTANCE_ID, "1"));
    expect(scopeUnitName(INSTANCE_ID, "abc-def")).toBe(`crs-session-${INSTANCE_ID}-abc-def`);
  });

  it("differs for the same id across two instances — the whole point of #1140", () => {
    expect(scopeUnitName("aaaaaaaa", "1")).not.toBe(scopeUnitName("bbbbbbbb", "1"));
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

  it("also owns an id from a per-instance-namespaced unit name for THIS instance (PR 2's own shape)", async () => {
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

  // Issue #1232 — this spawn used to have no timeout at all: a wedged
  // `--user` D-Bus bus left the returned promise pending forever, and every
  // isMasterAlive/isMasterAliveBatch caller bottomed out here. `vi.useFakeTimers()`
  // is scoped to each test with a try/finally so a failure here can't leak
  // fake timers into later, unrelated tests in this file.
  describe("timeout (issue #1232)", () => {
    it("resolves failed:true, not hung, when systemctl never emits close/error", async () => {
      listUnitsShouldHang = true;
      vi.useFakeTimers();
      try {
        const promise = listOwnedScopes("/inst-a", INSTANCE_A, { all: true });
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(promise).resolves.toEqual({
          owned: new Map(),
          unverifiable: new Set(),
          failed: true,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("sends SIGTERM at the timeout, then escalates to SIGKILL if the child is still alive", async () => {
      listUnitsShouldHang = true;
      vi.useFakeTimers();
      try {
        const promise = listOwnedScopes("/inst-a", INSTANCE_A, { all: true });
        await vi.advanceTimersByTimeAsync(5_000);
        await promise; // the outer promise already settles at the timeout
        const child = vi.mocked(spawnChildProcess).mock.results[0]?.value as MockChild;
        expect(child.kill).toHaveBeenCalledTimes(1);
        expect(child.kill).toHaveBeenNthCalledWith(1); // SIGTERM — no args

        // The mock's kill() never flips exitCode/signalCode on its own (see
        // createMockChild's own comment) — this child is "still alive" from
        // the escalation check's point of view, same as one that's ignoring
        // SIGTERM for real.
        await vi.advanceTimersByTimeAsync(2_000);
        expect(child.kill).toHaveBeenCalledTimes(2);
        expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not escalate to SIGKILL once the child is confirmed to have actually ended", async () => {
      listUnitsShouldHang = true;
      vi.useFakeTimers();
      try {
        const promise = listOwnedScopes("/inst-a", INSTANCE_A, { all: true });
        await vi.advanceTimersByTimeAsync(5_000);
        await promise;
        const child = vi.mocked(spawnChildProcess).mock.results[0]?.value as MockChild;
        expect(child.kill).toHaveBeenCalledTimes(1);

        // The SIGTERM actually worked — simulate the child confirming that,
        // same as a real 'close' event would (which also clears the pending
        // escalation timer in the production code).
        child.exitCode = 0;
        child.emit("close", 0);

        await vi.advanceTimersByTimeAsync(2_000);
        expect(child.kill).toHaveBeenCalledTimes(1); // no SIGKILL escalation
      } finally {
        vi.useRealTimers();
      }
    });
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

  // Issue #1140 (PR 2) — unlike PR 1 (Hermes review, PR 1: falling back to
  // the un-namespaced legacy name on a listing failure could still stop a
  // DIFFERENT instance's session), the fallback name is now namespaced —
  // `crs-session-<instanceId>-<id>.scope` can only ever be a unit THIS
  // instance created, so falling back to it on a listing failure is safe.
  it("falls back to stopping the namespaced unit name when the listing itself fails", async () => {
    listUnitsShouldError = true;
    await stopScope(SESSIONS_DIR, INSTANCE_ID, "1");
    expect(stopCalls).toEqual([["--user", "stop", `crs-session-${INSTANCE_ID}-1.scope`]]);
  });

  it("resolves (does not reject) even when the stop spawn itself errors", async () => {
    listUnitsReply = [ownedLine("1")];
    stopShouldError = true;
    await expect(stopScope(SESSIONS_DIR, INSTANCE_ID, "1")).resolves.toBeUndefined();
  });

  // Issue #1232 — this spawn also had no timeout. Unlike listOwnedScopes'
  // own listing, this is a mutating `systemctl --user stop` — the fix here
  // is only "resolve instead of hanging," never "read as failed," since
  // killing the child on timeout doesn't cancel the stop request itself
  // (see stopScope's own comment on this in session-process.ts).
  it("resolves (does not hang) when the stop spawn never exits", async () => {
    listUnitsReply = [ownedLine("1")];
    stopShouldHang = true;
    const promise = stopScope(SESSIONS_DIR, INSTANCE_ID, "1");
    // stopScope first does a real (unhung) listing via resolveOwningUnit,
    // which resolves through this mock's own real setImmediate chain — let
    // that settle, with real timers still in effect, before engaging fake
    // timers for just the "stop" spawn's own timeout below. Faking
    // setImmediate too (a plain vi.useFakeTimers() up front) would freeze
    // that chain and hang the test itself, not just exercise the timeout
    // under test.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(promise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
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

// Issue #1232 — the three-way counterpart to isMasterAlive() above, added
// so a caller that takes a DESTRUCTIVE action on "not alive" (routes/
// projects.ts's startStackSession/findActiveStackSession) can tell an
// unverifiable/timed-out listing apart from a confident "dead" — see
// isMasterAliveState's own doc comment in session-process.ts.
describe("isMasterAliveState", () => {
  it('resolves "alive" for an id this instance owns and has listed', async () => {
    listUnitsReply = [ownedLine("1")];
    await expect(isMasterAliveState(SESSIONS_DIR, INSTANCE_ID, "1")).resolves.toBe("alive");
  });

  it('resolves "dead" when nothing in the listing claims this id', async () => {
    listUnitsReply = [];
    await expect(isMasterAliveState(SESSIONS_DIR, INSTANCE_ID, "1")).resolves.toBe("dead");
  });

  it('resolves "unknown" (not "dead") when a row names this id but ownership can\'t be confirmed', async () => {
    listUnitsReply = [line("crs-session-1.scope", "not a dtach invocation")];
    await expect(isMasterAliveState(SESSIONS_DIR, INSTANCE_ID, "1")).resolves.toBe("unknown");
  });

  it('resolves "unknown" (not "dead"), never rejects, when the underlying listing spawn fails', async () => {
    listUnitsShouldError = true;
    await expect(isMasterAliveState(SESSIONS_DIR, INSTANCE_ID, "1")).resolves.toBe("unknown");
  });

  // The whole reason this function exists: isMasterAlive()'s own `?? false`
  // posture must NOT change — a caller that only needs the old boolean
  // contract still gets it, byte-for-byte, on all three states above.
  it("isMasterAlive's boolean answer is unaffected by this function's existence", async () => {
    listUnitsReply = [ownedLine("1")];
    await expect(isMasterAlive(SESSIONS_DIR, INSTANCE_ID, "1")).resolves.toBe(true);

    listUnitsReply = [];
    await expect(isMasterAlive(SESSIONS_DIR, INSTANCE_ID, "1")).resolves.toBe(false);

    listUnitsReply = [line("crs-session-1.scope", "not a dtach invocation")];
    await expect(isMasterAlive(SESSIONS_DIR, INSTANCE_ID, "1")).resolves.toBe(false);
  });
});

describe("describeScope", () => {
  const UNIT = `crs-session-${INSTANCE_ID}-1.scope`;

  it("resolves the unit's Description when it is active", async () => {
    showReplies[UNIT] = {
      description: "/usr/bin/dtach -n /tmp/some-sessions/1.sock /bin/bash",
      activeState: "active",
    };
    await expect(describeScope(INSTANCE_ID, "1")).resolves.toBe(
      "/usr/bin/dtach -n /tmp/some-sessions/1.sock /bin/bash",
    );
    expect(vi.mocked(spawnChildProcess)).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "show", UNIT, "-p", "Description", "-p", "ActiveState"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "ignore"] }),
    );
  });

  // Issue #988's same "deactivating is not yet gone" trust window
  // isMasterAlive() relies on — a scope Mullion itself just asked to stop
  // is still the genuine occupant of the name for a bootstrap collision's
  // purposes.
  it("resolves the Description when the unit is deactivating", async () => {
    showReplies[UNIT] = {
      description: "/usr/bin/dtach -n /tmp/some-sessions/1.sock /bin/bash",
      activeState: "deactivating",
    };
    await expect(describeScope(INSTANCE_ID, "1")).resolves.toBe(
      "/usr/bin/dtach -n /tmp/some-sessions/1.sock /bin/bash",
    );
  });

  // systemd's own fallback for a unit that never existed: `show` still
  // exits 0 with Description equal to the bare unit name and ActiveState
  // "inactive" — verified empirically against a real systemd --user while
  // writing this. Description alone can't distinguish "genuinely occupied"
  // from "never existed"; ActiveState is what does.
  it("resolves null for a unit that doesn't exist (systemd's own fallback reply)", async () => {
    await expect(describeScope(INSTANCE_ID, "999999999")).resolves.toBeNull();
  });

  it("resolves null when the unit is inactive/failed, even with a real Description left over", async () => {
    showReplies[UNIT] = {
      description: "/usr/bin/dtach -n /tmp/some-sessions/1.sock /bin/bash",
      activeState: "failed",
    };
    await expect(describeScope(INSTANCE_ID, "1")).resolves.toBeNull();
  });

  it("never rejects, even if the probe itself fails to spawn", async () => {
    vi.mocked(spawnChildProcess).mockImplementationOnce(() => {
      const ee = new EventEmitter();
      setImmediate(() => ee.emit("error", new Error("ENOENT")));
      return ee as unknown as ReturnType<typeof spawnChildProcess>;
    });
    await expect(describeScope(INSTANCE_ID, "1")).resolves.toBeNull();
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

  it("falls back to the namespaced unit name and still delegates when the listing itself fails", async () => {
    listUnitsShouldError = true;
    await listSessionProcesses(SESSIONS_DIR, INSTANCE_ID, "1");
    expect(vi.mocked(listScopeProcesses)).toHaveBeenCalledWith(
      `crs-session-${INSTANCE_ID}-1.scope`,
    );
  });

  it("passes through a populated process list unchanged", async () => {
    listUnitsReply = [ownedLine("1")];
    const processes = [{ pid: 123, ppid: 1, comm: "dtach", cmdline: ["dtach", "-n"] }];
    vi.mocked(listScopeProcesses).mockResolvedValueOnce(processes);
    await expect(listSessionProcesses(SESSIONS_DIR, INSTANCE_ID, "1")).resolves.toEqual(processes);
  });
});
