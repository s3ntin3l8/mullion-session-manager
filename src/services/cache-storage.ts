import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { diskBytes, dirSize } from "./temp-storage.js";
import type { CacheDirId, CacheDirStatus, CacheStorageStatus } from "../shared/types.js";
export type { CacheDirId, CacheDirStatus, CacheStorageStatus } from "../shared/types.js";

// A fixed allowlist of re-creatable cache directories (issue #1606): mostly
// subtrees of ~/.cache, plus a few toolchain caches that live elsewhere under
// the home directory (`base: "home"`). The
// ids are all a client ever supplies (via settings); the paths never come from
// outside, so nothing beyond these directories can be targeted. Everything in
// here is rebuilt or re-downloaded on next use, which is why cleaning is opt-in
// per cache and only ever runs in the aggressive tier.
const CACHE_DIRS = [
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
  { id: "gh", label: "GitHub CLI", dir: "gh", base: "cache" },
  {
    id: "claude-cli-nodejs",
    label: "Claude Code CLI cache",
    dir: "claude-cli-nodejs",
    base: "cache",
  },
  // `npx` unpacks packages here and runs them from here, e.g. an MCP server
  // an agent session launched: an entry some process still references is kept
  // (see `entriesInUse`).
  { id: "npm-npx", label: "npx packages", dir: ".npm/_npx", base: "home", skipInUse: true },
  // Emptied for good, not moved anywhere, which is why it is opt-in like the
  // rest. `files` and `info` are put back so the next trash operation works
  // even for a tool that doesn't create them.
  {
    id: "trash",
    label: "Trash",
    dir: ".local/share/Trash",
    base: "home",
    recreate: ["files", "info"],
    permanent: true,
  },
  // Agent CLIs keep every version they download. Only the old ones go: see
  // `keepEntries` for what is always kept (newest, running, `current`).
  {
    id: "claude-versions",
    label: "Claude Code binaries (old versions)",
    dir: ".local/share/claude/versions",
    base: "home",
    skipInUse: true,
    keepNewest: true,
  },
  {
    id: "claude-remote-cli",
    label: "Claude Code remote CLI (old versions)",
    dir: ".claude/remote/ccd-cli",
    base: "home",
    skipInUse: true,
    keepNewest: true,
  },
  {
    id: "minimax-releases",
    label: "MiniMax Code releases (old versions)",
    dir: ".minimax-code/releases",
    base: "home",
    skipInUse: true,
    keepNewest: true,
  },
] as const satisfies ReadonlyArray<{
  id: CacheDirId;
  label: string;
  dir: string;
  base: "cache" | "home";
  skipInUse?: boolean;
  /**
   * Children are versions: the newest is kept, and so is any a running process
   * executes or a `current` symlink points at. Unparsable names are kept.
   */
  keepNewest?: boolean;
  recreate?: readonly string[];
  /** Not rebuilt or re-downloaded afterwards: the UI must say so. */
  permanent?: boolean;
}>;

// The other direction from the `satisfies` above: every shared CacheDirId has
// an entry here, so the union (src/shared/api-types/storage.ts) cannot grow an
// id no table produces.
const _everyCacheDirIdHasAnEntry: Exclude<
  CacheDirId,
  (typeof CACHE_DIRS)[number]["id"]
> extends never
  ? true
  : never = true;

export const CACHE_DIR_IDS: readonly CacheDirId[] = CACHE_DIRS.map((c) => c.id);

export interface CacheStorageOptions {
  /** Defaults to `~/.cache`. */
  cacheRoot?: string;
  /** Defaults to the user's home directory. */
  homeDir?: string;
  /** Test seam: the /proc scanned for processes using a `skipInUse` cache. */
  procDir?: string;
  /** Test seam for the `skipInUse` grace window; defaults to the real clock. */
  now?: number;
}

// An entry created or touched this recently is kept: `npx` makes `<hash>/`
// before any process references it by path, so a cleanup landing mid-install
// would otherwise delete the tree under it.
const IN_USE_GRACE_MS = 10 * 60 * 1000;

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

/**
 * Which of `candidates` (absolute paths) appear in a running process's command
 * line or working directory. Unreadable processes are skipped, so this can miss
 * one owned by another user; every cache using it lives in the user's own home,
 * where only their own processes run.
 */
