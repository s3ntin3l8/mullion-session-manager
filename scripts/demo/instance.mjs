#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertDemoEnv, assertPortsFree, demoEnv, instanceIdFor, ownsScope } from "./env.mjs";
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
 * SESSIONS_DIR, so they can't collide with a real instance's units; teardown
 * stops exactly those.
 */

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = (name) => path.join(REPO_ROOT, "node_modules", ".bin", name);

export const DEMO_BACKEND_PORT = process.env.DEMO_BACKEND_PORT ?? "3956";
export const DEMO_FRONTEND_PORT = process.env.DEMO_FRONTEND_PORT ?? "3957";

/** Own process group (`detached`) so teardown reaches every descendant. */
function spawnServer(name, cmd, args, opts, quiet) {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: true, ...opts });
  child.stdout.on("data", (d) => !quiet && process.stdout.write(`[${name}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  return child;
}

/** SIGTERM the group, wait until the child and its group are gone, then SIGKILL. */
async function killGroup(child, graceMs = 5_000) {
  if (!child) return;
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
  const alive = () => child.exitCode === null || signal(0);
  while (Date.now() < deadline && alive()) await new Promise((r) => setTimeout(r, 100));
  signal("SIGKILL");
}

async function waitForHttp(url, timeoutMs = 90_000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
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

const systemctl = (args) => execFileAsync("systemctl", ["--user", ...args]);

/**
 * Stops the demo's own session scopes. The name pattern is instance-namespaced,
 * and each match is additionally checked with the backend's own ownership rule
 * (ownsScope in ./env.mjs, mirroring src/services/session-process.ts): its
 * Description names the dtach socket, which must sit in this demo's
 * SESSIONS_DIR. A unit that fails that check is never stopped, even on an
 * instanceId collision.
 *
 * Returns the units it could not account for (listing or stop failed), so the
 * caller can keep the scratch dir instead of orphaning live scopes.
 */
export async function stopDemoScopes(instanceId, sessionsDir, run = systemctl) {
  let units;
  try {
    const { stdout } = await run([
      "list-units",
      `crs-session-${instanceId}-*`,
      "--all",
      "--no-legend",
      "--plain",
    ]);
    units = stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean);
  } catch (err) {
    // No systemctl at all: the backend can't have created scopes either.
    if (err.code === "ENOENT") return [];
    // A non-matching pattern exits 0, so this is a real failure.
    console.warn(`[demo] could not list crs-session-${instanceId}-* scopes: ${err.message}`);
    return [`crs-session-${instanceId}-*`];
  }
  const failed = [];
  for (const unit of units) {
    try {
      const { stdout } = await run(["show", unit, "--property=Description", "--value"]);
      if (!ownsScope(stdout, sessionsDir)) {
        console.warn(`[demo] not stopping ${unit}: its socket is outside ${sessionsDir}`);
        continue;
      }
      await run(["stop", unit]);
    } catch (err) {
      if (/not loaded|not found/i.test(err.stderr ?? "")) continue; // Exited meanwhile.
      console.warn(`[demo] could not stop ${unit}: ${err.message}`);
      failed.push(unit);
    }
  }
  return failed;
}

export async function startDemo({ quiet = false, keep = false, seed = true } = {}) {
  await assertPortsFree([DEMO_BACKEND_PORT, DEMO_FRONTEND_PORT]);

  // /tmp keeps SESSIONS_DIR short: the backend silently relocates it when a
  // dtach socket path would exceed 107 bytes (src/plugins/pty.ts).
  const demoDir = await mkdtemp("/tmp/mullion-demo-");
  const runDir = path.join(demoDir, "run"); // backend cwd: no .env, migrations via symlink
  const sessionsDir = path.join(demoDir, "s");
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
  const stop = async () => {
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

  try {
    // Inside the try so a refusal still removes the scratch dir.
    assertDemoEnv(backendEnv, demoDir, { cwd: runDir });
    assertDemoEnv(frontendEnv, demoDir, { cwd: path.join(REPO_ROOT, "frontend") });
    console.log(`[demo] scratch dir ${demoDir} (instance ${instanceId})`);
    backend = spawnServer(
      "backend",
      BIN("tsx"),
      ["--tsconfig", path.join(REPO_ROOT, "tsconfig.json"), path.join(REPO_ROOT, "src/server.ts")],
      { cwd: runDir, env: backendEnv },
      quiet,
    );
    frontend = spawnServer(
      "frontend",
      path.join(REPO_ROOT, "frontend", "node_modules", ".bin", "vite"),
      ["--port", DEMO_FRONTEND_PORT, "--strictPort", "--host", "127.0.0.1"],
      { cwd: path.join(REPO_ROOT, "frontend"), env: frontendEnv },
      quiet,
    );
    await waitForHttp(`${backendUrl}/api/sessions`);
    await waitForHttp(frontendUrl);
    await api("/api/settings", { method: "PATCH", body: JSON.stringify({ theme: "dark" }) });
    const seeded = seed ? await seedDemo({ api, root: path.join(demoDir, "projects") }) : null;
    return { demoDir, backendUrl, frontendUrl, instanceId, api, seeded, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const demo = await startDemo({ keep: process.argv.includes("--keep") });
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
