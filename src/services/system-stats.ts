import fs from "node:fs/promises";
import os from "node:os";

export type ResourceSeverity = "normal" | "warning" | "critical";

export interface MonitoredPath {
  label: string;
  path: string;
}

export interface FilesystemStat {
  labels: string[];
  paths: string[];
  available: boolean;
  totalBytes?: number;
  freeBytes?: number;
  freePercent?: number;
  severity?: ResourceSeverity;
  error?: string;
}

export interface StatsDependencies {
  cpus: typeof os.cpus;
  loadavg: typeof os.loadavg;
  totalmem: typeof os.totalmem;
  freemem: typeof os.freemem;
  stat: typeof fs.stat;
  statfs: typeof fs.statfs;
  now: () => Date;
}

const defaultDependencies: StatsDependencies = {
  cpus: os.cpus,
  loadavg: os.loadavg,
  totalmem: os.totalmem,
  freemem: os.freemem,
  stat: fs.stat,
  statfs: fs.statfs,
  now: () => new Date(),
};

const GIB = 1024 ** 3;

export function filesystemSeverity(freeBytes: number, totalBytes: number): ResourceSeverity {
  const freePercent = totalBytes > 0 ? (freeBytes / totalBytes) * 100 : 0;
  if (freePercent < 5 || freeBytes < 5 * GIB) return "critical";
  if (freePercent < 15 || freeBytes < 20 * GIB) return "warning";
  return "normal";
}

export async function sampleSystemStats(
  monitoredPaths: MonitoredPath[],
  dependencies: StatsDependencies = defaultDependencies,
) {
  const filesystems = new Map<string, FilesystemStat>();
  const unavailable: FilesystemStat[] = [];

  for (const target of monitoredPaths) {
    try {
      const stat = await dependencies.stat(target.path);
      const key = String(stat.dev);
      const existing = filesystems.get(key);
      if (existing) {
        if (!existing.paths.includes(target.path)) existing.paths.push(target.path);
        if (!existing.labels.includes(target.label)) existing.labels.push(target.label);
        continue;
      }
      const volume = await dependencies.statfs(target.path);
      const totalBytes = Number(volume.blocks) * Number(volume.bsize);
      const freeBytes = Number(volume.bavail) * Number(volume.bsize);
      filesystems.set(key, {
        labels: [target.label],
        paths: [target.path],
        available: true,
        totalBytes,
        freeBytes,
        freePercent: totalBytes > 0 ? (freeBytes / totalBytes) * 100 : 0,
        severity: filesystemSeverity(freeBytes, totalBytes),
      });
    } catch {
      unavailable.push({
        labels: [target.label],
        paths: [target.path],
        available: false,
        error: "Path is inaccessible",
      });
    }
  }

  return {
    sampledAt: dependencies.now().toISOString(),
    cpu: {
      logicalCores: dependencies.cpus().length,
      loadAverage1m: dependencies.loadavg()[0] ?? 0,
    },
    memory: { totalBytes: dependencies.totalmem(), freeBytes: dependencies.freemem() },
    filesystems: [...filesystems.values(), ...unavailable],
  };
}
