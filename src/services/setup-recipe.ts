// Issue #2245 — the per-project setup recipe: a shell command (`sh -c`) that
// installs dependencies in a freshly cut worktree or a freshly cloned checkout.
//
// Two halves, deliberately split the way scaffold generation is:
//  - `execSetupRecipe` is the RUNNER. It executes the recipe in `cwd` on THIS
//    machine, captures output to `<sessionsDir>/<logKey>.setup.log`, and never
//    throws. The primary calls it in-process for a local host; a remote agent
//    calls it from `POST /internal/run-setup`.
//  - `startSetupRecipe` is the primary-side TRIGGER. It fire-and-forgets: the
//    session start never waits for an install, and a failed or timed-out
//    recipe only flags the session (`sessions.setup_status`) — it never blocks
//    or kills it.

import { spawn } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { sessions, type projects } from "../db/schema.js";

type ProjectRow = typeof projects.$inferSelect;
import { LOCAL_HOST_ID } from "./host-registry.js";
import { viaRemote } from "./host-git.js";
import { buildSessionEnv } from "./session-env.js";
import {
  DEFAULT_SETUP_TIMEOUT_MS,
  SETUP_LOG_TAIL_BYTES,
  type SetupRunResult,
  type SetupStatus,
} from "./setup-recipe-shared.js";
import { broadcastTaskEvent } from "./task-events.js";

export {
  SETUP_RECIPE_MAX_LENGTH,
  DEFAULT_SETUP_TIMEOUT_MS,
  SETUP_LOG_TAIL_BYTES,
  type SetupStatus,
  type SetupRunResult,
} from "./setup-recipe-shared.js";

const LOG_KEY_PATTERN = /^(checkout-)?(\d{1,15})$/;
// The per-run timeout is process-local, never taken from a request: a caller
// (including `/internal/run-setup`) cannot choose how long a timer runs.
let setupTimeoutMs = DEFAULT_SETUP_TIMEOUT_MS;

/** Test-only: shorten (or restore, with no argument) the run timeout. */
export function setSetupTimeoutForTests(ms?: number): void {
  setupTimeoutMs = ms ?? DEFAULT_SETUP_TIMEOUT_MS;
}

/** `<sessionsDir>/<logKey>.setup.log`. `logKey` is a session id or
 * `checkout-<projectId>`; the filename is rebuilt from the parsed integer, so
 * no part of the request's string reaches the path. Anything else throws. */
export function setupLogPath(sessionsDir: string, logKey: string): string {
  const m = LOG_KEY_PATTERN.exec(logKey);
  if (!m) throw new Error("invalid setup log key");
  const stem = `${m[1] ?? ""}${Number(m[2])}`;
  const root = path.resolve(sessionsDir);
  const file = path.join(root, `${stem}.setup.log`);
  if (path.dirname(file) !== root || !file.startsWith(root + path.sep)) {
    throw new Error("invalid setup log key");
  }
  return file;
}

// One run per directory at a time, per process. Keyed by the resolved cwd.
const inFlight = new Set<string>();

/** The canonical, existing directory `cwd` names, or null. The recipe only ever
 * runs in a directory that resolves (symlinks followed) to a real one. When
 * `roots` is given (the remote route: a DB-less agent's only trust anchor) the
 * real path must also sit inside one of the real roots — the explicit
 * `startsWith(root + sep)` guard is the containment check on the value that
 * reaches `spawn`, not just on the request's string. */
function canonicalCwd(cwd: string, roots?: string[]): string | null {
  if (typeof cwd !== "string" || cwd.includes("\0") || !path.isAbsolute(cwd)) return null;
  if (roots === undefined) return existingDir(cwd);
  // Request-derived cwd: contain it lexically BEFORE any filesystem call, then
  // again on the symlink-resolved path (a link inside a root must not escape).
  let realRoots: string[];
  try {
    realRoots = roots.map((r) => realpathSync(path.resolve(r)));
  } catch {
    return null;
  }
  const lexical = path.resolve(cwd);
  const lexicalRoots = roots.map((r) => path.resolve(r));
  if (!lexicalRoots.some((root) => lexical === root || lexical.startsWith(root + path.sep))) {
    return null;
  }
  const real = existingDir(lexical);
  if (real === null) return null;
  if (!realRoots.some((root) => real === root || real.startsWith(root + path.sep))) return null;
  return real;
}

