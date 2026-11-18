// Hook-independent startup evidence. Discovery is deliberately conservative:
// unreadable directories/files or an unbounded search mean "unknown", never
// "no turn". Task worktrees give each worker a distinct launch cwd.
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { openInsideRoots, readTranscriptFile } from "./session-transcript.js";
import type { TranscriptFormat } from "./session-transcript.js";

export interface TurnStartSearch {
  format: TranscriptFormat;
  roots: string[];
  cwd: string;
  since: number;
}

/** Codex's session_meta is written when its rollout is created, before output.
 * Claude's user entry is written before its first provider request. */
export async function discoverTurnStarted(search: TurnStartSearch): Promise<boolean | null> {
  try {
    if (search.roots.length === 0) return null;
    const candidates: string[] = [];
    let visited = 0;
    async function walk(dir: string, depth: number): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (++visited > 4000) throw new Error("startup transcript search limit");
        const file = path.join(dir, entry.name);
        if (entry.isDirectory() && depth > 0) {
          await walk(file, depth - 1);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          if ((await stat(file)).mtimeMs >= search.since) candidates.push(file);
        } else if (entry.isSymbolicLink()) {
          throw new Error("unverifiable transcript symlink");
        }
      }
    }
    for (const root of search.roots) {
      try {
        await stat(root);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        await readdir(
          search.format === "codex" ? path.dirname(root) : path.dirname(path.dirname(root)),
        );
        continue;
      }
      await walk(root, search.format === "codex" ? 3 : 0);
    }
    for (const file of candidates) {
      if (search.format === "codex") {
        const handle = await openInsideRoots(file, search.roots);
        if (!handle) return null;
        let header: string;
        try {
          const bytes = Buffer.alloc(64 * 1024);
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
          header = bytes.subarray(0, bytesRead).toString("utf8").split("\n")[0]!;
        } finally {
          await handle.close();
        }
        const meta = JSON.parse(header) as {
          type?: string;
          payload?: { cwd?: string; timestamp?: string };
          timestamp?: string;
        };
        if (meta.type !== "session_meta") return null;
        const stamp = Date.parse(meta.payload?.timestamp ?? meta.timestamp ?? "");
        if (!Number.isFinite(stamp)) return null;
        if (typeof meta.payload?.cwd !== "string") return null;
        if (path.resolve(meta.payload.cwd) !== path.resolve(search.cwd)) {
          // CLIs can canonicalize a launch cwd that contains a symlink.
          try {
            if ((await realpath(meta.payload.cwd)) !== (await realpath(search.cwd))) continue;
          } catch {
            continue;
          }
        }
        if (stamp >= search.since) return true;
        const resumed = await readTranscriptFile(
          { format: "codex", path: file, roots: search.roots },
          { afterSeq: 0, limit: 500, fullTools: false },
        );
        if (!resumed.ok || resumed.more) return null;
        if (
          resumed.entries.some(
            (entry) =>
              entry.role === "user" && (entry.ts === null || Date.parse(entry.ts) >= search.since),
          )
        )
          return true;
      } else {
        const result = await readTranscriptFile(
          { format: search.format, path: file, roots: search.roots },
          { afterSeq: 0, limit: 500, fullTools: false },
        );
        if (!result.ok || result.more) return null;
        if (
          result.entries.some(
            (entry) =>
              entry.role === "user" && (entry.ts === null || Date.parse(entry.ts) >= search.since),
          )
        )
          return true;
      }
    }
    return false;
  } catch {
    return null;
  }
}
