import fs from "node:fs/promises";
import path from "node:path";
import { resolveClaudeConfigDir } from "./hook-adapters/claude-code.js";

// Claude Code keeps per-session scratch under
// `<tmpdir>/claude-<uid>/<project-slug>/<session-uuid>/{scratchpad,tasks,images}`
// and records every running session in `~/.claude/sessions/<pid>.json`
// (`{ pid, sessionId, procStart, ... }`). Mullion can't tell from mtime alone
// whether a session that has been idle for days is still running and will read
// that scratch back, so liveness comes from that registry instead (issue #1608).

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isSessionUuid = (name: string) => SESSION_UUID.test(name);

export const defaultClaudeSessionsDir = () => path.join(resolveClaudeConfigDir(), "sessions");

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

/** e.g. "pid:[4026533104]" — this process's PID namespace, or null if unknown. */
async function ownPidNamespace(): Promise<string | null> {
  try {
    return await fs.readlink("/proc/self/ns/pid");
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
  const ownNamespace = await ownPidNamespace();
  if (ownNamespace === null) return null;
  let names: string[];
  try {
    names = await fs.readdir(registryDir);
  } catch {
    return null;
  }
  const live = new Set<string>();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let entry: { pid?: unknown; sessionId?: unknown; procStart?: unknown; pidDomain?: unknown };
    try {
      entry = JSON.parse(await fs.readFile(path.join(registryDir, name), "utf8")) as typeof entry;
    } catch {
      return null;
    }
    if (typeof entry.pid !== "number" || typeof entry.sessionId !== "string") return null;
    // `pidDomain` is e.g. "linux:<machine>:pid:[4026533104]". An entry from a
    // different PID namespace (container, sandbox) has a pid that means nothing
    // in this /proc, and one without it wasn't written by a Claude Code that
    // can be verified at all — in both cases we can't call it dead, so assume
    // it's running.
    if (typeof entry.pidDomain !== "string" || !entry.pidDomain.endsWith(`:${ownNamespace}`)) {
      live.add(entry.sessionId);
      continue;
    }
    const start = await procStartTime(entry.pid);
    // Gone from /proc: skip it. Even if the file was left behind by a clean
    // exit, or the process is about to die, the callers' mtime window (24h
    // safe, 10 minutes aggressive) still protects a session that just ended.
    if (start === null) continue;
    // Only a numeric, differing start time proves the pid was reused. Missing
    // or unrecognised values (older/newer Claude Code, another platform) can't
    // disprove "still running", so err that way.
    const proven = typeof entry.procStart === "string" && /^\d+$/.test(entry.procStart);
    if (!proven || entry.procStart === start) live.add(entry.sessionId);
  }
  return live;
}

export interface ScratchEntry {
  fullPath: string;
  sessionId: string;
}

/**
 * Session directories (`<project>/<session-uuid>`) under one `claude-<uid>`
 * directory — and nothing else. The same tree also holds state that running
 * sessions read for their whole lifetime and that has no session id to check
 * against (`bundled-skills/<version>`, `emptyhome`, shared logs and pid files),
 * so only the UUID-named directories that liveness can actually vouch for are
 * ever offered for removal.
 */
export async function listClaudeScratchEntries(claudeDir: string): Promise<ScratchEntry[]> {
  const entries: ScratchEntry[] = [];
  for (const project of await fs.readdir(claudeDir)) {
    const projectPath = path.join(claudeDir, project);
    let children;
    try {
      if (!(await fs.lstat(projectPath)).isDirectory()) continue;
      children = await fs.readdir(projectPath, { withFileTypes: true });
    } catch {
      continue; // vanished or unreadable
    }
    for (const child of children) {
      if (child.isDirectory() && isSessionUuid(child.name)) {
        entries.push({ fullPath: path.join(projectPath, child.name), sessionId: child.name });
      }
    }
  }
  return entries;
}
