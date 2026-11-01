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
//   - the agent binary and what it needs next to it (see `installRoots`),
//   - the same for `node` (codex and opencode are node scripts),
//   - the project repo's git directory, because the scratch worktree is a
//     `git worktree add` whose `.git` file points into it. Known limit: that
//     directory is readable whole, `config` included, so a remote URL with an
//     embedded token in it is visible to the turn. It is the project's own
//     secret, not the operator's HOME, and git needs the directory to work.
//
// Not covered: `--ro-bind / /` still exposes everything outside HOME (an app
// at /opt, other users' homes, /etc), and the turn inherits the server's
// environment variables. This hides the operator's HOME, no more.
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
    // A relative entry would resolve against the server's cwd, not the turn's.
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    const real = realpathOrNull(candidate);
    try {
      // A directory is "executable" too; only a file can be the agent or node.
      if (!real || !fs.statSync(real).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
    } catch {
      continue;
    }
    return { found: candidate, real };
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
    // A linked worktree's gitdir names its common dir in `commondir` (usually
    // "../.."); a submodule or --separate-git-dir layout has none, and the
    // gitdir itself is then what git needs.
    try {
      const rel = fs.readFileSync(path.join(gitdir, "commondir"), "utf8").trim();
      return path.resolve(gitdir, rel);
    } catch {
      return gitdir;
    }
  } catch {
    return null;
  }
}

/** What a binary at `real` needs next to it. A package under a `node_modules`
 * (npm, pnpm, bun globals) needs that whole directory: the platform package
 * with the vendored binary is a sibling of the entry package. An nvm-style
 * `<prefix>/bin/<name>` needs its prefix, but only when the prefix is nested
 * (`~/.nvm/versions/node/v26`): a prefix directly under HOME (`~/.local`,
 * `~/.config`) is a shared root that also holds credentials, so only its
 * `lib/node_modules` is taken. Anything else (a single native binary) needs
 * nothing beyond the file itself, which the caller binds. */
function installRoots(real: string, home: string): string[] {
  const marker = `${path.sep}node_modules${path.sep}`;
  const at = real.indexOf(marker);
  if (at !== -1) return [real.slice(0, at + marker.length - 1)];
  const dir = path.dirname(real);
  if (path.basename(dir) !== "bin") return [];
  const prefix = path.dirname(dir);
  const depth = path.relative(home, prefix).split(path.sep).length;
  return depth >= 3 ? [prefix] : [path.join(prefix, "lib", "node_modules")];
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
  // Files bound at the path the turn will exec them by: bwrap binds a
  // symlink's TARGET, so without this `<prefix>/bin/codex` would not exist.
  const files: Array<{ src: string; dest: string }> = [];
  if (opts.agentCommand) {
    const agent = findOnPath(opts.agentCommand, pathEnv);
    // The symlink itself, not its directory (`~/.local/bin` holds unrelated
    // scripts), and what it points at.
    if (agent) {
      files.push({ src: agent.real, dest: agent.found });
      needed.push(...installRoots(agent.real, home));
    }
    const node = findOnPath("node", pathEnv);
    if (node) {
      files.push({ src: node.real, dest: node.found });
      needed.push(...installRoots(node.real, home));
    }
  }
  if (opts.worktreePath) {
    const common = gitCommonDirOf(opts.worktreePath);
    if (common) needed.push(common);
  }
  const inside = outermost(
    needed
      .map((d) => realpathOrNull(d))
      .filter((d): d is string => d !== null && d.startsWith(home + path.sep)),
  );
  const fileBinds = files.filter(
    (f) =>
      f.dest.startsWith(home + path.sep) &&
      // already present through a bound directory
      !inside.some((d) => f.dest === d || f.dest.startsWith(d + path.sep)),
  );
  return [
    "--tmpfs",
    home,
    ...inside.flatMap((d) => ["--ro-bind-try", d, d]),
    ...fileBinds.flatMap((f) => ["--ro-bind-try", f.src, f.dest]),
  ];
}
