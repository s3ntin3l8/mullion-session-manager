import fs from "node:fs";
import path from "node:path";

// Issue #2489 — a scaffold generation turn runs in bwrap with `--ro-bind / /`,
// so without this the agent can READ everything the server user can: `~/.ssh`,
// `~/.codex/auth.json`, this app's `.env`. Writes were always contained; reads
// were not, and codex's `danger-full-access` (#2472) lets its shell commands
// read and `curl` out whatever it can see. This builds the bwrap arguments that
// mask the operator's real HOME with an empty tmpfs and put back, read-only,
// only what the turn needs to start:
//
//   - the agent binary and the directory its symlink points into,
//   - the `node` install prefix (codex and opencode are node scripts, and an
//     nvm-style prefix holds both node and the global packages),
//   - the project repo's git directory, because the scratch worktree is a
//     `git worktree add` whose `.git` file points into it.
//
// The scratch worktree and the fake HOME are bound writable AFTER these (the
// caller's argument order), so they work even when they live under HOME.
// Credentials stay reachable only through the copy seeded into the fake HOME.

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** The first executable named `name` on `pathEnv`, resolved through symlinks. */
function findOnPath(name: string, pathEnv: string): { found: string; real: string } | null {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
    } catch {
      continue;
    }
    const real = realpathOrNull(candidate);
    if (real) return { found: candidate, real };
  }
  return null;
}

/** The common git directory a scratch worktree points at, from its `.git` file
 * (`gitdir: <common>/worktrees/<name>`), or null if it is not a linked worktree. */
function gitCommonDirOf(worktreePath: string): string | null {
  try {
    const text = fs.readFileSync(path.join(worktreePath, ".git"), "utf8");
    const m = /^gitdir:\s*(.+)$/m.exec(text);
    if (!m) return null;
    const gitdir = path.resolve(worktreePath, m[1].trim());
    return path.dirname(path.dirname(gitdir));
  } catch {
    return null;
  }
}

/** `dirs` with any directory that lies inside another listed one removed. */
function outermost(dirs: string[]): string[] {
  const unique = [...new Set(dirs)];
  return unique.filter((d) => !unique.some((o) => o !== d && d.startsWith(o + path.sep)));
}

export interface HomeMaskOptions {
  /** The operator's real HOME (`os.homedir()`); injectable for tests. */
  home: string;
  /** Without an agent only the mask is produced (the capability probe). */
  agentCommand?: string;
  /** The scratch worktree; its git directory is re-bound read-only. */
  worktreePath?: string;
  pathEnv?: string;
}

/** bwrap arguments to place right after `--ro-bind / /`. Empty when HOME cannot
 * be resolved or is the filesystem root (nothing sensible to mask). */
export function homeMaskArgs(opts: HomeMaskOptions): string[] {
  const home = realpathOrNull(opts.home);
  if (!home || home === path.parse(home).root) return [];
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const needed: string[] = [];
  if (opts.agentCommand) {
    const agent = findOnPath(opts.agentCommand, pathEnv);
    if (agent) needed.push(path.dirname(agent.found), path.dirname(agent.real));
    const node = findOnPath("node", pathEnv);
    // An nvm-style prefix is `<prefix>/bin/node`; bind the prefix so global
    // packages (the agent's own files) come with it.
    if (node && path.basename(path.dirname(node.real)) === "bin") {
      needed.push(path.dirname(path.dirname(node.real)));
    } else if (node) {
      needed.push(path.dirname(node.real));
    }
  }
  if (opts.worktreePath) {
    const common = gitCommonDirOf(opts.worktreePath);
    if (common) needed.push(common);
  }
  const inside = needed
    .map((d) => realpathOrNull(d))
    .filter((d): d is string => d !== null && d.startsWith(home + path.sep));
  return ["--tmpfs", home, ...outermost(inside).flatMap((d) => ["--ro-bind-try", d, d])];
}
