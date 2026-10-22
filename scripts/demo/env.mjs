import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import net from "node:net";
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
const PATH_ALLOW = new Set(["XDG_RUNTIME_DIR"]);
const PATH_KEY = /(_DIR|_PATH|_FILE|_ROOTS)$/;

// Same pattern as src/services/session-process.ts (DTACH_SOCKET_PATTERN); a
// test asserts the two agree.
const DTACH_SOCKET_PATTERN = /dtach\s+-n\s+(?:"([^"]+)"|'([^']+)'|(\S+))/;

/** Mirror of extractDtachSocketPath() in src/services/session-process.ts. */
export function extractDtachSocketPath(description) {
  const match = DTACH_SOCKET_PATTERN.exec(description);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

/**
 * The backend's own ownership rule (listOwnedScopes in session-process.ts):
 * a scope belongs to an instance when its dtach socket sits directly in that
 * instance's SESSIONS_DIR. Teardown stops a unit only when this holds.
 */
export function ownsScope(description, sessionsDir) {
  const socketPath = extractDtachSocketPath(description);
  return socketPath !== null && path.dirname(socketPath) === path.resolve(sessionsDir);
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
  // ensureSessionsDir() (src/plugins/pty.ts) moves SESSIONS_DIR to a short
  // fallback under the platform's temp dir when its longest socket path would
  // pass the platform's sun_path limit; the backend's sockets, and so
  // teardown's ownership check, would then point somewhere else. Refuse a path
  // that long instead. The limit is the platform's own (108 on Linux, 104 on
  // macOS), less one for the NUL terminator — the same rule the backend
  // applies, so a SESSIONS_DIR the backend would keep is not refused here.
  const maxSunPathBytes = process.platform === "darwin" ? 104 : 108;
  if (
    env.SESSIONS_DIR !== undefined &&
    Buffer.byteLength(path.join(path.resolve(env.SESSIONS_DIR), "999999999999.sock")) >
      maxSunPathBytes - 1
  )
    problems.push("SESSIONS_DIR is too long; the backend would relocate it");
  for (const key of ["HOME", "TMPDIR"])
    if (env[key] === undefined) problems.push(`${key} must be set (inside the demo dir)`);
  if (env.DATABASE_URL !== undefined) {
    const file = env.DATABASE_URL.replace(/^file:/, "");
    if (!env.DATABASE_URL.startsWith("file:") || !path.isAbsolute(file) || !inside(demoDir, file))
      problems.push("DATABASE_URL must be a file: path inside the demo dir");
  }
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
