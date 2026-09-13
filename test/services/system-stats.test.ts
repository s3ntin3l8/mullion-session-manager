import { describe, expect, it, vi } from "vitest";
import {
  filesystemSeverity,
  sampleSystemStats,
  type StatsDependencies,
} from "../../src/services/system-stats.js";

const GIB = 1024 ** 3;

function dependencies(
  devices: Record<string, number>,
  volumes: Record<string, { blocks: number; bavail: number; bsize: number }>,
): StatsDependencies {
  return {
    cpus: () => Array.from({ length: 8 }, () => ({}) as ReturnType<StatsDependencies["cpus"]>[0]),
    loadavg: () => [1.25, 0, 0],
    totalmem: () => 64 * GIB,
    freemem: () => 16 * GIB,
    stat: vi.fn(async (target) => {
      const device = devices[String(target)];
      if (device === undefined) throw new Error("EACCES");
      return { dev: device } as Awaited<ReturnType<StatsDependencies["stat"]>>;
    }),
    statfs: vi.fn(async (target) => {
      const volume = volumes[String(target)];
      if (!volume) throw new Error("EACCES");
      return volume as Awaited<ReturnType<StatsDependencies["statfs"]>>;
    }),
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
