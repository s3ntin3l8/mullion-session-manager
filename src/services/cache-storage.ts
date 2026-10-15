import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dirSize } from "./temp-storage.js";

// A fixed allowlist of re-creatable subtrees of ~/.cache (issue #1606). The
// ids are all a client ever supplies (via settings); the paths never come from
// outside, so nothing beyond these directories can be targeted. Everything in
// here is rebuilt or re-downloaded on next use, which is why cleaning is opt-in
// per cache and only ever runs in the aggressive tier.
export const CACHE_DIRS = [
  { id: "ms-playwright", label: "Playwright browsers", dir: "ms-playwright" },
  { id: "huggingface", label: "Hugging Face models", dir: "huggingface" },
  { id: "pre-commit", label: "pre-commit environments", dir: "pre-commit" },
  { id: "pip", label: "pip", dir: "pip" },
  { id: "go-build", label: "Go build cache", dir: "go-build" },
] as const;

export type CacheDirId = (typeof CACHE_DIRS)[number]["id"];
export const CACHE_DIR_IDS: readonly CacheDirId[] = CACHE_DIRS.map((c) => c.id);

export interface CacheStorageOptions {
  /** Defaults to `~/.cache`. */
  cacheRoot?: string;
}

export interface CacheDirStatus {
  id: CacheDirId;
  label: string;
  bytes: number;
  exists: boolean;
}

export interface CacheStorageStatus {
  available: boolean;
  root: string;
  caches: CacheDirStatus[];
  error?: string;
}

export interface CachePruneResult {
  output: string;
  reclaimedBytes: number;
  /** Set when some entries couldn't be removed; the rest still were. */
  error?: string;
}

const cacheRoot = (options: CacheStorageOptions) =>
  options.cacheRoot ?? path.join(os.homedir(), ".cache");

/** Keeps only known ids, once each, in allowlist order. */
export function sanitizeCacheDirIds(value: unknown): CacheDirId[] {
  const wanted = new Set(Array.isArray(value) ? value : []);
  return CACHE_DIR_IDS.filter((id) => wanted.has(id));
}

// A cache dir that is itself a symlink (e.g. ~/.cache/huggingface -> a data
// disk) is left alone: removing "its contents" would reach through the link.
async function realDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.lstat(dir)).isDirectory();
  } catch {
    return false;
  }
}

export async function inspectCacheStorage(
  options: CacheStorageOptions = {},
): Promise<CacheStorageStatus> {
  const root = cacheRoot(options);
  const caches: CacheDirStatus[] = [];
  for (const { id, label, dir } of CACHE_DIRS) {
    const full = path.join(root, dir);
    const exists = await realDirectory(full);
    caches.push({ id, label, exists, bytes: exists ? await dirSize(full) : 0 });
  }
  return { available: true, root, caches };
}

let pruneRunning = false;

/**
 * Empties the selected caches (leaving the directories themselves), ignoring
 * any id that isn't on the allowlist. One entry that can't be removed doesn't
 * stop the others.
 */
export async function pruneCacheStorage(
  ids: readonly string[],
  options: CacheStorageOptions = {},
): Promise<CachePruneResult> {
  if (pruneRunning) throw new Error("CACHE_PRUNE_IN_PROGRESS");
  pruneRunning = true;
  try {
    const root = cacheRoot(options);
    const selected = sanitizeCacheDirIds(ids);
    let reclaimedBytes = 0;
    const cleaned: string[] = [];
    const errors: string[] = [];
    for (const { id, dir } of CACHE_DIRS.filter((c) => selected.includes(c.id))) {
      const full = path.join(root, dir);
      if (!(await realDirectory(full))) continue;
      const before = await dirSize(full);
      let names: string[] = [];
      try {
        names = await fs.readdir(full);
      } catch (error) {
        // Unreadable or vanished since the check above: report it, move on.
        if (errors.length < 3) {
          errors.push(`${id}: ${error instanceof Error ? error.message : "cannot read directory"}`);
        }
        continue;
      }
      for (const name of names) {
        try {
          await fs.rm(path.join(full, name), { recursive: true, force: true });
        } catch (error) {
          if (errors.length < 3) {
            errors.push(
              `${id}/${name}: ${error instanceof Error ? error.message : "remove failed"}`,
            );
          }
        }
      }
      reclaimedBytes += Math.max(0, before - (await dirSize(full)));
      cleaned.push(id);
    }
    return {
      output: `Cleaned ${String(cleaned.length)} cache${cleaned.length === 1 ? "" : "s"}${
        cleaned.length > 0 ? `: ${cleaned.join(", ")}` : ""
      }.`,
      reclaimedBytes,
      ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
    };
  } finally {
    pruneRunning = false;
  }
}
