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
      claudeSessionsDirs: [path.join(path.dirname(root), "no-such-registry")],
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
    let procDir: string;
    let project: string;

    async function ownDomain(): Promise<string> {
      return `linux:test:${await fs.readlink("/proc/self/ns/pid")}`;
    }

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
      // No claude binary is "running" unless a test says so.
      procDir = path.join(path.dirname(root), "proc");
      await fs.mkdir(procDir);
      // This very process stands in for a running Claude session.
      await fs.writeFile(
        path.join(registry, `${String(process.pid)}.json`),
        JSON.stringify({
          pid: process.pid,
          sessionId: LIVE,
          procStart: await startTicks(),
          pidDomain: await ownDomain(),
        }),
      );
      project = path.join(root, "claude-1000", "-home-me-proj");
      await fs.mkdir(project, { recursive: true });
    });

    const opts = () => ({
      root,
      npmCacheDir: npmDir,
      now: NOW,
      claudeSessionsDirs: [registry],
      procDir,
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

    it("keeps a dir touched in the last ten minutes even in aggressive mode", async () => {
      const fresh = await session(DEAD, 5 * 60 * 1000);
      await pruneTempStorage("aggressive", opts());
      expect(await exists(fresh)).toBe(true);
    });

    it("treats a registry entry whose process start time differs as dead (pid reuse)", async () => {
      await fs.writeFile(
        path.join(registry, "reused.json"),
        JSON.stringify({
          pid: process.pid,
          sessionId: DEAD,
          procStart: "1",
          pidDomain: await ownDomain(),
        }),
      );
      const reused = await session(DEAD, 3 * DAY);
      await pruneTempStorage("safe", opts());
      expect(await exists(reused)).toBe(false);
    });

    // A file or dir under claude-1000, aged along with everything above it so
    // that only the rule under test can decide its fate.
    async function place(rel: string, ageMs: number, kind: "file" | "dir" = "file") {
      const full = path.join(root, "claude-1000", rel);
      if (kind === "dir") {
        await fs.mkdir(path.join(full, "inner"), { recursive: true });
        await fs.writeFile(path.join(full, "inner", "f"), "z");
      } else {
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, "z");
      }
      const t = new Date(NOW - ageMs);
      for (const sub of kind === "dir" ? ["inner/f", "inner"] : []) {
        await fs.utimes(path.join(full, sub), t, t);
      }
      const top = path.join(root, "claude-1000");
      for (let p = full; p !== path.dirname(top); p = path.dirname(p)) {
        await fs.utimes(p, t, t);
      }
      return full;
    }

    it("touches nothing under claude-* when a registry file may belong to a running process", async () => {
      await fs.writeFile(path.join(registry, "broken.json"), "{not json");
      const dead = await session(DEAD, 30 * DAY);
      const status = await inspectTempStorage(opts());
      await pruneTempStorage("aggressive", opts());
      expect(await exists(dead)).toBe(true);
      expect(status.candidates).toEqual({ safe: 0, aggressive: 0 });
      expect(status.claudeScratch.skipped).toContain("broken.json");
    });

    it("skips just an unparseable registry file whose process is gone, and reports it", async () => {
      const name = `${String(2 ** 22 + 12345)}.json`;
      await fs.writeFile(path.join(registry, name), "{not json");
      const dead = await session(DEAD, 30 * DAY);
      const live = await session(LIVE, 30 * DAY);
      const status = await inspectTempStorage(opts());
      expect(status.claudeScratch.skipped).toBeUndefined();
      expect(status.claudeScratch.warnings).toHaveLength(1);
      expect(status.claudeScratch.warnings[0]).toContain(name);
      await pruneTempStorage("aggressive", opts());
      expect(await exists(dead)).toBe(false);
      expect(await exists(live)).toBe(true);
    });

    it("counts a session registered under another config dir as running", async () => {
      const other = path.join(path.dirname(root), "registry-other");
      await fs.mkdir(other);
      await fs.writeFile(
        path.join(other, "1.json"),
        JSON.stringify({
          pid: process.pid,
          sessionId: DEAD,
          procStart: await startTicks(),
          pidDomain: await ownDomain(),
        }),
      );
      const theirs = await session(DEAD, 30 * DAY);
      await pruneTempStorage("aggressive", opts());
      expect(await exists(theirs)).toBe(false);
      await session(DEAD, 30 * DAY);
      await pruneTempStorage("aggressive", {
        ...opts(),
        claudeSessionsDirs: [registry, other, path.join(other, "gone")],
      });
      expect(await exists(theirs)).toBe(true);
    });

    it("drops a project dir only once it has sat empty past the window, never in the same pass", async () => {
      const dead = await session(DEAD, 3 * DAY);
      const live = await session(LIVE, 3 * DAY);
      await pruneTempStorage("safe", opts());
      expect(await exists(dead)).toBe(false);
      expect(await exists(project)).toBe(true);
      // Its last session goes: the dir is emptied but freshly touched, so it stays.
      await fs.rm(live, { recursive: true });
      await session(DEAD, 3 * DAY);
      await pruneTempStorage("safe", opts());
      expect(await exists(project)).toBe(true);
      expect((await fs.readdir(project)).length).toBe(0);
      // Still inside the grace window on the next run...
      await pruneTempStorage("aggressive", opts());
      expect(await exists(project)).toBe(true);
      // ...and gone once it has been empty for longer than that.
      const t = new Date(NOW - 3 * DAY);
      await fs.utimes(project, t, t);
      await pruneTempStorage("safe", opts());
      expect(await exists(project)).toBe(false);
    });

    it("leaves a project dir that gained a child after listing", async () => {
      const t = new Date(NOW - 3 * DAY);
      await fs.utimes(project, t, t);
      const status = await inspectTempStorage(opts());
      expect(status.candidates.safe).toBe(1);
      await fs.mkdir(path.join(project, DEAD));
      await pruneTempStorage("safe", opts());
      expect(await exists(path.join(project, DEAD))).toBe(true);
    });

    it("keeps a project dir holding non-session state, and emptyhome, whatever their age", async () => {
      const lock = await place(path.join("-home-me-proj", "tasks.lock"), 60 * DAY);
      const home = await place("emptyhome", 60 * DAY, "dir");
      await fs.utimes(project, new Date(NOW - 60 * DAY), new Date(NOW - 60 * DAY));
      await pruneTempStorage("aggressive", opts());
      expect(await exists(lock)).toBe(true);
      expect(await exists(home)).toBe(true);
    });

    describe("bundled-skills", () => {
      const pidDomain = () => ownDomain();
      // Replaces the outer beforeEach's entry, which names no version.
      async function runningVersion(version: string | undefined) {
        await fs.writeFile(
          path.join(registry, `${String(process.pid)}.json`),
          JSON.stringify({
            pid: process.pid,
            sessionId: LIVE,
            procStart: await startTicks(),
            pidDomain: await pidDomain(),
            ...(version === undefined ? {} : { version }),
          }),
        );
      }

      beforeEach(() => runningVersion("9.9.9"));

      it("removes versions no running session uses and keeps the ones in use", async () => {
        const used = await place(path.join("bundled-skills", "2.1.300", "h", "SKILL.md"), 3 * DAY);
        const unused = await place(
          path.join("bundled-skills", "2.1.299", "h", "SKILL.md"),
          3 * DAY,
        );
        const fresh = await place(path.join("bundled-skills", "2.1.298", "h", "SKILL.md"), 60_000);
        await runningVersion("2.1.300");
        const status = await inspectTempStorage(opts());
        expect(status.candidates.safe).toBe(1);
        await pruneTempStorage("aggressive", opts());
        expect(await exists(unused)).toBe(false);
        expect(await exists(used)).toBe(true);
        expect(await exists(fresh)).toBe(true);
      });

      it("counts a version used by an unregistered running binary, even a replaced one", async () => {
        const unused = await place(path.join("bundled-skills", "2.1.299", "SKILL.md"), 3 * DAY);
        const headless = await place(path.join("bundled-skills", "2.1.301", "SKILL.md"), 3 * DAY);
        const replaced = await place(path.join("bundled-skills", "2.1.302", "SKILL.md"), 3 * DAY);
        await runningVersion("2.1.300");
        await fs.mkdir(path.join(procDir, "42"));
        await fs.symlink(
          "/h/.local/share/claude/versions/2.1.301",
          path.join(procDir, "42", "exe"),
        );
        await fs.mkdir(path.join(procDir, "43"));
        await fs.symlink(
          "/h/.local/share/claude/versions/2.1.302 (deleted)",
          path.join(procDir, "43", "exe"),
        );
        await pruneTempStorage("aggressive", opts());
        expect(await exists(unused)).toBe(false);
        expect(await exists(headless)).toBe(true);
        expect(await exists(replaced)).toBe(true);
      });

      it("removes nothing when a running session doesn't say which version it runs", async () => {
        const skills = await place(path.join("bundled-skills", "2.1.299", "SKILL.md"), 60 * DAY);
        await runningVersion(undefined);
        expect((await inspectTempStorage(opts())).candidates).toEqual({ safe: 0, aggressive: 0 });
        await pruneTempStorage("aggressive", opts());
        expect(await exists(skills)).toBe(true);
      });

      it("drops a version dir a session started using since listing", async () => {
        const skills = await place(path.join("bundled-skills", "2.1.299", "SKILL.md"), 3 * DAY);
        const status = await inspectTempStorage(opts());
        expect(status.candidates.safe).toBe(1);
        await runningVersion("2.1.299");
        await pruneTempStorage("safe", opts());
        expect(await exists(skills)).toBe(true);
      });
    });

    describe("loose entries", () => {
      it("ages stray files and non-project directories on the generic windows", async () => {
        const oldFile = await place("old.log", 8 * DAY);
        const midFile = await place("mid.log", 2 * DAY);
        const oldDir = await place("next-branch", 8 * DAY, "dir");
        const midDir = await place("shots", 2 * DAY, "dir");
        await pruneTempStorage("safe", opts());
        expect(await exists(oldFile)).toBe(false);
        expect(await exists(oldDir)).toBe(false);
        expect(await exists(midFile)).toBe(true);
        expect(await exists(midDir)).toBe(true);
        await pruneTempStorage("aggressive", opts());
        expect(await exists(midFile)).toBe(false);
        expect(await exists(midDir)).toBe(false);
      });

      it("keeps a *.pid file naming a running process", async () => {
        const live = await place("api.pid", 30 * DAY);
        await fs.writeFile(live, String(process.pid));
        await fs.utimes(live, new Date(NOW - 30 * DAY), new Date(NOW - 30 * DAY));
        const dead = await place("dead.pid", 30 * DAY);
        await fs.writeFile(dead, String(2 ** 22 + 12345));
        await fs.utimes(dead, new Date(NOW - 30 * DAY), new Date(NOW - 30 * DAY));
        await pruneTempStorage("aggressive", opts());
        expect(await exists(live)).toBe(true);
        expect(await exists(dead)).toBe(false);
      });

      it("treats a non-project directory holding a session as a project, not as loose", async () => {
        const dir = path.join(root, "claude-1000", "odd-proj");
        await fs.mkdir(path.join(dir, LIVE), { recursive: true });
        await fs.writeFile(path.join(dir, LIVE, "f"), "z");
        const t = new Date(NOW - 60 * DAY);
        for (const p of [path.join(dir, LIVE, "f"), path.join(dir, LIVE), dir]) {
          await fs.utimes(p, t, t);
        }
        await pruneTempStorage("aggressive", opts());
        expect(await exists(path.join(dir, LIVE))).toBe(true);
      });
    });

    it("assumes a session from another PID namespace, or with an unrecognised procStart, is running", async () => {
      await fs.writeFile(
        path.join(registry, "other-ns.json"),
        JSON.stringify({
          pid: 999_999,
          sessionId: DEAD,
          procStart: "1",
          pidDomain: "linux:abc:pid:[1]",
        }),
      );
      await fs.writeFile(
        path.join(registry, "odd.json"),
        JSON.stringify({
          pid: process.pid,
          sessionId: RECENT_DEAD,
          procStart: "n/a",
          pidDomain: await ownDomain(),
        }),
      );
      const other = await session(DEAD, 30 * DAY);
      const odd = await session(RECENT_DEAD, 30 * DAY);
      await pruneTempStorage("aggressive", opts());
      expect(await exists(other)).toBe(true);
      expect(await exists(odd)).toBe(true);
    });
  });
});
