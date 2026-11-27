import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  DOCKER_PRUNE_AGGRESSIVE_ARGS,
  DOCKER_SAFE_PRUNE_STEPS,
  DOCKER_VOLUME_PRUNE_ARGS,
  PRUNE_TIMEOUT_MS,
  estimateAggressivePrune,
  estimateSafePrune,
  inspectDockerStorage,
  parseDockerMajorVersion,
  parseDockerUsage,
  parseDockerVolumes,
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
    // The child's stdio are real PassThroughs — the fake writes the
    // canned output into them (a `Readable` has no `write` of its own).
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    Object.assign(emitter, {
      stdout,
      stderr,
      stdin,
      kill: vi.fn(),
    });
    child = emitter;
    calls.push({ command, args });
    if (!options.hold) {
      queueMicrotask(() => {
        if (options.stdout) stdout.write(options.stdout);
        if (options.stderr) stderr.write(options.stderr);
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

  it("estimates the aggressive tier from every unused entry, never volumes", () => {
    const verbose = JSON.stringify({
      Images: [
        { ID: "a", Containers: "0", UniqueSize: "1GB" },
        { ID: "b", Containers: "2", UniqueSize: "9GB" },
      ],
      Containers: [
        { State: "exited", Size: "10MB" },
        { State: "running", Size: "30MB" },
      ],
      BuildCache: [
        { CacheType: "regular", InUse: "false", Size: "100MB" },
        { CacheType: "source.local", InUse: "false", Size: "400MB" },
        { CacheType: "frontend", InUse: "false", Size: "1GB" },
        { CacheType: "regular", InUse: "true", Size: "300MB" },
      ],
      Volumes: [{ Name: "v", Size: "5GB" }],
    });
    expect(estimateAggressivePrune(verbose)).toBe(
      1000 ** 3 + 10 * 1000 ** 2 + 100 * 1000 ** 2 + 400 * 1000 ** 2 + 1000 ** 3,
    );
    expect(estimateAggressivePrune("{}")).toBe(0);
  });

  it("counts all unused build cache when the summary row understates it (containerd store)", async () => {
    const df =
      '{"Type":"Images","TotalCount":"2","Active":"2","Size":"3GB","Reclaimable":"0B"}\n' +
      '{"Type":"Build Cache","TotalCount":"3","Active":"0","Size":"6.5GB","Reclaimable":"1.1GB"}\n';
    const verbose = JSON.stringify({
      Images: [],
      Containers: [],
      BuildCache: [
        { CacheType: "regular", InUse: "false", Size: "1.1GB" },
        { CacheType: "source.local", InUse: "false", Size: "2.4GB" },
        { CacheType: "frontend", InUse: "false", Size: "3GB" },
      ],
    });
    const spawn: SpawnDocker = (command, args) => {
      const joined = args.join(" ");
      const stdout = joined.includes("-v") ? verbose : joined.startsWith("images") ? "" : df;
      return fakeSpawn({ stdout }).spawn(command, args);
    };
    await expect(inspectDockerStorage(spawn)).resolves.toMatchObject({
      estimates: { aggressiveBytes: 6.5 * 1000 ** 3 },
    });
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

  it("lets a prune run past the read timeout, up to its own longer bound", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeSpawn({ hold: true });
      let settled = false;
      const prune = pruneDockerStorage("aggressive", fake.spawn);
      prune.then(
        () => (settled = true),
        () => (settled = true),
      );
      const rejected = expect(prune).rejects.toThrow("Docker command timed out");
      // An aggressive prune of a few GB routinely outlasts 30 s.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(false);
      expect(fake.child.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(PRUNE_TIMEOUT_MS);
      await rejected;
      expect(fake.child.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  describe("volumes", () => {
    const anon = (c: string) => c.repeat(64);
    const verbose = JSON.stringify({
      Images: [],
      Containers: [],
      BuildCache: [],
      Volumes: [
        { Name: anon("a"), Links: "0", Size: "68MB" },
        { Name: anon("b"), Links: 0, Size: "32MB" },
        { Name: anon("c"), Links: "2", Size: "10MB" },
        { Name: "pgdata", Links: "0", Size: "1GB" },
        { Name: "uploads", Links: "1", Size: "500MB" },
        { Name: anon("D"), Links: "0", Size: "1MB" },
        { Name: "a".repeat(63), Links: "0", Size: "1MB" },
        { Name: anon("e"), Links: "N/A", Size: "5MB" },
        { Name: anon("f"), Size: "5MB" },
        { Name: anon("1"), Links: null, Size: "5MB" },
        { Name: anon("2"), Links: false, Size: "5MB" },
        { Size: "5MB", Links: "0" },
        "junk",
        null,
      ],
    });

    it("splits anonymous unused, anonymous in use and named, skipping malformed rows", () => {
      expect(parseDockerVolumes(verbose)).toEqual({
        anonymousUnused: { count: 2, bytes: 100 * 1000 ** 2 },
        inUse: { count: 1, bytes: 10 * 1000 ** 2 },
        // Uppercase and 63-character hex names are named volumes by the rule.
        named: { count: 4, bytes: 1000 ** 3 + 500 * 1000 ** 2 + 2 * 1000 ** 2 },
      });
    });

    it("is empty when there are no volumes", () => {
      expect(parseDockerVolumes("{}").named).toEqual({ count: 0, bytes: 0 });
      expect(parseDockerVolumes('{"Volumes":null}').anonymousUnused.count).toBe(0);
    });

    it("reports volumes from the verbose call and omits them when it fails", async () => {
      const df =
        '{"Type":"Images","TotalCount":"1","Active":"0","Size":"1GB","Reclaimable":"1GB"}\n';
      const ok: SpawnDocker = (command, args) =>
        fakeSpawn({
          stdout: args.includes("-v") ? verbose : args[0] === "images" ? "" : df,
        }).spawn(command, args);
      const status = await inspectDockerStorage(ok);
      expect(status.volumes?.anonymousUnused.count).toBe(2);
      const failing: SpawnDocker = (command, args) =>
        args.includes("-v")
          ? fakeSpawn({ stderr: "nope", code: 1 }).spawn(command, args)
          : fakeSpawn({ stdout: args[0] === "images" ? "" : df }).spawn(command, args);
      const failed = await inspectDockerStorage(failing);
      expect(failed.available).toBe(true);
      expect("volumes" in failed).toBe(false);
    });
  });
});

// A spawn that answers `docker version` with the given text (or a failure) and
// everything else with a canned prune output, recording every argv.
function versionedSpawn(version: { stdout?: string; code?: number }) {
  const calls: string[][] = [];
  const spawn: SpawnDocker = (command, args) => {
    calls.push([...args]);
    const isVersion = args[0] === "version";
    return fakeSpawn(
      isVersion
        ? {
            stdout: version.stdout ?? "",
            code: version.code ?? 0,
            stderr: version.code ? "boom" : "",
          }
        : { stdout: "Total reclaimed space: 1GB\n" },
    ).spawn(command, args);
  };
  return { spawn, calls };
}

describe("Docker volume prune (opt-in)", () => {
  const volumeCalls = (calls: string[][]) => calls.filter((args) => args[0] === "volume");

  it("runs exactly `volume prune --force` after the system prune and adds its reclaimed space", async () => {
    const fake = versionedSpawn({ stdout: "27.3.1\n" });
    const result = await pruneDockerStorage("aggressive", fake.spawn, { pruneVolumes: true });
    expect(fake.calls.map((args) => args[0])).toEqual(["system", "version", "volume"]);
    expect(volumeCalls(fake.calls)).toEqual([["volume", "prune", "--force"]]);
    expect(DOCKER_VOLUME_PRUNE_ARGS).toEqual(["volume", "prune", "--force"]);
    for (const args of volumeCalls(fake.calls)) {
      expect(args).not.toContain("--all");
      expect(args).not.toContain("--filter");
    }
    expect(result.reclaimedBytes).toBe(2 * 1000 ** 3);
    expect(result.note).toBeUndefined();
  });

  it("never runs in safe mode or without the option, and never even reads the version", async () => {
    const safe = versionedSpawn({ stdout: "27.3.1" });
    await pruneDockerStorage("safe", safe.spawn, { pruneVolumes: true });
    expect(safe.calls.map((args) => args[0])).not.toContain("volume");
    expect(safe.calls.map((args) => args[0])).not.toContain("version");
    const off = versionedSpawn({ stdout: "27.3.1" });
    await pruneDockerStorage("aggressive", off.spawn);
    await pruneDockerStorage("aggressive", off.spawn, { pruneVolumes: false });
    expect(off.calls.map((args) => args[0])).toEqual(["system", "system"]);
  });

  it.each(["23.0.0", "23.0", "27.3.1", "v28.0.0-rc1"])("runs on Docker Engine %s", async (v) => {
    const fake = versionedSpawn({ stdout: `${v}\n` });
    await pruneDockerStorage("aggressive", fake.spawn, { pruneVolumes: true });
    expect(volumeCalls(fake.calls)).toHaveLength(1);
  });

  it.each([
    ["22.06.3", "22.06.3"],
    ["20.10.24", "20.10.24"],
    ["latest", "unknown"],
    ["", "unknown"],
  ])("skips with a note on version %j", async (stdout, found) => {
    const fake = versionedSpawn({ stdout });
    const result = await pruneDockerStorage("aggressive", fake.spawn, { pruneVolumes: true });
    expect(volumeCalls(fake.calls)).toEqual([]);
    expect(result.note).toBe(
      `Docker volume cleanup skipped: needs Docker Engine 23+ (found ${found})`,
    );
    expect(result.error).toBeUndefined();
    // The rest of the Docker step still counted.
    expect(result.reclaimedBytes).toBe(1000 ** 3);
  });

  it("skips with 'unknown' when `docker version` fails", async () => {
    const fake = versionedSpawn({ code: 1 });
    const result = await pruneDockerStorage("aggressive", fake.spawn, { pruneVolumes: true });
    expect(volumeCalls(fake.calls)).toEqual([]);
    expect(result.note).toBe(
      "Docker volume cleanup skipped: needs Docker Engine 23+ (found unknown)",
    );
  });

  it("keeps the system prune's progress and reports an error when the volume prune fails", async () => {
    const calls: string[][] = [];
    const spawn: SpawnDocker = (command, args) => {
      calls.push([...args]);
      if (args[0] === "volume")
        return fakeSpawn({ code: 1, stderr: "volume busy" }).spawn(command, args);
      return fakeSpawn({
        stdout: args[0] === "version" ? "27.0.0" : "Total reclaimed space: 1GB",
      }).spawn(command, args);
    };
    const result = await pruneDockerStorage("aggressive", spawn, { pruneVolumes: true });
    expect(result).toMatchObject({ reclaimedBytes: 1000 ** 3, error: "volume busy" });
  });

  it("parses the engine's major version strictly", () => {
    expect(parseDockerMajorVersion("27.3.1\n")).toBe(27);
    expect(parseDockerMajorVersion("23.0")).toBe(23);
    expect(parseDockerMajorVersion("")).toBeNull();
    expect(parseDockerMajorVersion("<no value>")).toBeNull();
    expect(parseDockerMajorVersion("x23.0.1")).toBeNull();
  });
});

describe("Docker aggressive estimate with the volumes opt-in", () => {
  const verbose = JSON.stringify({
    Volumes: [{ Name: "a".repeat(64), Links: 0, Size: "1GB" }],
  });
  const usage = '{"Type":"Images","TotalCount":"0","Active":"0","Size":"0B","Reclaimable":"0B"}\n';
  const spawnFor =
    (version: string): SpawnDocker =>
    (command, args) =>
      fakeSpawn({
        stdout: args[0] === "version" ? version : args.includes("-v") ? verbose : usage,
      }).spawn(command, args);

  it("adds the unused anonymous volumes only when opted in and the engine is 23+", async () => {
    const base = await inspectDockerStorage(spawnFor("27.0.0"));
    expect(base.estimates.aggressiveBytes).toBe(0);
    const on = await inspectDockerStorage(spawnFor("27.0.0"), { countVolumes: true });
    expect(on.estimates.aggressiveBytes).toBe(1000 ** 3);
    const old = await inspectDockerStorage(spawnFor("22.06.3"), { countVolumes: true });
    expect(old.estimates.aggressiveBytes).toBe(0);
  });
});
