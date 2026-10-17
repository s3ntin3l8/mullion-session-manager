import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveClaudeConfigDir } from "./hook-adapters/claude-code.js";

// Claude Code keeps per-session scratch under
// `<tmpdir>/claude-<uid>/<project-slug>/<session-uuid>/{scratchpad,tasks,images}`
// and records every running session in `<config dir>/sessions/<pid>.json`
// (`{ pid, sessionId, procStart, version, ... }`). Mullion can't tell from
// mtime alone whether a session that has been idle for days is still running and
// will read that scratch back, so liveness comes from that registry instead
// (issue #1608). Every config dir Mullion launches a session with has its own
// registry, while the tmp dir is shared, so liveness is the union of them all
// (issue #1614).

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isSessionUuid = (name: string) => SESSION_UUID.test(name);

export const defaultClaudeSessionsDir = () => path.join(resolveClaudeConfigDir(), "sessions");

/**
 * Registry dirs to consult: the server's own first (its registry must exist,
 * see `loadLiveSessions`), then one per distinct `CLAUDE_CONFIG_DIR` found in
 * the persisted env of sessions (`sessions.env`, a JSON object). A relative
 * value is ignored: it would resolve against whatever cwd Mullion runs in.
 */
export function claudeSessionsDirsFor(envColumns: ReadonlyArray<string | null>): string[] {
  const dirs = [defaultClaudeSessionsDir()];
  for (const column of envColumns) {
    if (!column) continue;
    let configDir: unknown;
    try {
      configDir = (JSON.parse(column) as Record<string, unknown> | null)?.CLAUDE_CONFIG_DIR;
    } catch {
      continue; // one corrupt column must not hide the rest
    }
    if (typeof configDir !== "string" || !path.isAbsolute(configDir)) continue;
    const sessionsDir = path.join(configDir.normalize("NFC"), "sessions");
    if (!dirs.includes(sessionsDir)) dirs.push(sessionsDir);
  }
  return dirs;
}

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

// A registry dir that is gone, or not a directory at all (a stale
// CLAUDE_CONFIG_DIR pointing at a file), has nothing registered in it.
const isNoRegistry = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
};

export interface LiveSessions {
  /** Session ids of every Claude Code session still running. */
  ids: Set<string>;
  /** Claude Code versions in use by a running session (registry + `/proc/<pid>/exe`). */
  versions: Set<string>;
  /**
   * False when some running session's version couldn't be established, in
   * which case `versions` proves nothing about what is unused.
   */
  versionsComplete: boolean;
  /** Registry files that were skipped, with why. */
  warnings: string[];
  /**
   * Set when liveness can't be established at all: callers must treat that as
   * "unknown, leave everything alone" — never as "nothing is running".
   */
  blocked?: string;
}

interface RegistryEntry {
  pid: number;
  sessionId: string;
  procStart?: unknown;
  pidDomain?: unknown;
  version?: unknown;
}

async function readRegistryEntry(file: string): Promise<RegistryEntry | null> {
  try {
    const entry = JSON.parse(await fs.readFile(file, "utf8")) as Partial<RegistryEntry> | null;
    if (typeof entry?.pid !== "number" || typeof entry.sessionId !== "string") return null;
    return entry as RegistryEntry;
  } catch {
    return null;
  }
}

// A binary replaced by an upgrade while a session still runs it reads back as
// "<path> (deleted)".
const CLAUDE_BINARY_VERSION = /\/claude\/versions\/([^/]+?)(?: \(deleted\))?$/;

/** Versions of every `claude` binary running as a process we can inspect. */
async function addRunningBinaryVersions(live: LiveSessions, procDir: string) {
  let pids: string[];
  try {
    pids = await fs.readdir(procDir);
  } catch {
    live.versionsComplete = false;
    return;
  }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const exe = await fs.readlink(path.join(procDir, pid, "exe"));
      const version = CLAUDE_BINARY_VERSION.exec(exe)?.[1];
      if (version) live.versions.add(version);
    } catch {
      // another user's process, or gone: neither is a session of ours
    }
  }
}

export interface LoadLiveSessionsOptions {
  /** Test seam: where to look for running binaries (`<pid>/exe`). */
  procDir?: string;
  /** Skip the /proc scan for running binaries; only session ids are wanted. */
  includeBinaries?: boolean;
}

/**
 * Liveness across every registry in `registryDirs`. The first is the server's
 * own and must be readable: a Claude Code too old to keep a registry looks
 * exactly like a missing one, and "no registry" must not read as "nothing is
 * running". Any later dir (a `CLAUDE_CONFIG_DIR` some session once used) may
 * be gone or not a directory, which just means nothing registers there; one
 * that exists but can't be read (permissions) is unknown, so it blocks.
 *
 * One unparseable registry file doesn't disable everything when its name is
 * `<pid>.json` and that pid is gone: it is skipped with a warning. Otherwise it
 * could belong to a running session, so the result is `blocked`.
 */
