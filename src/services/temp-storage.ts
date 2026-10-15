import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Stats } from "node:fs";

const SAFE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const AGGRESSIVE_AGE_MS = 24 * 60 * 60 * 1000;
// A tree this large is more likely a live workspace than leftover scratch;
// skipping it is the conservative answer to "can't prove it's all stale".
const WALK_ENTRY_CAP = 200_000;
const NPM_TIMEOUT_MS = 120_000;

// Live tool caches and per-user runtime dirs other processes expect to find.
const DENYLIST: ReadonlyArray<RegExp> = [
  /^tmux-/,
  /^ssh-/,
  /^systemd-private-/,
  /^\.X11-unix$/,
  /^\.ICE-unix$/,
  /^\.font-unix$/,
  /^snap-private-tmp$/,
  /^node-compile-cache$/,
  /^tsx-/,
];

export type TempPruneMode = "safe" | "aggressive";

export interface TempPruneResult {
  output: string;
  reclaimedBytes: number;
  /** Set when cleanup stopped early; earlier removals still freed space. */
  error?: string;
}

export interface TempStorageStatus {
  available: boolean;
  root: string;
  estimates: { safeBytes: number; aggressiveBytes: number };
  candidates: { safe: number; aggressive: number };
  error?: string;
}

export interface TempStorageOptions {
  root?: string;
  /** Directory holding the npm cache (`~/.npm`); aggressive mode only. */
  npmCacheDir?: string;
  now?: number;
  /** Test seam; defaults to the real uid. */
  uid?: number;
  runNpmCacheClean?: () => Promise<string>;
}

interface Candidate {
  name: string;
  fullPath: string;
  bytes: number;
  newestMtimeMs: number;
}

interface WalkResult {
  bytes: number;
  newestMtimeMs: number;
  /** Socket seen, device boundary crossed, or entry cap hit. */
  unsafe: boolean;
}

async function walk(dir: string, rootDev: number, budget: { left: number }): Promise<WalkResult> {
  const result: WalkResult = { bytes: 0, newestMtimeMs: 0, unsafe: false };
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return { ...result, unsafe: true };
  }
  for (const name of names) {
    if (--budget.left < 0) return { ...result, unsafe: true };
    let st: Stats;
    try {
      st = await fs.lstat(path.join(dir, name));
    } catch {
      continue; // vanished between readdir and lstat
    }
    if (st.isSocket() || st.dev !== rootDev) return { ...result, unsafe: true };
    result.bytes += st.size;
    result.newestMtimeMs = Math.max(result.newestMtimeMs, st.mtimeMs);
    if (st.isDirectory()) {
      const child = await walk(path.join(dir, name), rootDev, budget);
      result.bytes += child.bytes;
      result.newestMtimeMs = Math.max(result.newestMtimeMs, child.newestMtimeMs);
      if (child.unsafe) result.unsafe = true;
    }
  }
  return result;
}

async function listCandidates(
  root: string,
  uid: number,
): Promise<{ entries: Candidate[]; rootDev: number }> {
  const rootStat = await fs.lstat(root);
  const entries: Candidate[] = [];
  for (const name of await fs.readdir(root)) {
    if (DENYLIST.some((re) => re.test(name))) continue;
    const fullPath = path.join(root, name);
    let st: Stats;
    try {
      st = await fs.lstat(fullPath);
    } catch {
      continue;
    }
    if (st.uid !== uid || st.isSocket() || st.dev !== rootStat.dev) continue;
    let bytes = st.size;
    let newest = st.mtimeMs;
    if (st.isDirectory()) {
      const tree = await walk(fullPath, rootStat.dev, { left: WALK_ENTRY_CAP });
      if (tree.unsafe) continue;
      bytes += tree.bytes;
      newest = Math.max(newest, tree.newestMtimeMs);
    }
    entries.push({ name, fullPath, bytes, newestMtimeMs: newest });
  }
  return { entries, rootDev: rootStat.dev };
}

