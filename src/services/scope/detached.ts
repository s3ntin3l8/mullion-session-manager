import { execFile } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { CgroupProcess } from "../cgroup-inventory.js";
import { probeSocket, type SocketProbeResult } from "../unix-socket.js";
import { isDtachCreateFor, sessionSocketPath } from "./dtach.js";
import { spawnScopeProcess } from "./spawn.js";
import type { ScopeBackend, ScopeLaunchSpec, ScopeLiveness } from "./types.js";

/** How long the process-table read may take before it counts as "could not read". */
const PS_TIMEOUT_MS = 5_000;

/** How long a signalled process tree gets to exit before it is SIGKILLed. */
const TERMINATE_GRACE_MS = 2_000;

/** How long the termination wait re-checks whether the tree is gone. */
const TERMINATE_POLL_MS = 50;

/**
 * The process-table read, portable across BSD (macOS) and procps (Linux).
 *
 * `command=` is the one keyword both spell the same way — procps also accepts
 * `args=`, but BSD's `ps` does not, and BSD's `command=` is the same field —
 * so this form works unchanged on either. `-ax` (every process) and the
 * `pid=,ppid=,pgid=,command=` selectors are likewise common to both.
 *
 * COLUMNS is set wide: BSD's `ps` truncates its output to the terminal
 * width when stdout is a terminal. This is always piped (so it would not
 * truncate anyway), but a narrow width would cut the tail off a long command
 * line — and the socket path this matches on sits at the FRONT of a dtach
 * master's argv, so even a truncated tail cannot corrupt the match.
 */
const PS_ARGS = ["-ax", "-o", "pid=,ppid=,pgid=,command="];

/** One row of the process table. */
export interface ProcessEntry {
  pid: number;
  ppid: number;
  /**
   * The process group id.
   *
   * Load-bearing for teardown: dtach's daemonize calls `setsid()`, so its
   * master LEADS a process group of its own — the master and everything it
   * started, and nothing else. Signalling that group catches a child
   * forked after the tree was snapshotted, which walking the tree cannot.
   */
  pgid: number;
  /** The process's full command line, as `ps` rendered it. */
  command: string;
}

/**
 * Parses `ps -ax -o pid=,ppid=,pgid=,command=` output.
 *
 * The four fields are whitespace-delimited and the command line is LAST, so
 * the command is "everything after the third field" — a command line's own
 * spaces are preserved that way.
 */
export function parseProcessTable(stdout: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 4) continue;
    const pid = Number.parseInt(parts[0], 10);
    const ppid = Number.parseInt(parts[1], 10);
    const pgid = Number.parseInt(parts[2], 10);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgid)) continue;
    entries.push({ pid, ppid, pgid, command: parts.slice(3).join(" ") });
  }
  return entries;
}

/**
 * The dtach session masters in a process table, keyed by socket path.
 *
 * `socketPaths` are the paths this caller cares about — the master for a
 * path is the process whose command line IS `dtach -n <that path> …`, not a
 * process that happens to mention one.
 *
 * When several processes claim the same socket, the HIGHEST pid wins.
 * `dtach -n` daemonizes: the process Mullion spawns forks, and the parent
 * exits once the forked child is ready — so for a moment the table holds two
 * dtach processes with the SAME argv, one of which is about to vanish. A
 * fork always gives the child a higher pid, and the master is the survivor
 * of that fork chain, so the highest pid is the one that will still be
 * there. Picking the other would make `stop()` signal a corpse while the
 * real master kept running.
 */
export function dtachMasters(table: ProcessEntry[], socketPaths: string[]): Map<string, number> {
  const masters = new Map<string, number>();
  for (const entry of table) {
    for (const socketPath of socketPaths) {
      if (!isDtachCreateFor(entry.command, socketPath)) continue;
      const existing = masters.get(socketPath);
      if (existing === undefined || entry.pid > existing) {
        masters.set(socketPath, entry.pid);
      }
    }
  }
  return masters;
}

