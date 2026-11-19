// PtyManager scope probes — isMasterAlive(State|Batch), the macOS local scope, and the per-session process inventory.
//
// Split out of the former test/services/pty-manager.test.ts (issue #3277) —
// that file sat at the file-size ratchet's ceiling, so a change here could no
// longer land next to the tests it belongs with. The shared mock preamble and
// helpers live in test/helpers/pty-manager-harness.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  bundleSyncMock,
  cgroupInventoryMock,
  childProcessMock,
  createPtyManagerFixture,
  destroyPtyManagerFixture,
  nodePtyMock,
  ownedLine,
  resetPtyManagerMocks,
  scopeLine,
  scopeMocks,
} from "../helpers/pty-manager-harness.js";
import { spawn as spawnChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { deriveInstanceId } from "../../src/services/session-process.js";

vi.mock("node-pty", () => nodePtyMock());
vi.mock("../../src/services/bundle-sync.js", () => bundleSyncMock());
vi.mock("node:child_process", async (importOriginal) => childProcessMock(await importOriginal()));
vi.mock("../../src/services/cgroup-inventory.js", () => cgroupInventoryMock());

const { PtyManager } = await import("../../src/services/pty-manager.js");
const { listScopeProcesses } = await import("../../src/services/cgroup-inventory.js");

describe("PtyManager", () => {
  let sessionsDir: string;
  let manager: InstanceType<typeof PtyManager>;

  beforeEach(() => {
    // Every test starts from a clean slate: no fake PTYs, no `systemctl`
    // fixtures and no cgroup-inventory call log left over from a sibling.
    resetPtyManagerMocks();
    ({ sessionsDir, manager } = createPtyManagerFixture(PtyManager));
  });

  afterEach(async () => {
    await destroyPtyManagerFixture({ sessionsDir, manager });
  });

  describe("isMasterAliveState", () => {
    it('resolves "alive" when this instance\'s scope for the id is owned and listed', async () => {
      scopeMocks.listUnitsReply = [ownedLine("1", sessionsDir)];
      await expect(manager.isMasterAliveState("1")).resolves.toBe("alive");
      // A single list-units spawn, not a per-unit is-active spawn — issue
      // #1140 (PR 1): isMasterAliveState is now a thin wrapper over
      // isMasterAliveStateBatch, which needs the same ownership-by-socket-path
      // listing either way. See session-process.test.ts for the dedicated,
      // exhaustive coverage of this; these tests just confirm PtyManager's
      // own delegating method threads sessionsDir/instanceId through.
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

    it('resolves "dead" when nothing in the listing claims this id', async () => {
      scopeMocks.listUnitsReply = [];
      await expect(manager.isMasterAliveState("1")).resolves.toBe("dead");
    });

    it('resolves "dead" when a same-named scope belongs to a different instance\'s sessionsDir', async () => {
      scopeMocks.listUnitsReply = [ownedLine("1", "/some/other/instances/sessions")];
      await expect(manager.isMasterAliveState("1")).resolves.toBe("dead");
    });

    it('resolves "unknown", never rejects, even if the probe itself fails to spawn', async () => {
      vi.mocked(spawnChildProcess).mockImplementationOnce(() => {
        const ee = new EventEmitter();
        setImmediate(() => ee.emit("error", new Error("ENOENT")));
        return ee as unknown as ReturnType<typeof spawnChildProcess>;
      });
      await expect(manager.isMasterAliveState("1")).resolves.toBe("unknown");
    });

    // Issue #1715 — a backend's batch answer is contractually TOTAL (every
    // requested id is always present), but that is now a TRUST BOUNDARY: the
    // answer comes from a ScopeBackend implementation, not from the function
    // this module used to call directly. The systemd backend is total by
    // construction, so only a stub can produce the omission — and the guard
    // has to be pinned by one, because an omitted id that read as anything
    // other than "unknown" would fall through BOTH guards in
    // routes/project-docker.ts's startStackSession conflict check and land in its
    // "confirmed dead" branch, which marks a live session exited and
    // orphans its scope for good.
    it('resolves "unknown" for an id the backend\'s answer omits', async () => {
      const stubScope = {
        kind: "stub",
        start: vi.fn(async () => undefined),
        // Omits every id — the contract violation this guard exists for.
        isAliveBatch: vi.fn(async () => Object.create(null)),
        stop: vi.fn(async () => undefined),
        listProcesses: vi.fn(async () => []),
      };
      const stubManager = new PtyManager({ sessionsDir, scope: stubScope });
      try {
        await expect(stubManager.isMasterAliveState("1")).resolves.toBe("unknown");
      } finally {
        stubManager.killAll();
      }
    });
  });

  // Issue #1720 (roadmap 8.6) — a macOS PRIMARY's local sessions.
  //
  // The dogfooding #1720 asks to verify: on a Mac acting as the PRIMARY, a
  // LOCAL session runs under the darwin (detached/dtach) backend — the same
  // backend an agent's sessions use. The local path is PtyManager's own
  // scope, resolved from the HOST's platform by getScopeBackend(); there is
  // no separate "primary" backend.
  describe("a macOS primary's local session scope", () => {
    /** Runs the body with process.platform stubbed — the same technique
     *  test/services/scope.test.ts uses for its own darwin case. */
    async function withPlatform<T>(platform: NodeJS.Platform, body: () => Promise<T>): Promise<T> {
      const original = process.platform;
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      try {
        return await body();
      } finally {
        Object.defineProperty(process, "platform", { value: original, configurable: true });
      }
    }

    it("resolves the local scope through the PLATFORM, not a fixed backend", async () => {
      await withPlatform("freebsd", async () => {
        // A platform with no backend has no way to run a local session at
        // all, and says so plainly — which is only observable if the local
        // path really does go through getScopeBackend().
        const bsdManager = new PtyManager({ sessionsDir });
        try {
          await expect(bsdManager.isMasterAliveStateBatch(["1"])).rejects.toThrow(
            /no scope backend for platform "freebsd"/,
          );
        } finally {
          bsdManager.killAll();
        }
      });
    });

    it("resolves a usable scope on darwin — the primary boots and its local sessions run", async () => {
      await withPlatform("darwin", async () => {
        const macManager = new PtyManager({ sessionsDir });
        try {
          // The detached backend's answer is a TOTAL map — every requested id
          // is present — so this resolves rather than rejecting. (The
          // socket itself is not there, so the answer is "dead"/"unknown";
          // what matters here is that the darwin backend was SELECTED and
          // answered, instead of the app refusing to run a local session.)
          const state = await macManager.isMasterAliveStateBatch(["1"]);
          expect(Object.keys(state)).toEqual(["1"]);
          expect(["alive", "dead", "unknown"]).toContain(state["1"]);
        } finally {
          macManager.killAll();
        }
      });
    });

    it("keeps the local scope resolution LAZY — a Mac with only remote agents still boots", async () => {
      await withPlatform("darwin", async () => {
        // Constructing the manager must not touch the scope at all: a macOS
        // primary whose sessions all run on remote Linux agents never needs
        // a local scope backend, and refusing to start would make that
        // topology impossible (pty-manager.ts's own `scope` getter comment).
        const macManager = new PtyManager({ sessionsDir });
        expect(() =>
          macManager.getOrCreate({
            id: "1",
            cwd: "/tmp",
            command: "bash",
            cols: 80,
            rows: 24,
            env: {},
          }),
        ).not.toThrow();
        macManager.killAll();
      });
    });
  });

  // Issue #1715 — the process inventory goes through the scope backend like
  // every other scope operation. The inventory itself is a best-effort,
  // Linux-only probe (cgroup v2 + /proc), so on a host that can't answer it
  // the contract is an empty list — never an error.
  describe("listSessionProcesses", () => {
    it("reads the inventory from the OWNING scope's unit, not from a guess", async () => {
      const unit = `crs-session-${deriveInstanceId(sessionsDir)}-1.scope`;
      scopeMocks.listUnitsReply = [
        scopeLine(unit, `/usr/bin/dtach -n ${sessionsDir}/1.sock /usr/bin/zsh -lc bash`),
      ];
      await manager.listSessionProcesses("1");
      expect(vi.mocked(listScopeProcesses)).toHaveBeenCalledWith(unit);
    });

    it("resolves an empty list for an id this instance does not own, reading no cgroup at all", async () => {
      scopeMocks.listUnitsReply = [];
      await expect(manager.listSessionProcesses("1")).resolves.toEqual([]);
      expect(vi.mocked(listScopeProcesses)).not.toHaveBeenCalled();
    });
  });

  // Issue #1265 — the TOTAL tri-state batch primitive: every requested id
  // always present in the result. isMasterAliveState above and
  // isMasterAliveBatch below (the boolean wire adapter) are both thin reads
  // off this.
  describe("isMasterAliveStateBatch", () => {
    it("includes every requested id, resolving the right state for each", async () => {
      scopeMocks.listUnitsReply = [ownedLine("1", sessionsDir), ownedLine("3", sessionsDir)];
      await expect(manager.isMasterAliveStateBatch(["1", "2", "3"])).resolves.toEqual({
        "1": "alive",
        "2": "dead",
        "3": "alive",
      });
    });

    it("resolves an empty record for an empty id list without spawning anything", async () => {
      vi.mocked(spawnChildProcess).mockClear();
      await expect(manager.isMasterAliveStateBatch([])).resolves.toEqual({});
      expect(vi.mocked(spawnChildProcess)).not.toHaveBeenCalled();
    });

    it('resolves "unknown" for every requested id (not "dead") when the spawn itself fails', async () => {
      vi.mocked(spawnChildProcess).mockImplementationOnce(() => {
        const ee = new EventEmitter();
        setImmediate(() => ee.emit("error", new Error("ENOENT")));
        return ee as unknown as ReturnType<typeof spawnChildProcess>;
      });
      await expect(manager.isMasterAliveStateBatch(["1", "2"])).resolves.toEqual({
        "1": "unknown",
        "2": "unknown",
      });
    });
  });

  // Perf audit finding B8(2) — wire-format adapter only (issue #1265): the
  // boolean-with-omitted-keys shape `/internal/sessions/liveness` needs.
  // Every other caller should use isMasterAliveStateBatch above instead.
  describe("isMasterAliveBatch", () => {
    it("resolves true only for ids whose scope this instance owns", async () => {
      scopeMocks.listUnitsReply = [ownedLine("1", sessionsDir), ownedLine("3", sessionsDir)];
      await expect(manager.isMasterAliveBatch(["1", "2", "3"])).resolves.toEqual({
        "1": true,
        "2": false,
        "3": true,
      });
    });

    it("spawns exactly one systemctl call for the whole batch, not one per id", async () => {
      scopeMocks.listUnitsReply = [ownedLine("1", sessionsDir), ownedLine("2", sessionsDir)];
      vi.mocked(spawnChildProcess).mockClear();
      await manager.isMasterAliveBatch(["1", "2", "3", "4", "5"]);
      expect(vi.mocked(spawnChildProcess)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(spawnChildProcess)).toHaveBeenCalledWith(
        "systemctl",
        [
          "--user",
          "list-units",
          "--type=scope",
          // Issue #988 — widened alongside "active"; see
          // session-process.test.ts for the dedicated coverage of why.
          "--state=active,deactivating",
          "--no-legend",
          "--plain",
          "crs-session-*.scope",
        ],
        expect.objectContaining({ stdio: ["ignore", "pipe", "ignore"] }),
      );
    });

    it("resolves an empty record for an empty id list without spawning anything", async () => {
      vi.mocked(spawnChildProcess).mockClear();
      await expect(manager.isMasterAliveBatch([])).resolves.toEqual({});
      expect(vi.mocked(spawnChildProcess)).not.toHaveBeenCalled();
    });

    it("resolves every id false when nothing is active", async () => {
      scopeMocks.listUnitsReply = [];
      await expect(manager.isMasterAliveBatch(["1", "2"])).resolves.toEqual({
        "1": false,
        "2": false,
      });
    });

    // Trust rule (see isMasterAliveBatch's own doc comment) — a spawn
    // failure means "unknown," not "confirmed not alive": resolving with
    // false for every id would tell session-reconciler.ts to mass-exit
    // every active session on a single transient systemctl error. An empty
    // record hits the reconciler's own "host omitted liveness, skip"
    // branch instead (the same one that already protects the
    // remote-host/partial-response case).
    it("resolves an empty record (not all-false) when the spawn itself fails", async () => {
      vi.mocked(spawnChildProcess).mockImplementationOnce(() => {
        const ee = new EventEmitter();
        setImmediate(() => ee.emit("error", new Error("ENOENT")));
        return ee as unknown as ReturnType<typeof spawnChildProcess>;
      });
      await expect(manager.isMasterAliveBatch(["1", "2"])).resolves.toEqual({});
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
      await expect(manager.isMasterAliveBatch(["1", "2"])).resolves.toEqual({});
    });
  });
});
