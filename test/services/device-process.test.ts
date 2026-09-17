import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { spawn as spawnChildProcess } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The devices/AVD analogue of session-process.test.ts — see
// device-process.ts's own header for why this is a separate module rather
// than a generalization of session-process.ts, and for the one real
// difference under test here: an emulator scope's Description is an
// EXPLICIT, self-controlled `--description` string (this module's own
// format), not systemd's own argv rendering — so there's no
// quoted-vs-unquoted argument shape to handle the way
// DTACH_SOCKET_PATTERN does, only "everything after the prefix, to end of
// line." Verified empirically against a real `systemd --user` during
// development (see the PR description) that this string round-trips
// unquoted even when the marker path itself contains a space.

const SESSIONS_DIR = "/tmp/some-sessions";
const INSTANCE_ID = "aaaaaaaa";

let listUnitsReply: string[] = [];
let listUnitsShouldError = false;
const stopCalls: string[][] = [];
let stopShouldError = false;

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
      if (file === "systemctl" && args[1] === "list-units") {
        if (listUnitsShouldError) {
          setImmediate(() => ee.emit("error", new Error("ENOENT")));
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
        setImmediate(() => {
          ee.exitCode = 0;
          ee.emit("exit", 0);
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

const {
  deviceScopeUnitName,
  deriveInstanceId,
  deviceMarkerPath,
  extractDeviceMarkerPath,
  touchDeviceMarker,
  removeDeviceMarker,
  listOwnedDeviceScopes,
  stopDeviceScope,
  isDeviceAliveState,
  isDeviceAliveStateBatch,
  buildDeviceLaunchPlan,
} = await import("../../src/services/device-process.js");

beforeEach(() => {
  listUnitsReply = [];
  listUnitsShouldError = false;
  stopCalls.length = 0;
  stopShouldError = false;
  vi.mocked(spawnChildProcess).mockClear();
});

function line(unit: string, description: string, state = "active"): string {
  return `${unit} loaded ${state} running ${description}`;
}

describe("deviceScopeUnitName", () => {
  it("is deterministic, instance- and id-derived, and prefixed distinctly from crs-session-*", () => {
    expect(deviceScopeUnitName(INSTANCE_ID, "5")).toBe(`crs-device-${INSTANCE_ID}-5`);
    expect(deviceScopeUnitName(INSTANCE_ID, "5")).not.toMatch(/^crs-session-/);
  });

  it("differs for the same id across two instances", () => {
    expect(deviceScopeUnitName("aaaaaaaa", "5")).not.toBe(deviceScopeUnitName("bbbbbbbb", "5"));
  });
});

describe("deviceMarkerPath / extractDeviceMarkerPath", () => {
  it("round-trips a plain path", () => {
    const marker = deviceMarkerPath(SESSIONS_DIR, "5");
    expect(marker).toBe(path.join(SESSIONS_DIR, "5.device"));
    expect(extractDeviceMarkerPath(`mullion-device -m ${marker}`)).toBe(marker);
  });

  it("captures a marker path containing a space, unquoted — the empirically-verified difference from DTACH_SOCKET_PATTERN", () => {
    const marker = "/tmp/some sessions with space/5.device";
    expect(extractDeviceMarkerPath(`mullion-device -m ${marker}`)).toBe(marker);
  });

  it("returns null for a description that doesn't match the format at all", () => {
    expect(extractDeviceMarkerPath("dtach -n /tmp/x/5.sock bash -lc foo")).toBeNull();
    expect(extractDeviceMarkerPath("")).toBeNull();
  });

  it("is unanchored at the start — matches even with incidental leading content", () => {
    const marker = deviceMarkerPath(SESSIONS_DIR, "5");
    expect(extractDeviceMarkerPath(`whatever prefix mullion-device -m ${marker}`)).toBe(marker);
  });
});

describe("touchDeviceMarker / removeDeviceMarker", () => {
  it("creates and removes a real, empty marker file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "device-marker-"));
    try {
      touchDeviceMarker(dir, "5");
      const marker = deviceMarkerPath(dir, "5");
      expect(() => removeDeviceMarker(dir, "5")).not.toThrow();
      // removeDeviceMarker is best-effort — calling it again (marker already
      // gone) must not throw either.
      expect(() => removeDeviceMarker(dir, "5")).not.toThrow();
      void marker;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("listOwnedDeviceScopes", () => {
  it("owns an id whose marker resolves directly under sessionsDir", async () => {
    const marker = deviceMarkerPath(SESSIONS_DIR, "5");
    listUnitsReply = [line(`crs-device-${INSTANCE_ID}-5.scope`, `mullion-device -m ${marker}`)];
    const listing = await listOwnedDeviceScopes(SESSIONS_DIR, INSTANCE_ID);
    expect(listing.failed).toBe(false);
    expect(listing.owned.get("5")).toBe(`crs-device-${INSTANCE_ID}-5.scope`);
  });

  it("does not own a marker under a DIFFERENT sessionsDir", async () => {
    listUnitsReply = [
      line(`crs-device-${INSTANCE_ID}-5.scope`, "mullion-device -m /tmp/other-sessions/5.device"),
    ];
    const listing = await listOwnedDeviceScopes(SESSIONS_DIR, INSTANCE_ID);
    expect(listing.owned.has("5")).toBe(false);
  });

  it("marks an id unverifiable when a candidate row's Description doesn't parse", async () => {
    listUnitsReply = [line(`crs-device-${INSTANCE_ID}-5.scope`, "some unrecognized description")];
    const listing = await listOwnedDeviceScopes(SESSIONS_DIR, INSTANCE_ID);
    expect(listing.owned.has("5")).toBe(false);
    expect(listing.unverifiable.has("5")).toBe(true);
  });

  it("resolves failed:true on a listing spawn error", async () => {
    listUnitsShouldError = true;
    const listing = await listOwnedDeviceScopes(SESSIONS_DIR, INSTANCE_ID);
    expect(listing.failed).toBe(true);
    expect(listing.owned.size).toBe(0);
  });

  it("queries the crs-device-* glob, not crs-session-*", async () => {
    await listOwnedDeviceScopes(SESSIONS_DIR, INSTANCE_ID);
    const call = vi.mocked(spawnChildProcess).mock.calls.find((c) => c[0] === "systemctl");
    expect(call?.[1]).toContain("crs-device-*.scope");
  });
});

describe("stopDeviceScope", () => {
  it("resolves the owning unit via the listing, then spawns systemctl --user stop <unit>.scope", async () => {
    const marker = deviceMarkerPath(SESSIONS_DIR, "5");
    listUnitsReply = [line(`crs-device-${INSTANCE_ID}-5.scope`, `mullion-device -m ${marker}`)];
    await stopDeviceScope(SESSIONS_DIR, INSTANCE_ID, "5");
    expect(stopCalls).toEqual([["--user", "stop", `crs-device-${INSTANCE_ID}-5.scope`]]);
  });

  it("does nothing when the listing doesn't claim this id", async () => {
    listUnitsReply = [];
    await stopDeviceScope(SESSIONS_DIR, INSTANCE_ID, "5");
    expect(stopCalls).toEqual([]);
  });

  it("falls back to stopping the namespaced unit name when the listing itself fails", async () => {
    listUnitsShouldError = true;
    await stopDeviceScope(SESSIONS_DIR, INSTANCE_ID, "5");
    expect(stopCalls).toEqual([["--user", "stop", `crs-device-${INSTANCE_ID}-5.scope`]]);
  });

  it("resolves (does not reject) even when the stop spawn itself errors", async () => {
    const marker = deviceMarkerPath(SESSIONS_DIR, "5");
    listUnitsReply = [line(`crs-device-${INSTANCE_ID}-5.scope`, `mullion-device -m ${marker}`)];
    stopShouldError = true;
    await expect(stopDeviceScope(SESSIONS_DIR, INSTANCE_ID, "5")).resolves.toBeUndefined();
  });
});

describe("isDeviceAliveState / isDeviceAliveStateBatch", () => {
  it('resolves "alive" for an id this instance owns and has listed', async () => {
    const marker = deviceMarkerPath(SESSIONS_DIR, "5");
    listUnitsReply = [line(`crs-device-${INSTANCE_ID}-5.scope`, `mullion-device -m ${marker}`)];
    expect(await isDeviceAliveState(SESSIONS_DIR, INSTANCE_ID, "5")).toBe("alive");
  });

  it('resolves "dead" when nothing in the listing claims this id', async () => {
    listUnitsReply = [];
    expect(await isDeviceAliveState(SESSIONS_DIR, INSTANCE_ID, "5")).toBe("dead");
  });

  it('resolves "unknown" for every id when the listing spawn fails, never rejecting', async () => {
    listUnitsShouldError = true;
    const result = await isDeviceAliveStateBatch(SESSIONS_DIR, INSTANCE_ID, ["5", "6"]);
    expect(result).toEqual({ "5": "unknown", "6": "unknown" });
  });

  it("includes every requested id in the result, never omitting one", async () => {
    const marker = deviceMarkerPath(SESSIONS_DIR, "5");
    listUnitsReply = [line(`crs-device-${INSTANCE_ID}-5.scope`, `mullion-device -m ${marker}`)];
    const result = await isDeviceAliveStateBatch(SESSIONS_DIR, INSTANCE_ID, ["5", "6"]);
    expect(result).toEqual({ "5": "alive", "6": "dead" });
  });

  it("resolves an empty record for an empty id list without spawning anything", async () => {
    const result = await isDeviceAliveStateBatch(SESSIONS_DIR, INSTANCE_ID, []);
    expect(result).toEqual({});
    expect(vi.mocked(spawnChildProcess)).not.toHaveBeenCalled();
  });
});

describe("buildDeviceLaunchPlan", () => {
  it("builds a systemd-run argv with the namespaced unit name and marker Description", () => {
    const plan = buildDeviceLaunchPlan({
      id: "5",
      sessionsDir: SESSIONS_DIR,
      emulatorPath: "/opt/android/emulator/emulator",
      avdName: "dev35",
      extraArgs: ["-no-window"],
    });
    const instanceId = deriveInstanceId(SESSIONS_DIR);
    const unitName = deviceScopeUnitName(instanceId, "5");
    expect(plan.unitName).toBe(unitName);
    expect(plan.argv).toEqual([
      "--user",
      "--scope",
      "--collect",
      "-u",
      unitName,
      "--description",
      `mullion-device -m ${deviceMarkerPath(SESSIONS_DIR, "5")}`,
      "--",
      "/opt/android/emulator/emulator",
      "-avd",
      "dev35",
      "-no-window",
    ]);
  });

  it("omits extraArgs entirely when not given", () => {
    const plan = buildDeviceLaunchPlan({
      id: "5",
      sessionsDir: SESSIONS_DIR,
      emulatorPath: "/opt/android/emulator/emulator",
      avdName: "dev35",
    });
    expect(plan.argv.at(-1)).toBe("dev35");
  });
});
