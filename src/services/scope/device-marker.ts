import { execFile, spawn as spawnChild } from "node:child_process";
import {
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { deviceMarkerPath } from "../device-process.js";
import type { DeviceScopeBackendOptions } from "./device-systemd.js";
import type { ScopeBackend, ScopeExit, ScopeLaunchSpec, ScopeLiveness } from "./types.js";

/** How long the process-table read may take before it counts as "could not read". */
const PS_TIMEOUT_MS = 5_000;
/** How long a SIGTERMed emulator gets to shut down before its group is SIGKILLed. */
const TERMINATE_GRACE_MS = 10_000;
/** How long, after SIGKILL, to wait for the process to be gone. */
const KILL_GRACE_MS = 2_000;
const POLL_MS = 100;
/** How many times, and how far apart, to retry an unreadable process table at launch. */
const RECORD_ATTEMPTS = 3;
const RECORD_RETRY_MS = 200;
/**
 * An EMPTY marker means "touched by the manager, launch not yet recorded" —
 * a window of a second or so inside `start()`. Past this age it can only be the
 * leftover of a Mullion that died inside that window, with no pid ever written:
 * there is no recorded scope to be unsure about, so liveness reads "dead" and
 * the next launch can reclaim the id instead of being wedged by "unknown".
 */
const EMPTY_MARKER_STALE_MS = 60_000;

/**
 * `stop()` could not confirm that the scope's process is gone (or could not
 * re-confirm whose it is). The marker is the ONLY record of a possibly-live
 * emulator here, so callers must keep it — and the port — when this is thrown.
 */
export class DeviceScopeStopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceScopeStopError";
  }
}

/**
 * The process-table read, portable across BSD (macOS) and procps (Linux).
 *
 * `lstart` is local time unless `TZ` is pinned, and its text changes with the
 * locale — so EVERY read (the capture at launch and every later check) runs
 * under `TZ=UTC LC_ALL=C`. Without that a DST change or a different `TZ`
 * between the capture and a check makes a live process "mismatch". `comm` is
 * last because it is a path (no arguments) that may contain spaces.
 */
const PS_ARGS = ["-ax", "-o", "pid=,pgid=,lstart=,comm="];
const PS_ENV = { TZ: "UTC", LC_ALL: "C" };

/**
 * The executable basenames an Android emulator can have once running.
 *
 * `emulator` is a launcher that execs `qemu-system-*` in the SAME pid (measured
 * on macOS arm64, issue #1854's B0 spike: pid and `lstart` are unchanged across
 * the exec, and `emulator` is never seen in `ps` afterwards). Only
 * `qemu-system-aarch64-headless` was observed; the others cover Intel hosts, a
 * headed run, and the instant before the exec.
 */
const EMULATOR_COMM = /^(emulator(64-.*)?|qemu-system-[A-Za-z0-9_]+(-headless)?)$/;

/** One row of the process table. */
interface PsRow {
  pid: number;
  pgid: number;
  /** `lstart` with its whitespace normalised ("Sat Oct  3 …" → "Sat Oct 3 …"). */
  lstart: string;
  comm: string;
}

/** What the marker file holds once a launch has been recorded. */
interface DeviceMarker {
  v: 1;
  pid: number;
  /** null when `ps` could not be read at launch: the pid is recorded but cannot be confirmed later. */
  lstart: string | null;
}

/** Parses `ps -ax -o pid=,pgid=,lstart=,comm=` output (lstart is always 5 tokens). */
export function parseDeviceProcessTable(stdout: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 8) continue;
    const pid = Number.parseInt(parts[0], 10);
    const pgid = Number.parseInt(parts[1], 10);
    if (!Number.isInteger(pid) || !Number.isInteger(pgid)) continue;
    rows.push({ pid, pgid, lstart: parts.slice(2, 7).join(" "), comm: parts.slice(7).join(" ") });
  }
  return rows;
}

function readProcessTable(): Promise<PsRow[] | null> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      PS_ARGS,
      { env: { ...process.env, ...PS_ENV }, timeout: PS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : parseDeviceProcessTable(String(stdout))),
    );
  });
}

/** The marker's content: a record, "empty" (touched, no launch recorded), or unreadable. */
function readMarker(markerPath: string): DeviceMarker | "empty" | "unreadable" | "absent" {
  let raw: string;
  try {
    raw = readFileSync(markerPath, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
  }
  if (raw.trim() === "") return "empty";
  try {
    const parsed = JSON.parse(raw) as Partial<DeviceMarker>;
    if (parsed.v === 1 && Number.isInteger(parsed.pid) && (parsed.pid as number) > 0) {
      return {
        v: 1,
        pid: parsed.pid as number,
        lstart: typeof parsed.lstart === "string" ? parsed.lstart : null,
      };
    }
  } catch {
    // fall through
  }
  return "unreadable";
}

/**
 * Writes the launch record next to the (already touched) marker, then renames
 * it into place. The temp file is created `wx` so a pre-planted symlink at that
 * name can't redirect the write, and the rename replaces the marker itself
 * (never writing through a link at the marker path) — the same reasoning as
 * device-process.ts's `touchDeviceMarker`.
 */
function writeMarker(markerPath: string, marker: DeviceMarker): void {
  const tmp = `${markerPath}.${process.pid}.tmp`;
  try {
    unlinkSync(tmp);
  } catch {
    // none left over
  }
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(marker));
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, markerPath);
}