function olderThan(entries: Candidate[], ageMs: number, now: number): Candidate[] {
  return entries.filter((entry) => now - entry.newestMtimeMs > ageMs);
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    try {
      const st = await fs.lstat(path.join(dir, name));
      total += st.size;
      if (st.isDirectory()) total += await dirSize(path.join(dir, name));
    } catch {
      // vanished mid-walk
    }
  }
  return total;
}

function npmCachePath(options: TempStorageOptions): string {
  return path.join(options.npmCacheDir ?? path.join(os.homedir(), ".npm"), "_cacache");
}

function defaultNpmCacheClean(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["cache", "clean", "--force"]);
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("npm cache clean timed out"));
    }, NPM_TIMEOUT_MS);
    timer.unref();
    const append = (chunk: Buffer) => {
      if (output.length < 64 * 1024) output += chunk.toString("utf8");
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(output.trim() || `npm exited with code ${String(code)}`));
    });
  });
}

export async function inspectTempStorage(
  options: TempStorageOptions = {},
): Promise<TempStorageStatus> {
  const root = options.root ?? os.tmpdir();
  const now = options.now ?? Date.now();
  const uid = options.uid ?? process.getuid?.() ?? -1;
  try {
    const { entries } = await listCandidates(root, uid);
    const safe = olderThan(entries, SAFE_AGE_MS, now);
    const aggressive = olderThan(entries, AGGRESSIVE_AGE_MS, now);
    const npmBytes = await dirSize(npmCachePath(options));
    return {
      available: true,
      root,
      estimates: {
        safeBytes: safe.reduce((sum, e) => sum + e.bytes, 0),
        aggressiveBytes: aggressive.reduce((sum, e) => sum + e.bytes, 0) + npmBytes,
      },
      candidates: { safe: safe.length, aggressive: aggressive.length },
    };
  } catch (error) {
    return {
      available: false,
      root,
      estimates: { safeBytes: 0, aggressiveBytes: 0 },
      candidates: { safe: 0, aggressive: 0 },
      error: error instanceof Error ? error.message : "Temp directory is unavailable",
    };
  }
}

let pruneRunning = false;

export async function pruneTempStorage(
  mode: TempPruneMode = "safe",
  options: TempStorageOptions = {},
): Promise<TempPruneResult> {
  if (pruneRunning) throw new Error("TEMP_PRUNE_IN_PROGRESS");
  pruneRunning = true;
  try {
    const root = options.root ?? os.tmpdir();
    const now = options.now ?? Date.now();
    const uid = options.uid ?? process.getuid?.() ?? -1;
    // Recomputed here, never taken from an earlier preview.
    const { entries } = await listCandidates(root, uid);
    const targets = olderThan(
      entries,
      mode === "aggressive" ? AGGRESSIVE_AGE_MS : SAFE_AGE_MS,
      now,
    );
    let reclaimedBytes = 0;
    let removed = 0;
    for (const target of targets) {
      try {
        await fs.rm(target.fullPath, { recursive: true, force: true });
        reclaimedBytes += target.bytes;
        removed += 1;
      } catch (error) {
        return {
          output: `Removed ${String(removed)} temp entries.`,
          reclaimedBytes,
          error: error instanceof Error ? error.message : "Temp cleanup failed",
        };
      }
    }
    let output = `Removed ${String(removed)} temp entries.`;
    if (mode === "aggressive") {
      const before = await dirSize(npmCachePath(options));
      try {
        output += `\n${await (options.runNpmCacheClean ?? defaultNpmCacheClean)()}`;
        reclaimedBytes += before;
      } catch (error) {
        return {
          output,
          reclaimedBytes,
          error: error instanceof Error ? error.message : "npm cache clean failed",
        };
      }
    }
    return { output, reclaimedBytes };
  } finally {
    pruneRunning = false;
  }
}
