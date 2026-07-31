// Issue #432 — Visual Skills Manager, discovery slice. A read-only sibling
// of agent-rules.ts: same allow-nothing-caller-supplied-paths posture
// (every directory scanned here is either a fixed, env-derived host path or
// a project cwd already trusted the same way agent-rules.ts's project-scope
// targets are), same tessera-derived guards (a byte cap per file, a file
// count cap, an fs deadline), but never throws — a skill directory that
// doesn't exist (the overwhelmingly common case: most projects and most
// hosts have none of these dirs) is exactly like project-config.ts's own
// "missing file is normal" contract, not a partial failure.
//
// Hermes review, PR #459 — unlike agent-rules.ts's fixed, mostly user-owned
// 12 targets, this module also scans genuinely machine-wide paths (e.g.
// `/etc/codex/skills`) that are commonly unreadable to an ordinary user by
// design, not by misconfiguration. Treating that the same way agent-rules.ts
// treats a permission failure (propagate -> 503 for the WHOLE request) would
// mean one unreadable system directory routinely takes down every skills
// endpoint even though every project/user-owned directory scanned
// alongside it is perfectly readable. So EACCES/EPERM is treated the same
// as "doesn't exist" here — skip that one entry, keep going — at every fs
// call site in this module. Only a genuine timeout (a hung mount) still
// propagates to the route layer as a real transient failure.
//
// Scope decision (see the plan): discovery + read-only listing only. No
// enable/disable — that means round-tripping four mutually incompatible
// per-agent config formats (Codex's config.toml, opencode's opencode.json
// permission block, Claude Code's settings, agy's plugin-not-skill
// enable/disable), deliberately deferred to a follow-up slice. A skill's
// body (the SKILL.md content after its frontmatter) is never read into
// memory or returned — only name/description, per the plan's explicit
// warning (tessera's own /skill and /command endpoints return full
// content/template, which should not be stored or logged).

import { readdir as readdirAsync, open as openAsync, stat as statAsync } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expandHome } from "./project-config.js";
import { resolveCodexHome } from "./hook-adapters/codex.js";

export type SkillAgent = "claude-code" | "codex" | "opencode" | "agy";
export type SkillScope = "builtin" | "global" | "project";

export interface SkillInfo {
  name: string;
  description: string;
  sourceDir: string;
  scope: SkillScope;
  agents: SkillAgent[];
}

// tessera's MAX_MEMORY_FILE_BYTES/MAX_MEMORY_FILES guards, ported the same
// way agent-rules.ts already ported them — a SKILL.md's frontmatter is
// always tiny in practice, so a generous cap on the bytes actually read
// (never the whole file — see readSkillFrontmatter below) plus a hard cap
// on the total number of skills scanned are cheap defenses against a
// pathological directory tree.
const MAX_FRONTMATTER_READ_BYTES = 64 * 1024;
// Hermes review, PR #459 — installed_plugins.json used to be read with
// readFile(path, "utf8") and no size bound at all, unlike every other file
// this module reads. A generous cap (this is a small, locally-generated
// config file — even a large plugin list is a handful of KB) rather than
// an unbounded read, for the same reason SKILL.md's own cap exists.
const MAX_INSTALLED_PLUGINS_READ_BYTES = 1024 * 1024;
const MAX_SKILLS = 500;

// Same reasoning as agent-rules.ts's FS_READ_DEADLINE_MS: a project-scope
// directory can be a remote-host mount (this module runs identically on a
// primary reading a local project and on an "agent" role reading its own
// filesystem for a remote-hosted one — routes/internal.ts's /internal/skills
// is the latter), so every fs call here is deadline-raced the same way.
const FS_READ_DEADLINE_MS = 2000;

export class SkillsTimeoutError extends Error {
  constructor(filePath: string) {
    super(`Timed out reading ${filePath}`);
    this.name = "SkillsTimeoutError";
  }
}

export function isTransientReadError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM";
}

function withReadDeadline<T>(op: Promise<T>, filePath: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new SkillsTimeoutError(filePath)), FS_READ_DEADLINE_MS);
  });
  return Promise.race([op, timeout]).finally(() => clearTimeout(timer));
}

