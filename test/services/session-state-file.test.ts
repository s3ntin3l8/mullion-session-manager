import { describe, it, expect, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  mkdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStateFile, stateFilePath } from "../../src/services/session-state-file.js";

// This module owns only the generic, session-shape-agnostic mechanics of
// `<sessionsDir>/<id>.state.json` persistence (issue #323) — path
// resolution, schema-version parsing, debounced+ceiling-timed write
// scheduling, and atomic (tmp+rename) writes. It is intentionally tested
// here against a tiny fake `TState` (`{ n: number }`) rather than Session's
// real ~20-field `StoredStateFields` — that decoupling is the whole point of
// making the class generic. The state-file BEHAVIOR tests that exercise the
// real Session shape (restore-on-construction, A8 kill()/terminate()
// lifecycle, the 30s ceiling under continuous churn, etc.) already live in
// pty-manager.test.ts and are unchanged by this extraction — see this PR's
// description.

type FakeState = { n: number };

function makeFile(dir: string, id = "1") {
  return {
    filePath: stateFilePath(dir, id),
    tmpPath: stateFilePath(dir, id) + ".tmp",
  };
}

describe("stateFilePath", () => {
  it("joins sessionsDir and id with the .state.json suffix", () => {
    expect(stateFilePath("/tmp/sessions", "42")).toBe(path.join("/tmp/sessions", "42.state.json"));
  });
});

