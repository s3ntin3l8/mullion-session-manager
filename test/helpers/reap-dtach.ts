// Issue #1798: PtyManager.kill() deliberately leaves a session's dtach master
// (and the program under it) running so the session can be re-attached, so a
// test that spawned a real session leaves both behind, reparented to
// `systemd --user` until the program exits. Reap every master whose socket
// lives under the given (per-worker, disposable) sessions dir.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { parseProcessTable } from "../../src/services/scope/detached.js";

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
  const table = parseProcessTable(psStdout);
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

/** Pids of `dtach` masters whose argv names a socket under `sessionsDir`. */
export function findDtachMasters(sessionsDir: string, procRoot = "/proc"): number[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    // No procfs (macOS): read the process table instead — returning [] here
    // left every dtach master of a vitest run behind (issue #2112).
    const ps = readPsTable();
    return ps ? dtachMastersFromPs(ps, sessionsDir).masters : [];
  }
  const pids: number[] = [];
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const argv = fs.readFileSync(`${procRoot}/${e}/cmdline`, "utf8").split("\0");
      if (/(^|\/)dtach$/.test(argv[0] ?? "") && argv.some((a) => a.startsWith(`${sessionsDir}/`))) {
        pids.push(Number(e));
      }
    } catch {
      // raced with the process exiting
    }
  }
  return pids;
}

/** SIGTERM each master and its direct children (the program it owns). */
export function reapDtachMasters(sessionsDir: string, procRoot = "/proc"): number {
  const masters = findDtachMasters(sessionsDir, procRoot);
  if (!fs.existsSync(procRoot)) {
    // macOS: children come from the same process-table read.
    const ps = readPsTable();
    for (const pid of ps ? dtachMastersFromPs(ps, sessionsDir).children : []) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }
  for (const pid of masters) {
    try {
      const kids = fs.readFileSync(`${procRoot}/${pid}/task/${pid}/children`, "utf8").trim();
      for (const k of kids ? kids.split(/\s+/) : []) process.kill(Number(k), "SIGTERM");
    } catch {
      // no children file / already gone
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  return masters.length;
}
