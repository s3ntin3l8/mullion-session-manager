// Issue #1951 follow-up — an agent host's EDITABLE project roots.
//
// `PROJECTS_ROOTS` is the containment barrier for the agent's file and git
// routes (routes/internal.ts's resolveWithinRoots) and the folder
// /internal/discover scans. It comes from the agent's own `.env`, which the
// primary could not change: editing it meant ssh-ing to the host and
// restarting the service. This module lets the primary's Settings → Hosts →
// config dialog move it.
//
// The value is a small persisted OVERRIDE, not a rewrite of `.env`: that file
// also holds the agent token, nothing in this codebase writes it, and the
// launchd/systemd wrappers parse it with their own rules. The override lives
// in the same fixed, per-user `~/.mullion/` directory as
// agent-bundle-state.ts (whose shape and atomic-write discipline this copies —
// see its header for why the location is neither `$MULLION_HOME`-relative nor
// XDG-aware). A missing or corrupt file means "no override": the env value
// applies, never an empty list, so a bad file can only ever fall back to what
// the operator configured.
//
// The agent re-reads its roots on EVERY request (nothing caches
// `app.config.PROJECTS_ROOTS`), so a saved override takes effect at once, with
// no restart.
//
// Trust: PROJECTS_ROOTS_LOCKED (env) lets the host's operator forbid all of
// this. The primary can already start arbitrary sessions on an agent (session
// spawn is deliberately outside the roots), so an editable roots list removes
// only defence in depth for the file and git routes — which is why a saved
// list is validated hard (validateProjectsRoots) and why the edit route is
// rate-limited and logged.
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { expandHome, parseProjectsRootsEnv } from "./project-config.js";

interface AgentProjectsRootsFile {
  version: 1;
  roots: string[];
}

const STATE_VERSION = 1 as const;

/** Most roots one override may list. */
export const MAX_PROJECTS_ROOTS = 16;

/** Fixed, per-user path — see this file's header (same as agent-bundle-state.ts). */
export function resolveAgentProjectsRootsPath(): string {
  return path.join(os.homedir(), ".mullion", "agent-projects-roots.json");
}

/** What was last read, keyed by the file's mtime (and the protected-dir set it
 * was validated against), so the per-request read in resolveWithinRoots is one
 * fstat instead of a parse plus a re-validation. */
let cache: { mtimeMs: number; sig: string; roots: string[] | null } | undefined;

/**
 * The saved override, or null when there is none — or when what is on disk
 * cannot be trusted: unreadable, the wrong shape, or a list that no longer
 * passes `validateProjectsRoots`. The file lives in a directory the agent's own
 * file routes could be pointed at, so what is READ is re-validated, not just
 * what was once written: a tampered `{"roots":["/"]}` must fall back to the env
 * value, never become the containment barrier. Never "empty" either way — see
 * this file's header.
 *
 * Opened once and read through that descriptor (fstat, then read), so the
 * file cannot change between "checked" and "read".
 */
export function readProjectsRootsOverride(protectedDirs: string[] = []): string[] | null {
  const file = resolveAgentProjectsRootsPath();
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    cache = undefined;
    return null;
  }
  try {
    const mtimeMs = fstatSync(fd).mtimeMs;
    const sig = protectedDirs.join("\0");
    if (cache && cache.mtimeMs === mtimeMs && cache.sig === sig) return cache.roots;
    let roots: string[] | null = null;
    // Only a verdict that cannot change without the file changing is cached:
    // a usable list, or a file that is structurally not an override (bad JSON,
    // wrong version). A list that fails VALIDATION is not cached — that can be
    // transient (an unmounted share, EACCES) and the file's mtime would never
    // move to trigger a re-check, leaving the host on its env roots until
    // restart. It is simply re-validated on the next request.
    let cacheable = true;
    try {
      const parsed: unknown = JSON.parse(readFileSync(fd, "utf8"));
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed as { version?: unknown }).version === STATE_VERSION
      ) {
        const checked = validateProjectsRoots((parsed as { roots?: unknown }).roots, {
          protectedDirs,
        });
        if (checked.ok) roots = checked.roots;
        else cacheable = false;
      }
    } catch {
      roots = null;
    }
    if (cacheable) cache = { mtimeMs, sig, roots };
    return roots;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Saves the override, or removes it when `roots` is null — atomic
 * tmp-then-rename, like agent-bundle-state.ts's writer. */
