import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * Environment isolation for the throwaway demo instance (`make demo`,
 * `make screenshots`). The demo runs on hosts that also run a real Mullion,
 * usually from inside one of its sessions, so the hazards are concrete:
 *
 *  - Sessions inherit MULLION_SOCKET_PATH / MULLION_HOOK_* / MULLION_SESSION_ID
 *    pointing at the real instance.
 *  - The backend loads `./.env` itself and lets it win over process.env
 *    (src/plugins/env.ts), and the repo-root .env of a dev checkout carries
 *    real keys and a real PROJECTS_ROOTS.
 *  - Global locations derived from HOME: CRS_CONFIG_DIR (~/.config/crs), the
 *    agent bundle sync (~/.claude, ~/.agents, ~/.gemini, ~/.config/opencode),
 *    and the forwarder shim under ~/.mullion.
 *
 * So every demo process gets an environment built from scratch, the backend
 * runs from a scratch directory (holding only a `drizzle` symlink for the
 * migrations), and assertDemoEnv refuses to start if anything still points
 * outside the scratch directory.
 */

/**
 * Inherited from the caller; everything else is dropped. XDG_RUNTIME_DIR and
 * DBUS_SESSION_BUS_ADDRESS are needed by `systemd-run --user`, which starts
 * every session; demo scopes get their own instance-namespaced unit names.
 */
const PASSTHROUGH = [
  "PATH",
  "LANG",
  "LC_ALL",
  "TERM",
  "TZ",
  "SHELL",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
];

/** The only MULLION_* key the demo sets: no auth on a loopback-only instance. */
const ALLOWED_MULLION = new Set(["MULLION_TRUST_GATEWAY"]);

/** Never set in the demo: they point at real agent configs or credentials. */
const FORBIDDEN = new Set([
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "SSH_AUTH_SOCK",
  "GITHUB_OAUTH_CLIENT_ID",
  "PREVIEW_BASE_HOST",
]);

const SECRET_KEY = /(SECRET|PASSWORD|_KEY|_TOKEN)$|ENCRYPTION/;
/** Keys that must resolve inside the demo dir. */
const SCRATCH_PATHS = [
  "HOME",
  "TMPDIR",
  "SESSIONS_DIR",
  "CRS_CONFIG_DIR",
  "BROWSER_DATA_DIR",
  "PROJECTS_ROOTS",
];
/** Path-ish keys that legitimately point outside the scratch dir. */
// XDG_RUNTIME_DIR is the systemd user bus location systemd-run needs.
const PATH_ALLOW = new Set(["PLAYWRIGHT_BROWSERS_PATH", "SCREENSHOTS_OUT_DIR", "XDG_RUNTIME_DIR"]);
const PATH_KEY = /(_DIR|_PATH|_FILE|_ROOTS)$/;

/** The production unit's default port; a demo must never take it. */
const RESERVED_PORTS = new Set(["3100"]);

/** Where Playwright keeps its browsers, resolved before HOME is redirected. */
export function playwrightBrowsersPath(parent = process.env) {
  return parent.PLAYWRIGHT_BROWSERS_PATH ?? path.join(os.homedir(), ".cache", "ms-playwright");
}

/** Same derivation as src/services/session-process.ts: sha256(resolved sessionsDir)[0:8]. */
export function instanceIdFor(sessionsDir) {
  return createHash("sha256").update(path.resolve(sessionsDir)).digest("hex").slice(0, 8);
}

/** A clean environment for a demo child process. */
export function demoEnv(demoDir, vars = {}, parent = process.env) {
  const env = {};
  for (const key of PASSTHROUGH) if (parent[key] !== undefined) env[key] = parent[key];
  return {
    ...env,
    HOME: path.join(demoDir, "home"),
    TMPDIR: path.join(demoDir, "tmp"),
    ...vars,
  };
}

const inside = (dir, p) => {
  const rel = path.relative(dir, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/**
 * Throws if `env` could reach anything outside `demoDir`. Returns the list of
 * problems instead when `collect` is true (used by the tests).
 */
export function assertDemoEnv(env, demoDir, { cwd, collect = false } = {}) {
  const problems = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    // One problem per key, most specific first: MULLION_SOCKET_PATH is a
    // forbidden key before it is an out-of-scratch path.
    if (key.startsWith("MULLION_") && !ALLOWED_MULLION.has(key))
      problems.push(`${key} must not reach the demo`);
    else if (FORBIDDEN.has(key)) problems.push(`${key} must not be set in the demo`);
    else if (SECRET_KEY.test(key))
      problems.push(`${key} looks like a real secret; the demo never sets it`);
    else if (
      PATH_KEY.test(key) &&
      !PATH_ALLOW.has(key) &&
      path.isAbsolute(value) &&
      !inside(demoDir, value)
    )
      problems.push(`${key}=${value} is outside the demo dir`);
  }
  for (const key of SCRATCH_PATHS) {
    if (env[key] !== undefined && !(path.isAbsolute(env[key]) && inside(demoDir, env[key])))
      problems.push(`${key} must be an absolute path inside the demo dir`);
  }
  for (const key of ["HOME", "TMPDIR"])
    if (env[key] === undefined) problems.push(`${key} must be set (inside the demo dir)`);
  if (env.DATABASE_URL !== undefined) {
    const file = env.DATABASE_URL.replace(/^file:/, "");
    if (!env.DATABASE_URL.startsWith("file:") || !path.isAbsolute(file) || !inside(demoDir, file))
      problems.push("DATABASE_URL must be a file: path inside the demo dir");
  }
  if (env.PORT !== undefined && RESERVED_PORTS.has(String(env.PORT)))
    problems.push(`PORT ${env.PORT} is reserved for the real instance`);
  for (const key of ["BROWSER_ENABLED", "DEVICE_ENABLED", "MULLION_TASK_MASTER_ENABLED"])
    if (env[key] === "true") problems.push(`${key} must stay off in the demo`);
  const firstPath = env.PATH?.split(":")[0];
  if (!firstPath || !inside(demoDir, firstPath) || !existsSync(path.join(firstPath, "docker")))
    problems.push("PATH must start with the demo's bin dir holding the docker shim");
  if (cwd && existsSync(path.join(cwd, ".env")))
    problems.push(`${cwd} contains a .env, which the backend would load over this env`);

  if (collect) return problems;
  if (problems.length > 0)
    throw new Error(`demo environment refused:\n  - ${problems.join("\n  - ")}`);
  return [];
}

/**
 * Rejects if something already listens on one of the ports (likely a real
 * instance). Probes IPv4 and IPv6 loopback, so a server bound to either is seen.
 */
export async function assertPortsFree(ports, hosts = ["127.0.0.1", "::1"]) {
  const listening = (port, host) =>
    new Promise((resolve) => {
      const socket = net.connect({ port: Number(port), host });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
  for (const port of ports)
    for (const host of hosts)
      if (await listening(port, host))
        throw new Error(`port ${port} is already in use on ${host}; refusing to start the demo`);
}