/**
 * Every process below `rootPid` in the table — the agent, its MCP servers,
 * its background jobs, and so on.
 *
 * A breadth-first walk from the root, with a `seen` set so a process that
 * (impossible in practice, but defensively handled) appeared as its own
 * ancestor cannot spin forever.
 */
export function descendantsOf(table: ProcessEntry[], rootPid: number): ProcessEntry[] {
  const byParent = new Map<number, ProcessEntry[]>();
  for (const entry of table) {
    const siblings = byParent.get(entry.ppid);
    if (siblings) siblings.push(entry);
    else byParent.set(entry.ppid, [entry]);
  }
  const out: ProcessEntry[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift() as number;
    for (const child of byParent.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

/** Whether a process is still running (or exists but may not be signalled). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, we just may not signal it. Still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForExit(pids: number[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pids.some(isProcessAlive)) return;
    await new Promise((resolve) => setTimeout(resolve, TERMINATE_POLL_MS));
  }
}

/**
 * Removes a socket file that nothing is serving any more.
 *
 * dtatch removes its socket on a CLEAN exit, but a master that is killed
 * outright (the SIGKILL escalation below, or a crash) leaves the file
 * behind — so the file can outlive the session it belonged to. That is
 * harmless for liveness, because the probe asks the SOCKET whether
 * anything is serving it, and a stale file with nothing behind it answers
 * ECONNREFUSED, i.e. "dead" — but it is not harmless for the next session
 * at that id, because `bind()` refuses an existing path. So the teardown
 * clears it.
 */
function removeSocket(socketPath: string): void {
  try {
    unlinkSync(socketPath);
  } catch {
    // ENOENT (already gone) or a permission problem — either way, nothing
    // the teardown should fail on.
  }
}

/** Signals a pid, ignoring the failures that are not ours to fix. */
function safeKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone, or not ours to signal — either way, not fatal here.
  }
}

/**
 * Signals a whole process group, ignoring the failures that are not ours to
 * fix.
 *
 * The group is addressed by its NEGATIVE id, which is how `kill(2)` spells
 * "every process in this group".
 */
function safeKillGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // The group is already empty, or we may not signal it.
  }
}

export interface DetachedScopeBackendOptions {
  /** This instance's absolute, resolved sessions dir. */
  sessionsDir: string;
}

/**
 * The macOS scope backend — a detached `dtach` session, with no supervisor
 * underneath it.
 *
 * **Why a session survives here the same way it survives on Linux.** On
 * Linux, a session outlives the Mullion process because its `systemd --user`
 * scope is independent of the service's cgroup. There is no systemd on
 * macOS, but `dtach -n` gives the same property for a different reason:
 * dtach daemonizes, so the master that holds the pty and serves the socket
 * is reparented to launchd and keeps running when Mullion does. What Linux
 * gets from systemd and macOS gets from dtach is the same thing — the
 * session outlives its creator.
 *
 * **How liveness is established.** The question is "is the session's dtach
 * master still serving its socket?", and `probeSocket()` answers it
 * directly: it connects, and
 *
 *   - something accepted the connection -> the master is alive
 *   - nothing answers (ECONNREFUSED)    -> the master is gone
 *   - the probe timed out, or the path is not a socket, or we may not open
 *     it                            -> we could not tell
 *
 * That last case is "unknown", and it is never widened to "dead": a false
 * "dead" makes the reconciler mark a live session exited and terminate it.
 *
 * Connecting is safe here, which was not obvious before it was measured. The
 * concern was that a probe would displace a browser's live attach. It does
 * not: dtach's master serves any number of attached terminals, a probe
 * connection sends no bytes and is closed immediately, the master survives
 * its clients disconnecting, and the closed connections do not pile up in
 * the accept queue (measured: 300 probes, queue depth still 1, a further
 * client still attaching). `probeSocket()` is the same probe the Linux path
 * already uses on a session's own socket, with the same tri-state.
 *
 * **What the scope's identity is.** The session's dtach socket path — the
 * same anchor the systemd backend recovers from a unit's `Description`. It
 * is what the process table is matched against to find the master, for
 * teardown and for the process inventory.
 */
