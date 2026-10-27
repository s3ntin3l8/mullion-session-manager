import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DIR_ENTRY_CONCURRENCY, diskBytes, limited, mapLimit } from "./temp-storage.js";

// A read-only answer to "where is my disk space going?": the biggest entries
// under the user's home directory, a few levels deep. Nothing here deletes
// anything. Entries that one of the cleanup sources already owns are tagged
// (`coveredBy`), so the page can tell what Mullion can clean from what only the
// user can decide about.
//
// It shares temp-storage's syscall limiter, so a walk of a big home directory
// never puts more than a handful of calls on the disk at once, however many
// other measurements run alongside.

const DEFAULT_DEPTH = 3;
const DEFAULT_TOP = 25;
// Below the top level only the few biggest children of each directory are kept.
const CHILDREN_KEPT = 8;
// A walk that has looked at this many entries stops counting and says so, the
// way temp-storage's WALK_ENTRY_CAP bounds its walks: a home directory full of
// `node_modules` can otherwise mean minutes of disk churn per run.
const ENTRY_CAP = 3_000_000;

export interface SpaceEntry {
  path: string;
  /** Allocated bytes, matching what deleting would free (hard links count per name). */
  bytes: number;
  isDirectory: boolean;
  /** What cleanup source owns this path, when one does (e.g. "uv"). */
  coveredBy?: string;
  /** The biggest entries inside it; absent at the deepest level and for files. */
  children?: SpaceEntry[];
}

export interface SpaceReport {
  available: boolean;
  root: string;
  entries: SpaceEntry[];
  /** Everything under `root` on its own filesystem. */
  scannedBytes: number;
  /** Used space on `root`'s filesystem, from statfs. */
  filesystemUsedBytes: number;
  /** Used space the walk didn't account for: outside `root`, or unreadable. */
  outsideBytes: number;
  /** Directories that couldn't be read; their contents are in `outsideBytes`. */
  unreadableEntries: number;
  /** The walk hit its entry cap: every figure is a lower bound. */
  truncated: boolean;
  error?: string;
}

export interface SpaceReportOptions {
  /** Defaults to the user's home directory. */
  root?: string;
  depth?: number;
  top?: number;
  /** Test seam: how many entries to look at before stopping. */
  entryCap?: number;
  /** Absolute paths owned by a cleanup source, and what to call it. */
  covered?: ReadonlyArray<{ path: string; label: string }>;
}

interface Walk {
  dev: number;
  maxDepth: number;
  top: number;
  unreadable: number;
  /** Entries still allowed; below zero the walk has hit its cap. */
  left: number;
}

// `depth` is the depth of `dir` itself; the root is 0.
async function measure(
  dir: string,
  depth: number,
  walk: Walk,
): Promise<{ bytes: number; children: SpaceEntry[] }> {
  let names: string[];
  try {
    names = await limited(() => fs.readdir(dir));
  } catch {
    walk.unreadable += 1;
    return { bytes: 0, children: [] };
  }
  const listing = depth < walk.maxDepth;
  const parts = await mapLimit(names, DIR_ENTRY_CONCURRENCY, async (name) => {
    if (--walk.left < 0) return null;
    const full = path.join(dir, name);
    try {
      const st = await limited(() => fs.lstat(full));
      let bytes = diskBytes(st);
      // A directory on another device (a mount point) is not this disk's space.
      if (st.isDirectory() && st.dev === walk.dev) {
        const inside = await measure(full, depth + 1, walk);
        bytes += inside.bytes;
        return {
          path: full,
          bytes,
          isDirectory: true,
          ...(inside.children.length > 0 ? { children: inside.children } : {}),
        } satisfies SpaceEntry;
      }
      return { path: full, bytes, isDirectory: st.isDirectory() } satisfies SpaceEntry;
    } catch {
      return null; // vanished mid-walk
    }
  });
  const entries = parts.filter((part): part is SpaceEntry => part !== null);
  const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (!listing) return { bytes, children: [] };
  const keep = depth === 0 ? walk.top : CHILDREN_KEPT;
  const children = entries
    .filter((entry) => entry.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, keep);
  return { bytes, children };
}

function tag(entries: SpaceEntry[], covered: ReadonlyMap<string, string>): void {
  for (const entry of entries) {
    const label = covered.get(entry.path);
    if (label !== undefined) entry.coveredBy = label;
    if (entry.children) tag(entry.children, covered);
  }
}

export async function inspectSpaceReport(options: SpaceReportOptions = {}): Promise<SpaceReport> {
  const root = options.root ?? os.homedir();
  const unavailable: SpaceReport = {
    available: false,
    root,
    entries: [],
    scannedBytes: 0,
    filesystemUsedBytes: 0,
    outsideBytes: 0,
    unreadableEntries: 0,
    truncated: false,
  };
  try {
    const rootStat = await limited(() => fs.stat(root));
    if (!rootStat.isDirectory()) return { ...unavailable, error: `${root} is not a directory` };
    const walk: Walk = {
      dev: rootStat.dev,
      maxDepth: options.depth ?? DEFAULT_DEPTH,
      top: options.top ?? DEFAULT_TOP,
      unreadable: 0,
      left: options.entryCap ?? ENTRY_CAP,
    };
    const [{ bytes, children }, fsStats] = await Promise.all([
      measure(root, 0, walk),
      fs.statfs(root),
    ]);
    tag(children, new Map((options.covered ?? []).map((c) => [c.path, c.label])));
    const filesystemUsedBytes = (fsStats.blocks - fsStats.bfree) * fsStats.bsize;
    return {
      available: true,
      root,
      entries: children,
      scannedBytes: bytes,
      filesystemUsedBytes,
      outsideBytes: Math.max(0, filesystemUsedBytes - bytes),
      unreadableEntries: walk.unreadable,
      truncated: walk.left < 0,
    };
  } catch (error) {
    return {
      ...unavailable,
      error: error instanceof Error ? error.message : "Could not measure disk usage",
    };
  }
}
