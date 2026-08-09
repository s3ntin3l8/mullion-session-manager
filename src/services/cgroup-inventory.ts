import { readFileSync, readdirSync } from "node:fs";
import { spawn as spawnChild } from "node:child_process";
import path from "node:path";

export interface CgroupProcess {
  pid: number;
  ppid: number;
  comm: string;
  cmdline: string[];
}

/**
 * Parses `cgroup.procs` contents (one PID per line, cgroup v2) into a PID
 * array. Blank lines (trailing newline, or a momentarily-empty cgroup) are
 * dropped rather than producing a NaN entry.
 */
export function parseCgroupProcs(contents: string): number[] {
  return contents
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => Number.parseInt(line, 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/**
 * Parses `/proc/<pid>/stat` contents and returns the comm (field 2) and
 * ppid (field 4). comm is parenthesized and may itself contain spaces or
 * parens (a process can rename itself to arbitrary bytes), so both fields
 * must be located from the *last* ')' rather than by naive
 * whitespace-splitting the whole line — mirrors the same leaf-vs-ancestor
 * caution as systemd-unit.ts's SERVICE_LEAF_PATTERN.
 */
export function parseStat(statContents: string): { comm: string; ppid: number } | null {
  const openParen = statContents.indexOf("(");
  const closeParen = statContents.lastIndexOf(")");
  if (openParen === -1 || closeParen === -1 || closeParen <= openParen) return null;
  const comm = statContents.slice(openParen + 1, closeParen);
  const fieldsAfterComm = statContents
    .slice(closeParen + 1)
    .trim()
    .split(/\s+/);
  // fieldsAfterComm[0] = state (field 3), fieldsAfterComm[1] = ppid (field 4).
  const ppid = Number.parseInt(fieldsAfterComm[1] ?? "", 10);
  if (!Number.isInteger(ppid)) return null;
  return { comm, ppid };
}

/**
 * Parses `/proc/<pid>/cmdline` contents (NUL-separated, NUL-terminated)
 * into argv. Empty for a zombie or kernel thread — callers needing a
 * display name in that case should fall back to `comm` (from parseStat),
 * which procfs always populates.
 */
export function parseCmdline(cmdlineContents: string): string[] {
  return cmdlineContents.split("\0").filter((arg) => arg.length > 0);
}

export interface CgroupReadOptions {
  // Test-only injection points; production always reads the real cgroupfs/procfs.
  cgroupRoot?: string;
  procRoot?: string;
  readFile?: (path: string) => string;
  readDir?: (path: string) => string[];
}

// Lists the immediate child cgroup directory names under `dir` (production:
// a real fs readdir filtered to directories). A session's scope is normally
// flat (verified live: dtach master + agent + its MCP-server child, no
// sub-cgroups) — but any subprocess that creates its own cgroup (a nested
// `systemd-run --scope`, a container runtime) lands in a *descendant*
// cgroup, invisible to a single flat `cgroup.procs` read. This walks
// descendants so that case isn't silently dropped.
function listChildCgroupDirs(dir: string, readDir: CgroupReadOptions["readDir"]): string[] {
  if (readDir) return readDir(dir);
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function readCgroupProcsPids(
  cgroupRoot: string,
  cgroupPath: string,
  readFile: (path: string) => string,
): number[] | null {
  try {
    return parseCgroupProcs(readFile(path.join(cgroupRoot, cgroupPath, "cgroup.procs")));
  } catch {
    return null;
  }
}

/**
 * Reads the PID set from `<cgroupRoot><cgroupPath>/cgroup.procs` and every
 * descendant cgroup beneath it, then resolves each PID's comm/ppid/cmdline
 * from procfs. Best-effort per PID: a process that exits between its
 * cgroup.procs snapshot and its own `/proc` reads (a real race —
 * cgroup.procs is a live snapshot) is silently skipped rather than failing
 * the whole inventory. Returns `[]` if the root `cgroup.procs` path itself
 * is unreadable (scope already gone, non-Linux, no cgroups).
 */
export function readCgroupProcesses(
  cgroupPath: string,
  options: CgroupReadOptions = {},
): CgroupProcess[] {
  const cgroupRoot = options.cgroupRoot ?? "/sys/fs/cgroup";
  const procRoot = options.procRoot ?? "/proc";
  const readFile = options.readFile ?? ((filePath: string) => readFileSync(filePath, "utf8"));

  // Root must exist for this to be a real, currently-active cgroup — an
  // unreadable root (scope gone) means "no processes," not "walk anyway."
  const rootPids = readCgroupProcsPids(cgroupRoot, cgroupPath, readFile);
  if (rootPids === null) return [];

  const allPids = new Set(rootPids);
  const queue = [cgroupPath];
  const seen = new Set([cgroupPath]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const childName of listChildCgroupDirs(path.join(cgroupRoot, current), options.readDir)) {
      const childPath = path.posix.join(current, childName);
      if (seen.has(childPath)) continue;
      seen.add(childPath);
      queue.push(childPath);
      for (const pid of readCgroupProcsPids(cgroupRoot, childPath, readFile) ?? [])
        allPids.add(pid);
    }
  }

  const processes: CgroupProcess[] = [];
  for (const pid of allPids) {
    try {
      const stat = readFile(path.join(procRoot, String(pid), "stat"));
      const cmdline = readFile(path.join(procRoot, String(pid), "cmdline"));
      const parsed = parseStat(stat);
      if (parsed === null) continue;
      processes.push({ pid, ppid: parsed.ppid, comm: parsed.comm, cmdline: parseCmdline(cmdline) });
    } catch {
      // Process exited between its cgroup.procs snapshot and reading its
      // own /proc entry — not a real session process anymore, skip it.
    }
  }
  return processes;
}

export interface ResolveScopeCgroupOptions {
  // Test-only injection point; production always shells out to systemctl.
  querySystemctl?: (unit: string) => Promise<string>;
}

function queryControlGroup(unit: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const child = spawnChild(
      "systemctl",
      ["--user", "show", unit, "-p", "ControlGroup", "--value"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", reject);
    // 'close', not 'exit' — see PtyManager.isMasterAlive()'s identical
    // reasoning: 'exit' doesn't guarantee every stdout chunk has arrived yet.
    child.on("close", () => resolve(stdout));
  });
}

/**
 * Resolves `unit`'s (e.g. `crs-session-<id>.scope`) cgroup v2 path via
 * `systemctl --user show ... -p ControlGroup`, the same mechanism systemd
 * itself uses — robust to whatever slice nesting the host's systemd puts
 * scopes under, unlike guessing the path from uid/slice conventions.
 * Returns null for a unit that's inactive/never existed (empty value) or
 * any query failure (non-systemd host, systemctl missing).
 */
export async function resolveScopeCgroupPath(
  unit: string,
  options: ResolveScopeCgroupOptions = {},
): Promise<string | null> {
  const query = options.querySystemctl ?? queryControlGroup;
  try {
    const value = (await query(unit)).trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

/**
 * Full inventory for a systemd --user scope: resolves its cgroup path, then
 * lists every process currently in that cgroup (and any descendant cgroup)
 * with ppid/comm/cmdline. Returns `[]` for a scope that isn't active rather
 * than throwing — callers (a session-processes route, a Dock panel) should
 * treat "not running" the same as "running with zero extra processes."
 */
export async function listScopeProcesses(
  unit: string,
  options: ResolveScopeCgroupOptions & CgroupReadOptions = {},
): Promise<CgroupProcess[]> {
  const cgroupPath = await resolveScopeCgroupPath(unit, options);
  if (cgroupPath === null) return [];
  return readCgroupProcesses(cgroupPath, options);
}
