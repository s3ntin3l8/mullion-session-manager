#!/usr/bin/env node
// The Windows launcher (issue #2160, part of #1728) — what the per-user
// scheduled task runs. It is the Windows counterpart of two things the other
// platforms get from their service manager:
//
//   - systemd's `EnvironmentFile=` + `ExecStart=` / scripts/run-with-env.sh's
//     parse-the-.env-then-exec-node: this reads the install's .env and starts
//     `node dist/server.js` with it, from the `current` release directory.
//   - systemd's `Restart=on-failure` / `RestartSec=2`: Task Scheduler's own
//     restart-on-failure has a one-minute floor, so this restarts the server
//     itself, with a backoff.
//
// And, because a scheduled task has no console, it is where the server's
// output goes: `<mullion-home>/logs/mullion.log`, rotated by size.
//
// Usage: node scripts/windows-launcher.mjs <mullion-home> [task-name]
//   mullion-home  the install root (parent of releases/, current, data/, .env)
//   task-name     the scheduled task running this; exported to the server as
//                 MULLION_SERVICE_UNIT (what the systemd unit's `%n` is) unless
//                 the .env sets it, so a self-update can restart the right task
//
// Stopping the task kills this process and, with it, the server (an ordinary
// child), while the session masters — spawned detached by the pty-host —
// survive it. That is measured, not assumed: see the spike results on #2160.
// So "stop, then start" is a clean restart, and sessions keep running.
//
// Plain ESM on purpose: it ships in the release tarball's scripts/ and runs
// under whatever Node the install recorded, with no build step. The pieces
// the tests drive (parseEnvFile, RotatingLog, nextRestartDelay, supervise) are
// exported; the entry point only runs when this file is executed directly.
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The log is rotated (to `mullion.log.1`, replacing it) once it reaches this size. */
export const LOG_MAX_BYTES = 10 * 1024 * 1024;

/** The first restart delay, matching the systemd units' `RestartSec=2`. */
export const RESTART_BASE_MS = 2_000;
export const RESTART_MAX_MS = 30_000;

/** How long after the server exits its output pipes are given to drain. */
export const STDIO_DRAIN_MS = 2_000;

/** A server that stayed up this long was healthy: its next failure restarts quickly again. */
export const HEALTHY_UPTIME_MS = 60_000;

