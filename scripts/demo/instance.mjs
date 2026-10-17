#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertDemoEnv, assertPortsFree, demoEnv, instanceIdFor } from "./env.mjs";
import { stopDemoScopes } from "./scopes.mjs";
import { seedDemo } from "./seed.mjs";

/**
 * A throwaway Mullion (backend + Vite frontend) with the demo dataset, fully
 * isolated from any real instance on the same host:
 *
 *   make demo          # interactive: seeds, prints the URL, Ctrl-C deletes it
 *   make screenshots   # scripts/capture-screenshots.mjs drives startDemo()
 *
 * Isolation is enforced in code (./env.mjs): a clean env with nothing inherited
 * but PATH/locale/shell and the systemd user-bus variables, every path under
 * one mkdtemp dir, loopback-only dedicated ports that must be free, and a
 * backend started from a scratch directory without a .env. Demo sessions run
 * as `crs-session-<instanceId>-*` scopes, where instanceId hashes the scratch
 * SESSIONS_DIR. Teardown does not trust that prefix: it stops a scope only when
 * its dtach socket sits in the demo's SESSIONS_DIR (see stopDemoScopes).
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The two server binaries; `startDemo({ bins })` overrides them in tests. */
export const demoBins = (root = REPO_ROOT) => ({
  tsx: path.join(root, "node_modules", ".bin", "tsx"),
  vite: path.join(root, "frontend", "node_modules", ".bin", "vite"),
});

export const DEMO_BACKEND_PORT = process.env.DEMO_BACKEND_PORT ?? "3956";
export const DEMO_FRONTEND_PORT = process.env.DEMO_FRONTEND_PORT ?? "3957";

/**
 * Refuses to start when a server binary is missing, before anything is
 * spawned or created. `make install` installs only the root workspace; the
 * frontend has its own `npm ci` (CONTRIBUTING.md), and a missing Vite used to
 * surface as an unhandled spawn ENOENT that orphaned the backend (#1642).
 */
export function preflight(bins = demoBins()) {
  const missing = [
    [bins.tsx, "npm ci"],
    [bins.vite, "npm --prefix frontend ci"],
  ].filter(([bin]) => !existsSync(bin));
  if (missing.length === 0) return;
  throw new Error(
    `missing ${missing.map(([bin]) => bin).join(", ")}. ` +
      `Install the dependencies first: ${missing.map(([, fix]) => fix).join(" && ")}.`,
  );
}

/**
 * Own process group (`detached`) so teardown reaches every descendant. A
 * failed spawn (ENOENT, EACCES) emits `'error'` asynchronously, after the
 * caller's try/catch has moved on, so it is routed to `onError` instead of
 * crashing the process with teardown skipped (#1642).
 */
function spawnServer(name, cmd, args, opts, quiet, onError) {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: true, ...opts });
  child.once("error", (err) =>
    onError(new Error(`${name}: could not run ${cmd}: ${err.code ?? err.message}`)),
  );
  child.stdout?.on("data", (d) => !quiet && process.stdout.write(`[${name}] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  return child;
}

/** SIGTERM the group, wait until the child and its group are gone, then SIGKILL. */
async function killGroup(child, graceMs = 5_000) {
  // A child that never spawned has no pid, and -pid must never become 0 or
  // NaN: process.kill(0) would signal our own process group.
  if (!child?.pid) return;
  const signal = (sig) => {
    try {
      process.kill(-child.pid, sig);
      return true;
    } catch {
      return false;
    }
  };
  if (!signal("SIGTERM")) return;
  const deadline = Date.now() + graceMs;
  // A child killed by a signal keeps exitCode null and sets signalCode.
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const alive = () => !exited() || signal(0);
  while (Date.now() < deadline && alive()) await new Promise((r) => setTimeout(r, 100));
  signal("SIGKILL");
}

async function waitForHttp(url, signal, timeoutMs = 90_000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    if (signal.aborted) throw new Error(`stopped waiting for ${url}`);
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url}${lastError ? `: ${lastError}` : ""}`);
}

