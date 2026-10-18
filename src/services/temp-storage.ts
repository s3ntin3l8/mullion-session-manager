import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Stats } from "node:fs";
import {
  defaultClaudeSessionsDir,
  isLivePidFile,
  loadLiveSessions,
  scanClaudeDir,
} from "./claude-scratch.js";

const SAFE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const AGGRESSIVE_AGE_MS = 24 * 60 * 60 * 1000;
// A tree this large is more likely a live workspace than leftover scratch;
// skipping it is the conservative answer to "can't prove it's all stale".
const WALK_ENTRY_CAP = 200_000;
const NPM_TIMEOUT_MS = 120_000;
// How long one look at the running claude binaries stands in for the next
// bundled-skills dir's re-check within a single prune.
const BINARY_RECHECK_MS = 5_000;
// Claude session scratch (issue #1608): a session that is no longer running
// only needs a day's grace in safe mode (long enough to --resume a crash with
// its scratch intact); aggressive takes any dead session, but never a dir
// touched in the last ten minutes, which could belong to a session that is
// still starting up, or one that doesn't register itself in the registry
// (headless/SDK sessions may not: only this window protects those). The same
// windows cover `bundled-skills/<version>` and empty project dirs (issue
// #1614): the latter are only ever removed once they have sat empty this long,
// which is also what keeps a session's two-step `mkdir proj; mkdir proj/<uuid>`
// from racing the cleanup.
const SESSION_SAFE_AGE_MS = 24 * 60 * 60 * 1000;
const SESSION_AGGRESSIVE_AGE_MS = 10 * 60 * 1000;

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
  // Live per-session scratch: tools read it back long after last writing it,
  // so mtime alone can't prove it's stale.
  /^claude-/,
  /^mullion-/,
  /^dbus-/,
];

export type TempPruneMode = "safe" | "aggressive";

export interface TempPruneResult {
  output: string;
  reclaimedBytes: number;
  /** Set when cleanup stopped early; earlier removals still freed space. */
  error?: string;
}

export interface ClaudeScratchStatus {
  /** Why `claude-<uid>` is being left alone entirely, when liveness is unknown. */
  skipped?: string;
  /** Registry files that were skipped but didn't stop the rest. */
  warnings: string[];
}

