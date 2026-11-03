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
//     `git worktree add` whose `.git` file points into it. Its `config` is
//     shadowed with a sanitised copy (remote URLs stripped of userinfo; see
//     `sanitizeGitConfig`) so credentialed remotes are not visible to the turn
//     while git keeps working. Known limit: `hooks/` and every git object
//     remain readable read-only as git needs the directory to work.
//
// Not covered: `--ro-bind / /` still exposes everything outside HOME (an app
// at /opt, other users' homes, /etc), and the turn inherits the server's
// environment variables (`turnEnv` drops only the ssh-agent sockets: provider
// API keys may be what the agent authenticates with). A remote agent host on a
// build that predates this runs unmasked, and nothing on the wire says so.
// This hides the operator's HOME, no more.
//
// The scratch worktree and the fake HOME are bound writable AFTER these (the
// caller's argument order), so they work even when they live under HOME.
// Credential FILES stay reachable only through the copy seeded into the fake
// HOME.

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
function gitCommonDirOf(worktreePath: string): { common: string; gitdir: string } | null {
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
      return { common: path.resolve(gitdir, rel), gitdir };
    } catch {
      return { common: gitdir, gitdir };
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

/** Strips userinfo (username and password/token) from a URL string, preserving
 * surrounding quotes if present. Non-standard URLs without userinfo are left
 * unchanged. */
export function stripUserInfoFromUrl(raw: string): string {
  const trimmed = raw.trim();
  const quoted = trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2;
  const unquoted = quoted ? trimmed.slice(1, -1) : trimmed;

  try {
    const parsed = new URL(unquoted);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      let stripped = parsed.toString();
      if (!unquoted.endsWith("/") && stripped.endsWith("/")) {
        stripped = stripped.slice(0, -1);
      }
      return quoted ? `"${stripped}"` : stripped;
    }
    return raw;
  } catch {
    return raw;
  }
}

function splitValueAndComment(raw: string): { value: string; comment: string } {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"')) {
    const m = raw.match(/^(\s*"[^"]*")(\s+[#;].*)$/);
    if (m) return { value: m[1], comment: m[2] };
    return { value: raw, comment: "" };
  }
  const m = raw.match(/^(\s*\S+)(\s+[#;].*)$/);
  if (m) return { value: m[1], comment: m[2] };
  return { value: raw, comment: "" };
}

/** Sanitises git configuration content by stripping userinfo from every URL
 * a config can carry credentials in: `url`/`pushurl` (keys are
 * case-insensitive) under `[remote ...]` and `[submodule ...]` sections, and
 * the base of a `[url "<base>"]` rewrite section. Everything else is kept, and
 * CRLF line endings are preserved (git accepts them, so they must be matched).
 * The caller shadows both `<common>/config` and `<gitdir>/config.worktree`. */
export function sanitizeGitConfig(content: string): string {
  const lines = content.split("\n");
  let inUrlSection = false;
  const result: string[] = [];

  for (const rawLine of lines) {
    const eol = rawLine.endsWith("\r") ? "\r" : "";
    const line = rawLine.slice(0, rawLine.length - eol.length);
    const trimmed = line.trim();
    const sectionMatch = trimmed.match(
      /^\[\s*([a-zA-Z0-9.-]+)(?:\s+"([^"]*)")?\s*\](?:\s+[#;].*)?$/,
    );
    if (sectionMatch) {
      const name = sectionMatch[1].toLowerCase();
      // Git still accepts the legacy `[remote.origin]` header form.
      const kind = name.split(".")[0];
      inUrlSection = kind === "remote" || kind === "submodule";
      const base = sectionMatch[2];
      if (name === "url" && base !== undefined) {
        const stripped = stripUserInfoFromUrl(base);
        result.push(
          (stripped === base ? line : line.replace(`"${base}"`, () => `"${stripped}"`)) + eol,
        );
      } else {
        result.push(rawLine);
      }
      continue;
    }

    if (inUrlSection) {
      const urlMatch = line.match(/^(\s*(?:push)?url\s*=\s*)(.*)$/i);
      if (urlMatch) {
        const { value, comment } = splitValueAndComment(urlMatch[2]);
        result.push(`${urlMatch[1]}${stripUserInfoFromUrl(value)}${comment}${eol}`);
        continue;
      }
    }

    result.push(rawLine);
  }

  return result.join("\n");
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
  const shadowConfigBinds: Array<{ src: string; dest: string }> = [];
  if (opts.worktreePath) {
    const dirs = gitCommonDirOf(opts.worktreePath);
    if (dirs) {
      const { common, gitdir } = dirs;
      needed.push(common);
      const shadowDir = fs.existsSync(path.join(opts.worktreePath, ".agent-home"))
        ? path.join(opts.worktreePath, ".agent-home")
        : opts.worktreePath;
      // `config.worktree` (extensions.worktreeConfig) is read as a real config
      // file too, from inside the bound tree, so it is shadowed the same way.
      const configs: Array<[string, string, string]> = [
        [common, "config", ".git-config-sanitized"],
        [gitdir, "config.worktree", ".git-config-worktree-sanitized"],
      ];
      for (const [dir, name, shadowName] of configs) {
        const realConfig = path.join(dir, name);
        if (!fs.existsSync(realConfig)) continue;
        try {
          const sanitized = sanitizeGitConfig(fs.readFileSync(realConfig, "utf8"));
          const shadowConfig = path.join(shadowDir, shadowName);
          fs.writeFileSync(shadowConfig, sanitized, { mode: 0o600 });
          const targets = new Set<string>([realConfig]);
          const resolvedDir = realpathOrNull(dir);
          if (resolvedDir) targets.add(path.join(resolvedDir, name));
          for (const dest of targets) shadowConfigBinds.push({ src: shadowConfig, dest });
        } catch (err) {
          // Fails open (the turn reads the original config): say so.
          console.warn(
            `git config ${realConfig} could not be shadowed; this turn can read its remote URLs: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
  }
  const inside = outermost(
    needed
      .map((d) => realpathOrNull(d))
      .filter((d): d is string => d !== null && d.startsWith(home + path.sep)),
  );
  // A file is re-bound in up to two places, each independent of the other:
  // at its real path when that lies under HOME (a symlink elsewhere, e.g.
  // /usr/local/bin/claude, points into it), and at the path the turn execs it
  // by whenever THAT lies under HOME (even if the real file is elsewhere).
  // Anything a bound directory already provides is skipped.
  const covered = (p: string) => inside.some((d) => p === d || p.startsWith(d + path.sep));
  const underHome = (p: string) => p.startsWith(home + path.sep);
  const fileBinds = files.flatMap((f) => {
    const out: Array<[string, string]> = [];
    if (underHome(f.src) && !covered(f.src)) out.push([f.src, f.src]);
    if (f.dest !== f.src && underHome(f.dest) && !covered(f.dest)) out.push([f.src, f.dest]);
    return out;
  });
  return [
    "--tmpfs",
    home,
    ...inside.flatMap((d) => ["--ro-bind-try", d, d]),
    ...fileBinds.flatMap(([src, dest]) => ["--ro-bind-try", src, dest]),
    ...shadowConfigBinds.flatMap((b) => ["--ro-bind-try", b.src, b.dest]),
  ];
}

/** The environment for a sandboxed turn: the server's, without the ssh-agent
 * sockets, which would let the turn authenticate with the operator's keys
 * without reading `~/.ssh`. */
export function turnEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { SSH_AUTH_SOCK: _a, MULLION_SSH_AUTH_SOCK: _b, ...rest } = env;
  return rest;
}