export function writeProjectsRootsOverride(roots: string[] | null): void {
  const target = resolveAgentProjectsRootsPath();
  cache = undefined;
  if (roots === null) {
    try {
      unlinkSync(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return;
  }
  mkdirSync(path.dirname(target), { recursive: true });
  const tmpPath = `${target}.${process.pid}.tmp`;
  const state: AgentProjectsRootsFile = { version: STATE_VERSION, roots };
  writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmpPath, target);
}

/**
 * Paths on THIS host that hold Mullion's own state — the install root
 * (`.env` with the agent token), the sessions dir, the SQLite file if any, and
 * `~/.mullion` (this very override, agent-bundle-state.json). A project
 * root that is, contains or sits inside one would hand the agent's file routes
 * the keys to the agent itself, so none is allowed.
 */
export function protectedAgentDirs(app: FastifyInstance): string[] {
  const dirs = [path.join(os.homedir(), ".mullion")];
  const { MULLION_HOME, SESSIONS_DIR, DATABASE_URL } = app.config as {
    MULLION_HOME?: string;
    SESSIONS_DIR?: string;
    DATABASE_URL?: string;
  };
  if (MULLION_HOME) dirs.push(path.resolve(expandHome(MULLION_HOME)));
  // The sessions dir and the database FILE themselves — not their parents: a
  // database often lives in a shared folder (`/tmp`, a data dir), and what is
  // being protected is the file, which any root CONTAINING it is already
  // refused for.
  if (SESSIONS_DIR) dirs.push(path.resolve(expandHome(SESSIONS_DIR)));
  if (DATABASE_URL?.startsWith("file:")) {
    dirs.push(path.resolve(DATABASE_URL.slice("file:".length)));
  }
  return dirs;
}

/** The roots this agent is actually using right now, and why. `overrideIgnored`
 * is true when a saved override exists but the operator's lock keeps it from
 * applying (so the dialog can offer to clear it). */
export function resolveEffectiveProjectsRoots(app: FastifyInstance): {
  roots: string[];
  source: "env" | "override";
  overrideIgnored: boolean;
} {
  const override = readProjectsRootsOverride(protectedAgentDirs(app));
  if (override && !app.config.PROJECTS_ROOTS_LOCKED) {
    return { roots: override, source: "override", overrideIgnored: false };
  }
  return {
    roots: parseProjectsRootsEnv(app.config.PROJECTS_ROOTS),
    source: "env",
    overrideIgnored: override !== null,
  };
}

/** Shorthand for callers that only need the list. */
export function effectiveProjectsRoots(app: FastifyInstance): string[] {
  return resolveEffectiveProjectsRoots(app).roots;
}

// Directories under the home directory that hold credentials: a project root
// there would hand the file routes a user's keys.
const SENSITIVE_HOME_DIRS = [".ssh", ".gnupg", ".aws", ".kube", ".config/gcloud", ".docker"];

// `parent` may itself end in a separator (the filesystem root is "/"), so the
// prefix is built from it rather than blindly appending one — "/" + "/" is
// "//", which no path starts with, and the check would pass for the broadest
// root of all.
const isInside = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

export type ProjectsRootsValidation = { ok: true; roots: string[] } | { ok: false; error: string };

/**
 * Validates a list of roots a caller wants to save. Every entry must be an
 * absolute path (after `~` expansion) to an EXISTING directory, with no `..`
 * segments or commas (the env separator), and must not be so broad that it
 * hands the file routes the whole machine: the filesystem root, the home
 * directory itself or any directory that contains it (`/Users`, `/home`), nor
 * a credentials directory under home, nor overlap Mullion's own install and
 * data directories (`protectedDirs` — the agent token's `.env`, the sessions
 * dir, `~/.mullion`). Duplicates are dropped; the list may not
 * be empty (use `null` to go back to the env value) nor longer than
 * MAX_PROJECTS_ROOTS.
 */
export function validateProjectsRoots(
  raw: unknown,
  opts: { protectedDirs?: string[] } = {},
): ProjectsRootsValidation {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "roots must be a non-empty list of directories" };
  }
  if (raw.length > MAX_PROJECTS_ROOTS) {
    return { ok: false, error: `at most ${MAX_PROJECTS_ROOTS} roots are allowed` };
  }
  let home: string;
  try {
    home = realpathSync(os.homedir());
  } catch {
    home = os.homedir();
  }
  const sensitive = SENSITIVE_HOME_DIRS.map((d) => path.join(home, d));
  // Mullion's own state dirs, resolved like the roots are so a symlinked
  // spelling cannot slip past.
  const protectedDirs = (opts.protectedDirs ?? []).map((d) => {
    try {
      return realpathSync(d);
    } catch {
      return d;
    }
  });
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim() === "") {
      return { ok: false, error: "every root must be a non-empty string" };
    }
    const trimmed = entry.trim();
    if (trimmed.includes(",")) {
      return { ok: false, error: `"${trimmed}": a root cannot contain a comma` };
    }
    const expanded = expandHome(trimmed);
    if (!path.isAbsolute(expanded)) {
      return { ok: false, error: `"${trimmed}" is not an absolute path` };
    }
    if (expanded.split(/[\\/]+/).includes("..")) {
      return { ok: false, error: `"${trimmed}" contains a ".." segment` };
    }
    const resolved = path.resolve(expanded);
    let real: string;
    try {
      real = realpathSync(resolved);
      if (!statSync(real).isDirectory()) {
        return { ok: false, error: `"${trimmed}" is not a directory` };
      }
    } catch {
      return { ok: false, error: `"${trimmed}" does not exist on this host` };
    }
    if (isInside(home, real)) {
      return {
        ok: false,
        error: `"${trimmed}" is too broad: it is, or contains, this host's home directory`,
      };
    }
    if (sensitive.some((dir) => isInside(real, dir))) {
      return { ok: false, error: `"${trimmed}" is inside a credentials directory` };
    }
    if (protectedDirs.some((dir) => isInside(real, dir) || isInside(dir, real))) {
      return {
        ok: false,
        error: `"${trimmed}" overlaps Mullion's own install or data directory on this host`,
      };
    }
    if (seen.has(real)) continue;
    seen.add(real);
    roots.push(resolved);
  }
  return { ok: true, roots };
}