export interface TempStorageStatus {
  available: boolean;
  root: string;
  estimates: {
    safeBytes: number;
    aggressiveBytes: number;
    /** Part of `aggressiveBytes`: the npm cache, which aggressive cleanup also clears. */
    npmCacheBytes: number;
  };
  candidates: { safe: number; aggressive: number };
  claudeScratch: ClaudeScratchStatus;
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
  /**
   * Claude Code live-session registries (`<config dir>/sessions`), the
   * server's own first; see `loadLiveSessions`.
   */
  claudeSessionsDirs?: string[];
  /** Test seam: the /proc used to find running `claude` binaries. */
  procDir?: string;
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

// Allocated bytes, matching what deleting actually frees.
const diskBytes = (st: Stats) => st.blocks * 512;

// A /tmp with a million files spends minutes waiting on one lstat at a time, so
// the walks run their syscalls concurrently. Every stat/readdir/lstat this
// module's walks make goes through this one limiter, so however many
// directories are being walked at once the disk sees at most FS_CONCURRENCY of
// them in flight. (The Claude-scratch scan in claude-scratch.ts makes its own
// few, sequential calls and is not counted.)
const FS_CONCURRENCY = 16;
// Top-level entries are expanded a few at a time: each one fans out into a whole
// tree of pending promises, and a handful in flight is plenty to keep the
// limiter saturated.
const TOP_LEVEL_CONCURRENCY = 8;
// Entries of one directory are visited this many at a time. The limiter above
// bounds syscalls in flight; this bounds the promises (and suspended frames)
// allocated for a directory with a hundred thousand entries.
const DIR_ENTRY_CONCURRENCY = FS_CONCURRENCY;
let activeFsCalls = 0;
// A queue with a moving head: `Array#shift` is O(length), which made a wide
// directory quadratic.
const fsWaiters: Array<() => void> = [];
let fsWaitersHead = 0;

async function limited<T>(call: () => Promise<T>): Promise<T> {
  if (activeFsCalls < FS_CONCURRENCY) activeFsCalls++;
  else await new Promise<void>((resolve) => fsWaiters.push(resolve));
  try {
    return await call();
  } finally {
    // Hand the slot straight to the next waiter; only free it if nobody waits.
    if (fsWaitersHead < fsWaiters.length) {
      const next = fsWaiters[fsWaitersHead++] as () => void;
      if (fsWaitersHead === fsWaiters.length) {
        fsWaiters.length = 0;
        fsWaitersHead = 0;
      }
      next();
    } else {
      activeFsCalls--;
    }
  }
}

/** Like `Promise.all(items.map(fn))`, with at most `limit` calls running; results keep input order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function walk(dir: string, rootDev: number, budget: { left: number }): Promise<WalkResult> {
  let names: string[];
  try {
    names = await limited(() => fs.readdir(dir));
  } catch {
    return { bytes: 0, newestMtimeMs: 0, unsafe: true };
  }
  const parts = await mapLimit(names, DIR_ENTRY_CONCURRENCY, async (name): Promise<WalkResult> => {
    const part: WalkResult = { bytes: 0, newestMtimeMs: 0, unsafe: false };
    if (--budget.left < 0) return { ...part, unsafe: true };
    let st: Stats;
    try {
      st = await limited(() => fs.lstat(path.join(dir, name)));
    } catch {
      return part; // vanished between readdir and lstat
    }
    if (st.isSocket() || st.dev !== rootDev) {
      // This entry is not removable at all, so the rest of its walk is wasted:
      // exhausting the budget makes every sibling still in flight bail out.
      budget.left = -1;
      return { ...part, unsafe: true };
    }
    part.bytes = diskBytes(st);
    part.newestMtimeMs = st.mtimeMs;
    if (st.isDirectory()) {
      const child = await walk(path.join(dir, name), rootDev, budget);
      part.bytes += child.bytes;
      part.newestMtimeMs = Math.max(part.newestMtimeMs, child.newestMtimeMs);
      part.unsafe = child.unsafe;
    }
    return part;
  });
  return parts.reduce<WalkResult>(
    (total, part) => ({
      bytes: total.bytes + part.bytes,
      newestMtimeMs: Math.max(total.newestMtimeMs, part.newestMtimeMs),
      unsafe: total.unsafe || part.unsafe,
    }),
    { bytes: 0, newestMtimeMs: 0, unsafe: false },
  );
}

async function evaluateEntry(
  root: string,
  rootDev: number,
  uid: number,
  name: string,
): Promise<Candidate | null> {
  if (DENYLIST.some((re) => re.test(name))) return null;
  const fullPath = path.join(root, name);
  let st: Stats;
  try {
    st = await limited(() => fs.lstat(fullPath));
  } catch {
    return null;
  }
  if (st.uid !== uid || st.isSocket() || st.dev !== rootDev) return null;
  let bytes = diskBytes(st);
  let newest = st.mtimeMs;
  if (st.isDirectory()) {
    const tree = await walk(fullPath, rootDev, { left: WALK_ENTRY_CAP });
    if (tree.unsafe) return null;
    bytes += tree.bytes;
    newest = Math.max(newest, tree.newestMtimeMs);
  }
  return { name, fullPath, bytes, newestMtimeMs: newest };
}

async function listCandidates(
  root: string,
  uid: number,
): Promise<{ entries: Candidate[]; names: string[]; rootDev: number }> {
  const rootDev = (await limited(() => fs.stat(root))).dev;
  const names = await limited(() => fs.readdir(root));
  const evaluated = await mapLimit(names, TOP_LEVEL_CONCURRENCY, (name) =>
    evaluateEntry(root, rootDev, uid, name),
  );
  const entries = evaluated.filter((entry): entry is Candidate => entry !== null);
  return { entries, names, rootDev };
}

interface TargetWindows {
  safeMs: number;
  aggressiveMs: number;
}

/** What a removable entry is; the first two are re-checked against liveness before removal. */
type TargetSpec = TargetWindows &
  (
    | { kind: "session"; sessionId: string }
    | { kind: "bundled"; version: string }
    | { kind: "temp" | "empty-project" | "loose" }
  );

type Target = TargetSpec & { entry: Candidate };

const windowFor = (target: Target, mode: TempPruneMode) =>
  mode === "aggressive" ? target.aggressiveMs : target.safeMs;

const isDue = (target: Target, mode: TempPruneMode, now: number) =>
  now - target.entry.newestMtimeMs > windowFor(target, mode);

/**
 * Every removable top-level temp entry, plus what lives under `claude-<uid>`:
 * session scratch, `bundled-skills/<version>` for versions no running
 * `claude` uses, empty project dirs, and loose files and directories. That
 * tree is skipped entirely whenever the registries of running sessions can't
 * be read: unknown must never count as "not running".
 */
async function gatherTargets(
  root: string,
  uid: number,
  options: TempStorageOptions,
): Promise<{ targets: Target[]; rootDev: number; claudeScratch: ClaudeScratchStatus }> {
  const { entries, names, rootDev } = await listCandidates(root, uid);
  const targets: Target[] = entries.map((entry) => ({
    entry,
    kind: "temp",
    safeMs: SAFE_AGE_MS,
    aggressiveMs: AGGRESSIVE_AGE_MS,
  }));
  const claudeScratch: ClaudeScratchStatus = { warnings: [] };
  // One registry read serves every claude-<uid> dir (they belong to one user);
  // the per-removal re-check in pruneTempStorage reads it again on purpose.
  const registryDirs = options.claudeSessionsDirs ?? [defaultClaudeSessionsDir()];
  let live: Awaited<ReturnType<typeof loadLiveSessions>> | undefined;
  const offer = async (fullPath: string, spec: TargetSpec) => {
    const entry = await evaluateEntry(
      path.dirname(fullPath),
      rootDev,
      uid,
      path.basename(fullPath),
    );
    if (entry) targets.push({ ...spec, entry });
  };
  for (const name of names) {
    if (!/^claude-/.test(name)) continue;
    const claudeDir = path.join(root, name);
    try {
      // First stat of this entry (the generic pass above skips claude-* on the
      // denylist before statting): also guards against it having been swapped
      // for a symlink or moved across filesystems since listCandidates.
      const st = await limited(() => fs.lstat(claudeDir));
      if (!st.isDirectory() || st.uid !== uid || st.dev !== rootDev) continue;
    } catch {
      continue;
    }
    live ??= await loadLiveSessions(registryDirs, { procDir: options.procDir });
    if (live.blocked) {
      claudeScratch.skipped = live.blocked;
      continue;
    }
    let scan;
    try {
      scan = await scanClaudeDir(claudeDir);
    } catch {
      continue;
    }
    const session = { safeMs: SESSION_SAFE_AGE_MS, aggressiveMs: SESSION_AGGRESSIVE_AGE_MS };
    for (const item of scan.sessions) {
      if (live.ids.has(item.sessionId)) continue;
      await offer(item.fullPath, { kind: "session", sessionId: item.sessionId, ...session });
    }
    // Unknown is not "unused": if any running session's version couldn't be
    // established, no version dir can be proven stale.
    if (live.versionsComplete) {
      for (const item of scan.bundledVersions) {
        if (live.versions.has(item.version)) continue;
        await offer(item.fullPath, { kind: "bundled", version: item.version, ...session });
      }
    }
    for (const fullPath of scan.emptyProjects) {
      await offer(fullPath, { kind: "empty-project", ...session });
    }
    for (const fullPath of scan.loose) {
      if (await isLivePidFile(fullPath)) continue;
      await offer(fullPath, {
        kind: "loose",
        safeMs: SAFE_AGE_MS,
        aggressiveMs: AGGRESSIVE_AGE_MS,
      });
    }
  }
  if (live) claudeScratch.warnings = live.warnings;
  return { targets, rootDev, claudeScratch };
}

export async function dirSize(dir: string): Promise<number> {
  let names: string[];
  try {
    names = await limited(() => fs.readdir(dir));
  } catch {
    return 0;
  }
  const sizes = await mapLimit(names, DIR_ENTRY_CONCURRENCY, async (name) => {
    try {
      const st = await limited(() => fs.lstat(path.join(dir, name)));
      return diskBytes(st) + (st.isDirectory() ? await dirSize(path.join(dir, name)) : 0);
    } catch {
      return 0; // vanished mid-walk
    }
  });
  return sizes.reduce((sum, size) => sum + size, 0);
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
    const { targets, claudeScratch } = await gatherTargets(root, uid, options);
    const safe = targets.filter((t) => isDue(t, "safe", now));
    const aggressive = targets.filter((t) => isDue(t, "aggressive", now));
    const npmBytes = await dirSize(npmCachePath(options));
    return {
      available: true,
      root,
      estimates: {
        safeBytes: safe.reduce((sum, t) => sum + t.entry.bytes, 0),
        aggressiveBytes: aggressive.reduce((sum, t) => sum + t.entry.bytes, 0) + npmBytes,
        npmCacheBytes: npmBytes,
      },
      candidates: { safe: safe.length, aggressive: aggressive.length },
      claudeScratch,
    };
  } catch (error) {
    return {
      available: false,
      root,
      estimates: { safeBytes: 0, aggressiveBytes: 0, npmCacheBytes: 0 },
      candidates: { safe: 0, aggressive: 0 },
      claudeScratch: { warnings: [] },
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
    const gathered = await gatherTargets(root, uid, options);
    const targets = gathered.targets.filter((t) => isDue(t, mode, now));
    const rootDev = gathered.rootDev;
    const registryDirs = options.claudeSessionsDirs ?? [defaultClaudeSessionsDir()];
    // Which versions are running is one answer for every bundled-skills dir, but
    // it costs a pass over /proc: reuse it for a few seconds rather than per dir.
    let binaries: { at: number; live: Awaited<ReturnType<typeof loadLiveSessions>> } | undefined;
    let reclaimedBytes = 0;
    let removed = 0;
    const errors: string[] = [];
    for (const target of targets) {
      const { entry } = target;
      // A big rm -r can take minutes and listing happened up front: re-check
      // right before removal so something that started using this entry in
      // the meantime is left alone.
      const fresh = await evaluateEntry(
        path.dirname(entry.fullPath),
        rootDev,
        uid,
        path.basename(entry.fullPath),
      );
      if (!fresh || now - fresh.newestMtimeMs <= windowFor(target, mode)) continue;
      if (target.kind === "session" || target.kind === "bundled") {
        // A session may have started since listing; ask the registries again.
        if (target.kind === "bundled" && binaries && Date.now() - binaries.at > BINARY_RECHECK_MS) {
          binaries = undefined;
        }
        const live =
          target.kind === "bundled" && binaries
            ? binaries.live
            : await loadLiveSessions(registryDirs, {
                procDir: options.procDir,
                includeBinaries: target.kind === "bundled",
              });
        if (target.kind === "bundled") binaries ??= { at: Date.now(), live };
        if (live.blocked) continue;
        if (target.kind === "session" && live.ids.has(target.sessionId)) continue;
        if (
          target.kind === "bundled" &&
          (!live.versionsComplete || live.versions.has(target.version))
        ) {
          continue;
        }
      }
      if (target.kind === "loose" && (await isLivePidFile(fresh.fullPath))) continue;
      try {
        if (target.kind === "empty-project") {
          // rmdir, not rm -r: a session that created its first child since
          // listing makes this fail, which is exactly the answer wanted.
          try {
            await fs.rmdir(fresh.fullPath);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOTEMPTY" || code === "ENOENT") continue;
            throw error;
          }
        } else {
          await fs.rm(fresh.fullPath, { recursive: true, force: true });
        }
        reclaimedBytes += fresh.bytes;
        removed += 1;
      } catch (error) {
        // One stubborn entry (e.g. a root-owned file inside) must not block the rest.
        errors.push(`${entry.name}: ${error instanceof Error ? error.message : "remove failed"}`);
      }
    }
    let output = `Removed ${String(removed)} temp entries.`;
    const tempError = errors.length > 0 ? errors.slice(0, 3).join("; ") : undefined;
    if (mode === "aggressive") {
      const before = await dirSize(npmCachePath(options));
      try {
        output += `\n${await (options.runNpmCacheClean ?? defaultNpmCacheClean)()}`;
        reclaimedBytes += before;
      } catch (error) {
        return {
          output,
          reclaimedBytes,
          error: [tempError, error instanceof Error ? error.message : "npm cache clean failed"]
            .filter(Boolean)
            .join("; "),
        };
      }
    }
    return { output, reclaimedBytes, ...(tempError ? { error: tempError } : {}) };
  } finally {
    pruneRunning = false;
  }
}
