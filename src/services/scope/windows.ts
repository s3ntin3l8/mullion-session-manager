import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CgroupProcess } from "../cgroup-inventory.js";
import { probeSocket } from "../unix-socket.js";
import { descendantsOf, type ProcessEntry } from "./detached.js";
import { sessionSocketPath } from "./dtach.js";
import { spawnScopeProcess } from "./spawn.js";
import type { ScopeBackend, ScopeLaunchSpec, ScopeLiveness } from "./types.js";

/** How long the process-table read may take before it counts as "could not read". */
const PROCESS_TABLE_TIMEOUT_MS = 15_000;

/** How long `taskkill` may take. */
const TASKKILL_TIMEOUT_MS = 10_000;

/**
 * The process table, as JSON, from the CIM provider — the one source on
 * Windows that gives every process's parent AND full command line. (`tasklist`
 * has neither; `wmic` is deprecated and missing on current Windows 11.)
 */
const PROCESS_TABLE_ARGS = [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
];

/**
 * Where the pty-host master script lives (src/pty-host/pty-host.mjs, copied
 * to dist/pty-host/ by the build) — resolved the same way as the hook
 * forwarder (hook-adapters/shared.ts's resolveHooksDir): under the stable
 * `MULLION_HOME/current` install path when there is one, so a session master
 * started by one release keeps a valid path across an update; next to this
 * module otherwise (src/ under tsx, dist/ when compiled — same relative path).
 */
export function resolvePtyHostPath(): string {
  const mullionHome = process.env.MULLION_HOME?.trim();
  if (mullionHome) {
    return path.join(mullionHome, "current", "dist", "pty-host", "pty-host.mjs");
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "..", "pty-host", "pty-host.mjs");
}

interface CimProcess {
  ProcessId?: number;
  ParentProcessId?: number;
  Name?: string | null;
  CommandLine?: string | null;
}

/**
 * Parses the CIM process table. ConvertTo-Json renders a one-element list as
 * a bare object, so both shapes are accepted. Rows without a pid are skipped;
 * a process whose command line we may not read (another user's, a protected
 * one) keeps its name as its command.
 */
export function parseCimProcessTable(stdout: string): ProcessEntry[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  const rows = (Array.isArray(parsed) ? parsed : [parsed]) as CimProcess[];
  const entries: ProcessEntry[] = [];
  for (const row of rows) {
    if (typeof row?.ProcessId !== "number") continue;
    entries.push({
      pid: row.ProcessId,
      ppid: typeof row.ParentProcessId === "number" ? row.ParentProcessId : 0,
      // Windows has no process groups; nothing here signals one.
      pgid: 0,
      command: row.CommandLine ?? row.Name ?? "",
    });
  }
  return entries;
}

/**
 * Whether a command line is the pty-host MASTER serving `endpoint` — i.e.
 * `... pty-host.mjs --serve <endpoint> ...`. The `-n` launcher names the same
 * endpoint and must not match; neither must a longer endpoint that merely
 * starts with ours (pipe names never contain a space, so the endpoint is a
 * whole token exactly when a space or the end of the line follows it).
 */
export function isPtyHostMasterFor(commandLine: string, endpoint: string): boolean {
  if (!commandLine.includes("pty-host")) return false;
  const needle = ` --serve ${endpoint}`;
  const at = commandLine.indexOf(needle);
  if (at === -1) return false;
  const after = commandLine.charAt(at + needle.length);
  return after === "" || after === " ";
}

export interface WindowsScopeBackendOptions {
  /** This instance's absolute, resolved sessions dir. */
  sessionsDir: string;
}

/**
 * The Windows scope backend — a detached pty-host master (src/pty-host/),
 * Mullion's stand-in for dtach, with no supervisor around it (issue #1728).
 *
 * **Why a session survives the backend here.** The master is launched
 * detached (its own process group, no console), so it is not torn down when
 * the Mullion process that started it exits — measured on Windows 11: a
 * session started by one process was re-attached from a fresh one after the
 * first had exited. That is the same property the systemd scope (Linux) and
 * dtach's daemonize (macOS) provide. Whether it also holds when Mullion
 * itself runs inside a kill-on-close job object (a Task Scheduler task, a
 * service wrapper) is a property of how it is installed, not of this backend.
 *
 * **The program is the same one the other backends run.** The launch plan
 * describes `dtach -n <endpoint> <shell> -lc <command>`; this backend runs
 * that very argv with the pty-host master standing in for dtach — it takes
 * dtach's arguments, so nothing upstream of the seam has to know.
 *
 * **Liveness** is the same socket probe the macOS backend uses, on the
 * session's named pipe: something accepts -> alive; no such pipe (ENOENT) ->
 * dead; anything else -> unknown, never widened to dead.
 *
 * **Identity** is the endpoint again: the master's command line names it
 * (`--serve <endpoint>`), which is what teardown and the process inventory
 * match the process table against.
 */
export class WindowsScopeBackend implements ScopeBackend {
  readonly kind = "pty-host";

  constructor(private readonly opts: WindowsScopeBackendOptions) {}

  private endpointFor(id: string): string {
    return sessionSocketPath(this.opts.sessionsDir, id);
  }