/**
 * The variables in a .env file, parsed the way systemd's `EnvironmentFile=`
 * (and scripts/run-with-env.sh) reads it — NOT the way a shell sources it:
 * `KEY=VALUE` literally, so a value with spaces, `$` or a backtick is taken
 * as written. `#` lines and lines without `=` are skipped, a key must be a
 * plain name, and one layer of matching surrounding quotes is stripped.
 * A trailing `\r` is dropped as well: a .env edited on Windows has CRLF
 * line endings, which the shell launcher never has to face.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnvFile(text) {
  /** @type {Record<string, string>} */
  const vars = {};
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1);
    if (value.length >= 2) {
      const first = value[0];
      if ((first === '"' || first === "'") && value.endsWith(first)) value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

/**
 * An exit as the log words it. Windows reports a process that was killed
 * (TerminateProcess, Task Manager, an out-of-memory kill) as an unsigned
 * 32-bit exit code, so a force-kill of -1 reads as 4294967295 — shown here
 * as the signed value it is.
 *
 * @param {number | null} code
 * @param {string | null} signal
 * @returns {string}
 */
export function describeExit(code, signal) {
  if (signal) return `signal ${signal}`;
  if (typeof code === "number" && code > 0x7fffffff) return `code ${code - 0x100000000}`;
  return `code ${code}`;
}

/** The delay before the next restart: back off while the server keeps failing fast. *
 * @param {number | null} previousDelayMs null before the first restart
 * @param {number} uptimeMs how long the server that just exited had been up
 * @returns {number}
 */
export function nextRestartDelay(previousDelayMs, uptimeMs) {
  if (uptimeMs >= HEALTHY_UPTIME_MS || previousDelayMs === null) return RESTART_BASE_MS;
  return Math.min(previousDelayMs * 2, RESTART_MAX_MS);
}

/**
 * An append-only log file that rotates itself by size: when a write would
 * take it past `maxBytes`, the current file becomes `<file>.1` (replacing an
 * older one) and a fresh file is started. One generation is kept — the log is
 * for finding out why the server stopped, not an archive.
 */
export class RotatingLog {
  /**
   * @param {string} file
   * @param {number} [maxBytes]
   */
  constructor(file, maxBytes = LOG_MAX_BYTES) {
    this.file = file;
    this.maxBytes = maxBytes;
    mkdirSync(path.dirname(file), { recursive: true });
    this.fd = -1;
    this.size = 0;
    this.open();
  }

  open() {
    this.fd = openSync(this.file, "a");
    this.size = statSync(this.file).size;
  }

  /**
   * Never throws. A log that cannot be written (a full disk, a file another
   * program has locked) loses that line; it must not take the supervisor
   * down with it — the writes happen inside stream handlers, where a throw
   * is an uncaught exception, and the launcher dying would leave the server
   * unsupervised.
   *
   * @param {Buffer | string} chunk
   */
  write(chunk) {
    try {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (this.fd < 0) this.open();
      if (this.size > 0 && this.size + data.length > this.maxBytes) this.rotate();
      writeSync(this.fd, data);
      this.size += data.length;
    } catch {
      // Dropped.
    }
  }

  rotate() {
    closeSync(this.fd);
    this.fd = -1;
    let renamed = true;
    try {
      renameSync(this.file, `${this.file}.1`);
    } catch {
      // The old generation cannot be replaced (something has it open): keep
      // appending to the current file rather than lose the server's output.
      renamed = false;
    }
    this.fd = openSync(this.file, "a");
    // After a failed rename the file is still the big one; counting from zero
    // again means the next attempt comes after another `maxBytes`, not on
    // every write.
    this.size = renamed ? statSync(this.file).size : 0;
  }

  close() {
    if (this.fd < 0) return;
    try {
      closeSync(this.fd);
    } catch {
      // Already closed.
    }
    this.fd = -1;
  }
}

/**
 * Runs the server until it exits cleanly or `stop()` is called, restarting it
 * when it fails. `runServer()` starts one server and resolves with how it
 * ended (`{ code, signal }`); it is injected so the loop can be tested
 * without a real process. Resolves with the exit code the launcher should
 * itself exit with.
 *
 * @param {object} options
 * @param {() => Promise<{ code: number | null, signal: string | null }>} options.runServer
 * @param {(ms: number) => Promise<unknown>} [options.sleep]
 * @param {() => number} [options.now]
 * @param {(line: string) => void} [options.log]
 * @returns {{ done: Promise<number>, stop: () => void }}
 */
export function supervise({
  runServer,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  log = () => {},
}) {
  let stopping = false;
  /** @type {(() => void) | null} */
  let wake = null;
  const stop = () => {
    stopping = true;
    wake?.();
  };
  const done = (async () => {
    /** @type {number | null} */
    let delay = null;
    while (!stopping) {
      const startedAt = now();
      const { code, signal } = await runServer();
      if (stopping) return code ?? 0;
      if (code === 0) {
        log("the server exited cleanly; not restarting it");
        return 0;
      }
      delay = nextRestartDelay(delay, now() - startedAt);
      log(`the server exited (${describeExit(code, signal)}); restarting in ${delay} ms`);
      await Promise.race([sleep(delay), new Promise((resolve) => (wake = resolve))]);
      wake = null;
    }
    return 0;
  })();
  return { done, stop };
}

/**
 * The environment the server starts with: the launcher's own, overlaid with
 * the .env's (as `EnvironmentFile=` overrides the manager's environment),
 * with MULLION_HOME and MULLION_SERVICE_UNIT defaulted.
 *
 * @param {object} options
 * @param {string} options.home
 * @param {string} options.taskName
 * @param {NodeJS.ProcessEnv} options.baseEnv
 * @param {string} options.envFileText
 * @param {boolean} [options.caseInsensitive] Windows' environment is: a `.env`
 *   `PATH=` replaces the inherited `Path` rather than sitting beside it.
 *   Defaults to the platform.
 * @returns {NodeJS.ProcessEnv}
 */
export function serverEnv({
  home,
  taskName,
  baseEnv,
  envFileText,
  caseInsensitive = process.platform === "win32",
}) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...baseEnv };
  for (const [key, value] of Object.entries(parseEnvFile(envFileText))) {
    if (caseInsensitive) {
      const lower = key.toLowerCase();
      for (const existing of Object.keys(env)) {
        if (existing !== key && existing.toLowerCase() === lower) delete env[existing];
      }
    }
    env[key] = value;
  }
  if (!env.MULLION_HOME) env.MULLION_HOME = home;
  if (taskName && !env.MULLION_SERVICE_UNIT) env.MULLION_SERVICE_UNIT = taskName;
  return env;
}

