import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// AGENTS.md: a test must never let a real spawn fire.
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { inspectTempStorage, pruneTempStorage } from "../../src/services/temp-storage.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

let root: string;
let npmDir: string;

async function makeEntry(name: string, ageMs: number, content = "x".repeat(100)) {
  const dir = path.join(root, name);
  await fs.mkdir(dir);
  const file = path.join(dir, "file.txt");
  await fs.writeFile(file, content);
  const t = new Date(NOW - ageMs);
  await fs.utimes(file, t, t);
  await fs.utimes(dir, t, t);
  return dir;
}

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "temp-storage-test-"));
  root = path.join(base, "tmp");
  npmDir = path.join(base, "npm");
  await fs.mkdir(root);
  await fs.mkdir(path.join(npmDir, "_cacache"), { recursive: true });
  await fs.writeFile(path.join(npmDir, "_cacache", "blob"), "y".repeat(500));
});

afterEach(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true });
});

describe("temp-storage", () => {
  it("safe mode removes only entries untouched for 7+ days", async () => {
    const old = await makeEntry("old", 8 * DAY);
    const mid = await makeEntry("mid", 2 * DAY);
    const result = await pruneTempStorage("safe", { root, npmCacheDir: npmDir, now: NOW });
    expect(await exists(old)).toBe(false);
    expect(await exists(mid)).toBe(true);
    expect(result.reclaimedBytes).toBeGreaterThanOrEqual(100);
    expect(result.error).toBeUndefined();
  });

  it("uses the newest mtime in the tree, not the top-level dir's", async () => {
    const dir = await makeEntry("live-session", 30 * DAY);
    await fs.writeFile(path.join(dir, "fresh.txt"), "now");
    const t = new Date(NOW - 30 * DAY);
    await fs.utimes(dir, t, t);
    await pruneTempStorage("safe", { root, npmCacheDir: npmDir, now: NOW });
    expect(await exists(dir)).toBe(true);
  });

  it("does not follow or delete symlink targets outside the root", async () => {
    const outside = path.join(path.dirname(root), "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "keep.txt"), "keep");
    const link = path.join(root, "link");
    await fs.symlink(outside, link);
    const t = new Date(NOW - 30 * DAY);
    await fs.lutimes(link, t, t);
    await pruneTempStorage("safe", { root, npmCacheDir: npmDir, now: NOW });
    expect(await exists(path.join(outside, "keep.txt"))).toBe(true);
    expect(await exists(link)).toBe(false);
  });

  it("skips entries owned by other users", async () => {
    const dir = await makeEntry("theirs", 30 * DAY);
    await pruneTempStorage("safe", { root, npmCacheDir: npmDir, now: NOW, uid: -2 });
    expect(await exists(dir)).toBe(true);
  });

  it("skips denylisted names and trees containing a socket", async () => {
    const tsx = await makeEntry("tsx-1000", 30 * DAY);
    const tmux = await makeEntry("tmux-1000", 30 * DAY);
    const withSocket = await makeEntry("has-socket", 30 * DAY);
    const server = net.createServer();
    const sock = path.join(withSocket, "s.sock");
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    try {
      const t = new Date(NOW - 30 * DAY);
      await fs.utimes(withSocket, t, t);
      await pruneTempStorage("aggressive", {
        root,
        npmCacheDir: npmDir,
        now: NOW,
        runNpmCacheClean: async () => "",
      });
      expect(await exists(tsx)).toBe(true);
      expect(await exists(tmux)).toBe(true);
      expect(await exists(withSocket)).toBe(true);
    } finally {
      server.close();
    }
  });

  it("aggressive mode uses the 24h window and runs npm cache clean", async () => {
    const day = await makeEntry("two-days", 2 * DAY);
    const fresh = await makeEntry("fresh", 1000);
    const runNpmCacheClean = vi.fn(async () => "npm done");
    const result = await pruneTempStorage("aggressive", {
      root,
      npmCacheDir: npmDir,
      now: NOW,
      runNpmCacheClean,
    });
    expect(await exists(day)).toBe(false);
    expect(await exists(fresh)).toBe(true);
    expect(runNpmCacheClean).toHaveBeenCalledOnce();
    expect(result.output).toContain("npm done");
    expect(result.reclaimedBytes).toBeGreaterThanOrEqual(600);
  });

  it("reports an npm failure without losing what was already freed", async () => {
    await makeEntry("old", 3 * DAY);
    const result = await pruneTempStorage("aggressive", {
      root,
      npmCacheDir: npmDir,
      now: NOW,
      runNpmCacheClean: async () => {
        throw new Error("npm broke");
      },
    });
    expect(result.error).toBe("npm broke");
    expect(result.reclaimedBytes).toBeGreaterThanOrEqual(100);
  });

  it("estimates per tier, including the npm cache for aggressive", async () => {
    await makeEntry("a", 8 * DAY);
    await makeEntry("b", 2 * DAY);
    const status = await inspectTempStorage({ root, npmCacheDir: npmDir, now: NOW });
    expect(status.available).toBe(true);
    expect(status.candidates).toEqual({ safe: 1, aggressive: 2 });
    expect(status.estimates.aggressiveBytes).toBeGreaterThan(status.estimates.safeBytes + 400);
  });

  it("reports unavailable for a missing root", async () => {
    const status = await inspectTempStorage({ root: path.join(root, "nope") });
    expect(status.available).toBe(false);
    expect(status.error).toBeTruthy();
  });

  it("rejects a concurrent prune", async () => {
    await makeEntry("old", 3 * DAY);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = pruneTempStorage("aggressive", {
      root,
      npmCacheDir: npmDir,
      now: NOW,
      runNpmCacheClean: async () => {
        await gate;
        return "";
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    await expect(pruneTempStorage("safe", { root, now: NOW })).rejects.toThrow(
      "TEMP_PRUNE_IN_PROGRESS",
    );
    release();
    await first;
  });
});
