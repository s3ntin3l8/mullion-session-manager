import { describe, expect, it, vi } from "vitest";
import type * as CacheStorage from "../../src/services/cache-storage.js";

// Every source is mocked: a real prune here would touch the host (docker, /tmp).
const inspectDockerStorage = vi.fn(async (..._args: unknown[]) => ({ available: true }));
const pruneDockerStorage = vi.fn(async (_mode?: string) => ({ output: "", reclaimedBytes: 5 }));
vi.mock("../../src/services/docker-storage.js", () => ({
  inspectDockerStorage: (...args: unknown[]) => inspectDockerStorage(...args),
  pruneDockerStorage: (mode?: string) => pruneDockerStorage(mode),
}));

const inspectTempStorage = vi.fn(async (..._args: unknown[]) => ({ available: true }));
const pruneTempStorage = vi.fn(async (_mode?: string, _options?: unknown) => ({
  output: "",
  reclaimedBytes: 7,
}));
vi.mock("../../src/services/temp-storage.js", () => ({
  inspectTempStorage: (...args: unknown[]) => inspectTempStorage(...args),
  pruneTempStorage: (mode?: string, options?: unknown) => pruneTempStorage(mode, options),
}));

const inspectCacheStorage = vi.fn(async (..._args: unknown[]) => ({ available: true, caches: [] }));
const pruneCacheStorage = vi.fn(async (_ids?: readonly string[]) => ({
  output: "",
  reclaimedBytes: 9,
}));
vi.mock("../../src/services/cache-storage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof CacheStorage>()),
  inspectCacheStorage: (...args: unknown[]) => inspectCacheStorage(...args),
  pruneCacheStorage: (ids?: readonly string[]) => pruneCacheStorage(ids),
}));

const inspectOpencodeStorage = vi.fn(
  async (..._args: unknown[]): Promise<Record<string, unknown>> => ({ available: true }),
);
const pruneOpencodeStorage = vi.fn(async (..._args: unknown[]) => ({
  output: "Compacted opencode.db.",
  reclaimedBytes: 11,
}));
vi.mock("../../src/services/opencode-storage.js", () => ({
  inspectOpencodeStorage: (...args: unknown[]) => inspectOpencodeStorage(...args),
  pruneOpencodeStorage: (...args: unknown[]) => pruneOpencodeStorage(...args),
}));

const inspectDevWorktrees = vi.fn(async (..._args: unknown[]) => ({
  available: true,
  candidates: [],
  totalBytes: 0,
}));
const pruneDevWorktrees = vi.fn(async (..._args: unknown[]) => ({
  output: "Removed 0 stale developer worktrees.",
  reclaimedBytes: 3,
}));
vi.mock("../../src/services/dev-worktrees.js", () => ({
  inspectDevWorktrees: (...args: unknown[]) => inspectDevWorktrees(...args),
  pruneDevWorktrees: (...args: unknown[]) => pruneDevWorktrees(...args),
}));

import path from "node:path";
import { projects, sessions } from "../../src/db/schema.js";
import { defaultClaudeSessionsDir } from "../../src/services/claude-scratch.js";
import type { CleanupJob, CleanupStatus } from "../../src/services/disk-cleanup-job.js";
import { buildTestApp } from "../helpers/app.js";

type App = Awaited<ReturnType<typeof buildTestApp>>;

const sources = (job: CleanupJob) => job.steps.map((s) => s.source);
const step = (job: CleanupJob, source: string) => job.steps.find((s) => s.source === source);

async function status(app: App) {
  return (await app.inject({ method: "GET", url: "/api/storage/cleanup" })).json<CleanupStatus>();
}

async function finished(app: App): Promise<CleanupJob> {
  let job!: CleanupJob;
  await vi.waitFor(async () => {
    const current = await status(app);
    expect(current.state).toBe("done");
    job = current as CleanupJob;
  });
  return job;
}

async function runCleanup(app: App, payload?: object) {
  const res = await app.inject({ method: "POST", url: "/api/storage/cleanup", payload });
  expect(res.statusCode).toBe(202);
  const started = res.json<CleanupJob>();
  return { started, job: await finished(app) };
}

async function setCacheDirs(app: App, cacheDirs: string[]) {
  await app.inject({
    method: "PATCH",
    url: "/api/settings",
    payload: { diskCleanup: { cacheDirs } },
  });
}