// ENOENT (the directory doesn't exist — by far the common case), ENOTDIR,
// and (Hermes review, PR #459 — see the file header) EACCES/EPERM all
// collapse to "no entries here." Only a genuine timeout propagates.
async function readDirSafe(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await withReadDeadline(readdirAsync(dir, { withFileTypes: true }), dir);
  } catch (err) {
    if (err instanceof SkillsTimeoutError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || isTransientReadError(err)) return [];
    throw err;
  }

  const names: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      names.push(entry.name);
      continue;
    }
    // Hermes review, PR #459 — Dirent.isDirectory() reports the raw
    // directory-entry type (DT_LNK for a symlink), never following it, so a
    // symlinked skills dir — common with a dotfiles manager (stow, chezmoi)
    // symlinking `~/.claude/skills` into a dotfiles repo — was silently
    // invisible even though it resolves to a perfectly normal directory.
    if (entry.isSymbolicLink()) {
      const entryPath = path.join(dir, entry.name);
      try {
        const stat = await withReadDeadline(statAsync(entryPath), entryPath);
        if (stat.isDirectory()) names.push(entry.name);
      } catch (err) {
        if (err instanceof SkillsTimeoutError) throw err;
        // A dangling symlink (ENOENT) or a permission failure resolving it
        // — same "not visible to us" treatment as everything else here.
      }
    }
  }
  return names;
}

interface ParsedFrontmatter {
  name: string;
  description: string;
}

function stripYamlScalarQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

// A deliberately minimal, hand-rolled parser for exactly the two flat
// scalar fields SKILL.md's frontmatter is required to carry (name,
// description — see the plan's verified format: "YAML frontmatter (name,
// description required) plus a Markdown body"). Not a general YAML parser:
// this repo has no YAML dependency, and pulling one in for two string
// fields would be the wrong trade for a read-only discovery slice. A
// block-scalar description (`description: |` / `description: >`) is
// deliberately treated as unparseable rather than mis-captured as the
// literal "|"/">" character — such a skill is skipped (see the caller),
// same as any other malformed frontmatter.
function parseSkillFrontmatter(raw: string): ParsedFrontmatter | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) return null;

  let name: string | null = null;
  let description: string | null = null;
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^(name|description):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const value = kv[2].trim();
    if (/^[|>][+-]?\d?$/.test(value)) continue; // block-scalar indicator, unsupported
    const unquoted = stripYamlScalarQuotes(value);
    if (unquoted.length === 0) continue;
    if (kv[1] === "name" && name === null) name = unquoted;
    if (kv[1] === "description" && description === null) description = unquoted;
  }
  if (!name || !description) return null;
  return { name, description };
}

