import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

const OUTPUT_LIMIT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
export const DOCKER_PRUNE_ARGS = ["system", "prune", "--force", "--filter", "until=168h"] as const;
const DOCKER_USAGE_ARGS = ["system", "df", "--format", "{{json .}}"] as const;

export interface DockerUsageRow {
  type: string;
  totalCount: number;
  activeCount: number;
  sizeBytes: number;
  reclaimableBytes: number;
}

export interface DockerStorageStatus {
  available: boolean;
  rows: DockerUsageRow[];
  totalSizeBytes: number;
  reclaimableBytes: number;
  error?: string;
}

export type SpawnDocker = (
  command: string,
  args: readonly string[],
) => ChildProcessWithoutNullStreams;

function parseSize(value: unknown): number {
  if (typeof value !== "string") return 0;
  const match = value.trim().match(/^([\d.]+)\s*([kmgtp]?i?b)/i);
  if (!match) return 0;
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1000,
    kib: 1024,
    mb: 1000 ** 2,
    mib: 1024 ** 2,
    gb: 1000 ** 3,
    gib: 1024 ** 3,
    tb: 1000 ** 4,
    tib: 1024 ** 4,
    pb: 1000 ** 5,
    pib: 1024 ** 5,
  };
  return Math.round(Number(match[1]) * (multipliers[match[2].toLowerCase()] ?? 1));
}

export function parseDockerUsage(output: string): DockerUsageRow[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .map((row) => ({
      type: String(row.Type ?? "Unknown"),
      totalCount: Number(row.TotalCount ?? 0),
      activeCount: Number(row.Active ?? 0),
      sizeBytes: parseSize(row.Size),
      reclaimableBytes: parseSize(row.Reclaimable),
    }));
}

async function runDocker(
  args: readonly string[],
  spawnDocker: SpawnDocker = (command, commandArgs) => spawn(command, commandArgs),
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnDocker("docker", args);
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Docker command timed out"));
    }, COMMAND_TIMEOUT_MS);
    timer.unref();
    const append = (current: string, chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > OUTPUT_LIMIT_BYTES) {
        child.kill("SIGKILL");
        finish(new Error("Docker output exceeded the 1 MiB limit"));
        return current;
      }
      return current + chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(stderr.trim() || `Docker exited with code ${String(code)}`));
    });
  });
}

export async function inspectDockerStorage(
  spawnDocker?: SpawnDocker,
): Promise<DockerStorageStatus> {
  try {
    const rows = parseDockerUsage(await runDocker(DOCKER_USAGE_ARGS, spawnDocker));
    return {
      available: true,
      rows,
      totalSizeBytes: rows.reduce((sum, row) => sum + row.sizeBytes, 0),
      reclaimableBytes: rows.reduce((sum, row) => sum + row.reclaimableBytes, 0),
    };
  } catch (error) {
    return {
      available: false,
      rows: [],
      totalSizeBytes: 0,
      reclaimableBytes: 0,
      error: error instanceof Error ? error.message : "Docker is unavailable",
    };
  }
}

let pruneRunning = false;

export async function pruneDockerStorage(spawnDocker?: SpawnDocker): Promise<{ output: string }> {
  if (pruneRunning) throw new Error("DOCKER_PRUNE_IN_PROGRESS");
  pruneRunning = true;
  try {
    return { output: await runDocker(DOCKER_PRUNE_ARGS, spawnDocker) };
  } finally {
    pruneRunning = false;
  }
}
