// PtyManager dev-server detection (issue #404) — the once-per-(session,port) dedup, accept and dismiss.
//
// Split out of the former test/services/pty-manager.test.ts (issue #3277) —
// that file sat at the file-size ratchet's ceiling, so a change here could no
// longer land next to the tests it belongs with. The shared mock preamble and
// helpers live in test/helpers/pty-manager-harness.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  bundleSyncMock,
  cgroupInventoryMock,
  childProcessMock,
  createPtyManagerFixture,
  destroyPtyManagerFixture,
  fakePtyChildren,
  nodePtyMock,
  resetPtyManagerMocks,
  waitForSpawn,
} from "../helpers/pty-manager-harness.js";

vi.mock("node-pty", () => nodePtyMock());
vi.mock("../../src/services/bundle-sync.js", () => bundleSyncMock());
vi.mock("node:child_process", async (importOriginal) => childProcessMock(await importOriginal()));
vi.mock("../../src/services/cgroup-inventory.js", () => cgroupInventoryMock());

const { PtyManager } = await import("../../src/services/pty-manager.js");

// Issue #404 — the plain-session dev-server detection/dedup/accept/dismiss
// logic, unit-tested directly against Session/PtyManager rather than only
// through an integration test (see the issue's own requirement that the
// once-per-(session,port) dedup and dismiss-suppression behavior get real
// coverage, not just "the route returns 200"). The actual throttle (how
// often this gets CALLED at all) is a fixed interval constant in
// src/plugins/pty.ts, outside PtyManager/Session entirely — see that file's
// DEV_SERVER_DETECT_INTERVAL_MS comment for why detection couldn't live in
// Session.tick()'s own 500ms loop (no settings/DB access there).
describe("PtyManager dev-server detection (issue #404)", () => {
  let sessionsDir: string;
  let manager: InstanceType<typeof PtyManager>;

  beforeEach(() => {
    // The shared harness's reset, so this file starts each test from the
    // same clean slate as its siblings: no fake PTYs, no `systemctl`
    // fixtures and no cgroup-inventory call log left over from a sibling.
    resetPtyManagerMocks();
    ({ sessionsDir, manager } = createPtyManagerFixture(PtyManager, "pty-manager-devserver-test-"));
  });

  afterEach(async () => {
    await destroyPtyManagerFixture({ sessionsDir, manager });
  });

  const VITE_BANNER = "  ➜  Local:   http://localhost:5173/\n";
  const VITE_BANNER_RESTART = "  ➜  Local:   http://localhost:5174/\n";

  describe("Session.detectDevServerPort", () => {
    it("returns null when no banner has appeared yet", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.detectDevServerPort(1)).toBeNull();
    });

    it("returns the port and emits a dev_server_detected event on first detection", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      fakePtyChildren[0].emitData(VITE_BANNER);

      expect(session.detectDevServerPort(7)).toBe("5173");
      expect(session.toInfo().pendingDevServerPort).toBe("5173");

      const events = session.getEvents();
      const detected = events.find((e) => e.kind === "dev_server_detected");
      expect(detected?.payload).toEqual({ port: "5173", projectId: 7 });
    });

    it("does not re-emit for the SAME port on a second call (once per (session, port))", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      fakePtyChildren[0].emitData(VITE_BANNER);

      expect(session.detectDevServerPort(1)).toBe("5173");
      // A re-printed banner for the SAME port (e.g. a restart that happens
      // to land back on the same port) — still must not re-offer.
      fakePtyChildren[0].emitData(VITE_BANNER);
      expect(session.detectDevServerPort(1)).toBeNull();
      expect(session.getEvents().filter((e) => e.kind === "dev_server_detected")).toHaveLength(1);
    });

    it("DOES re-offer a genuinely different port (a restart that lands on a new port)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      fakePtyChildren[0].emitData(VITE_BANNER);
      expect(session.detectDevServerPort(1)).toBe("5173");

      fakePtyChildren[0].emitData(VITE_BANNER_RESTART);
      expect(session.detectDevServerPort(1)).toBe("5174");
      expect(session.toInfo().pendingDevServerPort).toBe("5174");
    });
  });

  describe("Session.acceptDevServerPort / dismissDevServerPort", () => {
    it("accept returns false when nothing is pending", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.acceptDevServerPort("5173")).toBe(false);
    });

    it("accept returns false for a stale/mismatched port", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      fakePtyChildren[0].emitData(VITE_BANNER);
      session.detectDevServerPort(1);

      expect(session.acceptDevServerPort("9999")).toBe(false);
      // The real pending port is untouched by the failed attempt.
      expect(session.toInfo().pendingDevServerPort).toBe("5173");
    });

    it("accept clears pendingDevServerPort and emits an 'accepted' follow-up event", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
        projectId: 1,
      });
      await waitForSpawn(session);
      fakePtyChildren[0].emitData(VITE_BANNER);
      session.detectDevServerPort(1);

      expect(session.acceptDevServerPort("5173")).toBe(true);
      expect(session.toInfo().pendingDevServerPort).toBeNull();

      const events = session.getEvents().filter((e) => e.kind === "dev_server_detected");
      expect(events).toHaveLength(2);
      expect(events[1].payload).toEqual({ port: "5173", projectId: 1, state: "accepted" });
    });

    it("dismiss clears pendingDevServerPort, emits a 'dismissed' event, and suppresses re-offering the SAME port", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
        projectId: 1,
      });
      await waitForSpawn(session);
      fakePtyChildren[0].emitData(VITE_BANNER);
      session.detectDevServerPort(1);

      expect(session.dismissDevServerPort("5173")).toBe(true);
      expect(session.toInfo().pendingDevServerPort).toBeNull();

      const events = session.getEvents().filter((e) => e.kind === "dev_server_detected");
      expect(events).toHaveLength(2);
      expect(events[1].payload).toEqual({ port: "5173", projectId: 1, state: "dismissed" });

      // The banner re-prints (e.g. the dev server's own periodic recompile
      // log noise mentions "Local" again) — must NOT re-offer after a
      // dismiss for the same (session, port).
      fakePtyChildren[0].emitData(VITE_BANNER);
      expect(session.detectDevServerPort(1)).toBeNull();
    });

    it("dismiss returns false when the port doesn't match what's pending", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      fakePtyChildren[0].emitData(VITE_BANNER);
      session.detectDevServerPort(1);

      expect(session.dismissDevServerPort("9999")).toBe(false);
      expect(session.toInfo().pendingDevServerPort).toBe("5173");
    });
  });

  describe("PtyManager.sweepDevServerDetection", () => {
    it("only scans sessions present in the eligible map, skipping unknown ids", async () => {
      const s1 = manager.getOrCreate({ id: "1", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
      const s2 = manager.getOrCreate({ id: "2", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
      await waitForSpawn(s1);
      await waitForSpawn(s2);
      fakePtyChildren[0].emitData(VITE_BANNER);
      fakePtyChildren[1].emitData(VITE_BANNER);

      // "2" is eligible (per the caller's DB-derived map); "1" and "999"
      // (untracked) are not — only "2" should be scanned/detected.
      const detected = manager.sweepDevServerDetection(new Map([["2", 3]]));

      expect(detected).toEqual([{ sessionId: "2", port: "5173" }]);
      expect(s1.toInfo().pendingDevServerPort).toBeNull();
      expect(s2.toInfo().pendingDevServerPort).toBe("5173");
    });

    it("returns an empty array when nothing eligible has a banner yet", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(manager.sweepDevServerDetection(new Map([["1", 1]]))).toEqual([]);
    });
  });

  describe("PtyManager.acceptDevServerPort / dismissDevServerPort", () => {
    it("returns false for an id this process isn't tracking", () => {
      expect(manager.acceptDevServerPort("999", "5173")).toBe(false);
      expect(manager.dismissDevServerPort("999", "5173")).toBe(false);
    });

    it("delegates to the tracked session", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      fakePtyChildren[0].emitData(VITE_BANNER);
      manager.sweepDevServerDetection(new Map([["1", 1]]));

      expect(manager.acceptDevServerPort("1", "5173")).toBe(true);
      expect(session.toInfo().pendingDevServerPort).toBeNull();
    });
  });
});
