// Issue #1798: PtyManager.kill() deliberately leaves a session's dtach master
// (and the program under it) running so the session can be re-attached, so a
// test that spawned a real session leaves both behind, reparented to
// `systemd --user` until the program exits. Reap every master whose socket
// lives under the given (per-worker, disposable) sessions dir.
// test/setup.ts imports this module, so keep it free of src/ modules that
// CAPTURE a spawn binding at load (e.g. src/services/shell-spawn.ts): such a
// module would bind the real child_process before a test's own vi.mock applies
// and let real spawns through. Importing node:child_process itself is fine.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

interface PsRow {
  pid: number;
  ppid: number;
  command: string;
}

// Local rather than src/services/scope/detached.ts's parseProcessTable: this
// helper is imported by test/setup.ts, and importing src/ there loads
// node:child_process before a test's vi.mock can apply.
function parsePs(stdout: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const pid = Number.parseInt(parts[0], 10);
    const ppid = Number.parseInt(parts[1], 10);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    rows.push({ pid, ppid, command: parts.slice(3).join(" ") });
  }
  return rows;
}

/**
 * Pids of `dtach` masters named in a `ps -ax -o pid=,ppid=,pgid=,command=`
 * table whose argv has a path under `dir` (the macOS counterpart of the
 * /proc scan below, which has no procfs to read). `children` are the direct
 * children of those masters — the program each owns.
 */
export function dtachMastersFromPs(
  psStdout: string,
  dir: string,
): { masters: number[]; children: number[] } {
  const table = parsePs(psStdout);
  const masters = table
    .filter((e) => {
      const argv = e.command.split(" ");
      return /(^|\/)dtach$/.test(argv[0] ?? "") && argv.some((a) => a.startsWith(`${dir}/`));
    })
    .map((e) => e.pid);
  const children = table.filter((e) => masters.includes(e.ppid)).map((e) => e.pid);
  return { masters, children };
}

/** The portable process-table read (same selectors as src/services/scope/detached.ts). */
export function readPsTable(): string | null {
  try {
    return execFileSync("ps", ["-ax", "-o", "pid=,ppid=,pgid=,command="], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, COLUMNS: "10000" },
    });
  } catch {
    return null;
  }
}

/** What a scan found: master pids, plus (ps path only) their direct children. */
interface DtachScan {
  masters: number[];
  psChildren: number[];
}

type PsReader = () => string | null;

function scanDtach(sessionsDir: string, procRoot: string, ps: PsReader): DtachScan {
  let entries: string[];
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    // No procfs (macOS): read the process table instead — returning [] here
    // left every dtach master of a vitest run behind (issue #2112). Windows has
    // neither procfs nor ps (its sessions are named pipes, no dtach).
    if (process.platform === "win32") return { masters: [], psChildren: [] };
    const out = ps();
    const found = out ? dtachMastersFromPs(out, sessionsDir) : { masters: [], children: [] };
    return { masters: found.masters, psChildren: found.children };
  }
  const masters: number[] = [];
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const argv = fs.readFileSync(`${procRoot}/${e}/cmdline`, "utf8").split("\0");
      if (/(^|\/)dtach$/.test(argv[0] ?? "") && argv.some((a) => a.startsWith(`${sessionsDir}/`))) {
        masters.push(Number(e));
      }
    } catch {
      // raced with the process exiting
    }
  }
  return { masters, psChildren: [] };
}

/** Pids of `dtach` masters whose argv names a socket under `sessionsDir`. */
export function findDtachMasters(
  sessionsDir: string,
  procRoot = "/proc",
  ps: PsReader = readPsTable,
): number[] {
  return scanDtach(sessionsDir, procRoot, ps).masters;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Blocks (bounded) until every pid is gone, so a caller that checks for
 * survivors right after a reap doesn't race a process that is still exiting. */
function waitGone(pids: number[], timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline && pids.some(isAlive)) Atomics.wait(sleeper, 0, 0, 25);
}

/** SIGTERM each master and its direct children (the program it owns), then
 * wait briefly for them to exit. */
export function reapDtachMasters(
  sessionsDir: string,
  procRoot = "/proc",
  ps: PsReader = readPsTable,
): number {
  const { masters, psChildren } = scanDtach(sessionsDir, procRoot, ps);
  const signalled: number[] = [];
  const term = (pid: number): void => {
    try {
      process.kill(pid, "SIGTERM");
      signalled.push(pid);
    } catch {
      // already gone
    }
  };
  for (const pid of psChildren) term(pid);
  for (const pid of masters) {
    try {
      const kids = fs.readFileSync(`${procRoot}/${pid}/task/${pid}/children`, "utf8").trim();
      for (const k of kids ? kids.split(/\s+/) : []) term(Number(k));
    } catch {
      // no children file / already gone
    }
    term(pid);
  }
  waitGone(signalled, 1500);
  return masters.length;
}
