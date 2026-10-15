import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Stats } from "node:fs";
import {
  defaultClaudeSessionsDir,
  listClaudeScratchEntries,
  loadLiveSessionIds,
} from "./claude-scratch.js";

const SAFE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const AGGRESSIVE_AGE_MS = 24 * 60 * 60 * 1000;
// A tree this large is more likely a live workspace than leftover scratch;
// skipping it is the conservative answer to "can't prove it's all stale".
const WALK_ENTRY_CAP = 200_000;
const NPM_TIMEOUT_MS = 120_000;
// Claude session scratch (issue #1608): a session that is no longer running
// only needs a day's grace in safe mode (long enough to --resume a crash with
// its scratch intact); aggressive takes any dead session, but never a dir
// touched in the last ten minutes, which could belong to a session that is
// still starting up, or one that doesn't register itself in the registry.
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
  /** Directory holding Claude Code's live-session registry (`~/.claude/sessions`). */
  claudeSessionsDir?: string;
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
    result.bytes += diskBytes(st);
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
    st = await fs.lstat(fullPath);
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
  const rootDev = (await fs.stat(root)).dev;
  const entries: Candidate[] = [];
  const names = await fs.readdir(root);
  for (const name of names) {
    const entry = await evaluateEntry(root, rootDev, uid, name);
    if (entry) entries.push(entry);
  }
  return { entries, names, rootDev };
}

interface Target {
  entry: Candidate;
  /** Set for Claude session directories; liveness is re-checked before removal. */
  sessionId?: string;
  safeMs: number;
  aggressiveMs: number;
}

const windowFor = (target: Target, mode: TempPruneMode) =>
  mode === "aggressive" ? target.aggressiveMs : target.safeMs;

const isDue = (target: Target, mode: TempPruneMode, now: number) =>
  now - target.entry.newestMtimeMs > windowFor(target, mode);

/**
 * Every removable top-level temp entry, plus Claude session scratch under
 * `claude-<uid>`. That tree is skipped entirely whenever the registry of
 * running sessions can't be read: unknown must never count as "not running".
 */
async function gatherTargets(
  root: string,
  uid: number,
  options: TempStorageOptions,
): Promise<{ targets: Target[]; rootDev: number }> {
  const { entries, names, rootDev } = await listCandidates(root, uid);
  const targets: Target[] = entries.map((entry) => ({
    entry,
    safeMs: SAFE_AGE_MS,
    aggressiveMs: AGGRESSIVE_AGE_MS,
  }));
  // One registry read serves every claude-<uid> dir (they belong to one user);
  // the per-removal re-check in pruneTempStorage reads it again on purpose.
  const registryDir = options.claudeSessionsDir ?? defaultClaudeSessionsDir();
  let live: Set<string> | null | undefined;
  for (const name of names) {
    if (!/^claude-/.test(name)) continue;
    const claudeDir = path.join(root, name);
    try {
      const st = await fs.lstat(claudeDir);
      if (!st.isDirectory() || st.uid !== uid || st.dev !== rootDev) continue;
    } catch {
      continue;
    }
    live ??= await loadLiveSessionIds(registryDir);
    if (live === null) continue;
    let scratch;
    try {
      scratch = await listClaudeScratchEntries(claudeDir);
    } catch {
      continue;
    }
    for (const item of scratch) {
      if (live.has(item.sessionId)) continue;
      const entry = await evaluateEntry(
        path.dirname(item.fullPath),
        rootDev,
        uid,
        path.basename(item.fullPath),
      );
      if (!entry) continue;
      targets.push({
        entry,
        sessionId: item.sessionId,
        safeMs: SESSION_SAFE_AGE_MS,
        aggressiveMs: SESSION_AGGRESSIVE_AGE_MS,
      });
    }
  }
  return { targets, rootDev };
}

export async function dirSize(dir: string): Promise<number> {
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
      total += diskBytes(st);
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
    const { targets } = await gatherTargets(root, uid, options);
    const safe = targets.filter((t) => isDue(t, "safe", now));
    const aggressive = targets.filter((t) => isDue(t, "aggressive", now));
    const npmBytes = await dirSize(npmCachePath(options));
    return {
      available: true,
      root,
      estimates: {
        safeBytes: safe.reduce((sum, t) => sum + t.entry.bytes, 0),
        aggressiveBytes: aggressive.reduce((sum, t) => sum + t.entry.bytes, 0) + npmBytes,
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
    const gathered = await gatherTargets(root, uid, options);
    const targets = gathered.targets.filter((t) => isDue(t, mode, now));
    const rootDev = gathered.rootDev;
    const registryDir = options.claudeSessionsDir ?? defaultClaudeSessionsDir();
    let reclaimedBytes = 0;
    let removed = 0;
    const errors: string[] = [];
    const emptiedParents = new Set<string>();
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
      if (target.sessionId !== undefined) {
        // A session may have started since listing; ask the registry again.
        const live = await loadLiveSessionIds(registryDir);
        if (live === null || live.has(target.sessionId)) continue;
      }
      try {
        await fs.rm(fresh.fullPath, { recursive: true, force: true });
        reclaimedBytes += fresh.bytes;
        removed += 1;
        if (target.sessionId !== undefined) emptiedParents.add(path.dirname(fresh.fullPath));
      } catch (error) {
        // One stubborn entry (e.g. a root-owned file inside) must not block the rest.
        errors.push(`${entry.name}: ${error instanceof Error ? error.message : "remove failed"}`);
      }
    }
    for (const parent of emptiedParents) {
      // Drop a project dir once its last session is gone; rmdir refuses a
      // non-empty one, which is exactly the check wanted here.
      await fs.rmdir(parent).catch(() => undefined);
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