/** The symlink-resolved directory `dir` names, or null when it is not one. */
function existingDir(dir: string): string | null {
  try {
    const real = realpathSync(dir);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** Test-only introspection. */
export function setupRunsInFlightForTests(): number {
  return inFlight.size;
}

export interface ExecSetupOptions {
  cwd: string;
  recipe: string;
  logKey: string;
  sessionsDir: string;
  /** Real-path containment for `cwd`; omit for a trusted in-process caller. */
  withinRoots?: string[];
}

/** Runs `recipe` with `sh -c` in `cwd`, output to the log. Never throws. */
export async function execSetupRecipe(opts: ExecSetupOptions): Promise<SetupRunResult> {
  let logPath: string;
  try {
    logPath = setupLogPath(opts.sessionsDir, opts.logKey);
  } catch (err) {
    return {
      outcome: "failed",
      exitCode: null,
      logPath: "",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  const key = canonicalCwd(opts.cwd, opts.withinRoots);
  if (key === null) {
    return {
      outcome: "failed",
      exitCode: null,
      logPath,
      detail: "cwd is not an existing directory",
    };
  }
  if (inFlight.has(key)) {
    return { outcome: "busy", exitCode: null, logPath, detail: "a setup run is already in flight" };
  }
  inFlight.add(key);
  try {
    return await spawnRecipe(opts, key, logPath);
  } finally {
    inFlight.delete(key);
  }
}

/** The session environment (server config scrubbed, the user's interactive
 * PATH merged in — a systemd service's PATH lacks ~/.nvm, ~/.local/bin) minus
 * Mullion's own credentials and NODE_ENV: a production server's
 * NODE_ENV=production would make `npm ci` skip devDependencies (issue #70),
 * leaving the new tree unable to build or test. */
function recipeEnv(): NodeJS.ProcessEnv {
  const env = buildSessionEnv();
  delete env.NODE_ENV;
  for (const key of Object.keys(env)) {
    if (/^MULLION_.*(TOKEN|SECRET|KEY)/.test(key)) delete env[key];
  }
  return env;
}

function spawnRecipe(
  opts: ExecSetupOptions,
  cwd: string,
  logPath: string,
): Promise<SetupRunResult> {
  const timeoutMs = setupTimeoutMs;
  return new Promise((resolve) => {
    let fd: number;
    try {
      mkdirSync(path.dirname(logPath), { recursive: true });
      // O_NOFOLLOW: never write through a symlink planted at the log path.
      fd = openSync(
        logPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
        0o600,
      );
    } catch (err) {
      resolve({
        outcome: "failed",
        exitCode: null,
        logPath,
        detail: `could not open the setup log: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    let settled = false;
    let timedOut = false;
    const finish = (result: SetupRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        closeSync(fd);
      } catch {
        // Already closed; nothing to do.
      }
      resolve(result);
    };
    // The recipe IS a shell command by design (a project setting, set by the
    // authenticated operator); the request-reachable path is the token-gated
    // `/internal/run-setup`. CodeQL's js/command-line-injection on this spawn is
    // the feature itself, not an injection: `cwd` is containment-checked above
    // and the recipe never gets interpolated into anything else.
    // `detached` puts the shell in its own process group so a timeout can kill
    // the whole install tree (npm and its children), not just `sh`.
    const child = spawn("sh", ["-c", opts.recipe], {
      cwd,
      stdio: ["ignore", fd, fd],
      env: recipeEnv(),
      detached: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", (err) =>
      finish({ outcome: "failed", exitCode: null, logPath, detail: err.message }),
    );
    child.on("close", (code) => {
      if (timedOut) {
        finish({
          outcome: "timeout",
          exitCode: null,
          logPath,
          detail: `timed out after ${Math.round(timeoutMs / 1000)}s`,
        });
      } else if (code === 0) {
        finish({ outcome: "ok", exitCode: 0, logPath });
      } else {
        finish({ outcome: "failed", exitCode: code, logPath, detail: `exited with code ${code}` });
      }
    });
  });
}

/** Reads the tail of a setup log on THIS machine; null when there is none. */
export function readLocalSetupLog(
  sessionsDir: string,
  logKey: string,
): { content: string; truncated: boolean } | null {
  try {
    const file = setupLogPath(sessionsDir, logKey);
    // Open first and stat the descriptor, so the size we read against is the
    // file we actually opened (no check-then-use gap).
    const fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, SETUP_LOG_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      return { content: buf.toString("utf8"), truncated: size > SETUP_LOG_TAIL_BYTES };
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** The session's setup log, from whichever host ran the recipe. */
export async function readSessionSetupLog(
  app: FastifyInstance,
  hostId: string,
  sessionId: number,
): Promise<{ content: string; truncated: boolean } | null> {
  if (hostId === LOCAL_HOST_ID) {
    return readLocalSetupLog(app.config.SESSIONS_DIR, String(sessionId));
  }
  const result = await viaRemote(app, hostId, (client) =>
    client.resolveSetupLog(String(sessionId)),
  );
  return result.ok ? result.value : null;
}

/** Runs the recipe on the host that owns `cwd`: in-process locally, through
 * `/internal/run-setup` remotely. A transport failure is a `failed` outcome. */
export async function runSetupOnHost(
  app: FastifyInstance,
  hostId: string,
  opts: { cwd: string; recipe: string; logKey: string },
): Promise<SetupRunResult> {
  if (hostId === LOCAL_HOST_ID) {
    return await execSetupRecipe({ ...opts, sessionsDir: app.config.SESSIONS_DIR });
  }
  const result = await viaRemote(app, hostId, (client) =>
    client.resolveRunSetup(opts.cwd, opts.recipe, opts.logKey),
  );
  if (result.ok) return result.value;
  return {
    outcome: "failed",
    exitCode: null,
    logPath: "",
    detail:
      result.reason === "unsupported"
        ? `host ${hostId} is too old to run a setup recipe — upgrade it`
        : (result.detail ?? "host unreachable"),
  };
}

function setStatus(
  app: FastifyInstance,
  sessionId: number,
  projectId: number,
  status: SetupStatus,
  logPath?: string,
): void {
  app.db
    .update(sessions)
    .set({ setupStatus: status, ...(logPath !== undefined ? { setupLogPath: logPath } : {}) })
    .where(eq(sessions.id, sessionId))
    .run();
  // A doorbell on the tasks channel (taskId 0 when the session is not a task's):
  // the frontend refetches its sessions list on a `setup` frame.
  broadcastTaskEvent({ taskId: 0, projectId, kind: "setup", ts: Date.now() });
}

/**
 * Fire-and-forget: run `project.setupRecipe` in a worktree just cut for
 * `session`, on its host, and record the outcome on the session row. Does
 * nothing (status stays null) when the project has no recipe. Never throws and
 * is never awaited by the session start.
 */
export function startSetupRecipe(
  app: FastifyInstance,
  project: Pick<ProjectRow, "id" | "setupRecipe">,
  session: { id: number; hostId: string; cwd: string },
): void {
  const recipe = project.setupRecipe?.trim();
  if (!recipe) return;
  setStatus(app, session.id, project.id, "running");
  void runSetupOnHost(app, session.hostId, {
    cwd: session.cwd,
    recipe,
    logKey: String(session.id),
  })
    .then((result) => {
      if (result.outcome === "busy") {
        // Another session is already installing in this directory: this one
        // has nothing of its own to report.
        app.db.update(sessions).set({ setupStatus: null }).where(eq(sessions.id, session.id)).run();
        broadcastTaskEvent({ taskId: 0, projectId: project.id, kind: "setup", ts: Date.now() });
        return;
      }
      setStatus(app, session.id, project.id, result.outcome, result.logPath || undefined);
    })
    .catch((err) => {
      app.log.warn({ err, sessionId: session.id }, "setup recipe: run failed unexpectedly");
      try {
        setStatus(app, session.id, project.id, "failed");
      } catch {
        // The row may be gone (session deleted mid-run); nothing to flag.
      }
    });
}

/**
 * The clone trigger: call after a successful clone of a project's checkout onto
 * `hostId` (the checkout-materialization job, issue #2243). A clone has no
 * session, so the log is keyed `checkout-<projectId>`. Fire-and-forget like
 * `startSetupRecipe`.
 */
export function startSetupAfterClone(
  app: FastifyInstance,
  project: Pick<ProjectRow, "id" | "setupRecipe">,
  hostId: string,
  cwd: string,
): void {
  const recipe = project.setupRecipe?.trim();
  if (!recipe) return;
  void runSetupOnHost(app, hostId, { cwd, recipe, logKey: `checkout-${project.id}` }).then(
    (result) => {
      if (result.outcome !== "ok" && result.outcome !== "busy") {
        app.log.warn(
          { projectId: project.id, hostId, outcome: result.outcome },
          "setup recipe after clone did not succeed",
        );
      }
    },
    () => {},
  );
}
