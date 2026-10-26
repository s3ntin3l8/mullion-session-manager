// Issue #1798: PtyManager.kill() deliberately leaves a session's dtach master
// (and the program under it) running so the session can be re-attached, so a
// test that spawned a real session leaves both behind, reparented to
// `systemd --user` until the program exits. Reap every master whose socket
// lives under the given (per-worker, disposable) sessions dir.
import fs from "node:fs";

/** Pids of `dtach` masters whose argv names a socket under `sessionsDir`. */
export function findDtachMasters(sessionsDir: string, procRoot = "/proc"): number[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    return []; // no procfs (macOS): nothing to inspect
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