  /** The process table, or null when it could not be read (NOT an empty table). */
  private readProcessTable(): Promise<ProcessEntry[] | null> {
    return new Promise((resolve) => {
      execFile(
        "powershell.exe",
        PROCESS_TABLE_ARGS,
        { timeout: PROCESS_TABLE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (err, stdout) => {
          if (err) {
            resolve(null);
            return;
          }
          try {
            resolve(parseCimProcessTable(String(stdout)));
          } catch {
            resolve(null);
          }
        },
      );
    });
  }

  private async findMaster(
    id: string,
  ): Promise<{ table: ProcessEntry[]; master: number | undefined } | null> {
    const table = await this.readProcessTable();
    if (table === null) return null;
    const endpoint = this.endpointFor(id);
    // At most one master can hold a pipe (a second `--serve` fails to listen
    // and exits), and the `-n` launcher never matches — so the first match
    // is the master.
    const master = table.find((entry) => isPtyHostMasterFor(entry.command, endpoint))?.pid;
    return { table, master };
  }

  /**
   * Launches the program with the pty-host master standing in for dtach, and
   * resolves once the master is serving (`-n` exits 0 at that point, exactly
   * like `dtach -n`). A program that is not a dtach invocation runs as given.
   */
  async start(spec: ScopeLaunchSpec): Promise<void> {
    const [program, ...rest] = spec.argv;
    if (!program) {
      throw new Error(`${spec.label} failed: no program to launch`);
    }
    const [command, argv] =
      program === "dtach" ? [process.execPath, [resolvePtyHostPath(), ...rest]] : [program, rest];
    const endpoint = this.endpointFor(spec.id);
    await spawnScopeProcess({
      command,
      argv,
      cwd: spec.cwd,
      env: spec.env,
      timeoutMs: spec.timeoutMs,
      label: spec.label,
      scopeName: endpoint,
      scopeKind: "pipe",
      describeFailure: async () => {
        let probe: Awaited<ReturnType<typeof probeSocket>> = "unknown";
        try {
          probe = await probeSocket(endpoint);
        } catch {
          // Nothing to add.
        }
        return probe === "live"
          ? `the pipe ${endpoint} is already in use — a master for this session may still be running`
          : null;
      },
    });
  }

  /** Liveness for every requested id — a TOTAL map ("unknown" is never "dead"). */
  async isAliveBatch(ids: string[]): Promise<Record<string, ScopeLiveness>> {
    const result: Record<string, ScopeLiveness> = Object.create(null);
    for (const id of ids) result[id] = "unknown";
    await Promise.all(
      ids.map(async (id) => {
        try {
          const probe = await probeSocket(this.endpointFor(id));
          if (probe === "live") result[id] = "alive";
          else if (probe === "dead") result[id] = "dead";
        } catch {
          // A probe that threw tells us nothing.
        }
      }),
    );
    return result;
  }

  /**
   * Stops the session: the master AND everything under it — the shell, the
   * agent, its MCP servers — with `taskkill /T /F`, the Windows equivalent of
   * stopping a scope's whole cgroup. A pipe leaves nothing behind once its
   * master is gone, so there is no file to clean up.
   */
  async stop(id: string): Promise<void> {
    const found = await this.findMaster(id);
    if (found?.master === undefined) return;
    const pid = found.master;
    await new Promise<void>((resolve) => {
      execFile(
        "taskkill",
        ["/T", "/F", "/PID", String(pid)],
        { timeout: TASKKILL_TIMEOUT_MS, windowsHide: true },
        // Already gone, or not ours to kill — either way nothing to do here.
        () => resolve(),
      );
    });
  }

  /**
   * The processes in this session — the master, the program, and everything
   * under them. `cmdline` is a DISPLAY string split on whitespace, as on
   * macOS: Windows hands out a command line, not an argv.
   */
  async listProcesses(id: string): Promise<CgroupProcess[]> {
    const found = await this.findMaster(id);
    if (!found || found.master === undefined) return [];
    const { table, master } = found;
    const byPid = new Map(table.map((entry) => [entry.pid, entry]));
    const tree = [master, ...descendantsOf(table, master).map((entry) => entry.pid)];
    return tree.map((pid) => {
      const entry = byPid.get(pid);
      const argv = entry ? splitCommandLine(entry.command) : [];
      return {
        pid,
        ppid: entry?.ppid ?? 0,
        comm: path.win32.basename(argv[0] ?? ""),
        cmdline: argv,
      };
    });
  }
}

/**
 * Splits a Windows command line for DISPLAY: whitespace-separated, with
 * double quotes grouping (and dropped) — enough that
 * `"C:\Program Files\Git\bin\bash.exe" -lc "x y"` reads as three arguments.
 * Not the full CommandLineToArgvW backslash rules; nothing here executes it.
 */
export function splitCommandLine(commandLine: string): string[] {
  const args: string[] = [];
  let current = "";
  let quoted = false;
  let inArg = false;
  for (const ch of commandLine) {
    if (ch === '"') {
      quoted = !quoted;
      inArg = true;
    } else if (/\s/.test(ch) && !quoted) {
      if (inArg) args.push(current);
      current = "";
      inArg = false;
    } else {
      current += ch;
      inArg = true;
    }
  }
  if (inArg) args.push(current);
  return args;
}