export async function startDemo({ quiet = false, keep = false, seed = true, bins } = {}) {
  bins ??= demoBins();
  preflight(bins);
  await assertPortsFree([DEMO_BACKEND_PORT, DEMO_FRONTEND_PORT]);

  // /tmp keeps SESSIONS_DIR short: the backend silently relocates it when a
  // dtach socket path would exceed 107 bytes (src/plugins/pty.ts).
  const demoDir = await mkdtemp("/tmp/mullion-demo-");
  const runDir = path.join(demoDir, "run"); // backend cwd: no .env, migrations via symlink
  const sessionsDir = path.join(demoDir, "s");
  const instanceId = instanceIdFor(sessionsDir);

  const backendUrl = `http://127.0.0.1:${DEMO_BACKEND_PORT}`;
  const frontendUrl = `http://127.0.0.1:${DEMO_FRONTEND_PORT}`;

  const PATH = `${path.join(demoDir, "bin")}:${process.env.PATH}`;
  const backendEnv = demoEnv(demoDir, {
    PATH,
    NODE_ENV: "development",
    PORT: DEMO_BACKEND_PORT,
    HOST: "127.0.0.1",
    LOG_LEVEL: "warn",
    DATABASE_URL: `file:${path.join(demoDir, "app.db")}`,
    SESSIONS_DIR: sessionsDir,
    CRS_CONFIG_DIR: path.join(demoDir, "crs"),
    BROWSER_DATA_DIR: path.join(demoDir, "browsers"),
    PROJECTS_ROOTS: path.join(demoDir, "projects"),
    FRONTEND_DIST: path.join(demoDir, "no-frontend-dist"),
    // No auth on a loopback-only throwaway instance; the backend requires this
    // explicit opt-in when no token/OIDC is configured (src/app.ts).
    MULLION_TRUST_GATEWAY: "true",
  });
  const frontendEnv = demoEnv(demoDir, { PATH, BACKEND_URL: backendUrl });

  let backend;
  let frontend;
  let stopping;
  const aborted = new AbortController();
  // Idempotent: a spawn error, Ctrl-C and the caller may all ask to stop.
  const stop = () => (stopping ??= teardown());
  const teardown = async () => {
    aborted.abort();
    // Stop the sessions first: they live in systemd scopes, not in the
    // backend's process group, and would otherwise outlive it.
    const leaked = await stopDemoScopes(instanceId, sessionsDir);
    await Promise.all([killGroup(backend), killGroup(frontend)]);
    if (keep) return console.log(`[demo] kept ${demoDir}`);
    if (leaked.length > 0)
      return console.warn(
        `[demo] kept ${demoDir}: ${leaked.join(", ")} may still be running; stop them, then remove it`,
      );
    for (let attempt = 0; attempt < 5; attempt++) {
      await rm(demoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(
        (err) => console.warn(`[demo] cleanup attempt failed: ${err}`),
      );
      await new Promise((r) => setTimeout(r, 500));
      if (!existsSync(demoDir)) return;
    }
    console.warn(`[demo] could not fully remove ${demoDir}`);
  };

  // A spawn error or a signal during startup rejects this, which ends the
  // startup race below in the catch (teardown, rethrow). Without it, Ctrl-C
  // mid-startup would kill only this process: the servers run in their own
  // process groups and would outlive it, scratch dir and all.
  let started = false;
  let abortStartup;
  const startupAborted = new Promise((_, reject) => (abortStartup = reject));
  startupAborted.catch(() => {});
  const onSpawnError = (err) => {
    if (!started) return abortStartup(err);
    // Not reachable today (spawn's 'error' fires on the next tick, long before
    // startup resolves), and must not exit a library caller's process.
    console.error(`[demo] ${err.message}; stopping the demo`);
    process.exitCode = 1;
    void stop();
  };
  const onSignal = (signal) => abortStartup(new Error(`interrupted by ${signal} during startup`));

  const api = async (pathname, options = {}) => {
    const res = await fetch(`${backendUrl}${pathname}`, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    if (!res.ok)
      throw new Error(
        `${options.method ?? "GET"} ${pathname} -> ${res.status} ${await res.text()}`,
      );
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  };

  const startup = async () => {
    for (const dir of ["home", "tmp", "run", "s", "projects", "bin"])
      await mkdir(path.join(demoDir, dir), { recursive: true });
    // Shadow `docker` for the demo: Mullion's Dock probes the host's running
    // compose stacks (read-only), which would reach real stacks and put their
    // container names into public screenshots. The probe treats failure as
    // "no Docker" and shows nothing.
    await writeFile(
      path.join(demoDir, "bin", "docker"),
      '#!/bin/sh\necho "docker is disabled in the Mullion demo" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    await symlink(path.join(REPO_ROOT, "drizzle"), path.join(runDir, "drizzle"));
    assertDemoEnv(backendEnv, demoDir, { cwd: runDir });
    assertDemoEnv(frontendEnv, demoDir, { cwd: path.join(REPO_ROOT, "frontend") });
    console.log(`[demo] scratch dir ${demoDir} (instance ${instanceId})`);
    backend = spawnServer(
      "backend",
      bins.tsx,
      ["--tsconfig", path.join(REPO_ROOT, "tsconfig.json"), path.join(REPO_ROOT, "src/server.ts")],
      { cwd: runDir, env: backendEnv },
      quiet,
      onSpawnError,
    );
    frontend = spawnServer(
      "frontend",
      bins.vite,
      ["--port", DEMO_FRONTEND_PORT, "--strictPort", "--host", "127.0.0.1"],
      { cwd: path.join(REPO_ROOT, "frontend"), env: frontendEnv },
      quiet,
      onSpawnError,
    );
    await waitForHttp(`${backendUrl}/api/sessions`, aborted.signal);
    await waitForHttp(frontendUrl, aborted.signal);
    await api("/api/settings", { method: "PATCH", body: JSON.stringify({ theme: "dark" }) });
    return seed ? await seedDemo({ api, root: path.join(demoDir, "projects") }) : null;
  };

  // Everything after mkdtemp runs inside the try, so any failure (a refused
  // env, a failed spawn, a timeout) still stops the servers and removes the
  // scratch dir.
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const seeded = await Promise.race([startup(), startupAborted]);
    started = true;
    return { demoDir, backendUrl, frontendUrl, instanceId, api, seeded, stop };
  } catch (err) {
    await stop();
    throw err;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const demo = await startDemo({ keep: process.argv.includes("--keep") }).catch((err) => {
    console.error(`[demo] failed to start: ${err.message}`);
    process.exit(1);
  });
  console.log(`
[demo] Mullion demo is up: ${demo.frontendUrl}
[demo] Loopback only, no login. Ctrl-C stops its sessions and deletes all demo data.`);
  const shutdown = async () => {
    await demo.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