// Reads only the first `maxBytes` bytes of `filePath` via one bounded
// positional read on an open handle — deliberately NOT a
// stat-for-size-then-readFile sequence (an earlier version did exactly that
// for SKILL.md, flagged by CodeQL as a TOCTOU: the file can change between
// the two calls). It was also a latent correctness bug in its own right for
// readSkillFrontmatter below: gating on the file's TOTAL size skipped every
// skill whose SKILL.md body happens to be large, even though frontmatter
// always sits at the very top and this module never reads a skill's body at
// all (see the file header) — a large-bodied skill's small frontmatter was
// being discarded unread for no reason. Reading a bounded prefix directly
// avoids both problems at once: there's no separate size to race against,
// and a big body no longer hides a perfectly parseable frontmatter block.
// Shared with listInstalledClaudePluginDirs below (Hermes review, PR #459 —
// that read used to have no byte cap at all, unlike every other file this
// module reads).
//
// Returns null for ENOENT/EACCES/EPERM (see the file header on why a
// permission failure is "not visible to us" here, not a hard error) — only
// a genuine timeout still propagates.
async function readBoundedPrefix(filePath: string, maxBytes: number): Promise<string | null> {
  let handle;
  try {
    handle = await withReadDeadline(openAsync(filePath, "r"), filePath);
  } catch (err) {
    if (err instanceof SkillsTimeoutError) throw err;
    return null;
  }
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await withReadDeadline(
      handle.read(buffer, 0, buffer.length, 0),
      filePath,
    );
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function readSkillFrontmatter(skillMdPath: string): Promise<ParsedFrontmatter | null> {
  const raw = await readBoundedPrefix(skillMdPath, MAX_FRONTMATTER_READ_BYTES);
  return raw === null ? null : parseSkillFrontmatter(raw);
}

interface SkillSourceDir {
  dir: string;
  agent: SkillAgent;
  scope: SkillScope;
}

/** Project-scope directories, relative to a trusted project cwd — see the
 * plan's verified discovery matrix. Deliberately just `<cwd>/.agents/skills`
 * for Codex/opencode, not also a walked-up `$REPO_ROOT/.agents/skills`: for
 * a Mullion-managed project, cwd already IS the repo root in the common
 * case, and a separate git-root resolution is more machinery than a
 * discovery-only slice needs (documented simplification, not an oversight). */
function projectSkillDirs(cwd: string): SkillSourceDir[] {
  return [
    { dir: path.join(cwd, ".claude", "skills"), agent: "claude-code", scope: "project" },
    { dir: path.join(cwd, ".agents", "skills"), agent: "codex", scope: "project" },
    { dir: path.join(cwd, ".opencode", "skills"), agent: "opencode", scope: "project" },
    { dir: path.join(cwd, ".claude", "skills"), agent: "opencode", scope: "project" },
    { dir: path.join(cwd, ".agents", "skills"), agent: "opencode", scope: "project" },
  ];
}

/** Global (user-home / env-derived) directories — a function of environment
 * (CODEX_HOME, HOME), resolved lazily per listing, same reasoning as
 * agent-rules.ts's globalDir(). `/etc/codex/skills` is the one genuinely
 * machine-wide (not user-home) entry in the plan's matrix; classified as
 * "global" rather than a distinct scope since it shares that scope's
 * semantics (read-only, not bundled with the CLI binary itself, not a
 * project). */
function globalSkillDirs(): SkillSourceDir[] {
  const claudeSkills = path.join(os.homedir(), ".claude", "skills");
  const agentsSkills = expandHome("~/.agents/skills");
  return [
    { dir: claudeSkills, agent: "claude-code", scope: "global" },
    { dir: path.join(resolveCodexHome(), "skills"), agent: "codex", scope: "global" },
    { dir: agentsSkills, agent: "codex", scope: "global" },
    { dir: "/etc/codex/skills", agent: "codex", scope: "global" },
    { dir: expandHome("~/.config/opencode/skills"), agent: "opencode", scope: "global" },
    { dir: claudeSkills, agent: "opencode", scope: "global" },
    { dir: agentsSkills, agent: "opencode", scope: "global" },
  ];
}

/** Reads `~/.claude/plugins/installed_plugins.json` for the set of ACTUALLY
 * installed plugin cache paths — not `~/.claude/plugins/marketplaces`, which
 * is a marketplace's own catalog of everything available to install,
 * scanning that would surface hundreds of not-installed plugins' skills as
 * if they were live. Malformed/missing file → no builtin plugin skills,
 * never thrown (this is the one part of this module reading a file whose
 * shape this app doesn't control at all).
 *
 * Each `plugins` value is an ARRAY of install-record objects (`{scope,
 * installPath, ...}[]`), not a single object — verified directly against a
 * real installed_plugins.json on this host (`"version": 2`, claude-code
 * 2.1.220), not just documentation. */
async function listInstalledClaudePluginDirs(): Promise<string[]> {
  const installedPath = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json");
  const raw = await readBoundedPrefix(installedPath, MAX_INSTALLED_PLUGINS_READ_BYTES);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as { plugins?: Record<string, unknown> };
    const dirs: string[] = [];
    for (const entries of Object.values(parsed.plugins ?? {})) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const installPath = (entry as { installPath?: unknown } | null)?.installPath;
        if (typeof installPath === "string" && installPath.length > 0) dirs.push(installPath);
      }
    }
    return dirs;
  } catch {
    return [];
  }
}

