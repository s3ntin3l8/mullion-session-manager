import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Claude Code keeps per-session scratch under
// `<tmpdir>/claude-<uid>/<project-slug>/<session-uuid>/{scratchpad,tasks,images}`
// and records every running session in `~/.claude/sessions/<pid>.json`
// (`{ pid, sessionId, procStart, ... }`). Mullion can't tell from mtime alone
// whether a session that has been idle for days is still running and will read
// that scratch back, so liveness comes from that registry instead (issue #1608).

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isSessionUuid = (name: string) => SESSION_UUID.test(name);

export const defaultClaudeSessionsDir = () => path.join(os.homedir(), ".claude", "sessions");

/** Field 22 of /proc/<pid>/stat (process start time in clock ticks), or null. */
async function procStartTime(pid: number): Promise<string | null> {
  try {
    const stat = await fs.readFile(`/proc/${String(pid)}/stat`, "utf8");
    // `comm` (field 2) is parenthesised and may itself contain spaces/parens,
    // so count fields from the last ")": the remainder starts at field 3.
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return rest[19] ?? null;
  } catch {
    return null;
  }
}

/**
 * Session ids of every Claude Code session still running, or `null` when that
 * can't be established (registry unreadable, a file that doesn't parse, or no
 * /proc to verify against). Callers must treat `null` as "unknown, leave
 * everything alone" — never as "nothing is running".
 */
export async function loadLiveSessionIds(
  registryDir: string = defaultClaudeSessionsDir(),
): Promise<Set<string> | null> {
  if ((await procStartTime(process.pid)) === null) return null;
  let names: string[];
  try {
    names = await fs.readdir(registryDir);
  } catch {
    return null;
  }
  const live = new Set<string>();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let entry: { pid?: unknown; sessionId?: unknown; procStart?: unknown };
    try {
      entry = JSON.parse(await fs.readFile(path.join(registryDir, name), "utf8")) as typeof entry;
    } catch {
      return null;
    }
    if (typeof entry.pid !== "number" || typeof entry.sessionId !== "string") return null;
    const start = await procStartTime(entry.pid);
    if (start === null) continue; // process is gone
    // A registry entry without procStart predates the pid-reuse guard; with
    // only the pid to go on, err towards "still running".
    if (entry.procStart === undefined || String(entry.procStart) === start) {
      live.add(entry.sessionId);
    }
  }
  return live;
}

export interface ScratchEntry {
  fullPath: string;
  /** Set for `<project>/<session-uuid>` directories. */
  sessionId?: string;
}

/**
 * Enumerates the structure under one `claude-<uid>` directory: session
 * directories (identified by their UUID name) inside project directories, and
 * everything else at the same levels as plain entries. A top-level directory
 * with no UUID-named children is not a project directory (e.g. a build output
 * a tool dropped there) and is reported whole.
 */
export async function listClaudeScratchEntries(claudeDir: string): Promise<ScratchEntry[]> {
  const entries: ScratchEntry[] = [];
  for (const project of await fs.readdir(claudeDir)) {
    const projectPath = path.join(claudeDir, project);
    let children: Array<{ name: string; isDirectory: boolean }>;
    try {
      const stat = await fs.lstat(projectPath);
      if (!stat.isDirectory()) {
        entries.push({ fullPath: projectPath });
        continue;
      }
      children = (await fs.readdir(projectPath, { withFileTypes: true })).map((d) => ({
        name: d.name,
        isDirectory: d.isDirectory(),
      }));
    } catch {
      continue; // vanished or unreadable
    }
    if (!children.some((c) => c.isDirectory && isSessionUuid(c.name))) {
      entries.push({ fullPath: projectPath });
      continue;
    }
    for (const child of children) {
      entries.push({
        fullPath: path.join(projectPath, child.name),
        ...(child.isDirectory && isSessionUuid(child.name) ? { sessionId: child.name } : {}),
      });
    }
  }
  return entries;
}