export class DetachedScopeBackend implements ScopeBackend {
  readonly kind = "detached";

  constructor(private readonly opts: DetachedScopeBackendOptions) {}

  /** The socket path that identifies this session's master. */
  private socketPathFor(id: string): string {
    return sessionSocketPath(this.opts.sessionsDir, id);
  }

  /**
   * Reads the process table.
   *
   * `null` means "could not read it" — a missing `ps`, a timeout, a
   * non-zero exit. That is NOT the same as an empty table, and the callers
   * below treat it as "we know nothing".
   */
  private async readProcessTable(): Promise<ProcessEntry[] | null> {
    return new Promise((resolve) => {
      execFile(
        "ps",
        PS_ARGS,
        {
          timeout: PS_TIMEOUT_MS,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, COLUMNS: "10000" },
        },
        (err, stdout) => {
          // `stdout` is a string under the default utf8 encoding, but the
          // overload types it as `string | Buffer` — String() handles both.
          resolve(err ? null : parseProcessTable(String(stdout)));
        },
      );
    });
  }

  /**
   * Launches the program directly — there is no supervisor to wrap it in.
   *
   * The program is the same `dtach -n <socket> <shell> -lc <command>` the
   * Linux backend runs inside a systemd scope; only the supervisor around it
   * differs. `dtach -n` exits as soon as the master it forked is ready, so
   * this resolves while the session itself keeps running.
   */
  async start(spec: ScopeLaunchSpec): Promise<void> {
    const [command, ...args] = spec.argv;
    if (!command) {
      throw new Error(`${spec.label} failed: no program to launch`);
    }
    const socketPath = this.socketPathFor(spec.id);
    await spawnScopeProcess({
      command,
      argv: args,
      cwd: spec.cwd,
      env: spec.env,
      timeoutMs: spec.timeoutMs,
      label: spec.label,
      scopeName: socketPath,
      scopeKind: "socket",
      // dtach refuses to create a session on a socket that is already in
      // use, which is the macOS counterpart of systemd-run refusing to
      // create a scope whose unit name is taken.
      describeFailure: async () => {
        if (!existsSync(socketPath)) return null;
        return `the socket ${socketPath} is already in use — a dtach master for this session may still be running`;
      },
    });
  }

  /**
   * Liveness for every requested id — a TOTAL map.
   *
   * Every requested id is always present in the result, so no caller can
   * mistake "this backend's reply omitted the id" for a confident "dead".
   */
  async isAliveBatch(ids: string[]): Promise<Record<string, ScopeLiveness>> {
    const result: Record<string, ScopeLiveness> = Object.create(null);
    // Seed the map with the requested ids so it is total even if a probe
    // rejects outright.
    for (const id of ids) result[id] = "unknown";
    await Promise.all(
      ids.map(async (id) => {
        try {
          const probe = await probeSocket(this.socketPathFor(id));
          if (probe === "live") result[id] = "alive";
          else if (probe === "dead") result[id] = "dead";
          // "unknown" stays "unknown" — a probe that could not tell must
          // never be read as "not alive".
        } catch {
          // A probe that threw tells us nothing either. "unknown" it is.
        }
      }),
    );
    return result;
  }

  /**
   * Stops the session: the dtach master AND everything under it.
   *
   * The whole tree, not just the master: on Linux, stopping a scope kills
   * every process in its cgroup, so the agent, its MCP servers and its
   * background jobs all go with it. Signalling only the master here would
   * leave the agent running — invisible, and still burning the CPU this
   * whole phase exists to reclaim.
   */
  async stop(id: string): Promise<void> {
    const socketPath = this.socketPathFor(id);
    const table = await this.readProcessTable();
    if (table === null) return;
    const masterPid = dtachMasters(table, [socketPath]).get(socketPath);
    if (masterPid === undefined) {
      // No master we can see. If nothing is serving the socket either, the
      // session is definitively gone and the socket file is stale — remove
      // it, so the next session at this id can bind that path. A probe that
      // could not answer is not evidence of anything, so the file stays
      // (fail-closed: unlinking the socket of a live session would break
      // its attach).
      let probe: SocketProbeResult = "unknown";
      try {
        probe = await probeSocket(socketPath);
      } catch {
        // A probe that threw tells us nothing.
      }
      if (probe === "dead") removeSocket(socketPath);
      return;
    }
    const master = table.find((entry) => entry.pid === masterPid);
    // dtach's daemonize calls setsid(), so the master LEADS a process group
    // of its own — the master and everything it started, and nothing else.
    // Signalling that group is what catches a child forked DURING the grace
    // window below, which a snapshot of the tree cannot: the snapshot
    // predates the fork. The group is only signalled when the master
    // actually leads it (pgid === pid), because "the group with this id"
    // is only ours to signal in that case.
    const group = master && master.pgid === master.pid ? master.pid : null;
    let tree = [masterPid, ...descendantsOf(table, masterPid).map((entry) => entry.pid)];

    for (const pid of tree) safeKill(pid, "SIGTERM");
    if (group !== null) safeKillGroup(group, "SIGTERM");
    await waitForExit(tree, TERMINATE_GRACE_MS);

    // Look again before escalating: a child the master forked during the
    // grace window is in neither the snapshot nor the group kill's reach
    // (if the master has since died, the child was reparented to launchd
    // and is no longer attributed to it) — but while the master is still
    // alive it is still its child, and the only way to see it is to read
    // the table again.
    const fresh = await this.readProcessTable();
    if (fresh) {
      tree = [...new Set([...tree, ...descendantsOf(fresh, masterPid).map((e) => e.pid)])];
    }

    for (const pid of tree) {
      if (!isProcessAlive(pid)) continue;
      safeKill(pid, "SIGKILL");
    }
    if (group !== null) safeKillGroup(group, "SIGKILL");
    // The socket is stale now — a master killed outright leaves it behind.
    // Remove it, but only once the tree is confirmed gone: unlinking the
    // socket of a LIVE session would break its attach.
    await waitForExit(tree, TERMINATE_POLL_MS * 10);
    if (tree.every((pid) => !isProcessAlive(pid))) removeSocket(socketPath);
  }

  /**
   * The processes running inside this session — the dtach master, the agent
   * it launched, and everything under those.
   *
   * There is no cgroup on macOS, so this walks the process tree instead.
   * An empty list means "nothing running, or nothing we could read" — the
   * same honest answer the interface allows for a platform that cannot
   * enumerate.
   *
   * The `cmdline` is BEST EFFORT and deliberately so: `ps` renders a
   * printable command line, not an argv, so an argument containing a space
   * cannot be told apart from two arguments, and quoted arguments lose
   * their grouping. The Linux path reads the real argv out of
   * `/proc/<pid>/cmdline`; there is no equivalent here. Consumers that need
   * the exact argv should treat this as a display string.
   */
  async listProcesses(id: string): Promise<CgroupProcess[]> {
    const socketPath = this.socketPathFor(id);
    const table = await this.readProcessTable();
    if (table === null) return [];
    const masterPid = dtachMasters(table, [socketPath]).get(socketPath);
    if (masterPid === undefined) return [];
    const byPid = new Map(table.map((entry) => [entry.pid, entry]));
    const tree = [masterPid, ...descendantsOf(table, masterPid).map((entry) => entry.pid)];
    return tree.map((pid) => {
      const entry = byPid.get(pid);
      const argv = entry ? entry.command.split(/\s+/).filter(Boolean) : [];
      return {
        pid,
        ppid: entry?.ppid ?? 0,
        comm: path.basename(argv[0] ?? ""),
        cmdline: argv,
      };
    });
  }
}
