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
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync } from "node:fs";
import { writeFileSync } from "node:fs";
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

/** What was last read, keyed by the file's mtime, so the per-request read in
 * resolveWithinRoots is one cheap stat instead of a parse. */
let cache: { mtimeMs: number; roots: string[] | null } | undefined;

/** The saved override, or null when there is none (or it is unreadable —
 * never "empty": see this file's header). */
export function readProjectsRootsOverride(): string[] | null {
  const file = resolveAgentProjectsRootsPath();
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    cache = undefined;
    return null;
  }
  if (cache && cache.mtimeMs === mtimeMs) return cache.roots;
  let roots: string[] | null = null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as { version?: unknown }).version === STATE_VERSION &&
      Array.isArray((parsed as { roots?: unknown }).roots) &&
      (parsed as { roots: unknown[] }).roots.length > 0 &&
      (parsed as { roots: unknown[] }).roots.every((r) => typeof r === "string" && r !== "")
    ) {
      roots = (parsed as AgentProjectsRootsFile).roots;
    }
  } catch {
    roots = null;
  }
  cache = { mtimeMs, roots };
  return roots;
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

/** The roots this agent is actually using right now, and why. */
export function resolveEffectiveProjectsRoots(app: FastifyInstance): {
  roots: string[];
  source: "env" | "override";
} {
  if (!app.config.PROJECTS_ROOTS_LOCKED) {
    const override = readProjectsRootsOverride();
    if (override) return { roots: override, source: "override" };
  }
  return { roots: parseProjectsRootsEnv(app.config.PROJECTS_ROOTS), source: "env" };
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
 * a credentials directory under home. Duplicates are dropped; the list may not
 * be empty (use `null` to go back to the env value) nor longer than
 * MAX_PROJECTS_ROOTS.
 */
export function validateProjectsRoots(raw: unknown): ProjectsRootsValidation {
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
    if (seen.has(real)) continue;
    seen.add(real);
    roots.push(resolved);
  }
  return { ok: true, roots };
}