describe("SessionStateFile", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("read() returns null (not throw) when the file doesn't exist yet (ENOENT)", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-state-file-"));
    const { filePath } = makeFile(dir);
    const sf = new SessionStateFile<FakeState>(filePath, () => ({
      v: 1,
      launchedAtVersion: "1.0.0",
      state: { n: 0 },
    }));

    expect(sf.read()).toBeNull();
  });

  it("read() calls onCorrupt and returns null for invalid JSON, without throwing", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-state-file-"));
    const { filePath } = makeFile(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, "not valid json");

    const onCorrupt = vi.fn();
    const sf = new SessionStateFile<FakeState>(
      filePath,
      () => ({ v: 1, launchedAtVersion: "1.0.0", state: { n: 0 } }),
      onCorrupt,
    );

    expect(sf.read()).toBeNull();
    expect(onCorrupt).toHaveBeenCalledTimes(1);
  });

  it("read() returns null (silently, no onCorrupt) for a schema-version mismatch", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-state-file-"));
    const { filePath } = makeFile(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, JSON.stringify({ v: 2, state: { n: 1 } }));

    const onCorrupt = vi.fn();
    const sf = new SessionStateFile<FakeState>(
      filePath,
      () => ({ v: 1, launchedAtVersion: "1.0.0", state: { n: 0 } }),
      onCorrupt,
    );

    expect(sf.read()).toBeNull();
    expect(onCorrupt).not.toHaveBeenCalled();
  });

  it("read() returns the parsed payload for a well-formed v1 file", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-state-file-"));
    const { filePath } = makeFile(dir);
    mkdirSync(dir, { recursive: true });
    const stored = { v: 1 as const, launchedAtVersion: "1.2.3", state: { n: 7 } };
    writeFileSync(filePath, JSON.stringify(stored));

    const sf = new SessionStateFile<FakeState>(filePath, () => stored);

    expect(sf.read()).toEqual(stored);
  });

  it("flush() is a no-op when nothing is dirty (never scheduled)", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-state-file-"));
    const { filePath } = makeFile(dir);
    const buildPayload = vi.fn(() => ({
      v: 1 as const,
      launchedAtVersion: "1.0.0",
      state: { n: 0 },
    }));
    const sf = new SessionStateFile<FakeState>(filePath, buildPayload);

    sf.flush();

    expect(buildPayload).not.toHaveBeenCalled();
    expect(existsSync(filePath)).toBe(false);
  });

  it("schedule() debounces: rapid repeated calls produce exactly one write, 5s after the last call", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      dir = mkdtempSync(path.join(os.tmpdir(), "mullion-state-file-"));
      mkdirSync(dir, { recursive: true });
      const { filePath } = makeFile(dir);
      let n = 0;
      const sf = new SessionStateFile<FakeState>(filePath, () => ({
        v: 1,
        launchedAtVersion: "1.0.0",
        state: { n },
      }));

      sf.schedule();
      n = 1;
      await vi.advanceTimersByTimeAsync(4000);
      sf.schedule(); // resets the trailing debounce
      n = 2;
      expect(existsSync(filePath)).toBe(false);

      await vi.advanceTimersByTimeAsync(5000);

      expect(existsSync(filePath)).toBe(true);
      const written = JSON.parse(readFileSync(filePath, "utf8")) as { state: FakeState };
      expect(written.state.n).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("schedule() forces a flush at the 30s ceiling even under continuous re-scheduling", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      dir = mkdtempSync(path.join(os.tmpdir(), "mullion-state-file-"));
      mkdirSync(dir, { recursive: true });
      const { filePath } = makeFile(dir);
      const sf = new SessionStateFile<FakeState>(filePath, () => ({
        v: 1,
        launchedAtVersion: "1.0.0",
        state: { n: 0 },
      }));

      for (let i = 0; i < 8; i++) {
        sf.schedule();
        await vi.advanceTimersByTimeAsync(4000); // t = 4000, 8000, ..., 32000
        if (i < 7) expect(existsSync(filePath)).toBe(false);
      }

      expect(existsSync(filePath)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flush() writes atomically (temp file renamed into place) at 0600", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-state-file-"));
    mkdirSync(dir, { recursive: true });
    const { filePath, tmpPath } = makeFile(dir);
    const sf = new SessionStateFile<FakeState>(filePath, () => ({
      v: 1,
      launchedAtVersion: "1.0.0",
      state: { n: 5 },
    }));

    sf.schedule();
    sf.flush();

    expect(existsSync(tmpPath)).toBe(false);
    expect(existsSync(filePath)).toBe(true);
    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("flush() calls onWriteError (not throw) when the write fails, e.g. a non-existent parent directory", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-state-file-"));
    const filePath = path.join(dir, "does-not-exist", "1.state.json");
    const onWriteError = vi.fn();
    const sf = new SessionStateFile<FakeState>(
      filePath,
      () => ({ v: 1, launchedAtVersion: "1.0.0", state: { n: 0 } }),
      undefined,
      onWriteError,
    );

    sf.schedule();
    expect(() => sf.flush()).not.toThrow();

    expect(onWriteError).toHaveBeenCalledTimes(1);
    expect(existsSync(filePath)).toBe(false);
  });

  it("disable() permanently stops schedule() from arming any future write, even after a fresh dirty transition", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      dir = mkdtempSync(path.join(os.tmpdir(), "mullion-state-file-"));
      mkdirSync(dir, { recursive: true });
      const { filePath } = makeFile(dir);
      const sf = new SessionStateFile<FakeState>(filePath, () => ({
        v: 1,
        launchedAtVersion: "1.0.0",
        state: { n: 0 },
      }));

      sf.disable();
      sf.schedule();
      await vi.advanceTimersByTimeAsync(35_000);

      expect(existsSync(filePath)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disable() does not block a flush() called directly (A8: kill() disables, then flushes synchronously)", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-state-file-"));
    mkdirSync(dir, { recursive: true });
    const { filePath } = makeFile(dir);
    const sf = new SessionStateFile<FakeState>(filePath, () => ({
      v: 1,
      launchedAtVersion: "1.0.0",
      state: { n: 9 },
    }));

    sf.schedule();
    sf.disable();
    sf.flush();

    expect(existsSync(filePath)).toBe(true);
    const written = JSON.parse(readFileSync(filePath, "utf8")) as { state: FakeState };
    expect(written.state.n).toBe(9);
  });
});
