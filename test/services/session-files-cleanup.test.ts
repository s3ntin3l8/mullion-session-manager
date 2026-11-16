import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  sessionTmpDirPath,
  cleanupSessionFiles,
  sweepOrphanedSessionTmpDirs,
  type SweepLogger,
} from "../../src/services/session-files-cleanup.js";

describe("session-files-cleanup", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sessionTmpDirPath constructs the correct path", () => {
    expect(sessionTmpDirPath("/var/sessions", "42")).toBe("/var/sessions/42.tmp");
  });

  it("cleanupSessionFiles removes the session tmp directory along with other files", async () => {
    const sessionId = "123";
    const sessionTmp = sessionTmpDirPath(tmpDir, sessionId);
    fs.mkdirSync(sessionTmp, { recursive: true });
    fs.writeFileSync(path.join(sessionTmp, "scratch.txt"), "hello");

    // Also create some standard session files
    fs.writeFileSync(path.join(tmpDir, `${sessionId}.token`), "token");
    fs.writeFileSync(path.join(tmpDir, `${sessionId}.state.json`), "{}");

    expect(fs.existsSync(sessionTmp)).toBe(true);
    await cleanupSessionFiles(tmpDir, sessionId);

    expect(fs.existsSync(sessionTmp)).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, `${sessionId}.token`))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, `${sessionId}.state.json`))).toBe(false);
  });

  it("cleanupSessionFiles succeeds even if session tmp directory does not exist", async () => {
    await expect(cleanupSessionFiles(tmpDir, "nonexistent")).resolves.not.toThrow();
  });

  describe("sweepOrphanedSessionTmpDirs", () => {
    it("sweeps only confirmed dead sessions older than minAgeMs", async () => {
      const activeId = "active-1";
      const deadId = "orphan-dead";
      const aliveUntrackedId = "orphan-alive-dtach";
      const recentDeadId = "orphan-recent-dead";

      const activeDir = sessionTmpDirPath(tmpDir, activeId);
      const deadDir = sessionTmpDirPath(tmpDir, deadId);
      const aliveDir = sessionTmpDirPath(tmpDir, aliveUntrackedId);
      const recentDir = sessionTmpDirPath(tmpDir, recentDeadId);

      fs.mkdirSync(activeDir, { recursive: true });
      fs.mkdirSync(deadDir, { recursive: true });
      fs.mkdirSync(aliveDir, { recursive: true });
      fs.mkdirSync(recentDir, { recursive: true });

      // Backdate deadDir, aliveDir, and activeDir by 2 minutes
      const twoMinutesAgo = new Date(Date.now() - 120_000);
      fs.utimesSync(deadDir, twoMinutesAgo, twoMinutesAgo);
      fs.utimesSync(aliveDir, twoMinutesAgo, twoMinutesAgo);
      fs.utimesSync(activeDir, twoMinutesAgo, twoMinutesAgo);

      // recentDir has current mtime (< 60s)
      const mockIsDead = vi.fn((ids: string[]) => {
        // aliveUntrackedId is "alive", deadId is "dead"
        return new Set(ids.filter((id) => id === deadId));
      });

      const swept = await sweepOrphanedSessionTmpDirs(
        tmpDir,
        mockIsDead,
        new Set([activeId]),
        60_000,
      );

      expect(swept).toBe(1);
      expect(fs.existsSync(deadDir)).toBe(false);
      expect(fs.existsSync(activeDir)).toBe(true);
      expect(fs.existsSync(aliveDir)).toBe(true); // preserved because it's still alive in dtach!
      expect(fs.existsSync(recentDir)).toBe(true); // preserved because it's recent (< 60s)!

      // Candidate IDs checked for liveness did NOT include activeId or recentDeadId
      expect(mockIsDead).toHaveBeenCalledTimes(1);
      const checkedIds = mockIsDead.mock.calls[0][0];
      expect(checkedIds).toEqual(expect.arrayContaining([deadId, aliveUntrackedId]));
      expect(checkedIds).toHaveLength(2);
    });

    it("ignores non-directory files and directories not matching *.tmp", async () => {
      fs.writeFileSync(path.join(tmpDir, "file.tmp"), "not a dir");
      fs.mkdirSync(path.join(tmpDir, "not-tmp-dir"), { recursive: true });

      const twoMinutesAgo = new Date(Date.now() - 120_000);
      fs.utimesSync(path.join(tmpDir, "file.tmp"), twoMinutesAgo, twoMinutesAgo);
      fs.utimesSync(path.join(tmpDir, "not-tmp-dir"), twoMinutesAgo, twoMinutesAgo);

      const mockIsDead = vi.fn((ids: string[]) => new Set(ids));
      const swept = await sweepOrphanedSessionTmpDirs(tmpDir, mockIsDead, new Set(), 60_000);

      expect(swept).toBe(0);
      expect(mockIsDead).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(tmpDir, "file.tmp"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "not-tmp-dir"))).toBe(true);
    });

    it("logs warning and returns 0 when readdir fails", async () => {
      const mockLogger: SweepLogger = {
        warn: vi.fn(),
      };
      const swept = await sweepOrphanedSessionTmpDirs(
        "/nonexistent/directory/path",
        () => new Set(),
        new Set(),
        60_000,
        mockLogger,
      );
      expect(swept).toBe(0);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it("logs warning when liveness check rejects", async () => {
      const orphanId = "orphan-test";
      const orphanDir = sessionTmpDirPath(tmpDir, orphanId);
      fs.mkdirSync(orphanDir, { recursive: true });
      const twoMinutesAgo = new Date(Date.now() - 120_000);
      fs.utimesSync(orphanDir, twoMinutesAgo, twoMinutesAgo);

      const mockLogger: SweepLogger = {
        warn: vi.fn(),
      };
      const failingIsDead = () => Promise.reject(new Error("liveness check exploded"));

      const swept = await sweepOrphanedSessionTmpDirs(
        tmpDir,
        failingIsDead,
        new Set(),
        60_000,
        mockLogger,
      );
      expect(swept).toBe(0);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining("failed to check session liveness"),
      );
      expect(fs.existsSync(orphanDir)).toBe(true);
    });

    it("logs warning when stat fails on candidate tmp dir", async () => {
      const orphanId = "orphan-stat-fail";
      const orphanDir = sessionTmpDirPath(tmpDir, orphanId);
      fs.mkdirSync(orphanDir, { recursive: true });

      const mockLogger: SweepLogger = { warn: vi.fn() };
      const statSpy = vi
        .spyOn(fsPromises, "stat")
        .mockRejectedValueOnce(new Error("stat permission denied"));

      const swept = await sweepOrphanedSessionTmpDirs(tmpDir, () => new Set(), { log: mockLogger });

      expect(swept).toBe(0);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error), path: orphanDir }),
        expect.stringContaining("failed to stat candidate artifact"),
      );
      statSpy.mockRestore();
    });

    it("sweeps every per-session artifact of a dead session, not just the tmp dir", async () => {
      const old = new Date(Date.now() - 120_000);
      const deadId = "4001";
      const liveId = "4002";
      const files = [".hooks.json", ".mcp.json", ".token", ".state.json", ".agent-guide.md"];
      for (const id of [deadId, liveId]) {
        for (const f of files) fs.writeFileSync(path.join(tmpDir, `${id}${f}`), "x");
        const cfg = path.join(tmpDir, `${id}.opencode-config`);
        fs.mkdirSync(path.join(cfg, "node_modules"), { recursive: true });
        fs.writeFileSync(path.join(cfg, "node_modules", "pkg.js"), "x");
        for (const f of [...files.map((f) => `${id}${f}`), `${id}.opencode-config`]) {
          fs.utimesSync(path.join(tmpDir, f), old, old);
        }
      }
      // Files the sweep must never touch: shared sockets, task files, odd names.
      fs.writeFileSync(path.join(tmpDir, "hooks.sock"), "x");
      fs.writeFileSync(path.join(tmpDir, "task-1.title"), "x");
      fs.mkdirSync(path.join(tmpDir, "4001.token.d"));

      const swept = await sweepOrphanedSessionTmpDirs(
        tmpDir,
        (ids) => new Set(ids.filter((id) => id === deadId)),
        { minAgeMs: 60_000 },
      );

      expect(swept).toBe(1);
      for (const f of files) expect(fs.existsSync(path.join(tmpDir, `${deadId}${f}`))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, `${deadId}.opencode-config`))).toBe(false);
      for (const f of files) expect(fs.existsSync(path.join(tmpDir, `${liveId}${f}`))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, `${liveId}.opencode-config`))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "hooks.sock"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "task-1.title"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "4001.token.d"))).toBe(true);
    });

    it("treats a session as recent when any of its artifacts is recent", async () => {
      const old = new Date(Date.now() - 120_000);
      fs.writeFileSync(path.join(tmpDir, "4003.hooks.json"), "x");
      fs.utimesSync(path.join(tmpDir, "4003.hooks.json"), old, old);
      fs.writeFileSync(path.join(tmpDir, "4003.state.json"), "x"); // fresh mtime

      const isDead = vi.fn((ids: string[]) => new Set(ids));
      const swept = await sweepOrphanedSessionTmpDirs(tmpDir, isDead, { minAgeMs: 60_000 });

      expect(swept).toBe(0);
      expect(isDead).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(tmpDir, "4003.hooks.json"))).toBe(true);
    });

    it("cleanupSessionFiles removes the claude hooks and mcp config files", async () => {
      fs.writeFileSync(path.join(tmpDir, "9.hooks.json"), "{}");
      fs.writeFileSync(path.join(tmpDir, "9.mcp.json"), "{}");
      await cleanupSessionFiles(tmpDir, "9");
      expect(fs.existsSync(path.join(tmpDir, "9.hooks.json"))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, "9.mcp.json"))).toBe(false);
    });

    it("removes the composed bundle dir and the dead master's socket, only in the sweep", async () => {
      const old = new Date(Date.now() - 120_000);
      const bundle = path.join(tmpDir, "4005.mullion-bundle");
      fs.mkdirSync(path.join(bundle, "skills"), { recursive: true });
      fs.writeFileSync(path.join(bundle, "skills", "SKILL.md"), "x");
      fs.utimesSync(bundle, old, old);
      fs.writeFileSync(path.join(tmpDir, "4005.sock"), "stale");
      fs.writeFileSync(path.join(tmpDir, "4006.sock"), "other session");
      fs.writeFileSync(path.join(tmpDir, "4007.mullion-bundle.d"), "unrelated file");

      const swept = await sweepOrphanedSessionTmpDirs(tmpDir, (ids) => new Set(ids), {
        minAgeMs: 60_000,
      });

      expect(swept).toBe(1);
      expect(fs.existsSync(bundle)).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, "4005.sock"))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, "4006.sock"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "4007.mullion-bundle.d"))).toBe(true);

      // terminate() reaches cleanupSessionFiles, which must leave the socket alone.
      fs.writeFileSync(path.join(tmpDir, "4008.sock"), "live master");
      await cleanupSessionFiles(tmpDir, "4008");
      expect(fs.existsSync(path.join(tmpDir, "4008.sock"))).toBe(true);
    });

    it("does not count a session whose file could not be removed, and retries it", async () => {
      const old = new Date(Date.now() - 120_000);
      const orphanDir = sessionTmpDirPath(tmpDir, "4004");
      fs.mkdirSync(orphanDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "4004.mcp.json"), "x");
      fs.utimesSync(orphanDir, old, old);
      fs.utimesSync(path.join(tmpDir, "4004.mcp.json"), old, old);

      const realRm = fsPromises.rm.bind(fsPromises);
      const rmSpy = vi.spyOn(fsPromises, "rm").mockImplementation(async (target, opts) => {
        if (String(target) === orphanDir) throw new Error("rm failed");
        return realRm(target, opts);
      });
      const mockLogger: SweepLogger = { warn: vi.fn() };
      const first = await sweepOrphanedSessionTmpDirs(tmpDir, (ids) => new Set(ids), {
        minAgeMs: 60_000,
        log: mockLogger,
      });
      rmSpy.mockRestore();

      expect(first).toBe(0); // the other file went, but the session is not clean
      expect(fs.existsSync(path.join(tmpDir, "4004.mcp.json"))).toBe(false);
      expect(fs.existsSync(orphanDir)).toBe(true);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ stuck: 1 }),
        expect.stringContaining("could not be removed"),
      );

      const second = await sweepOrphanedSessionTmpDirs(tmpDir, (ids) => new Set(ids), {
        minAgeMs: 60_000,
      });
      expect(second).toBe(1);
      expect(fs.existsSync(orphanDir)).toBe(false);
    });
  });
});
