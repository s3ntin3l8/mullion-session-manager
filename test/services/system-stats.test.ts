import { describe, expect, it, vi } from "vitest";
import type {
  BigIntStats,
  BigIntStatsFs,
  PathLike,
  StatFsOptions,
  StatOptions,
  Stats,
  StatsFs,
} from "node:fs";
import {
  filesystemSeverity,
  sampleSystemStats,
  type StatsDependencies,
} from "../../src/services/system-stats.js";

const GIB = 1024 ** 3;

/**
 * fs.stat and fs.statfs are OVERLOADED — the `bigint: true` variants return
 * BigIntStats/BigIntStatsFs, the plain variants Stats/StatsFs — and
 * StatsDependencies asks for exactly those overloads. A vi.fn() carries a
 * single call signature, so it can never satisfy that type on its own: the
 * two wrappers below restate the overload set and forward to the recorder.
 * Object.assign copies the recorder's `mock` context (and its
 * `_isMockFunction` marker) onto the wrapper, so
 * `expect(deps.statfs).toHaveBeenCalledTimes(n)` still sees every call.
 *
 * The sampler only ever calls the one-argument form, so the recorder
 * ignores the options argument entirely.
 */
function statDouble(recorder: (path: PathLike) => Promise<Stats>): StatsDependencies["stat"] {
  function stat(path: PathLike): Promise<Stats>;
  function stat(
    path: PathLike,
    opts?: StatOptions & { bigint?: false | undefined; throwIfNoEntry?: true | undefined },
  ): Promise<Stats>;
  function stat(
    path: PathLike,
    opts: StatOptions & { bigint: true; throwIfNoEntry?: true | undefined },
  ): Promise<BigIntStats>;
  function stat(
    path: PathLike,
    opts: StatOptions & { bigint?: false | undefined; throwIfNoEntry: false },
  ): Promise<Stats | undefined>;
  function stat(
    path: PathLike,
    opts: StatOptions & { bigint: true; throwIfNoEntry: false },
  ): Promise<BigIntStats | undefined>;
  function stat(
    path: PathLike,
    opts: StatOptions & { throwIfNoEntry?: true | undefined },
  ): Promise<Stats | BigIntStats>;
  function stat(path: PathLike, opts?: StatOptions): Promise<Stats | BigIntStats | undefined>;
  function stat(path: PathLike, _opts?: StatOptions): Promise<Stats | BigIntStats | undefined> {
    return recorder(path);
  }
  return Object.assign(stat, recorder);
}

function statfsDouble(recorder: (path: PathLike) => Promise<StatsFs>): StatsDependencies["statfs"] {
  function statfs(path: PathLike): Promise<StatsFs>;
  function statfs(
    path: PathLike,
    opts: StatFsOptions & { bigint: true; throwIfNoEntry?: true | undefined },
  ): Promise<BigIntStatsFs>;
  function statfs(path: PathLike, opts?: StatFsOptions): Promise<StatsFs | BigIntStatsFs>;
  function statfs(path: PathLike, _opts?: StatFsOptions): Promise<StatsFs | BigIntStatsFs> {
    return recorder(path);
  }
  return Object.assign(statfs, recorder);
}

function dependencies(
  devices: Record<string, number>,
  volumes: Record<string, { blocks: number; bavail: number; bsize: number }>,
): StatsDependencies {
  const stat = vi.fn(async (target: PathLike): Promise<Stats> => {
    const device = devices[String(target)];
    if (device === undefined) throw new Error("EACCES");
    return { dev: device } as Stats;
  });
  const statfs = vi.fn(async (target: PathLike): Promise<StatsFs> => {
    const volume = volumes[String(target)];
    if (!volume) throw new Error("EACCES");
    return volume as StatsFs;
  });
  return {
    cpus: () => Array.from({ length: 8 }, () => ({}) as ReturnType<StatsDependencies["cpus"]>[0]),
    loadavg: () => [1.25, 0, 0],
    totalmem: () => 64 * GIB,
    freemem: () => 16 * GIB,
    stat: statDouble(stat),
    statfs: statfsDouble(statfs),
    now: () => new Date("2026-09-13T12:00:00.000Z"),
  };
}

describe("system resource sampling", () => {
  it("classifies exact boundaries conservatively without treating them as below", () => {
    expect(filesystemSeverity(20 * GIB, 100 * GIB)).toBe("normal");
    expect(filesystemSeverity(15 * GIB, 100 * GIB)).toBe("warning");
    expect(filesystemSeverity(5 * GIB, 100 * GIB)).toBe("warning");
    expect(filesystemSeverity(4 * GIB, 100 * GIB)).toBe("critical");
  });

  it("reports CPU/RAM, warning and critical volumes, deduplicates devices, and retains inaccessible paths", async () => {
    const deps = dependencies(
      { "/home": 1, "/cwd": 1, "/warn": 2, "/critical": 3 },
      {
        "/home": { blocks: 100, bavail: 50, bsize: GIB },
        "/warn": { blocks: 100, bavail: 14, bsize: GIB },
        "/critical": { blocks: 100, bavail: 4, bsize: GIB },
      },
    );
    const result = await sampleSystemStats(
      [
        { label: "Home", path: "/home" },
        { label: "Working directory", path: "/cwd" },
        { label: "Projects", path: "/warn" },
        { label: "Data", path: "/critical" },
        { label: "Missing", path: "/missing" },
      ],
      deps,
    );

    expect(result.sampledAt).toBe("2026-09-13T12:00:00.000Z");
    expect(result.cpu).toEqual({ logicalCores: 8, loadAverage1m: 1.25 });
    expect(result.memory).toEqual({ totalBytes: 64 * GIB, freeBytes: 16 * GIB });
    expect(result.filesystems).toHaveLength(4);
    expect(result.filesystems[0]).toMatchObject({
      labels: ["Home", "Working directory"],
      paths: ["/home", "/cwd"],
      severity: "normal",
    });
    expect(result.filesystems[1]).toMatchObject({ severity: "warning" });
    expect(result.filesystems[2]).toMatchObject({ severity: "critical" });
    expect(result.filesystems[3]).toEqual({
      labels: ["Missing"],
      paths: ["/missing"],
      available: false,
      error: "Path is inaccessible",
    });
    expect(deps.statfs).toHaveBeenCalledTimes(3);
  });
});
