import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  sessionTmpDirPath,
  cleanupSessionFiles,
  sweepOrphanedSessionTmpDirs,
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
    it("sweeps orphaned tmp directories older than minAgeMs whose session is not active", async () => {
      const activeId = "active-1";
      const orphanOldId = "orphan-old";
      const orphanRecentId = "orphan-recent";

      const activeDir = sessionTmpDirPath(tmpDir, activeId);
      const orphanOldDir = sessionTmpDirPath(tmpDir, orphanOldId);
      const orphanRecentDir = sessionTmpDirPath(tmpDir, orphanRecentId);

      fs.mkdirSync(activeDir, { recursive: true });
      fs.mkdirSync(orphanOldDir, { recursive: true });
      fs.mkdirSync(orphanRecentDir, { recursive: true });

      // Backdate orphanOldDir and activeDir by 2 minutes
      const twoMinutesAgo = new Date(Date.now() - 120_000);
      fs.utimesSync(orphanOldDir, twoMinutesAgo, twoMinutesAgo);
      fs.utimesSync(activeDir, twoMinutesAgo, twoMinutesAgo);

      // orphanRecentDir has current mtime (< 60s)
      const swept = await sweepOrphanedSessionTmpDirs(tmpDir, new Set([activeId]), 60_000);

      expect(swept).toBe(1);
      expect(fs.existsSync(orphanOldDir)).toBe(false);
      expect(fs.existsSync(activeDir)).toBe(true);
      expect(fs.existsSync(orphanRecentDir)).toBe(true);
    });

    it("ignores non-directory files and directories not matching *.tmp", async () => {
      fs.writeFileSync(path.join(tmpDir, "file.tmp"), "not a dir");
      fs.mkdirSync(path.join(tmpDir, "not-tmp-dir"), { recursive: true });

      const twoMinutesAgo = new Date(Date.now() - 120_000);
      fs.utimesSync(path.join(tmpDir, "file.tmp"), twoMinutesAgo, twoMinutesAgo);
      fs.utimesSync(path.join(tmpDir, "not-tmp-dir"), twoMinutesAgo, twoMinutesAgo);

      const swept = await sweepOrphanedSessionTmpDirs(tmpDir, new Set(), 60_000);
      expect(swept).toBe(0);
      expect(fs.existsSync(path.join(tmpDir, "file.tmp"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "not-tmp-dir"))).toBe(true);
    });

    it("handles non-existent or inaccessible directory gracefully", async () => {
      const swept = await sweepOrphanedSessionTmpDirs("/nonexistent/path", new Set());
      expect(swept).toBe(0);
    });
  });
});
