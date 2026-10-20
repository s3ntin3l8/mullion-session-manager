import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { CgroupProcess } from "../cgroup-inventory.js";
import { extractDtachSocketPath, sessionSocketPath } from "./dtach.js";
import { spawnScopeProcess } from "./spawn.js";
import type { ScopeBackend, ScopeLaunchSpec, ScopeLiveness } from "./types.js";

/** How long the process-table read may take before it counts as "could not read". */
const PS_TIMEOUT_MS = 5_000;

/** How long a signalled process tree gets to exit before it is SIGKILLed. */
const TERMINATE_GRACE_MS = 2_000;

/** How often the termination wait re-checks whether the tree is gone. */
const TERMINATE_POLL_MS = 50;

/**
 * The process-table read, portable across BSD (macOS) and procps (Linux).
 *
 * `command=` is the one keyword both spell the same way — procps also accepts
 * `args=`, but BSD's `ps` does not, and BSD's `command=` is the same field —
 * so this form works unchanged on either. `-ax` (every process) and the
 * `pid=,ppid=,command=` selectors are likewise common to both.
 *
 * COLUMNS is set wide: BSD's `ps` truncates its output to the terminal
 * width when stdout is a terminal. This is always piped (so it would not
 * truncate anyway), but a narrow width would cut the tail off a long command
 * line — and the socket path this matches on sits at the FRONT of a dtach
 * master's argv, so even a truncated tail cannot corrupt the match.
 */
const PS_ARGS = ["-ax", "-o", "pid=,ppid=,command="];

/** One row of the process table. */
export interface ProcessEntry {
  pid: number;
  ppid: number;
  /** The process's full command line, as `ps` rendered it. */
  command: string;
}

/**
 * Parses `ps -ax -o pid=,ppid=,command=` output.
 *
 * The three fields are whitespace-delimited and the command line is LAST, so
 * the command is "everything after the second field" — a command line's own
 * spaces are preserved that way.
 */
export function parseProcessTable(stdout: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number.parseInt(parts[0], 10);
    const ppid = Number.parseInt(parts[1], 10);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    entries.push({ pid, ppid, command: parts.slice(2).join(" ") });
  }
  return entries;
}

/**
 * Whether this command line IS a dtach process — as opposed to some other
 * process whose command line merely MENTIONS a dtach invocation.
 *
 * The distinction matters: a shell running `sh -c "dtach -n /path/1.sock …"`
 * would otherwise be mistaken for the session's master, and `stop()` would
 * then signal the wrong process. Anchoring on argv[0] — which `ps` always
 * renders first — rules that out.
 */
function isDtachProcess(command: string): boolean {
  const argv0 = command.split(/\s+/, 1)[0] ?? "";
  return argv0 === "dtach" || argv0.endsWith("/dtach");
}

/**
 * The dtach session masters in a process table, keyed by the socket path
 * each one serves.
 *
 * Two rules, both load-bearing:
 *
 *   - Only a `-n` (create) invocation is a master. An attach client
 *     (`dtach -a <socket> …`) names the same socket but is not its owner,
 *     and mistaking one for the master would make a session look alive after
 *     its real master died.
 *
 *   - When several processes claim the same socket, the HIGHEST pid wins.
 *     `dtach -n` daemonizes: the process Mullion spawns forks, and the
 *     parent exits once the forked child is ready — so for a moment the
 *     table holds two dtach processes with the SAME argv, one of which is
 *     about to vanish. A fork always gives the child a higher pid, and the
 *     master is the survivor of that fork chain, so the highest pid is the
 *     one that will still be there. Picking the other would make `stop()`
 *     signal a corpse while the real master kept running.
 */
export function dtachMasters(table: ProcessEntry[]): Map<string, number> {
  const masters = new Map<string, number>();
  for (const entry of table) {
    if (!isDtachProcess(entry.command)) continue;
    const socketPath = extractDtachSocketPath(entry.command);
    if (socketPath === null) continue;
    const existing = masters.get(socketPath);
    if (existing === undefined || entry.pid > existing) {
      masters.set(socketPath, entry.pid);
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
 * **What the scope's identity is here.** On Linux it is a systemd unit,
 * identified by the dtach socket path in the unit's `Description`. On macOS
 * there is no unit, so the identity is the socket path directly, recovered
 * from a live process's command line. The trust rules are deliberately the
 * same shape:
 *
 *   - the master is identified  -> "alive"
 *   - no trace of the scope at all -> "dead" (a confident negative)
 *   - the scope's socket is still on disk, but its master cannot be
 *     identified -> "unknown" (the same posture the systemd backend takes
 *     when a scope's Description does not parse)
 *
 * The "unknown" case is the important one: it is what stops a process
 * table this backend cannot interpret from reading as "the session died",
 * which the reconciler would act on.
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

  async isAliveBatch(ids: string[]): Promise<Record<string, ScopeLiveness>> {
    const result: Record<string, ScopeLiveness> = Object.create(null);
    if (ids.length === 0) return result;
    const table = await this.readProcessTable();
    if (table === null) {
      // The process table could not be read at all. A liveness probe that
      // could not run knows NOTHING about any session — "unknown" for every
      // id, never "dead". Collapsing the two would let a transient `ps`
      // failure mark live sessions exited.
      for (const id of ids) result[id] = "unknown";
      return result;
    }
    const masters = dtachMasters(table);
    for (const id of ids) {
      const socketPath = this.socketPathFor(id);
      if (masters.has(socketPath)) {
        result[id] = "alive";
        continue;
      }
      // No master found for this socket. If the socket file is gone too,
      // the master is definitely gone (dtach removes its socket when it
      // exits) — a confident "dead". If the socket file is STILL there,
      // there IS a scope but its master cannot be identified: a stale
      // socket, or a process table this backend cannot interpret. That is
      // "unknown", never "dead" — the same posture the systemd backend takes
      // for a scope whose Description does not parse.
      result[id] = existsSync(socketPath) ? "unknown" : "dead";
    }
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
    const masterPid = dtachMasters(table).get(socketPath);
    if (masterPid === undefined) return;
    const tree = [masterPid, ...descendantsOf(table, masterPid).map((entry) => entry.pid)];
    for (const pid of tree) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone, or not ours to signal — either way, not fatal here.
      }
    }
    await waitForExit(tree, TERMINATE_GRACE_MS);
    for (const pid of tree) {
      if (!isProcessAlive(pid)) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Exited between the check and the signal.
      }
    }
  }

  /**
   * The processes running inside this session — the dtach master, the agent
   * it launched, and everything under those.
   *
   * There is no cgroup on macOS, so this walks the process tree instead.
   * An empty list means "nothing running, or nothing we could read" — the
   * same honest answer the interface allows for a platform that cannot
   * enumerate.
   */
  async listProcesses(id: string): Promise<CgroupProcess[]> {
    const socketPath = this.socketPathFor(id);
    const table = await this.readProcessTable();
    if (table === null) return [];
    const masterPid = dtachMasters(table).get(socketPath);
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
