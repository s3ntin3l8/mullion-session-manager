// PtyManager sockets — the hook socket's shared path and per-session tokens, and the control socket path.
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
  resetPtyManagerMocks,
  waitForSpawn,
} from "../helpers/pty-manager-harness.js";
import { spawn as spawnChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

vi.mock("node-pty", () => nodePtyMock());
vi.mock("../../src/services/bundle-sync.js", () => bundleSyncMock());
vi.mock("node:child_process", async (importOriginal) => childProcessMock(await importOriginal()));
vi.mock("../../src/services/cgroup-inventory.js", () => cgroupInventoryMock());

const { PtyManager } = await import("../../src/services/pty-manager.js");

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

  describe("hook socket (issue #172)", () => {
    it("exposes one shared hookSocketPath under sessionsDir", () => {
      expect(manager.hookSocketPath).toBe(path.join(sessionsDir, "hooks.sock"));
    });

    it("gives each session its own hookToken", async () => {
      const a = manager.getOrCreate({ id: "1", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
      const b = manager.getOrCreate({ id: "2", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
      await waitForSpawn(a);
      await waitForSpawn(b);

      expect(a.hookToken).toEqual(expect.any(String));
      expect(a.hookToken.length).toBeGreaterThan(0);
      expect(a.hookToken).not.toBe(b.hookToken);
      // Every session shares the same socket path — only the token
      // disambiguates messages on it.
      expect(a.hookSocketPath).toBe(manager.hookSocketPath);
      expect(b.hookSocketPath).toBe(manager.hookSocketPath);
    });

    it("injects MULLION_HOOK_SOCKET/MULLION_HOOK_TOKEN, MULLION_SOCKET_PATH, and MULLION_SESSION_ID into the master bootstrap env", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      expect(vi.mocked(spawnChildProcess)).toHaveBeenCalledWith(
        "systemd-run",
        expect.arrayContaining(["dtach", "-n", expect.any(String)]),
        expect.objectContaining({
          cwd: "/tmp",
          env: expect.objectContaining({
            MULLION_HOOK_SOCKET: manager.hookSocketPath,
            MULLION_HOOK_TOKEN: session.hookToken,
            MULLION_SOCKET_PATH: manager.controlSocketPath,
            MULLION_SESSION_ID: "1",
          }),
          stdio: "ignore",
        }),
      );
    });

    it("resolveToken() resolves a live session's token to its id", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      expect(manager.resolveToken(session.hookToken)).toBe("1");
    });

    it("resolveToken() returns undefined for an unknown/forged token", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      expect(manager.resolveToken("not-a-real-token")).toBeUndefined();
      // Same length as a real token but wrong content — exercises the
      // timingSafeTokenMatch path rather than the length-mismatch fast-path.
      expect(manager.resolveToken("0".repeat(session.hookToken.length))).toBeUndefined();
    });

    it("resolveToken() no longer resolves a token once its session is killed", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      const token = session.hookToken;

      manager.kill("1");

      expect(manager.resolveToken(token)).toBeUndefined();
    });

    it("a respawned session (after kill/detach) keeps the SAME token — kill() only detaches, the dtach master + its already-baked-in env survive", async () => {
      const first = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(first);
      const oldToken = first.hookToken;

      manager.kill("1");
      const second = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(second);

      // Issue: worktree/branch detection — the surviving dtach master's
      // agent process still holds `oldToken` in its env; if a reattach
      // minted a different one, every hook message it ever sends again
      // would be rejected. See loadOrCreateHookToken()'s doc comment.
      expect(second.hookToken).toBe(oldToken);
      expect(manager.resolveToken(second.hookToken)).toBe("1");
    });

    it("persists the token to <id>.token under sessionsDir, and a brand-new PtyManager pointed at the same directory adopts it (simulates a Mullion process restart)", async () => {
      const first = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(first);

      const tokenFile = path.join(sessionsDir, "1.token");
      expect(fs.readFileSync(tokenFile, "utf8").trim()).toBe(first.hookToken);

      // A fresh PtyManager, in a fresh process's memory, pointed at the
      // same on-disk sessionsDir — exactly what happens across a restart,
      // since dtach masters and their env are outside this process.
      const restarted = new PtyManager({ sessionsDir });
      const reattached = restarted.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(reattached);

      expect(reattached.hookToken).toBe(first.hookToken);
      expect(restarted.resolveToken(first.hookToken)).toBe("1");
    });

    it("replaces a corrupt/malformed token file rather than adopting it", async () => {
      // sessionsDir already exists — created by mkdtempSync above, and
      // again (idempotently) by PtyManager's own constructor.
      const tokenFile = path.join(sessionsDir, "1.token");
      fs.writeFileSync(tokenFile, "not-a-valid-hex-token");

      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      expect(session.hookToken).not.toBe("not-a-valid-hex-token");
      expect(session.hookToken).toMatch(/^[0-9a-f]{48}$/);
      // The corrupt file is overwritten with the freshly minted, valid one.
      expect(fs.readFileSync(tokenFile, "utf8").trim()).toBe(session.hookToken);
    });

    it("terminate() deletes the persisted token file, so a future spawn for the same id gets a fresh token", async () => {
      const first = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(first);
      const oldToken = first.hookToken;
      const tokenFile = path.join(sessionsDir, "1.token");
      expect(fs.existsSync(tokenFile)).toBe(true);

      await manager.terminate("1");
      expect(fs.existsSync(tokenFile)).toBe(false);

      const second = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(second);

      expect(second.hookToken).not.toBe(oldToken);
      expect(manager.resolveToken(oldToken)).toBeUndefined();
      expect(manager.resolveToken(second.hookToken)).toBe("1");
    });
  });

  describe("control socket (issue #185)", () => {
    it("derives controlSocketPath under sessionsDir, alongside hookSocketPath", () => {
      expect(manager.controlSocketPath).toBe(path.join(sessionsDir, "mullion.sock"));
      expect(manager.controlSocketPath).not.toBe(manager.hookSocketPath);
    });

    it("resolves an explicit controlSocketPath override (MULLION_SOCKET_PATH)", () => {
      const overridden = new PtyManager({
        sessionsDir,
        controlSocketPath: path.join(sessionsDir, "custom.sock"),
      });
      expect(overridden.controlSocketPath).toBe(path.join(sessionsDir, "custom.sock"));
    });

    it("resolves a relative controlSocketPath override against the process cwd", () => {
      const overridden = new PtyManager({ sessionsDir, controlSocketPath: "relative.sock" });
      expect(overridden.controlSocketPath).toBe(path.resolve("relative.sock"));
    });

    it("takes a named-pipe override as given instead of resolving it as a file path (issue #1728)", () => {
      const pipe = "\\\\.\\pipe\\operator-chosen";
      const overridden = new PtyManager({ sessionsDir, controlSocketPath: pipe });
      expect(overridden.controlSocketPath).toBe(pipe);
    });

    it("exposes the sessions dir itself, so no caller has to derive it from a socket path", () => {
      expect(manager.sessionsDir).toBe(sessionsDir);
    });
  });
});
