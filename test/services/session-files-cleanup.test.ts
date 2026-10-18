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
        expect.stringContaining("failed to stat candidate tmp dir"),
      );
      statSpy.mockRestore();
    });

    it("logs warning when rm fails on candidate tmp dir", async () => {
      const orphanId = "orphan-rm-fail";
      const orphanDir = sessionTmpDirPath(tmpDir, orphanId);
      fs.mkdirSync(orphanDir, { recursive: true });
      const twoMinutesAgo = new Date(Date.now() - 120_000);
      fs.utimesSync(orphanDir, twoMinutesAgo, twoMinutesAgo);

      const mockLogger: SweepLogger = { warn: vi.fn() };
      const rmSpy = vi.spyOn(fsPromises, "rm").mockRejectedValueOnce(new Error("rm failed"));

      const swept = await sweepOrphanedSessionTmpDirs(tmpDir, (ids) => new Set(ids), {
        log: mockLogger,
      });

      expect(swept).toBe(0);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error), id: orphanId, fullPath: orphanDir }),
        expect.stringContaining("failed to rm candidate tmp dir"),
      );
      rmSpy.mockRestore();
    });
  });
});