describe("/api/storage/cleanup", () => {
  it("is idle until a cleanup has run", async () => {
    const app = await buildTestApp();
    expect(await status(app)).toEqual({ state: "idle" });
  });

  it("answers at once with the running job, then reports each source as it finishes", async () => {
    let release!: () => void;
    pruneDockerStorage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ output: "", reclaimedBytes: 5 });
        }),
    );
    const app = await buildTestApp();
    const res = await app.inject({ method: "POST", url: "/api/storage/cleanup" });
    expect(res.statusCode).toBe(202);
    const started = res.json<CleanupJob>();
    expect(started).toMatchObject({ mode: "safe", state: "running" });
    expect(started.id).toEqual(expect.any(String));
    expect(sources(started)).toEqual(["docker", "temp"]);

    await vi.waitFor(async () => {
      const job = (await status(app)) as CleanupJob;
      expect(step(job, "docker")?.state).toBe("running");
      expect(step(job, "temp")?.state).toBe("pending");
    });
    release();
    const done = await finished(app);
    expect(step(done, "docker")).toMatchObject({ state: "done", reclaimedBytes: 5 });
    expect(step(done, "temp")).toMatchObject({ state: "done", reclaimedBytes: 7 });
    expect(done.finishedAt).toEqual(expect.any(String));
  });

  it("refuses a second cleanup while one is running", async () => {
    let release!: () => void;
    pruneDockerStorage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ output: "", reclaimedBytes: 0 });
        }),
    );
    const app = await buildTestApp();
    await app.inject({ method: "POST", url: "/api/storage/cleanup" });
    const second = await app.inject({ method: "POST", url: "/api/storage/cleanup" });
    expect(second.statusCode).toBe(409);
    release();
    await finished(app);
    expect((await app.inject({ method: "POST", url: "/api/storage/cleanup" })).statusCode).toBe(
      202,
    );
    await finished(app);
  });

  it("runs only Docker and temp files in safe mode, with the safe mode", async () => {
    const app = await buildTestApp();
    await setCacheDirs(app, ["pip"]);
    pruneCacheStorage.mockClear();
    pruneOpencodeStorage.mockClear();
    pruneDevWorktrees.mockClear();
    const { job } = await runCleanup(app, { mode: "safe" });
    expect(sources(job)).toEqual(["docker", "temp"]);
    expect(pruneDockerStorage).toHaveBeenLastCalledWith("safe");
    expect(pruneTempStorage.mock.lastCall?.[0]).toBe("safe");
    expect(pruneCacheStorage).not.toHaveBeenCalled();
    expect(pruneOpencodeStorage).not.toHaveBeenCalled();
    expect(pruneDevWorktrees).not.toHaveBeenCalled();
  });

  it("defaults to safe with no body, and passes aggressive to every source that takes a mode", async () => {
    const app = await buildTestApp();
    expect((await runCleanup(app)).job.mode).toBe("safe");
    await setCacheDirs(app, ["pip"]);
    const { job } = await runCleanup(app, { mode: "aggressive" });
    expect(job.mode).toBe("aggressive");
    expect(sources(job)).toEqual(["docker", "temp", "caches", "opencode", "worktrees"]);
    expect(pruneDockerStorage).toHaveBeenLastCalledWith("aggressive");
    expect(pruneTempStorage.mock.lastCall?.[0]).toBe("aggressive");
    expect(job.steps.reduce((sum, s) => sum + s.reclaimedBytes, 0)).toBe(5 + 7 + 9 + 11 + 3);
  });

  it("rejects unknown modes and an oversized cache list, and ignores fields it doesn't know", async () => {
    const app = await buildTestApp();
    const post = (payload: object) =>
      app.inject({ method: "POST", url: "/api/storage/cleanup", payload });
    expect((await post({ mode: "volumes" })).statusCode).toBe(400);
    expect(
      (await post({ mode: "aggressive", cacheDirs: Array.from({ length: 21 }, () => "pip") }))
        .statusCode,
    ).toBe(400);
    expect(await status(app)).toEqual({ state: "idle" });
    // Extra properties are stripped by validation: nothing a client adds can steer a prune.
    pruneDevWorktrees.mockClear();
    const res = await post({ mode: "safe", paths: ["/etc"], projects: [{ id: 1, cwd: "/etc" }] });
    expect(res.statusCode).toBe(202);
    await finished(app);
    expect(pruneDevWorktrees).not.toHaveBeenCalled();
    expect(pruneTempStorage.mock.lastCall?.[1]).not.toHaveProperty("paths");
  });

  describe("caches", () => {
    it("empties only ids that are both requested and saved, so neither side can widen the other", async () => {
      const app = await buildTestApp();
      await setCacheDirs(app, ["pip", "../../etc", "go-build"]);
      // The client just unticked go-build (its PATCH may still be debounced) and
      // asks for pip plus a cache that was never opted in.
      await runCleanup(app, { mode: "aggressive", cacheDirs: ["pip", "huggingface"] });
      expect(pruneCacheStorage).toHaveBeenLastCalledWith(["pip"]);
      // Nothing requested: fall back to the saved set.
      await runCleanup(app, { mode: "aggressive" });
      expect(pruneCacheStorage).toHaveBeenLastCalledWith(["pip", "go-build"]);
    });

    it("leaves caches out when nothing is opted in", async () => {
      const app = await buildTestApp();
      await setCacheDirs(app, []);
      const { job } = await runCleanup(app, { mode: "aggressive" });
      expect(sources(job)).not.toContain("caches");
    });
  });

  describe("temp files", () => {
    it("consults the registry of every config dir an active session runs with", async () => {
      const app = await buildTestApp();
      const { lastInsertRowid } = app.db
        .insert(projects)
        .values({ name: "p", cwd: "/tmp/p-registry-dirs" })
        .run();
      const projectId = Number(lastInsertRowid);
      const remote = app.db
        .insert(projects)
        .values({ name: "r", cwd: "/tmp/r-registry-dirs", hostId: "remote-1" })
        .run();
      const env = (dir: string) => JSON.stringify({ CLAUDE_CONFIG_DIR: dir });
      app.db
        .insert(sessions)
        .values([
          { projectId, command: "claude", cwd: "/tmp", env: env("/work/active") },
          { projectId, command: "claude", cwd: "/tmp", env: env("/work/dead"), status: "killed" },
          { projectId, command: "claude", cwd: "/tmp", env: env("/work/exited"), status: "exited" },
          { projectId, command: "claude", cwd: "/tmp" },
          {
            projectId: Number(remote.lastInsertRowid),
            command: "claude",
            cwd: "/tmp",
            env: env("/work/remote"),
          },
        ])
        .run();
      await runCleanup(app);
      expect(pruneTempStorage.mock.lastCall?.[1]).toEqual({
        claudeSessionsDirs: [defaultClaudeSessionsDir(), path.join("/work/active", "sessions")],
      });
    });
  });

  describe("skipping what was measured as unusable", () => {
    it("skips Docker, with the reason, when it was measured as unavailable", async () => {
      inspectDockerStorage.mockResolvedValueOnce({ available: false, error: "permission denied" });
      const app = await buildTestApp();
      await app.inject({ method: "GET", url: "/api/storage/docker" });
      pruneDockerStorage.mockClear();
      const { job } = await runCleanup(app);
      expect(step(job, "docker")).toMatchObject({ state: "skipped" });
      expect(step(job, "docker")?.note).toContain("permission denied");
      expect(pruneDockerStorage).not.toHaveBeenCalled();
      expect(step(job, "temp")?.state).toBe("done");
    });

    it("ignores an old measurement: a Docker daemon that has since come up is not skipped", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        inspectDockerStorage.mockResolvedValueOnce({ available: false, error: "daemon down" });
        const app = await buildTestApp();
        await app.inject({ method: "GET", url: "/api/storage/docker" });
        vi.setSystemTime(Date.now() + 61_000);
        pruneDockerStorage.mockClear();
        const { job } = await runCleanup(app);
        expect(step(job, "docker")?.state).toBe("done");
        expect(pruneDockerStorage).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it("skips temp files when they were measured as unavailable", async () => {
      inspectTempStorage.mockResolvedValueOnce({ available: false, error: "no /tmp" });
      const app = await buildTestApp();
      await app.inject({ method: "GET", url: "/api/storage/temp" });
      pruneTempStorage.mockClear();
      const { job } = await runCleanup(app);
      expect(step(job, "temp")?.state).toBe("skipped");
      expect(pruneTempStorage).not.toHaveBeenCalled();
    });

    it("gives the skipped temp step a reason when the scan reported none", async () => {
      inspectTempStorage.mockResolvedValueOnce({ available: false });
      const app = await buildTestApp();
      await app.inject({ method: "GET", url: "/api/storage/temp" });
      const { job } = await runCleanup(app);
      expect(step(job, "temp")).toMatchObject({
        state: "skipped",
        note: "Temp files unavailable: could not be scanned",
      });
    });

    it.each([
      ["opencode is running", { inUse: true }],
      ["Can't tell whether opencode is running", { holdersUnknown: true }],
      ["It is already being compacted", { compacting: true }],
    ])("skips opencode when measured as blocked (%s)", async (note, blocked) => {
      inspectOpencodeStorage.mockResolvedValueOnce({
        available: true,
        reclaimableBytes: 100,
        ...blocked,
      });
      const app = await buildTestApp();
      await app.inject({ method: "GET", url: "/api/storage/opencode" });
      pruneOpencodeStorage.mockClear();
      const { job } = await runCleanup(app, { mode: "aggressive" });
      expect(step(job, "opencode")).toMatchObject({ state: "skipped", note });
      expect(pruneOpencodeStorage).not.toHaveBeenCalled();
    });

    it("leaves opencode out when there is nothing to reclaim or it isn't installed", async () => {
      const app = await buildTestApp();
      for (const measured of [
        { available: false },
        { available: true, reclaimableBytes: 0, inUse: false },
      ]) {
        inspectOpencodeStorage.mockResolvedValueOnce(measured);
        await app.inject({ method: "GET", url: "/api/storage/opencode?refresh=1" });
        const { job } = await runCleanup(app, { mode: "aggressive" });
        expect(sources(job)).not.toContain("opencode");
      }
    });

    it.each([
      "opencode is running; its database was skipped. Close it and run again.",
      "The opencode database has nothing to reclaim.",
    ])("shows why opencode freed nothing instead of a quiet 0 B (%s)", async (output) => {
      pruneOpencodeStorage.mockResolvedValueOnce({ output, reclaimedBytes: 0 });
      const app = await buildTestApp();
      const { job } = await runCleanup(app, { mode: "aggressive" });
      expect(step(job, "opencode")).toMatchObject({ state: "skipped", note: output });
    });

    it("still tries opencode and worktrees when nothing was measured, since each re-checks itself", async () => {
      const app = await buildTestApp();
      pruneOpencodeStorage.mockClear();
      pruneDevWorktrees.mockClear();
      const { job } = await runCleanup(app, { mode: "aggressive" });
      expect(step(job, "opencode")?.state).toBe("done");
      expect(step(job, "worktrees")?.state).toBe("done");
      expect(pruneOpencodeStorage).toHaveBeenCalledOnce();
      expect(pruneDevWorktrees).toHaveBeenCalledOnce();
    });
  });

  describe("failures", () => {
    it("records a failed source and carries on with the rest", async () => {
      pruneDockerStorage.mockRejectedValueOnce(new Error("disk on fire"));
      const app = await buildTestApp();
      const { job } = await runCleanup(app);
      expect(step(job, "docker")).toMatchObject({ state: "error", note: "disk on fire" });
      expect(step(job, "temp")).toMatchObject({ state: "done", reclaimedBytes: 7 });
    });

    it("turns a source's own 'already running' code into a sentence", async () => {
      pruneTempStorage.mockRejectedValueOnce(new Error("TEMP_PRUNE_IN_PROGRESS"));
      pruneDockerStorage.mockRejectedValueOnce(new Error("DOCKER_PRUNE_IN_PROGRESS"));
      const app = await buildTestApp();
      const { job } = await runCleanup(app);
      expect(step(job, "docker")?.note).toBe("Docker cleanup is already running");
      expect(step(job, "temp")?.note).toBe("Temp file cleanup is already running");
    });

    it("keeps what a source freed before it stopped, with the reason", async () => {
      pruneTempStorage.mockResolvedValueOnce({ output: "", reclaimedBytes: 2, error: "boom" });
      const app = await buildTestApp();
      const { job } = await runCleanup(app);
      expect(step(job, "temp")).toMatchObject({ state: "done", reclaimedBytes: 2, note: "boom" });
    });
  });

  it("drops what it measured, so the next look is a fresh one", async () => {
    inspectTempStorage.mockClear();
    const app = await buildTestApp();
    await app.inject({ method: "GET", url: "/api/storage/temp" });
    await app.inject({ method: "GET", url: "/api/storage/temp" });
    expect(inspectTempStorage).toHaveBeenCalledTimes(1);
    await runCleanup(app);
    await app.inject({ method: "GET", url: "/api/storage/temp" });
    expect(inspectTempStorage).toHaveBeenCalledTimes(2);
  });

  it("keeps the last job so a reloaded page can still show it", async () => {
    const app = await buildTestApp();
    const { job } = await runCleanup(app);
    expect(await status(app)).toEqual(job);
  });
});