/** Whether an empty marker is old enough that no launch can still be in flight. */
function emptyMarkerIsStale(markerPath: string): boolean {
  try {
    return Date.now() - statSync(markerPath).mtimeMs > EMPTY_MARKER_STALE_MS;
  } catch {
    return false;
  }
}

function safeKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // ESRCH: already gone. EPERM: not ours to signal — nothing more to do.
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return !isProcessAlive(pid);
}

/**
 * The macOS device-scope backend (issue #1854): an Android emulator as a
 * detached, launchd-reparented process, identified by its **pid + start time**
 * recorded in the device's marker file.
 *
 * **The scope.** The Linux scope exists so the emulator OUTLIVES the Mullion
 * process that started it. `spawn(..., {detached: true})` gives the same
 * property on macOS: the child is its own session/process-group leader
 * (`pgid == pid`) and is reparented to launchd when Mullion exits.
 *
 * **Identity.** A pid alone is not enough — pids are reused — so the marker
 * records `{pid, lstart}` (the process's start time, read under `TZ=UTC
 * LC_ALL=C`) and a later Mullion trusts it only while BOTH still match and the
 * command is an emulator binary.
 *
 * **The trust rule** (the same as the systemd backend's): an unconfirmable
 * scope is "unknown", never "dead" and never "not ours" — a false "dead" makes
 * the manager mark a live device exited and tear it down. The only "dead"
 * answers are an absent marker, a pid that is not in the table, and a pid
 * that is now some OTHER program. A start-time mismatch on an emulator
 * binary is "unknown" (it could be ours, e.g. after a clock step).
 *
 * **The marker.** Linux markers stay empty (the identity is the systemd
 * Description); these carry JSON, on purpose — don't "fix" one side to match.
 * The file is touched before launch by the manager (`touchDeviceMarker`) and
 * REPLACED here once the pid is known; it only needs to exist for
 * scripts/check-scope-leaks.ts.
 *
 * **Teardown.** The emulator is its own process-group leader and the pid IS the
 * emulator (no launcher parent — measured), so `kill -TERM -<pgid>` takes down
 * it and its helpers (`netsimd`, adb children) in ~3 s; SIGKILL follows only
 * after a grace period. It only ever signals a process whose identity it has
 * just re-confirmed.
 */
export class MarkerDeviceScopeBackend implements ScopeBackend {
  readonly kind = "marker-device";

  constructor(private readonly opts: DeviceScopeBackendOptions) {}

  private markerPath(id: string): string {
    return deviceMarkerPath(this.opts.sessionsDir, id);
  }