export async function loadLiveSessions(
  registryDirs: readonly string[] = [defaultClaudeSessionsDir()],
  options: LoadLiveSessionsOptions = {},
): Promise<LiveSessions> {
  const live: LiveSessions = {
    ids: new Set(),
    versions: new Set(),
    versionsComplete: true,
    warnings: [],
  };
  const blocked = (reason: string): LiveSessions => ({ ...live, blocked: reason });
  if ((await procStartTime(process.pid)) === null) return blocked("/proc is not available");
  const ownNamespace = await ownPidNamespace();
  if (ownNamespace === null) return blocked("this process's PID namespace is unknown");

  for (const [index, dir] of registryDirs.entries()) {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      if (index > 0 && isNoRegistry(error)) continue;
      return blocked(`cannot read the Claude session registry ${dir}`);
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(dir, name);
      const entry = await readRegistryEntry(file);
      if (entry === null) {
        const pid = /^(\d+)\.json$/.exec(name)?.[1];
        if (pid !== undefined && (await procStartTime(Number(pid))) === null) {
          live.warnings.push(`${file} is unparseable; skipped (its process is gone)`);
          continue;
        }
        return blocked(`${file} is unparseable and its process may be running`);
      }
      const markLive = () => {
        live.ids.add(entry.sessionId);
        if (typeof entry.version === "string" && entry.version) live.versions.add(entry.version);
        else live.versionsComplete = false;
      };
      // `pidDomain` is e.g. "linux:<machine>:pid:[4026533104]". An entry from a
      // different PID namespace (container, sandbox) has a pid that means nothing
      // in this /proc, and one without it wasn't written by a Claude Code that
      // can be verified at all — in both cases we can't call it dead, so assume
      // it's running.
      if (typeof entry.pidDomain !== "string" || !entry.pidDomain.endsWith(`:${ownNamespace}`)) {
        markLive();
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
      if (!proven || entry.procStart === start) markLive();
    }
  }
  if (options.includeBinaries !== false) {
    await addRunningBinaryVersions(live, options.procDir ?? "/proc");
  }
  return live;
}

/**
 * A `*.pid` file naming a process that is still running (or one we can't
 * read). Opened once, without following a link, and judged from that same
 * handle, so what is checked is what is read: a path swapped for something else
 * between a stat and a read can't change the answer.
 */
export async function isLivePidFile(file: string): Promise<boolean> {
  if (!file.endsWith(".pid")) return false;
  let handle;
  try {
    handle = await fs.open(
      file,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    if (!(await handle.stat()).isFile()) return false;
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(64), 0, 64, 0);
    const pid = Number(buffer.subarray(0, bytesRead).toString("utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    return (await procStartTime(pid)) !== null;
  } catch (error) {
    // A link isn't a pid file (and is removed as the link it is, never followed).
    if ((error as NodeJS.ErrnoException).code === "ELOOP") return false;
    return true; // can't tell: leave it
  } finally {
    await handle?.close();
  }
}

export interface ScratchEntry {
  fullPath: string;
  sessionId: string;
}

export interface ClaudeDirScan {
  /** `<project>/<session-uuid>` directories. */
  sessions: ScratchEntry[];
  /** Project dirs with nothing in them. */
  emptyProjects: string[];
  /** `bundled-skills/<version>` directories. */
  bundledVersions: Array<{ fullPath: string; version: string }>;
  /** Everything else at the top level: stray files and non-project directories. */
  loose: string[];
}

/**
 * Sorts the top level of one `claude-<uid>` directory by what can vouch for it:
 * session directories (checked against the registry), `bundled-skills/<version>`
 * (checked against the versions in use), empty project dirs (checked by age
 * alone — see temp-storage.ts for why they are never removed in the same pass
 * as their last session), and loose entries, which have nothing to check and are
 * left to the plain age windows. `emptyhome` and a project dir holding
 * anything but session directories are never offered.
 */
export async function scanClaudeDir(claudeDir: string): Promise<ClaudeDirScan> {
  const scan: ClaudeDirScan = { sessions: [], emptyProjects: [], bundledVersions: [], loose: [] };
  for (const name of await fs.readdir(claudeDir)) {
    const full = path.join(claudeDir, name);
    let isDirectory: boolean;
    try {
      isDirectory = (await fs.lstat(full)).isDirectory();
    } catch {
      continue; // vanished
    }
    if (!isDirectory) {
      scan.loose.push(full);
      continue;
    }
    if (name === "emptyhome") continue;
    let children;
    try {
      children = await fs.readdir(full, { withFileTypes: true });
    } catch {
      continue; // unreadable
    }
    if (name === "bundled-skills") {
      for (const child of children) {
        if (child.isDirectory()) {
          scan.bundledVersions.push({ fullPath: path.join(full, child.name), version: child.name });
        }
      }
      continue;
    }
    const sessionDirs = children.filter((c) => c.isDirectory() && isSessionUuid(c.name));
    for (const child of sessionDirs) {
      scan.sessions.push({ fullPath: path.join(full, child.name), sessionId: child.name });
    }
    if (sessionDirs.length > 0) continue;
    // Claude names a project dir after its path ("-home-me-proj").
    if (name.startsWith("-")) {
      if (children.length === 0) scan.emptyProjects.push(full);
    } else {
      scan.loose.push(full);
    }
  }
  return scan;
}
