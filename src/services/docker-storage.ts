import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

const OUTPUT_LIMIT_BYTES = 1024 * 1024;
const VERBOSE_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const SAFE_CONTAINER_AGE_MS = 168 * 60 * 60 * 1000;
// Build cache is cheap to regenerate and piles up fastest, so safe cleanup
// frees it after a day instead of a week (issue #1607). Today's cache stays.
const SAFE_BUILD_CACHE_AGE_MS = 24 * 60 * 60 * 1000;
// On the containerd image store `until=` compares against the image's local
// record time (last tag/untag), and an image only becomes dangling when a newer
// build takes its tag, so an age filter on images never matches. Dangling
// images are therefore pruned at any age; everything except build cache keeps
// the 7-day window.
export const DOCKER_SAFE_PRUNE_STEPS: ReadonlyArray<readonly string[]> = [
  ["image", "prune", "--force"],
  ["container", "prune", "--force", "--filter", "until=168h"],
  ["network", "prune", "--force", "--filter", "until=168h"],
  ["builder", "prune", "--force", "--filter", "until=24h"],
];
// Never --volumes: volumes hold data. --all also removes unused tagged images.
export const DOCKER_PRUNE_AGGRESSIVE_ARGS = ["system", "prune", "--all", "--force"] as const;
const DOCKER_USAGE_ARGS = ["system", "df", "--format", "{{json .}}"] as const;
const DOCKER_VERBOSE_USAGE_ARGS = ["system", "df", "-v", "--format", "{{json .}}"] as const;
const DOCKER_DANGLING_IMAGES_ARGS = [
  "images",
  "--filter",
  "dangling=true",
  "--no-trunc",
  "--format",
  "{{.ID}}",
] as const;

export type DockerPruneMode = "safe" | "aggressive";

export interface DockerPruneResult {
  output: string;
  reclaimedBytes: number;
  /** Set when a multi-step cleanup stopped early; earlier steps still freed space. */
  error?: string;
}

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
  /** What each cleanup tier is expected to free; `safeBytes` is null if it couldn't be computed. */
  estimates: { safeBytes: number | null; aggressiveBytes: number };
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

export function parseReclaimed(output: string): number {
  // `builder prune` prints "Total:\t<size>"; the other prunes print "Total reclaimed space: <size>".
  const match = output.match(/^Total(?: reclaimed space)?:\s*(.+)$/im);
  return match ? parseSize(match[1]) : 0;
}

// Docker prints "2026-10-14 09:10:26 +0200 CEST" (images/containers) and
// "2026-10-08 09:38:53.402492998 +0000 UTC" (build cache).
function parseDockerDate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)? ([+-]\d{2})(\d{2})/,
  );
  if (!match) return null;
  const time = Date.parse(`${match[1]}T${match[2]}${match[3]}:${match[4]}`);
  return Number.isNaN(time) ? null : time;
}

/**
 * Mirrors the "safe" cleanup against `docker system df -v` output: dangling
 * images at any age, plus stopped containers older than 7 days and unused
 * regular build cache older than 24 hours. Summing per-image unique sizes slightly understates
 * layers shared between dangling images, so treat the result as an estimate.
 */
export function estimateSafePrune(
  verboseJson: string,
  danglingImageIds: ReadonlySet<string>,
  now: number = Date.now(),
): number {
  const df = JSON.parse(verboseJson) as Record<string, Array<Record<string, unknown>> | undefined>;
  const isOld = (value: unknown, ageMs: number) => {
    const time = parseDockerDate(value);
    return time !== null && now - time > ageMs;
  };
  let total = 0;
  for (const image of df.Images ?? []) {
    if (danglingImageIds.has(String(image.ID)) && String(image.Containers) === "0") {
      total += parseSize(image.UniqueSize);
    }
  }
  for (const container of df.Containers ?? []) {
    if (container.State !== "running" && isOld(container.CreatedAt, SAFE_CONTAINER_AGE_MS)) {
      total += parseSize(container.Size);
    }
  }
  for (const entry of df.BuildCache ?? []) {
    if (
      entry.CacheType === "regular" &&
      String(entry.InUse) === "false" &&
      isOld(entry.LastUsedAt || entry.CreatedAt, SAFE_BUILD_CACHE_AGE_MS)
    ) {
      total += parseSize(entry.Size);
    }
  }
  return total;
}

async function runDocker(
  args: readonly string[],
  spawnDocker: SpawnDocker = (command, commandArgs) => spawn(command, commandArgs),
  outputLimitBytes: number = OUTPUT_LIMIT_BYTES,
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
      if (outputBytes > outputLimitBytes) {
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

async function estimateSafeBytes(spawnDocker?: SpawnDocker): Promise<number | null> {
  try {
    const [verbose, dangling] = await Promise.all([
      runDocker(DOCKER_VERBOSE_USAGE_ARGS, spawnDocker, VERBOSE_OUTPUT_LIMIT_BYTES),
      runDocker(DOCKER_DANGLING_IMAGES_ARGS, spawnDocker),
    ]);
    const ids = new Set(
      dangling
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
    return estimateSafePrune(verbose, ids);
  } catch {
    return null;
  }
}

export async function inspectDockerStorage(
  spawnDocker?: SpawnDocker,
): Promise<DockerStorageStatus> {
  try {
    const [usage, safeBytes] = await Promise.all([
      runDocker(DOCKER_USAGE_ARGS, spawnDocker),
      estimateSafeBytes(spawnDocker),
    ]);
    const rows = parseDockerUsage(usage);
    return {
      available: true,
      rows,
      totalSizeBytes: rows.reduce((sum, row) => sum + row.sizeBytes, 0),
      reclaimableBytes: rows.reduce((sum, row) => sum + row.reclaimableBytes, 0),
      estimates: {
        safeBytes,
        aggressiveBytes: rows
          .filter((row) => row.type !== "Local Volumes")
          .reduce((sum, row) => sum + row.reclaimableBytes, 0),
      },
    };
  } catch (error) {
    return {
      available: false,
      rows: [],
      totalSizeBytes: 0,
      reclaimableBytes: 0,
      estimates: { safeBytes: null, aggressiveBytes: 0 },
      error: error instanceof Error ? error.message : "Docker is unavailable",
    };
  }
}

// This guard relies on this service being loaded once through Node's ESM
// module cache; keep every route importing this canonical .js specifier.
let pruneRunning = false;

export async function pruneDockerStorage(
  mode: DockerPruneMode = "safe",
  spawnDocker?: SpawnDocker,
): Promise<DockerPruneResult> {
  if (pruneRunning) throw new Error("DOCKER_PRUNE_IN_PROGRESS");
  pruneRunning = true;
  try {
    const steps = mode === "aggressive" ? [DOCKER_PRUNE_AGGRESSIVE_ARGS] : DOCKER_SAFE_PRUNE_STEPS;
    let output = "";
    let reclaimedBytes = 0;
    let completedSteps = 0;
    for (const args of steps) {
      let stepOutput: string;
      try {
        stepOutput = await runDocker(args, spawnDocker);
      } catch (error) {
        if (completedSteps === 0) throw error;
        return {
          output,
          reclaimedBytes,
          error: error instanceof Error ? error.message : "Docker cleanup failed",
        };
      }
      completedSteps += 1;
      output += stepOutput;
      reclaimedBytes += parseReclaimed(stepOutput);
    }
    return { output, reclaimedBytes };
  } finally {
    pruneRunning = false;
  }
}
