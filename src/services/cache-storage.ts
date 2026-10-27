import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dirSize } from "./temp-storage.js";

// A fixed allowlist of re-creatable cache directories (issue #1606): mostly
// subtrees of ~/.cache, plus a few toolchain caches that live elsewhere under
// the home directory (`base: "home"`). The
// ids are all a client ever supplies (via settings); the paths never come from
// outside, so nothing beyond these directories can be targeted. Everything in
// here is rebuilt or re-downloaded on next use, which is why cleaning is opt-in
// per cache and only ever runs in the aggressive tier.
export const CACHE_DIRS = [
  { id: "ms-playwright", label: "Playwright browsers", dir: "ms-playwright", base: "cache" },
  { id: "huggingface", label: "Hugging Face models", dir: "huggingface", base: "cache" },
  { id: "pre-commit", label: "pre-commit environments", dir: "pre-commit", base: "cache" },
  { id: "pip", label: "pip", dir: "pip", base: "cache" },
  { id: "go-build", label: "Go build cache", dir: "go-build", base: "cache" },
  { id: "uv", label: "uv", dir: "uv", base: "cache" },
  // Go writes module files read-only; see `removeEntry`. Default location only
  // (GOMODCACHE / GOPATH aren't consulted).
  { id: "go-mod", label: "Go module cache", dir: "go/pkg/mod", base: "home" },
  { id: "gradle", label: "Gradle caches", dir: ".gradle/caches", base: "home" },
  { id: "cargo-registry", label: "Cargo registry", dir: ".cargo/registry", base: "home" },
] as const;

export type CacheDirId = (typeof CACHE_DIRS)[number]["id"];
export const CACHE_DIR_IDS: readonly CacheDirId[] = CACHE_DIRS.map((c) => c.id);

export interface CacheStorageOptions {
  /** Defaults to `~/.cache`. */
  cacheRoot?: string;
  /** Defaults to the user's home directory. */
  homeDir?: string;
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
}

export interface CachePruneResult {
  output: string;
  reclaimedBytes: number;
  /** Set when some entries couldn't be removed; the rest still were. */
  error?: string;
}

const homeDir = (options: CacheStorageOptions) => options.homeDir ?? os.homedir();
const cacheRoot = (options: CacheStorageOptions) =>
  options.cacheRoot ?? path.join(homeDir(options), ".cache");
const cachePath = (entry: (typeof CACHE_DIRS)[number], options: CacheStorageOptions) =>
  path.join(entry.base === "home" ? homeDir(options) : cacheRoot(options), entry.dir);

// Go makes everything it unpacks read-only (directories included), so a plain
// recursive remove fails with EACCES. Make directories writable on the way down
// first; symlinks are never followed.
async function makeWritable(target: string): Promise<void> {
  const st = await fs.lstat(target);
  if (!st.isDirectory()) return;
  await fs.chmod(target, st.mode | 0o700);
  for (const name of await fs.readdir(target)) await makeWritable(path.join(target, name));
}

// Only for the cache that is read-only by design: elsewhere an entry that can't
// be removed is a real problem to report, not something to chmod around.
async function removeEntry(target: string, readOnlyByDesign: boolean): Promise<void> {
  try {
    await fs.rm(target, { recursive: true, force: true });
  } catch (error) {
    if (!readOnlyByDesign || (error as NodeJS.ErrnoException).code !== "EACCES") throw error;
    await makeWritable(target);
    await fs.rm(target, { recursive: true, force: true });
  }
}

/** Where each allowlisted cache lives, for callers that need to recognise the paths. */
export function cacheDirPaths(
  options: CacheStorageOptions = {},
): Array<{ id: CacheDirId; label: string; path: string }> {
  return CACHE_DIRS.map((entry) => ({
    id: entry.id,
    label: entry.label,
    path: cachePath(entry, options),
  }));
}

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
  for (const entry of CACHE_DIRS) {
    const { id, label } = entry;
    const full = cachePath(entry, options);
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
  // Check-and-set with no await between them: JS runs this synchronously, so a
  // second concurrent request can never slip past the guard.
  if (pruneRunning) throw new Error("CACHE_PRUNE_IN_PROGRESS");
  pruneRunning = true;
  try {
    const selected = sanitizeCacheDirIds(ids);
    let reclaimedBytes = 0;
    const cleaned: string[] = [];
    const errors: string[] = [];
    for (const entry of CACHE_DIRS.filter((c) => selected.includes(c.id))) {
      const { id } = entry;
      const full = cachePath(entry, options);
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
          await removeEntry(path.join(full, name), id === "go-mod");
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
