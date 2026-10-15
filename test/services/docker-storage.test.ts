import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  DOCKER_PRUNE_AGGRESSIVE_ARGS,
  DOCKER_SAFE_PRUNE_STEPS,
  estimateSafePrune,
  inspectDockerStorage,
  parseDockerUsage,
  parseReclaimed,
  pruneDockerStorage,
  type SpawnDocker,
} from "../../src/services/docker-storage.js";

function fakeSpawn(
  options: { stdout?: string; stderr?: string; code?: number; hold?: boolean } = {},
) {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  let child: ChildProcessWithoutNullStreams;
  const spawn: SpawnDocker = (command, args) => {
    const emitter = new EventEmitter() as ChildProcessWithoutNullStreams;
    Object.assign(emitter, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      kill: vi.fn(),
    });
    child = emitter;
    calls.push({ command, args });
    if (!options.hold) {
      queueMicrotask(() => {
        if (options.stdout) emitter.stdout.write(options.stdout);
        if (options.stderr) emitter.stderr.write(options.stderr);
        emitter.emit("close", options.code ?? 0);
      });
    }
    return emitter;
  };
  return {
    spawn,
    calls,
    get child() {
      return child;
    },
  };
}

describe("Docker storage", () => {
  it("parses Docker's JSON-lines usage and reclaimable estimates", () => {
    const rows = parseDockerUsage(
      '{"Type":"Images","TotalCount":"3","Active":"1","Size":"1.5GB","Reclaimable":"512MB (33%)"}\n',
    );
    expect(rows).toEqual([
      {
        type: "Images",
        totalCount: 3,
        activeCount: 1,
        sizeBytes: 1.5 * 1000 ** 3,
        reclaimableBytes: 512 * 1000 ** 2,
      },
    ]);
  });

  it("runs the safe steps in order, summing reclaimed space, never using --all or --volumes", async () => {
    const fake = fakeSpawn({ stdout: "Total reclaimed space: 1GB\n" });
    await expect(pruneDockerStorage("safe", fake.spawn)).resolves.toMatchObject({
      reclaimedBytes: 4 * 1000 ** 3,
    });
    expect(fake.calls.map((call) => call.args)).toEqual(DOCKER_SAFE_PRUNE_STEPS);
    expect(DOCKER_SAFE_PRUNE_STEPS[0]).not.toContain("--filter");
    // Containers/networks keep the 7-day window; build cache frees after a day (#1607).
    const untilFor = (verb: string) =>
      DOCKER_SAFE_PRUNE_STEPS.find((step) => step[0] === verb)?.find((arg) =>
        arg.startsWith("until="),
      );
    expect(untilFor("container")).toBe("until=168h");
    expect(untilFor("network")).toBe("until=168h");
    expect(untilFor("builder")).toBe("until=24h");
    for (const step of DOCKER_SAFE_PRUNE_STEPS) {
      expect(step).not.toContain("--all");
      expect(step).not.toContain("--volumes");
    }
  });

  it("aggressive mode uses --all but never --volumes", async () => {
    const fake = fakeSpawn({ stdout: "Total reclaimed space: 2.5GB" });
    await expect(pruneDockerStorage("aggressive", fake.spawn)).resolves.toEqual({
      output: "Total reclaimed space: 2.5GB",
      reclaimedBytes: 2.5 * 1000 ** 3,
    });
    expect(fake.calls).toEqual([{ command: "docker", args: DOCKER_PRUNE_AGGRESSIVE_ARGS }]);
    expect(DOCKER_PRUNE_AGGRESSIVE_ARGS).toContain("--all");
    expect(DOCKER_PRUNE_AGGRESSIVE_ARGS).not.toContain("--volumes");
  });

  it("reports earlier progress when a later safe step fails, and throws if the first fails", async () => {
    let n = 0;
    const calls: string[][] = [];
    const flaky: SpawnDocker = (command, args) => {
      n += 1;
      calls.push([...args]);
      return fakeSpawn({
        stdout: n === 1 ? "Total reclaimed space: 1GB" : "",
        stderr: "boom",
        code: n === 1 ? 0 : 1,
      }).spawn(command, args);
    };
    await expect(pruneDockerStorage("safe", flaky)).resolves.toMatchObject({
      reclaimedBytes: 1000 ** 3,
      error: "boom",
    });
    expect(calls).toHaveLength(2);
    const failing = fakeSpawn({ stderr: "denied", code: 1 });
    await expect(pruneDockerStorage("safe", failing.spawn)).rejects.toThrow("denied");
  });

  it("parses the reclaimed-space line", () => {
    expect(parseReclaimed("Deleted\nTotal reclaimed space: 1.2GB\n")).toBe(1.2 * 1000 ** 3);
    expect(parseReclaimed("Total reclaimed space: 0B")).toBe(0);
    expect(parseReclaimed("ID  RECLAIMABLE\nabc 1GB\nTotal:\t2.5GB\n")).toBe(2.5 * 1000 ** 3);
    expect(parseReclaimed("nothing")).toBe(0);
  });

  it("estimates the safe tier: dangling images at any age, week-old containers, day-old cache", () => {
    const now = Date.parse("2026-10-14T12:00:00Z");
    const verbose = JSON.stringify({
      Images: [
        { ID: "sha256:dangling-new", Containers: "0", UniqueSize: "1GB" },
        { ID: "sha256:dangling-used", Containers: "1", UniqueSize: "5GB" },
        { ID: "sha256:tagged", Containers: "0", UniqueSize: "7GB" },
      ],
      Containers: [
        { State: "exited", CreatedAt: "2026-10-01 09:10:26 +0200 CEST", Size: "10MB" },
        { State: "exited", CreatedAt: "2026-10-14 09:10:26 +0200 CEST", Size: "20MB" },
        { State: "running", CreatedAt: "2026-09-01 09:10:26 +0200 CEST", Size: "30MB" },
      ],
      BuildCache: [
        {
          CacheType: "regular",
          InUse: "false",
          LastUsedAt: "2026-10-01 09:38:53.402492998 +0000 UTC",
          Size: "100MB",
        },
        {
          CacheType: "regular",
          InUse: "false",
          LastUsedAt: "2026-10-14 05:38:53.402492998 +0000 UTC",
          Size: "200MB",
        },
        {
          // 30h old: past the 24h build-cache window (issue #1607) but well
          // inside the 7-day container window, so only cache counts it.
          CacheType: "regular",
          InUse: "false",
          LastUsedAt: "2026-10-13 06:00:00.000000000 +0000 UTC",
          Size: "50MB",
        },
        {
          CacheType: "regular",
          InUse: "true",
          LastUsedAt: "2026-09-01 09:38:53.402492998 +0000 UTC",
          Size: "300MB",
        },
        {
          CacheType: "source.local",
          InUse: "false",
          LastUsedAt: "2026-09-01 09:38:53.402492998 +0000 UTC",
          Size: "400MB",
        },
      ],
    });
    const dangling = new Set(["sha256:dangling-new", "sha256:dangling-used"]);
    expect(estimateSafePrune(verbose, dangling, now)).toBe(
      1000 ** 3 + 10 * 1000 ** 2 + 100 * 1000 ** 2 + 50 * 1000 ** 2,
    );
  });

  it("reports per-tier estimates, excluding volumes from the aggressive tier", async () => {
    const df =
      '{"Type":"Images","TotalCount":"3","Active":"1","Size":"3GB","Reclaimable":"2GB (66%)"}\n' +
      '{"Type":"Local Volumes","TotalCount":"2","Active":"1","Size":"1GB","Reclaimable":"500MB (50%)"}\n' +
      '{"Type":"Build Cache","TotalCount":"2","Active":"0","Size":"1GB","Reclaimable":"1GB"}\n';
    const verbose = JSON.stringify({
      Images: [{ ID: "sha256:d", Containers: "0", UniqueSize: "1GB" }],
      Containers: [],
      BuildCache: [],
    });
    const spawn: SpawnDocker = (command, args) => {
      const joined = args.join(" ");
      const stdout = joined.includes("-v")
        ? verbose
        : joined.startsWith("images")
          ? "sha256:d\n"
          : df;
      return fakeSpawn({ stdout }).spawn(command, args);
    };
    await expect(inspectDockerStorage(spawn)).resolves.toMatchObject({
      available: true,
      estimates: { safeBytes: 1000 ** 3, aggressiveBytes: 3 * 1000 ** 3 },
    });
  });

  it("keeps Docker available with an unknown safe estimate when the verbose call fails", async () => {
    const df = '{"Type":"Images","TotalCount":"1","Active":"0","Size":"1GB","Reclaimable":"1GB"}\n';
    const spawn: SpawnDocker = (command, args) =>
      args.includes("-v") || args[0] === "images"
        ? fakeSpawn({ stderr: "nope", code: 1 }).spawn(command, args)
        : fakeSpawn({ stdout: df }).spawn(command, args);
    await expect(inspectDockerStorage(spawn)).resolves.toMatchObject({
      available: true,
      estimates: { safeBytes: null, aggressiveBytes: 1000 ** 3 },
    });
  });

  it("reports Docker as unavailable on a non-zero exit", async () => {
    const fake = fakeSpawn({ stderr: "permission denied", code: 1 });
    await expect(inspectDockerStorage(fake.spawn)).resolves.toMatchObject({
      available: false,
      error: "permission denied",
    });
  });

  it("bounds combined Docker output and kills a command that exceeds the limit", async () => {
    const fake = fakeSpawn({
      stdout: "x".repeat(600 * 1024),
      stderr: "y".repeat(600 * 1024),
    });
    await expect(inspectDockerStorage(fake.spawn)).resolves.toMatchObject({
      available: false,
      error: "Docker output exceeded the 1 MiB limit",
    });
    expect(fake.child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("rejects a concurrent prune while the first run is active", async () => {
    const fake = fakeSpawn({ hold: true });
    const first = pruneDockerStorage("aggressive", fake.spawn);
    await expect(pruneDockerStorage("safe", fake.spawn)).rejects.toThrow(
      "DOCKER_PRUNE_IN_PROGRESS",
    );
    fake.child.emit("close", 0);
    await expect(first).resolves.toEqual({ output: "", reclaimedBytes: 0 });
  });

  it("kills and rejects a Docker command that exceeds its timeout", async () => {
    vi.useFakeTimers();
    const fake = fakeSpawn({ hold: true });
    const inspection = inspectDockerStorage(fake.spawn);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(inspection).resolves.toMatchObject({
      available: false,
      error: "Docker command timed out",
    });
    expect(fake.child.kill).toHaveBeenCalledWith("SIGKILL");
    vi.useRealTimers();
  });
});
