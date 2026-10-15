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

  it("leaves mullion-* dirs alone and all of claude-* when liveness is unknown", async () => {
    const claude = await makeEntry("claude-1000", 30 * DAY);
    const mullion = await makeEntry("mullion-scaffold-generate", 30 * DAY);
    await pruneTempStorage("aggressive", {
      root,
      npmCacheDir: npmDir,
      now: NOW,
      claudeSessionsDir: path.join(path.dirname(root), "no-such-registry"),
      runNpmCacheClean: async () => "",
    });
    expect(await exists(claude)).toBe(true);
    expect(await exists(mullion)).toBe(true);
  });

  it("keeps going past an entry it cannot remove and reports it", async () => {
    const stuck = await makeEntry("stuck", 30 * DAY);
    const locked = path.join(stuck, "locked");
    await fs.mkdir(locked);
    await fs.writeFile(path.join(locked, "f"), "z");
    const t = new Date(NOW - 30 * DAY);
    await fs.utimes(path.join(locked, "f"), t, t);
    await fs.utimes(locked, t, t);
    await fs.utimes(stuck, t, t);
    await fs.chmod(locked, 0o500);
    const other = await makeEntry("other", 30 * DAY);
    try {
      const result = await pruneTempStorage("safe", { root, npmCacheDir: npmDir, now: NOW });
      expect(await exists(other)).toBe(false);
      if (process.getuid?.() !== 0) expect(result.error).toContain("stuck");
    } finally {
      await fs.chmod(locked, 0o700);
    }
  });

  describe("claude session scratch (#1608)", () => {
    const LIVE = "11111111-1111-4111-8111-111111111111";
    const DEAD = "22222222-2222-4222-8222-222222222222";
    const RECENT_DEAD = "33333333-3333-4333-8333-333333333333";
    let registry: string;
    let project: string;

    async function startTicks(): Promise<string> {
      const stat = await fs.readFile("/proc/self/stat", "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    }

    async function session(id: string, ageMs: number) {
      const dir = path.join(project, id);
      await fs.mkdir(path.join(dir, "scratchpad"), { recursive: true });
      const file = path.join(dir, "scratchpad", "note.txt");
      await fs.writeFile(file, "s".repeat(200));
      const t = new Date(NOW - ageMs);
      await fs.utimes(file, t, t);
      await fs.utimes(path.join(dir, "scratchpad"), t, t);
      await fs.utimes(dir, t, t);
      return dir;
    }

    beforeEach(async () => {
      registry = path.join(path.dirname(root), "registry");
      await fs.mkdir(registry);
      // This very process stands in for a running Claude session.
      await fs.writeFile(
        path.join(registry, `${String(process.pid)}.json`),
        JSON.stringify({ pid: process.pid, sessionId: LIVE, procStart: await startTicks() }),
      );
      project = path.join(root, "claude-1000", "-home-me-proj");
      await fs.mkdir(project, { recursive: true });
    });

    const opts = () => ({
      root,
      npmCacheDir: npmDir,
      now: NOW,
      claudeSessionsDir: registry,
      runNpmCacheClean: async () => "",
    });

    it("never removes a running session's scratch, however old", async () => {
      const live = await session(LIVE, 60 * DAY);
      await pruneTempStorage("aggressive", opts());
      expect(await exists(live)).toBe(true);
    });

    it("removes a dead session after 24h in safe mode and any dead one in aggressive", async () => {
      const dead = await session(DEAD, 3 * DAY);
      const recent = await session(RECENT_DEAD, 2 * 60 * 60 * 1000);
      await pruneTempStorage("safe", opts());
      expect(await exists(dead)).toBe(false);
      expect(await exists(recent)).toBe(true);
      await pruneTempStorage("aggressive", opts());
      expect(await exists(recent)).toBe(false);
    });

    it("keeps a dir touched in the last minute even in aggressive mode", async () => {
      const fresh = await session(DEAD, 5000);
      await pruneTempStorage("aggressive", opts());
      expect(await exists(fresh)).toBe(true);
    });

    it("treats a registry entry whose process start time differs as dead (pid reuse)", async () => {
      await fs.writeFile(
        path.join(registry, "reused.json"),
        JSON.stringify({ pid: process.pid, sessionId: DEAD, procStart: "1" }),
      );
      const reused = await session(DEAD, 3 * DAY);
      await pruneTempStorage("safe", opts());
      expect(await exists(reused)).toBe(false);
    });

    it("touches nothing under claude-* when the registry has an unparseable file", async () => {
      await fs.writeFile(path.join(registry, "broken.json"), "{not json");
      const dead = await session(DEAD, 30 * DAY);
      const status = await inspectTempStorage(opts());
      await pruneTempStorage("aggressive", opts());
      expect(await exists(dead)).toBe(true);
      expect(status.candidates).toEqual({ safe: 0, aggressive: 0 });
    });

    it("removes a project dir once its last session is gone, but not while others remain", async () => {
      const dead = await session(DEAD, 3 * DAY);
      const live = await session(LIVE, 3 * DAY);
      await pruneTempStorage("safe", opts());
      expect(await exists(dead)).toBe(false);
      expect(await exists(project)).toBe(true);
      await fs.rm(live, { recursive: true });
      await session(DEAD, 3 * DAY);
      await pruneTempStorage("safe", opts());
      expect(await exists(project)).toBe(false);
    });

    it("applies the generic windows to non-session entries and counts scratch in estimates", async () => {
      const dead = await session(DEAD, 3 * DAY);
      const stray = path.join(root, "claude-1000", "old.log");
      await fs.writeFile(stray, "l");
      const t = new Date(NOW - 8 * DAY);
      await fs.utimes(stray, t, t);
      const status = await inspectTempStorage(opts());
      expect(status.candidates.safe).toBe(2);
      expect(status.estimates.safeBytes).toBeGreaterThanOrEqual(200);
      await pruneTempStorage("safe", opts());
      expect(await exists(dead)).toBe(false);
      expect(await exists(stray)).toBe(false);
    });
  });
});