const stamp = () => new Date().toISOString();

/**
 * The launcher proper. Resolves with the process exit code.
 *
 * @param {string[]} [argv]
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @param {Pick<NodeJS.EventEmitter, "on" | "off">} [signals] where the
 *   shutdown signals arrive; the process, but injectable so a test can
 *   deliver one without signalling the test runner
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv, baseEnv = process.env, signals = process) {
  const home = argv[2];
  const taskName = argv[3] ?? "";
  if (!home) {
    process.stderr.write("usage: node windows-launcher.mjs <mullion-home> [task-name]\n");
    return 2;
  }
  const current = path.join(home, "current");
  const log = new RotatingLog(path.join(home, "logs", "mullion.log"));
  const note = (line) => log.write(`${stamp()} [launcher] ${line}\n`);

  const entry = path.join(current, "dist", "server.js");
  if (!existsSync(entry)) {
    note(`${entry} does not exist — is the install complete?`);
    log.close();
    return 1;
  }
  const envFile = path.join(home, ".env");
  let child = null;

  const runServer = () =>
    new Promise((resolve) => {
      // Re-read on every start: an operator's edit takes effect on the next
      // restart, the way a systemd unit re-reads its EnvironmentFile.
      const envFileText = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
      child = spawn(process.execPath, ["dist/server.js"], {
        cwd: current,
        env: serverEnv({ home, taskName, baseEnv, envFileText }),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      child.stdout.on("data", (chunk) => log.write(chunk));
      child.stderr.on("data", (chunk) => log.write(chunk));
      child.once("error", (err) => {
        note(`could not start the server: ${err.message}`);
        resolve({ code: 1, signal: null });
      });
      // 'close' comes after the output pipes have drained, so a crash's last
      // lines (usually the stack trace) are in the log before the restart
      // note. 'exit' alone can come first. But a long-lived grandchild that
      // inherited the pipes would hold 'close' off forever and leave the
      // supervisor waiting instead of restarting, so 'exit' also settles it
      // after a short grace period.
      child.once("exit", (code, signal) => {
        const timer = setTimeout(() => resolve({ code, signal }), STDIO_DRAIN_MS);
        timer.unref?.();
      });
      child.once("close", (code, signal) => resolve({ code, signal }));
    });

  const supervisor = supervise({ runServer, log: note });
  const shutdown = (signal) => {
    note(`received ${signal}; stopping the server`);
    supervisor.stop();
    child?.kill();
  };
  const handlers = ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"].map((signal) => {
    const handler = () => shutdown(signal);
    signals.on(signal, handler);
    return [signal, handler];
  });

  note(`starting the server (pid ${process.pid}) from ${current}`);
  const code = await supervisor.done;
  for (const [signal, handler] of handlers) signals.off(signal, handler);
  note(`exiting with code ${code}`);
  log.close();
  return code;
}

/**
 * Whether this file is the script node was started with. Compared by real
 * path, not by URL: the task starts it through the `current` junction, and
 * Node resolves the main module through links — so `import.meta.url` is the
 * release directory's path while `process.argv[1]` is still `current`'s.
 */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${fileURLToPath(import.meta.url)}: ${err?.stack ?? err}\n`);
      process.exit(1);
    },
  );
}