/** Builtin (bundled-with-the-CLI or bundled-with-an-installed-extension)
 * directories — agy's own shipped skills plus its extensions, and Claude
 * Code's installed plugin marketplace skills (see the plan's verified
 * matrix; Codex has no builtin dir of its own beyond what globalSkillDirs
 * already covers under `~/.codex/skills`). */
async function builtinSkillDirs(): Promise<SkillSourceDir[]> {
  const dirs: SkillSourceDir[] = [
    {
      dir: path.join(os.homedir(), ".gemini", "antigravity-cli", "builtin", "skills"),
      agent: "agy",
      scope: "builtin",
    },
  ];

  const extensionsRoot = path.join(os.homedir(), ".gemini", "extensions");
  for (const name of await readDirSafe(extensionsRoot)) {
    dirs.push({ dir: path.join(extensionsRoot, name, "skills"), agent: "agy", scope: "builtin" });
  }

  for (const installPath of await listInstalledClaudePluginDirs()) {
    dirs.push({ dir: path.join(installPath, "skills"), agent: "claude-code", scope: "builtin" });
  }

  return dirs;
}

/** Scans every `SkillSourceDir`'s immediate subdirectories for a
 * `SKILL.md`, merging entries that resolve to the exact same absolute
 * `sourceDir` (e.g. opencode and Claude Code both reading `~/.claude/skills`
 * — the same shared-file situation agent-rules.ts's own header comment
 * describes for AGENTS.md) into one SkillInfo with a combined `agents` list,
 * rather than reporting the same on-disk skill twice. */
async function scanSkillDirs(sourceDirs: SkillSourceDir[]): Promise<SkillInfo[]> {
  const byPath = new Map<string, SkillInfo>();
  let scanned = 0;

  for (const source of sourceDirs) {
    if (scanned >= MAX_SKILLS) break;
    const names = await readDirSafe(source.dir);
    for (const name of names) {
      if (scanned >= MAX_SKILLS) break;
      // Hermes review, PR #459 — incremented before the frontmatter-validity
      // check, so MAX_SKILLS bounds every SKILL.md read ATTEMPT (the actual
      // cost this cap exists to bound), not just successfully-parsed ones. A
      // directory full of malformed/missing-frontmatter entries used to
      // never count against the cap at all.
      scanned++;
      const skillDir = path.join(source.dir, name);
      const frontmatter = await readSkillFrontmatter(path.join(skillDir, "SKILL.md"));
      if (!frontmatter) continue;

      const existing = byPath.get(skillDir);
      if (existing) {
        if (!existing.agents.includes(source.agent)) existing.agents.push(source.agent);
        continue;
      }
      byPath.set(skillDir, {
        name: frontmatter.name,
        description: frontmatter.description,
        sourceDir: skillDir,
        scope: source.scope,
        agents: [source.agent],
      });
    }
  }

  return [...byPath.values()];
}

/** The full discovery list for a project: project-scope dirs under `cwd`
 * plus every global/builtin dir on this host. Used by both
 * GET /api/projects/:id/skills (primary, local project) and
 * /internal/skills (an "agent" role, its own filesystem — see
 * routes/internal.ts). `cwd` is never used to build a path outside itself
 * (path.join, never concatenation), and by the time it reaches this
 * function it has already been resolved through the same trust boundary
 * agent-rules.ts's targets go through (a DB-backed project row on the
 * primary, resolveWithinRoots on an agent). */
export async function listProjectSkills(cwd: string): Promise<SkillInfo[]> {
  const resolved = path.resolve(cwd);
  const dirs = [...projectSkillDirs(resolved), ...globalSkillDirs(), ...(await builtinSkillDirs())];
  return scanSkillDirs(dirs);
}

/** Global + builtin skills only, no project context — GET /api/skills,
 * deliberately primary-host-only (see the plan: a remote host's global
 * skill dirs are that host's own, not the primary's; a per-host selector
 * for this endpoint is left for a follow-up rather than guessed at here). */
export async function listGlobalSkills(): Promise<SkillInfo[]> {
  const dirs = [...globalSkillDirs(), ...(await builtinSkillDirs())];
  return scanSkillDirs(dirs);
}

export const __testing = { parseSkillFrontmatter, withReadDeadline, FS_READ_DEADLINE_MS };