async function entriesInUse(
  candidates: readonly string[],
  procDir = "/proc",
  now = Date.now(),
  checkExe = false,
): Promise<Set<string>> {
  const used = new Set<string>();
  // The kernel reports a process's cwd with symlinks resolved, and tools that
  // resolve themselves (npm's `.bin` shims use `readlink -f`) put the real path
  // in argv, so each candidate is matched in both spellings.
  const spellings = await Promise.all(
    candidates.map(async (candidate) => {
      const real = await fs.realpath(candidate).catch(() => candidate);
      return { candidate, forms: real === candidate ? [candidate] : [candidate, real] };
    }),
  );
  // Recently modified entries are in use whether or not anything names them yet.
  for (const { candidate } of spellings) {
    const mtimeMs = await fs
      .lstat(candidate)
      .then((st) => st.mtimeMs)
      .catch(() => now);
    if (now - mtimeMs < IN_USE_GRACE_MS) used.add(candidate);
  }
  let pids: string[];
  try {
    pids = (await fs.readdir(procDir)).filter((n) => /^\d+$/.test(n));
  } catch {
    // Can't tell what runs: the caller treats every entry as in use.
    return new Set(candidates);
  }
  for (const pid of pids) {
    let cmdline = "";
    let cwd = "";
    let exe = "";
    try {
      cmdline = (await fs.readFile(path.join(procDir, pid, "cmdline"), "utf8")).replaceAll(
        "\0",
        " ",
      );
    } catch {
      // exited, or not ours
    }
    try {
      cwd = await fs.readlink(path.join(procDir, pid, "cwd"));
    } catch {
      // exited, or not ours
    }
    if (checkExe) {
      // A binary run from a version directory: the kernel reports its resolved
      // path (with " (deleted)" appended if unlinked, which then matches nothing).
      try {
        const target = await fs.readlink(path.join(procDir, pid, "exe"));
        exe = await fs.realpath(target).catch(() => target);
      } catch {
        // exited, kernel thread, or not ours
      }
    }
    const inside = (p: string, f: string) => p !== "" && (p === f || p.startsWith(f + path.sep));
    for (const { candidate, forms } of spellings) {
      if (
        forms.some(
          (f) => cmdline.includes(f) || cwd === f || cwd.startsWith(f + path.sep) || inside(exe, f),
        )
      ) {
        used.add(candidate);
      }
    }
  }
  return used;
}

const VERSION_RE = /^(\d+(?:\.\d+)*)/;

function compareVersions(a: string, b: string): number {
  const pa = (VERSION_RE.exec(a)?.[1] ?? "").split(".").map(Number);
  const pb = (VERSION_RE.exec(b)?.[1] ?? "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The newest by leading dotted number; a name without one is never newest. */
function newestVersion(names: readonly string[]): string | undefined {
  let newest: string | undefined;
  for (const name of names) {
    if (!VERSION_RE.test(name)) continue;
    if (newest === undefined || compareVersions(name, newest) > 0) newest = name;
  }
  return newest;
}

/** Real targets of the symlinks named `current` beside, or one level above, the versions. */
async function currentTargets(full: string): Promise<string[]> {
  const targets: string[] = [];
  for (const dir of [full, path.dirname(full)]) {
    const link = path.join(dir, "current");
    try {
      if ((await fs.lstat(link)).isSymbolicLink()) targets.push(await fs.realpath(link));
    } catch {
      // absent, or a dangling link (which names nothing to keep)
    }
  }
  return targets;
}

/**
 * The children of `full` a cleanup must leave alone (absolute paths). Anything
 * that can't be determined counts as kept; an unreadable /proc keeps them all.
 */
async function keepEntries(
  entry: (typeof CACHE_DIRS)[number],
  full: string,
  names: readonly string[],
  options: CacheStorageOptions,
): Promise<Set<string>> {
  const keepNewest = "keepNewest" in entry && entry.keepNewest === true;
  if (!("skipInUse" in entry && entry.skipInUse) && !keepNewest) return new Set();
  const keep = await entriesInUse(
    names.map((n) => path.join(full, n)),
    options.procDir,
    options.now,
    keepNewest,
  );
  if (!keepNewest) return keep;
  const newest = newestVersion(names);
  const targets = await currentTargets(full);
  for (const name of names) {
    const child = path.join(full, name);
    if (name === newest || !VERSION_RE.test(name)) {
      keep.add(child);
      continue;
    }
    const real = await fs.realpath(child).catch(() => child);
    if (targets.some((t) => t === real || t.startsWith(real + path.sep))) keep.add(child);
  }
  return keep;
}

async function entrySize(target: string): Promise<number> {
  try {
    const st = await fs.lstat(target);
    return diskBytes(st) + (st.isDirectory() ? await dirSize(target) : 0);
  } catch {
    return 0;
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
    let bytes = 0;
    if (exists && "keepNewest" in entry && entry.keepNewest) {
      // Only what ticking the toggle would free.
      const names = await fs.readdir(full).catch(() => [] as string[]);
      const keep = await keepEntries(entry, full, names, options);
      for (const name of names) {
        if (!keep.has(path.join(full, name))) bytes += await entrySize(path.join(full, name));
      }
    } else if (exists) {
      bytes = await dirSize(full);
    }
    caches.push({
      id,
      label,
      exists,
      bytes,
      permanent: "permanent" in entry && entry.permanent === true,
    });
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
      const keep = await keepEntries(entry, full, names, options);
      for (const name of names) {
        if (keep.has(path.join(full, name))) continue;
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
      for (const sub of "recreate" in entry ? entry.recreate : []) {
        await fs.mkdir(path.join(full, sub), { recursive: true, mode: 0o700 }).catch(() => {});
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