  async start(spec: ScopeLaunchSpec): Promise<void> {
    const markerPath = this.markerPath(spec.id);
    const [program, ...args] = spec.argv;
    const child = spawnChild(program, args, {
      detached: true,
      stdio: "ignore",
      cwd: spec.cwd,
      env: spec.env,
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      child.once("error", onError);
      child.once("spawn", () => {
        child.off("error", onError);
        resolve();
      });
    });
    child.unref();
    const pid = child.pid;
    if (pid === undefined) throw new Error(`${spec.label} produced no pid (marker ${markerPath})`);

    // Exits are only DELIVERED once the launch is recorded: a launch that fails
    // here rejects start() instead, and reporting it through onExit too would
    // make the manager tear the same device down twice. An exit that lands in
    // the meantime is held and delivered right after.
    let delivering = false;
    let early: ScopeExit | null = null;
    const emit = (exit: ScopeExit): void => {
      if (delivering) spec.onExit?.(exit);
      else early ??= exit;
    };
    child.on("error", (err) => emit({ code: null, error: err, scopeName: markerPath }));
    child.on("exit", (code) => emit({ code, scopeName: markerPath }));

    // We hold this child's handle, so killing its group here is certain to be
    // ours — unlike stop(), which has to re-confirm an identity from a marker.
    const abandon = (): void => safeKill(-pid, "SIGKILL");

    let row: PsRow | undefined;
    let readable = false;
    for (let attempt = 0; attempt < RECORD_ATTEMPTS && !readable; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, RECORD_RETRY_MS));
      const table = await readProcessTable();
      if (table) {
        readable = true;
        row = table.find((r) => r.pid === pid);
      }
    }
    if (!readable) {
      // A marker without a start time can never be confirmed later, and would
      // leave an emulator no one can account for — fail closed instead.
      abandon();
      throw new Error(
        `${spec.label}: could not read the process table to record the launch (marker ${markerPath})`,
      );
    }
    if (!row) {
      throw new Error(`${spec.label} exited before it could be recorded (marker ${markerPath})`);
    }
    try {
      writeMarker(markerPath, { v: 1, pid, lstart: row.lstart });
    } catch (err) {
      abandon();
      throw err;
    }
    delivering = true;
    if (early) spec.onExit?.(early);
  }

  async isAliveBatch(ids: string[]): Promise<Record<string, ScopeLiveness>> {
    const result: Record<string, ScopeLiveness> = Object.create(null);
    if (ids.length === 0) return result;
    const table = await readProcessTable();
    for (const id of ids) {
      result[id] = this.liveness(this.markerPath(id), table);
    }
    return result;
  }

  private liveness(markerPath: string, table: PsRow[] | null): ScopeLiveness {
    const marker = readMarker(markerPath);
    if (marker === "absent") return "dead";
    if (marker === "empty") return emptyMarkerIsStale(markerPath) ? "dead" : "unknown";
    // An unreadable marker proves nothing either way.
    if (marker === "unreadable") return "unknown";
    if (table === null) return "unknown";
    const row = table.find((r) => r.pid === marker.pid);
    if (!row) return "dead";
    const isEmulator = EMULATOR_COMM.test(path.basename(row.comm));
    if (marker.lstart === null) return "unknown";
    if (row.lstart === marker.lstart) return isEmulator ? "alive" : "unknown";
    // Start time differs. Another program means the pid was reused (ours is
    // gone); an emulator binary could still be ours — never guess "dead".
    return isEmulator ? "unknown" : "dead";
  }

  /**
   * Resolves only when it is SAFE for the caller to forget this scope (delete the
   * marker, free the port): there was nothing recorded, the recorded process is
   * provably gone or provably not ours any more, or it was identity-confirmed and
   * has now exited. Everything else throws `DeviceScopeStopError` — the marker is
   * the only record of a possibly-live emulator here, so an unconfirmable stop must
   * not be reported as done.
   */
  async stop(id: string): Promise<void> {
    const markerPath = this.markerPath(id);
    const marker = readMarker(markerPath);
    if (marker === "absent" || marker === "empty") return;
    if (marker === "unreadable") {
      throw new DeviceScopeStopError(`device ${id}: marker ${markerPath} is unreadable`);
    }
    const table = await readProcessTable();
    if (!table) {
      throw new DeviceScopeStopError(
        `device ${id}: could not read the process table to confirm it`,
      );
    }
    const row = table.find((r) => r.pid === marker.pid);
    if (!row) return;
    const isEmulator = EMULATOR_COMM.test(path.basename(row.comm));
    if (marker.lstart === null) {
      throw new DeviceScopeStopError(`device ${id}: no start time recorded for pid ${marker.pid}`);
    }
    if (row.lstart !== marker.lstart) {
      // The pid now belongs to another program: ours is gone. A same-named binary
      // could still be ours (e.g. a clock step) — never guess.
      if (!isEmulator) return;
      throw new DeviceScopeStopError(
        `device ${id}: pid ${marker.pid} is an emulator but its start time changed`,
      );
    }
    if (!isEmulator) {
      throw new DeviceScopeStopError(
        `device ${id}: pid ${marker.pid} matches the recorded start time but is not an emulator`,
      );
    }

    // The emulator leads its own group (detached: true). Signal the group when
    // that holds, so its helpers go with it; otherwise just the process.
    const target = row.pgid === row.pid ? -row.pid : row.pid;
    safeKill(target, "SIGTERM");
    if (await waitForExit(row.pid, TERMINATE_GRACE_MS)) return;

    // Still there after the grace period. Re-confirm it is still the same
    // process before escalating — up to 10 s have passed since the last read.
    const again = await readProcessTable();
    if (!again) {
      throw new DeviceScopeStopError(`device ${id}: could not re-read the process table`);
    }
    const stillOurs = again.find(
      (r) =>
        r.pid === marker.pid &&
        r.lstart === marker.lstart &&
        EMULATOR_COMM.test(path.basename(r.comm)),
    );
    if (!stillOurs) return;
    safeKill(target, "SIGKILL");
    if (!(await waitForExit(row.pid, KILL_GRACE_MS))) {
      throw new DeviceScopeStopError(`device ${id}: pid ${marker.pid} survived SIGKILL`);
    }
  }

  async listProcesses(): Promise<[]> {
    return [];
  }
}
