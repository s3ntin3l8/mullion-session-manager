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
// Issue #463 — enable/disable, Codex + opencode only. Claude Code and agy
// stayed read-only in that slice (`enabledByAgent[agent]` always `null`) —
// both needed a materially different write mechanism, filed as #467 rather
// than guessed at. A skill's body (the SKILL.md content after its
// frontmatter) is never read into memory or returned — only
// name/description, per the plan's explicit warning (tessera's own /skill
// and /command endpoints return full content/template, which should not be
// stored or logged).
//
// Codex/opencode's own enable/disable selector is the skill's frontmatter
// `name`, not a directory-scoped path — verified empirically against both
// live binaries (see the plan's verification section; codex-skills.ts's own
// header has the fuller writeup). That selector is NOT scoped to a specific
// `sourceDir`: two distinct skills in different directories that happen to
// share a frontmatter name are toggled TOGETHER by either agent, with no way
// to target just one. `attachEnabledByAgent` below refuses (`null`, "not
// toggleable") whenever a name is ambiguous within a toggle-capable agent's
// discovered skills, computed from this SAME discovery result — never a
// second pass, so there's no TOCTOU between what the UI shows as toggleable
// and what a subsequent write would actually affect.
//
// Issue #467 — Claude Code gets a real writer too, but it doesn't fit this
// shape cleanly: toggleability there is PER-SKILL, not per-agent (see
// hook-adapters/claude-code-skills.ts's header for the two live-verified
// findings — the override key is the skill's directory basename, not its
// frontmatter name, and it's a hard no-op for plugin-sourced skills, i.e.
// Mullion's own `builtin` scope for this agent). `attachEnabledByAgent`
// forces `null` for a builtin-scope claude-code skill regardless of what
// `skillOverrides` says, and separately for a basename collision across
// scopes — a different hazard from Codex/opencode's frontmatter-name
// collision (there, both really do get toggled together; here, Claude Code
// loads only ONE of the two same-basename skills at all, live-verified
// reproducibly, and Mullion can't tell which).
//
// agy stays permanently read-only — not a coarse plugin-level toggle, a
// considered decision. Its proto data model has no per-skill disabled bit at
// all: inspecting the installed agy 1.1.9 binary's symbol table, `Plugin`
// and `PluginItem` both expose a `GetDisabled` accessor; `SkillMetadata`
// exposes only `GetName`/`GetDescription`/`GetPublisher`/`GetVersion` — no
// disabled/enabled field of any kind. Confirmed independently by
// antigravity's own public docs (https://antigravity.google/docs/cli/plugins):
// "the documentation provides no per-individual-skill enable/disable
// mechanism... `agy plugin disable <plugin_name>` suspends the entire
// package." Offering a "toggle" that actually disables a skill's whole
// containing plugin — taking its rules, hooks, and MCP servers down with it
// — would be a surprising thing to do from what looks like a single-skill
// switch, so agy's `enabledByAgent` stays `null` unconditionally rather than
// wiring up that coarser, riskier operation.
//
// Issue #885 — this module also discovers two more kinds alongside skills:
// Claude Code/opencode SUBAGENTS and Claude Code slash COMMANDS
// (`SkillInfo.kind`). Both are pure discovery, no writer of any kind exists
// or is planned here — `attachEnabledByAgent` forces `enabledByAgent[agent]
// = null` for every non-"skill" row unconditionally, same posture as agy's
// permanent read-only status above. Codex and agy have no subagent/command
// concept at all (confirmed against both CLIs' own docs — see
// docs/project-briefing.md's coverage table), so neither ever contributes an
// "agent"/"command" row. Unlike a skill (`<dir>/<name>/SKILL.md`), an
// agent/command is a single loose `.md` FILE directly inside its directory
// (`<dir>/<name>.md`) — scanned by the sibling `scanFileDirs`/
// `readMdFilesSafe`, never `scanSkillDirs`/`readDirSafe`. A command file's
// frontmatter is commonly missing `name:` entirely (verified against real
// `~/.claude/commands/*.md` files on this host — Claude Code's own slash
// commands are named by FILENAME, not frontmatter), so command discovery
// falls back to the filename (sans `.md`) when frontmatter has no name; a
// subagent, like a skill, requires both fields, matching Claude Code's own
// subagent file format (`.claude/agents/mullion-reviewer.md` in this repo,
// itself both name- and description-carrying).

import { readdir as readdirAsync, open as openAsync, stat as statAsync } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expandHome } from "./project-config.js";
import { resolveCodexHome } from "./hook-adapters/codex.js";
import {
  resolveClaudeConfigDir,
  resolveClaudePluginCacheDir,
} from "./hook-adapters/claude-code.js";
import {
  readCodexSkillEnabledMap,
  writeCodexSkillEnabled,
  CodexSkillsConfigParseError,
  CodexSkillUserAuthoredError,
} from "./hook-adapters/codex-skills.js";
import {
  readOpenCodeSkillEnabledMap,
  writeOpenCodeSkillEnabled,
  resolveOpenCodeConfigHome,
  OpenCodeConfigParseError,
  OpenCodeSkillUserAuthoredError,
} from "./hook-adapters/opencode-skills.js";
import { resolveAgyGlobalSkillsDir } from "./hook-adapters/agy.js";
import {
  readClaudeCodeSkillEnabledMap,
  writeClaudeCodeSkillEnabled,
  ClaudeCodeSettingsParseError,
  ClaudeCodeSkillUserAuthoredError,
  ClaudeCodeSkillProjectOverrideError,
  ClaudeCodeSkillBasenameCollisionError,
  ClaudeCodeSkillPluginSourcedError,
} from "./hook-adapters/claude-code-skills.js";
import { assertSafeSkillName, InvalidSkillNameError } from "./hook-adapters/skill-name.js";
// SkillAgent/SkillScope/SkillInfo now physically live in src/shared/types.ts
// (hand-mirrored 1:1 on the frontend — see frontend/src/api.ts's own
// re-export). Re-exported below so every existing backend importer of this
// module keeps working unchanged.
import type { SkillAgent, SkillScope, SkillKind, SkillInfo } from "../shared/types.js";

export type { SkillAgent, SkillScope, SkillKind, SkillInfo };

// Kept in one place so skills.ts, the routes, and the writer-selection
// switch never drift apart on which agents actually support a write. agy is
// permanently absent — see this file's header for why. claude-code's
// presence here means "some of its skills are toggleable," not all —
// attachEnabledByAgent/resolveSkillForToggle still gate individual skills
// out (builtin scope, basename collisions) below.
const TOGGLEABLE_SKILL_AGENTS: readonly SkillAgent[] = ["codex", "opencode", "claude-code"];

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
// Issue #885 — one shared budget across ALL THREE kinds (skill/agent/
// command), not one each: `scanSkillDirs` and `scanFileDirs` both take the
// same `ScanBudget` reference. 500 total read attempts is still generous for
// the combined case (a host with 500 skills+subagents+commands across every
// scanned directory is not a realistic target for this cap to protect
// against), and a single shared number is simpler to reason about than three
// independent ones that could each individually look fine while their sum
// still runs away.
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

// Issue #885 — sibling of readDirSafe above, for agent/command discovery: a
// subagent or slash command is a single loose `.md` FILE directly inside its
// directory (`.claude/agents/mullion-reviewer.md`), not a subdirectory
// containing one, so this lists FILES rather than directories. Identical
// guard set (ENOENT/ENOTDIR/EACCES/EPERM -> [], deadline-raced, symlinks
// resolved by an explicit stat since Dirent never follows one) — see
// readDirSafe's own comments for why each of those exists.
async function readMdFilesSafe(dir: string): Promise<string[]> {
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
    if (!entry.name.endsWith(".md")) continue;
    if (entry.isFile()) {
      names.push(entry.name);
      continue;
    }
    if (entry.isSymbolicLink()) {
      const entryPath = path.join(dir, entry.name);
      try {
        const stat = await withReadDeadline(statAsync(entryPath), entryPath);
        if (stat.isFile()) names.push(entry.name);
      } catch (err) {
        if (err instanceof SkillsTimeoutError) throw err;
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
// scalar fields a SKILL.md/agent/command frontmatter block can carry (name,
// description — see the plan's verified format: "YAML frontmatter (name,
// description required) plus a Markdown body"). Not a general YAML parser:
// this repo has no YAML dependency, and pulling one in for two string
// fields would be the wrong trade for a read-only discovery slice. A
// block-scalar description (`description: |` / `description: >`) is
// deliberately treated as unparseable rather than mis-captured as the
// literal "|"/">" character — such an entry is skipped (see the callers),
// same as any other malformed frontmatter. Returns `{name, description}`
// with either possibly `null` — callers (parseSkillFrontmatter,
// parseAgentOrCommandFrontmatter) decide which fields are actually required
// for their kind; a command's `name` is optional (see the latter's own
// comment), everything else requires both.
function parseFlatFrontmatterFields(
  raw: string,
): { name: string | null; description: string | null } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) return null;

  let name: string | null = null;
  let description: string | null = null;
  for (const line of match[1].split(/\r?\n/)) {
    // CodeQL (js/polynomial-redos), PR #894 — `\s*(.*)$` overlaps `\s` and
    // `.` on the same input, a superlinear-backtracking shape newly
    // reachable from arbitrary HTTP-body text once PR-894's project-skill/
    // reviewer-agent write routes started feeding attacker-controlled
    // content through this parser (every prior caller only ever ran it
    // against committed/discovered skill files). Dropping the `\s*` is
    // behavior-preserving, not just a workaround: `kv[2].trim()` right
    // below already strips exactly the leading whitespace `\s*` used to
    // consume, so capturing it into the group and trimming it afterward
    // produces the identical `value`.
    const kv = /^(name|description):(.*)$/.exec(line);
    if (!kv) continue;
    const value = kv[2].trim();
    if (/^[|>][+-]?\d?$/.test(value)) continue; // block-scalar indicator, unsupported
    const unquoted = stripYamlScalarQuotes(value);
    if (unquoted.length === 0) continue;
    if (kv[1] === "name" && name === null) name = unquoted;
    if (kv[1] === "description" && description === null) description = unquoted;
  }
  return { name, description };
}

// Exported so a guard test can assert Mullion's own shipped bundle skills
// (src/bundle/skills/) actually parse under this exact parser, rather than
// just "looking like" valid frontmatter — a bundle edit that silently broke
// discovery would otherwise only surface live, against a real Claude Code
// session.
export function parseSkillFrontmatter(raw: string): ParsedFrontmatter | null {
  const parsed = parseFlatFrontmatterFields(raw);
  if (!parsed?.name || !parsed.description) return null;
  return { name: parsed.name, description: parsed.description };
}

// Issue #885 — a subagent file (kind "agent") needs both fields, same as a
// skill (Claude Code's own `.claude/agents/*.md` format is name+description
// frontmatter, verified against this repo's own `mullion-reviewer.md`). A
// command file (kind "command") does NOT: verified against real
// `~/.claude/commands/*.md` files that a slash command's own `name:` key is
// commonly just absent — Claude Code names a command by its FILENAME, not
// its frontmatter — so `fallbackName` (the file's basename, sans `.md`) is
// used whenever frontmatter carries no name of its own. `description` is
// still required either way; a command/agent file with no description at
// all is skipped, same as a skill with malformed frontmatter.
export function parseAgentOrCommandFrontmatter(
  raw: string,
  kind: "agent" | "command",
  fallbackName: string,
): ParsedFrontmatter | null {
  const parsed = parseFlatFrontmatterFields(raw);
  if (!parsed?.description) return null;
  if (kind === "agent" && !parsed.name) return null;
  return { name: parsed.name ?? fallbackName, description: parsed.description };
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
// Returns null for ENOENT/EACCES/EPERM and (independent review, PR #459 —
// see below) any other non-timeout read failure (see the file header on why
// a permission failure is "not visible to us" here, not a hard error) —
// only a genuine timeout still propagates.
async function readBoundedPrefix(filePath: string, maxBytes: number): Promise<string | null> {
  let handle;
  try {
    handle = await withReadDeadline(openAsync(filePath, "r"), filePath);
  } catch (err) {
    if (err instanceof SkillsTimeoutError) throw err;
    return null;
  }
  try {
    // Independent review, PR #459 — an earlier version only wrapped
    // openAsync in this try/catch, not the read itself. open() succeeds on
    // a directory on Linux; a SKILL.md that's actually a directory (or any
    // other read-time errno — EIO on a flaky mount, which this module's own
    // header comment already anticipates) then threw EISDIR straight out of
    // this function, uncaught, taking down the ENTIRE listing instead of
    // being skipped like every other malformed entry this module handles —
    // reproduced directly (`open(dir, 'r')` then `.read()` -> EISDIR).
    // Bounding both calls under one try/catch makes read-time failures
    // "not visible to us" the same way open-time ones already are.
    const buffer = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await withReadDeadline(
      handle.read(buffer, 0, buffer.length, 0),
      filePath,
    );
    return buffer.toString("utf8", 0, bytesRead);
  } catch (err) {
    if (err instanceof SkillsTimeoutError) throw err;
    return null;
  } finally {
    await handle.close();
  }
}

async function readSkillFrontmatter(skillMdPath: string): Promise<ParsedFrontmatter | null> {
  const raw = await readBoundedPrefix(skillMdPath, MAX_FRONTMATTER_READ_BYTES);
  return raw === null ? null : parseSkillFrontmatter(raw);
}

async function readAgentOrCommandFrontmatter(
  filePath: string,
  kind: "agent" | "command",
  fallbackName: string,
): Promise<ParsedFrontmatter | null> {
  const raw = await readBoundedPrefix(filePath, MAX_FRONTMATTER_READ_BYTES);
  return raw === null ? null : parseAgentOrCommandFrontmatter(raw, kind, fallbackName);
}

interface SkillSourceDir {
  dir: string;
  agent: SkillAgent;
  scope: SkillScope;
}

// Issue #885 — sibling of SkillSourceDir for agent/command discovery: `dir`
// is scanned for loose `.md` FILES directly inside it (readMdFilesSafe),
// never a subdirectory tree (readDirSafe). Kept as a distinct type rather
// than an optional `kind` on SkillSourceDir so a caller can't accidentally
// pass a skill-shaped source into scanFileDirs (or vice versa) and have it
// silently scan the wrong way.
interface FileSourceDir {
  dir: string;
  agent: SkillAgent;
  scope: SkillScope;
  kind: "agent" | "command";
}

// Issue #885 — one mutable counter shared by scanSkillDirs and scanFileDirs
// (see MAX_SKILLS's own comment on why the budget is shared across kinds
// rather than per-kind) — a plain object rather than a closure/module-level
// variable so a fresh budget is trivial to construct per top-level listing
// call (listProjectSkills/listGlobalSkills) without any reset step, and so
// __testing's exported scanSkillDirs/scanFileDirs stay independently
// callable with their own budget in existing tests, unaffected by this.
interface ScanBudget {
  count: number;
}

/** Project-scope directories, relative to a trusted project cwd — see the
 * plan's verified discovery matrix. Deliberately just `<cwd>/.agents/skills`
 * for Codex/opencode, not also a walked-up `$REPO_ROOT/.agents/skills`: for
 * a Mullion-managed project, cwd already IS the repo root in the common
 * case, and a separate git-root resolution is more machinery than a
 * discovery-only slice needs (documented simplification, not an oversight). */
// Issue #467 — `<cwd>/.agents/skills` also reaches agy (antigravity's own
// docs, https://antigravity.google/docs/cli/plugins: "workspace-specific"
// skills at `.agents/skills/`), previously unlisted here even though this
// exact directory was already scanned for codex/opencode. `scanSkillDirs`
// merges entries resolving to the same absolute path, so this correctly
// produces one row listing three agents rather than three separate rows.
function projectSkillDirs(cwd: string): SkillSourceDir[] {
  return [
    { dir: path.join(cwd, ".claude", "skills"), agent: "claude-code", scope: "project" },
    { dir: path.join(cwd, ".agents", "skills"), agent: "codex", scope: "project" },
    { dir: path.join(cwd, ".opencode", "skills"), agent: "opencode", scope: "project" },
    { dir: path.join(cwd, ".claude", "skills"), agent: "opencode", scope: "project" },
    { dir: path.join(cwd, ".agents", "skills"), agent: "opencode", scope: "project" },
    { dir: path.join(cwd, ".agents", "skills"), agent: "agy", scope: "project" },
  ];
}

/** Global (user-home / env-derived) directories — a function of environment
 * (CODEX_HOME, HOME, XDG_CONFIG_HOME, CLAUDE_CONFIG_DIR), resolved lazily per listing, same
 * reasoning as agent-rules.ts's globalDir(). `/etc/codex/skills` is the one
 * genuinely machine-wide (not user-home) entry in the plan's matrix;
 * classified as "global" rather than a distinct scope since it shares that
 * scope's semantics (read-only, not bundled with the CLI binary itself, not
 * a project).
 *
 * Hermes review, PR #469 — opencode's skills dir goes through
 * `resolveOpenCodeConfigHome()` (opencode-skills.ts), not a hardcoded
 * `~/.config/opencode/skills`: verified opencode itself resolves its whole
 * config tree via XDG_CONFIG_HOME when set, so a skill installed under a
 * real XDG_CONFIG_HOME setup (NixOS and similar) used to be silently
 * invisible to this discovery, same root cause as the write-side bug that
 * same review found.
 *
 * Issue #470 — the same class of bug, for Claude Code: `claudeSkills` goes
 * through `resolveClaudeConfigDir()` (hook-adapters/claude-code.ts), not a
 * hardcoded `~/.claude/skills` — Claude Code resolves its entire user-scope
 * config tree off `CLAUDE_CONFIG_DIR` when set (verified statically against
 * the installed 2.1.220 bundle). This one variable feeds both the
 * claude-code AND opencode global rows below, since opencode also scans
 * Claude Code's skills dir. */
function globalSkillDirs(): SkillSourceDir[] {
  const claudeSkills = path.join(resolveClaudeConfigDir(), "skills");
  const agentsSkills = expandHome("~/.agents/skills");
  return [
    { dir: claudeSkills, agent: "claude-code", scope: "global" },
    { dir: path.join(resolveCodexHome(), "skills"), agent: "codex", scope: "global" },
    { dir: agentsSkills, agent: "codex", scope: "global" },
    { dir: "/etc/codex/skills", agent: "codex", scope: "global" },
    { dir: path.join(resolveOpenCodeConfigHome(), "skills"), agent: "opencode", scope: "global" },
    { dir: claudeSkills, agent: "opencode", scope: "global" },
    { dir: agentsSkills, agent: "opencode", scope: "global" },
    // Issue #888 — agy's REAL global skill root is ~/.gemini/config/skills,
    // not ~/.gemini/antigravity-cli/skills (verified empirically; agy's own
    // docs and bundled strings confirm ~/.gemini/config/ as the global
    // customization root). The project-scope .agents/skills is handled by
    // projectSkillDirs above.
    {
      dir: resolveAgyGlobalSkillsDir(),
      agent: "agy",
      scope: "global",
    },
  ];
}

/** Issue #885 — project-scope subagent/command directories. Claude Code
 * only: codex and agy have no subagent/command concept at all, and opencode
 * has no project-scope agent directory of its own (only the global,
 * singular `agent/` dir below — see globalAgentAndCommandDirs's comment). */
function projectAgentAndCommandDirs(cwd: string): FileSourceDir[] {
  return [
    {
      dir: path.join(cwd, ".claude", "agents"),
      agent: "claude-code",
      scope: "project",
      kind: "agent",
    },
    {
      dir: path.join(cwd, ".claude", "commands"),
      agent: "claude-code",
      scope: "project",
      kind: "command",
    },
  ];
}

/** Issue #885 — global subagent/command directories. Claude Code's two hang
 * off the same `resolveClaudeConfigDir()` CLAUDE_CONFIG_DIR-aware root as its
 * global skills dir above (same reasoning, issue #470). opencode's own
 * `<CONFIG_DIR>/agent/<name>.md` convention (singular `agent`, not `agents`)
 * hangs off `resolveOpenCodeConfigHome()`, the same XDG-aware root as its
 * global skills dir — the singular-`agent/` directory name itself was
 * live-verified only for the EPHEMERAL `OPENCODE_CONFIG_DIR` case
 * (mullion-bundle.ts's `deriveOpenCodeReviewerAgentFile`), not this real
 * config-home root; applying the same convention here is a reasonable but
 * unverified inference, not a repeated spike. Fails closed if wrong — the
 * directory simply won't exist and this scan finds nothing, same as any
 * other absent directory in this file. opencode has no slash-command
 * concept Mullion discovers here. */
function globalAgentAndCommandDirs(): FileSourceDir[] {
  const claudeConfigDir = resolveClaudeConfigDir();
  return [
    {
      dir: path.join(claudeConfigDir, "agents"),
      agent: "claude-code",
      scope: "global",
      kind: "agent",
    },
    {
      dir: path.join(claudeConfigDir, "commands"),
      agent: "claude-code",
      scope: "global",
      kind: "command",
    },
    {
      dir: path.join(resolveOpenCodeConfigHome(), "agent"),
      agent: "opencode",
      scope: "global",
      kind: "agent",
    },
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
 * Each `plugins` value can be either the current (v2) shape — an ARRAY of
 * install-record objects (`{scope, installPath, ...}[]`) — or the legacy
 * (v1) shape — a single install-record OBJECT, pre-migration (Hermes
 * review, PR #459: confirmed against claude-code's own bundled zod schemas
 * — `Fxr`, "Map of plugin IDs to arrays of installation entries" for v2,
 * `Nxr`, "Map of plugin IDs to their installation metadata" for v1 — not
 * just an on-disk sample; a real installed_plugins.json on the author's own
 * dev host independently confirmed the v2 array shape). Claude Code
 * migrates v1 -> v2 on load, so a v1 file is expected to self-heal, but
 * skipping it outright (an earlier version's `if (!Array.isArray)
 * continue`) meant a host that hadn't opened Claude Code since installing a
 * plugin would show zero plugin skills with no indication why. */
async function listInstalledClaudePluginDirs(): Promise<string[]> {
  // Issue #470 — hangs off the plugin CACHE dir, which has its own,
  // narrower `CLAUDE_CODE_PLUGIN_CACHE_DIR` override ahead of
  // `CLAUDE_CONFIG_DIR` (verified in the same bundle scan that found
  // `resolveClaudeConfigDir`'s own override) — resolveClaudePluginCacheDir
  // handles both.
  const installedPath = path.join(resolveClaudePluginCacheDir(), "installed_plugins.json");
  const raw = await readBoundedPrefix(installedPath, MAX_INSTALLED_PLUGINS_READ_BYTES);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as { plugins?: Record<string, unknown> };
    const dirs: string[] = [];
    const pushInstallPath = (entry: unknown) => {
      const installPath = (entry as { installPath?: unknown } | null)?.installPath;
      if (typeof installPath === "string" && installPath.length > 0) dirs.push(installPath);
    };
    for (const entries of Object.values(parsed.plugins ?? {})) {
      if (Array.isArray(entries)) {
        entries.forEach(pushInstallPath);
      } else if (entries && typeof entries === "object") {
        pushInstallPath(entries);
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

/** Issue #885 — builtin (plugin-sourced) subagent/command directories:
 * Claude Code plugin marketplace installs only, same
 * `listInstalledClaudePluginDirs()` source as builtinSkillDirs above. Never
 * includes Mullion's own session-scoped `--plugin-dir` bundle
 * (`src/bundle/`) — that bundle is never registered in
 * `installed_plugins.json` at all (mullion-bundle.ts's own header on why a
 * session-only plugin dir is invisible to Claude Code's own plugin
 * bookkeeping), so it can't appear here even once it ships an `agents/`/
 * `commands/` directory of its own; this is what "no synthetic bundle rows"
 * means in practice, not a separate exclusion this function has to encode.
 * agy/codex have no subagent/command concept, so neither contributes a
 * builtin row here either. */
async function builtinAgentAndCommandDirs(): Promise<FileSourceDir[]> {
  const dirs: FileSourceDir[] = [];
  for (const installPath of await listInstalledClaudePluginDirs()) {
    dirs.push({
      dir: path.join(installPath, "agents"),
      agent: "claude-code",
      scope: "builtin",
      kind: "agent",
    });
    dirs.push({
      dir: path.join(installPath, "commands"),
      agent: "claude-code",
      scope: "builtin",
      kind: "command",
    });
  }
  return dirs;
}

/** Scans every `SkillSourceDir`'s immediate subdirectories for a
 * `SKILL.md`, merging entries that resolve to the exact same absolute
 * `sourceDir` (e.g. opencode and Claude Code both reading `~/.claude/skills`
 * — the same shared-file situation agent-rules.ts's own header comment
 * describes for AGENTS.md) into one SkillInfo with a combined `agents` list,
 * rather than reporting the same on-disk skill twice.
 *
 * `budget` defaults to a fresh `{count: 0}` so every existing direct caller
 * (this module's own tests, via `__testing`) keeps working unchanged; the
 * real listing entry points (listProjectSkills/listGlobalSkills) pass one
 * explicit budget shared with the sibling `scanFileDirs` call below — see
 * ScanBudget's own comment for why. */
async function scanSkillDirs(
  sourceDirs: SkillSourceDir[],
  budget: ScanBudget = { count: 0 },
): Promise<SkillInfo[]> {
  const byPath = new Map<string, SkillInfo>();

  for (const source of sourceDirs) {
    if (budget.count >= MAX_SKILLS) break;
    const names = await readDirSafe(source.dir);
    for (const name of names) {
      if (budget.count >= MAX_SKILLS) break;
      // Hermes review, PR #459 — incremented before the frontmatter-validity
      // check, so MAX_SKILLS bounds every SKILL.md read ATTEMPT (the actual
      // cost this cap exists to bound), not just successfully-parsed ones. A
      // directory full of malformed/missing-frontmatter entries used to
      // never count against the cap at all.
      budget.count++;
      const skillDir = path.join(source.dir, name);
      const frontmatter = await readSkillFrontmatter(path.join(skillDir, "SKILL.md"));
      if (!frontmatter) continue;

      const existing = byPath.get(skillDir);
      if (existing) {
        if (!existing.agents.includes(source.agent)) existing.agents.push(source.agent);
        // Hermes review, PR #459 — explicit rather than relying on
        // `sourceDirs`'s call-site ordering (project dirs happening to be
        // spread before global/builtin ones): a project scope always wins a
        // merge, even if some future caller ever passes sources in a
        // different order. Only realistically reachable when a project's
        // own cwd IS the scanned global/builtin path (e.g. a project opened
        // at the user's home directory) — a real if rare edge case, not a
        // hypothetical one worth leaving to array order.
        if (source.scope === "project") existing.scope = "project";
        continue;
      }
      byPath.set(skillDir, {
        name: frontmatter.name,
        description: frontmatter.description,
        sourceDir: skillDir,
        scope: source.scope,
        kind: "skill",
        agents: [source.agent],
        enabledByAgent: {},
      });
    }
  }

  return [...byPath.values()];
}

/** Issue #885 — sibling of scanSkillDirs for agent/command discovery: scans
 * every `FileSourceDir`'s immediate `.md` FILES (readMdFilesSafe, never a
 * per-item subdirectory) rather than subdirectories containing a `SKILL.md`.
 * Merges on the exact file path the same way scanSkillDirs merges on a
 * skill's directory path (e.g. Claude Code's own `.claude/agents` dir could
 * in principle be scanned under more than one `agent` entry the way skills
 * dirs are, even though today only claude-code/opencode ever appear here).
 * `budget` is the SAME counter scanSkillDirs already advanced when both are
 * called from one listing — see ScanBudget's own comment. */
async function scanFileDirs(
  sourceDirs: FileSourceDir[],
  budget: ScanBudget = { count: 0 },
): Promise<SkillInfo[]> {
  const byPath = new Map<string, SkillInfo>();

  for (const source of sourceDirs) {
    if (budget.count >= MAX_SKILLS) break;
    const names = await readMdFilesSafe(source.dir);
    for (const fileName of names) {
      if (budget.count >= MAX_SKILLS) break;
      budget.count++;
      const filePath = path.join(source.dir, fileName);
      const fallbackName = fileName.slice(0, -".md".length);
      const frontmatter = await readAgentOrCommandFrontmatter(filePath, source.kind, fallbackName);
      if (!frontmatter) continue;

      const existing = byPath.get(filePath);
      if (existing) {
        if (!existing.agents.includes(source.agent)) existing.agents.push(source.agent);
        if (source.scope === "project") existing.scope = "project"; // see scanSkillDirs's own comment
        continue;
      }
      byPath.set(filePath, {
        name: frontmatter.name,
        description: frontmatter.description,
        sourceDir: filePath,
        scope: source.scope,
        kind: source.kind,
        agents: [source.agent],
        enabledByAgent: {},
      });
    }
  }

  return [...byPath.values()];
}

/** Every discovered skill that `agent` can see under the given `name` — the
 * shared matching rule behind both `attachEnabledByAgent`'s ambiguity check
 * and `resolveSkillForToggle`'s write-time validation, so a name that reads
 * as toggleable in a GET response is guaranteed to resolve to exactly the
 * same single skill a following PUT would act on (same discovery result,
 * no second pass — no TOCTOU between the two).
 *
 * Issue #885 — scoped to `kind === "skill"`: an agent/command row can share
 * a frontmatter name with an unrelated skill (e.g. a subagent and a skill
 * both named "reviewer") without that skill spuriously degrading to
 * "ambiguous" — the two kinds have entirely separate toggle mechanisms (a
 * skill's is real; an agent/command's doesn't exist), so they must never be
 * compared against each other here. */
function skillsSharingName(skills: SkillInfo[], agent: SkillAgent, name: string): SkillInfo[] {
  return skills.filter(
    (skill) => skill.kind === "skill" && skill.agents.includes(agent) && skill.name === name,
  );
}

/** Every discovered skill sharing `agent`'s toggle selector with `skill`
 * (its directory basename for claude-code, its frontmatter name for
 * everyone else) — used only to compute claude-code's basename-collision
 * hazard, kept separate from `skillsSharingName`'s name-based check since
 * the two agents key on different things entirely (see
 * claude-code-skills.ts's header for why). Scoped to `kind === "skill"` for
 * the same reason skillsSharingName is (issue #885) — an agent/command file
 * living in a directory with the same basename as an unrelated skill's
 * directory must not spuriously collide with it. */
function claudeCodeSkillsSharingBasename(skills: SkillInfo[], basename: string): SkillInfo[] {
  return skills.filter(
    (skill) =>
      skill.kind === "skill" &&
      skill.agents.includes("claude-code") &&
      skill.scope !== "builtin" &&
      path.basename(skill.sourceDir) === basename,
  );
}

/** Populates every skill's `enabledByAgent` in place, given the FULL
 * discovery result (see skillsSharingName's doc comment for why ambiguity
 * must be computed from this same list, not a second query). A toggle-
 * capable agent's config read failure (malformed config.toml/opencode.json/
 * settings.json) degrades every one of that agent's skills to `null` ("not
 * toggleable") rather than failing the whole listing — same "one unreadable
 * thing shouldn't take down the whole request" posture as this file's own
 * EACCES/EPERM handling.
 *
 * `cwd` is `null` for the global-only listing (`listGlobalSkills`, feeding
 * `GET /api/skills` / `Settings.tsx`'s global view) and the resolved project
 * cwd for `listProjectSkills` (feeding `GET /api/projects/:id/skills` /
 * `SkillsPanel`). For claude-code specifically, a `null` cwd means "cannot
 * rule out a project-scope settings.json/settings.local.json entry
 * shadowing whatever this reports" — see claude-code-skills.ts's header —
 * so every claude-code skill degrades to `null` from the global route
 * rather than reporting a boolean the project-scoped route could
 * contradict. Codex/opencode have no such asymmetry (their config is
 * global-only), so this only applies to claude-code.
 *
 * Issue #885 — every one of the four collision/toggleability computations
 * below (ambiguousNames, shadowedBasenames, the enabledMaps gate, and the
 * final assignment loop) is scoped to `kind === "skill"` — a discovered
 * agent/command row is discovery-only (see this file's own header) and must
 * never participate in, or be affected by, a skill's ambiguity/collision
 * math; it always gets `enabledByAgent[agent] = null` unconditionally,
 * handled by its own branch at the top of the final loop below. */
function attachEnabledByAgent(skills: SkillInfo[], cwd: string | null): SkillInfo[] {
  const ambiguousNames = new Map<SkillAgent, Set<string>>();
  for (const agent of TOGGLEABLE_SKILL_AGENTS) {
    if (agent === "claude-code") continue; // claude-code uses a basename check instead, below
    const namesSeen = new Set<string>();
    const namesAmbiguous = new Set<string>();
    for (const skill of skills) {
      if (skill.kind !== "skill" || !skill.agents.includes(agent)) continue;
      if (namesSeen.has(skill.name)) namesAmbiguous.add(skill.name);
      namesSeen.add(skill.name);
    }
    ambiguousNames.set(agent, namesAmbiguous);
  }

  // claude-code's own selector is the skill directory's basename, not its
  // frontmatter name (live-verified — see claude-code-skills.ts's header).
  // Two skills at different scopes sharing a basename collide on that
  // selector even when their frontmatter names differ and so pass the
  // name-based ambiguity check above cleanly — Claude Code loads only ONE
  // of them (empirically the global one won, reproducibly) and the other is
  // invisible to the model entirely, not "also toggled." Computed only over
  // non-builtin scope: builtin-scope claude-code skills are forced `null`
  // below for a different reason (plugin-sourced), so including them here
  // would be redundant.
  const shadowedBasenames = new Set<string>();
  {
    const basenamesSeen = new Set<string>();
    for (const skill of skills) {
      if (
        skill.kind !== "skill" ||
        !skill.agents.includes("claude-code") ||
        skill.scope === "builtin"
      )
        continue;
      const base = path.basename(skill.sourceDir);
      if (basenamesSeen.has(base)) shadowedBasenames.add(base);
      basenamesSeen.add(base);
    }
  }

  const enabledMaps = new Map<SkillAgent, Map<string, boolean | null> | null>();
  for (const agent of TOGGLEABLE_SKILL_AGENTS) {
    if (!skills.some((skill) => skill.kind === "skill" && skill.agents.includes(agent))) continue;
    if (agent === "claude-code") {
      if (cwd === null) continue; // see this function's own doc comment
      try {
        enabledMaps.set(agent, readClaudeCodeSkillEnabledMap(cwd));
      } catch {
        enabledMaps.set(agent, null);
      }
      continue;
    }
    try {
      switch (agent) {
        case "codex":
          enabledMaps.set(agent, readCodexSkillEnabledMap());
          break;
        case "opencode":
          enabledMaps.set(agent, readOpenCodeSkillEnabledMap());
          break;
        default:
          // Issue #467 / independent review, PR #469 — this module's own
          // writer switch (toggleSkillEnabled, below) was hardened with an
          // identical throwing `default` specifically so a future addition
          // to TOGGLEABLE_SKILL_AGENTS can't silently fall through into the
          // wrong agent's reader/writer. This is that same guard's read-side
          // twin — it had none before this change, which would have read
          // claude-code's state out of opencode's config the moment
          // claude-code was added here without it.
          throw new Error(`no enabled-map reader registered for toggleable agent "${agent}"`);
      }
    } catch {
      enabledMaps.set(agent, null);
    }
  }

  for (const skill of skills) {
    for (const agent of skill.agents) {
      if (skill.kind !== "skill") {
        skill.enabledByAgent[agent] = null; // agent/command rows are discovery-only — see issue #885
        continue;
      }
      if (!TOGGLEABLE_SKILL_AGENTS.includes(agent)) {
        skill.enabledByAgent[agent] = null;
        continue;
      }
      if (agent === "claude-code") {
        if (skill.scope === "builtin") {
          skill.enabledByAgent[agent] = null; // plugin-sourced — skillOverrides never reaches it
          continue;
        }
        if (shadowedBasenames.has(path.basename(skill.sourceDir))) {
          skill.enabledByAgent[agent] = null;
          continue;
        }
        if (cwd === null) {
          skill.enabledByAgent[agent] = null;
          continue;
        }
        const map = enabledMaps.get(agent);
        const raw = map ? map.get(path.basename(skill.sourceDir)) : undefined;
        skill.enabledByAgent[agent] = map ? (raw === undefined ? true : raw) : null;
        continue;
      }
      if (ambiguousNames.get(agent)?.has(skill.name)) {
        skill.enabledByAgent[agent] = null;
        continue;
      }
      const map = enabledMaps.get(agent);
      skill.enabledByAgent[agent] = map ? (map.get(skill.name) ?? true) : null;
    }
  }
  return skills;
}

export type ResolveSkillForToggleResult =
  | { ok: true; skill: SkillInfo }
  | {
      ok: false;
      reason:
        | "not-found"
        | "ambiguous"
        | "not-toggleable"
        | "claude-code-plugin-sourced"
        | "claude-code-basename-collision";
    };

/** Validates a `{agent, name}` write request against a FRESH discovery
 * result (the route layer re-runs discovery for this, per the plan's "the
 * client never sends a path" decision — see routes/skills.ts) before ever
 * calling a writer. Refuses (never guesses) exactly the same cases
 * `attachEnabledByAgent` already marks `null` for a GET, plus the
 * unresolvable-agent case up front — including claude-code's two
 * skill-specific gates (plugin-sourced, basename collision), which don't fit
 * the generic name-ambiguity check every other agent uses (see
 * claude-code-skills.ts's header for why claude-code's selector and hazard
 * are both different). */
export function resolveSkillForToggle(
  skills: SkillInfo[],
  agent: SkillAgent,
  name: string,
): ResolveSkillForToggleResult {
  if (!TOGGLEABLE_SKILL_AGENTS.includes(agent)) return { ok: false, reason: "not-toggleable" };
  const matches = skillsSharingName(skills, agent, name);
  if (matches.length === 0) return { ok: false, reason: "not-found" };
  if (matches.length > 1) return { ok: false, reason: "ambiguous" };
  const skill = matches[0];
  if (agent === "claude-code") {
    if (skill.scope === "builtin") return { ok: false, reason: "claude-code-plugin-sourced" };
    if (claudeCodeSkillsSharingBasename(skills, path.basename(skill.sourceDir)).length > 1) {
      return { ok: false, reason: "claude-code-basename-collision" };
    }
  }
  return { ok: true, skill };
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
  const skillDirs = [
    ...projectSkillDirs(resolved),
    ...globalSkillDirs(),
    ...(await builtinSkillDirs()),
  ];
  const fileDirs = [
    ...projectAgentAndCommandDirs(resolved),
    ...globalAgentAndCommandDirs(),
    ...(await builtinAgentAndCommandDirs()),
  ];
  // Issue #885 — one shared ScanBudget across both calls, not one each; see
  // MAX_SKILLS's own comment.
  const budget: ScanBudget = { count: 0 };
  const skills = await scanSkillDirs(skillDirs, budget);
  const files = await scanFileDirs(fileDirs, budget);
  return attachEnabledByAgent([...skills, ...files], resolved);
}

/** Global + builtin skills only, no project context — GET /api/skills,
 * deliberately primary-host-only (see the plan: a remote host's global
 * skill dirs are that host's own, not the primary's; a per-host selector
 * for this endpoint is left for a follow-up rather than guessed at here).
 * `cwd: null` here is what makes claude-code skills degrade to `null` in
 * `attachEnabledByAgent` — see that function's own comment. */
export async function listGlobalSkills(): Promise<SkillInfo[]> {
  const skillDirs = [...globalSkillDirs(), ...(await builtinSkillDirs())];
  const fileDirs = [...globalAgentAndCommandDirs(), ...(await builtinAgentAndCommandDirs())];
  const budget: ScanBudget = { count: 0 };
  const skills = await scanSkillDirs(skillDirs, budget);
  const files = await scanFileDirs(fileDirs, budget);
  return attachEnabledByAgent([...skills, ...files], null);
}

class SkillNotFoundError extends Error {
  constructor(agent: SkillAgent, name: string) {
    super(`No ${agent} skill named "${name}" was found`);
    this.name = "SkillNotFoundError";
  }
}

class SkillAmbiguousError extends Error {
  constructor(agent: SkillAgent, name: string) {
    super(
      `"${name}" matches more than one discovered ${agent} skill (different directories, same ` +
        `frontmatter name) — ${agent}'s own enable/disable selector can't target just one`,
    );
    this.name = "SkillAmbiguousError";
  }
}

class SkillNotToggleableError extends Error {
  constructor(agent: SkillAgent) {
    super(`Skill enable/disable is not supported for ${agent} yet`);
    this.name = "SkillNotToggleableError";
  }
}

/** The single write entry point for both the primary route
 * (routes/skills.ts, a local project) and the agent-side route
 * (routes/internal.ts's /internal/skills, a remote-hosted project) — same
 * "server re-resolves sourceDir, client only ever sends {agent, name}"
 * contract the plan committed to. Re-runs discovery itself (never trusts a
 * caller-supplied path or a stale previous listing) so the ambiguity check
 * and the actual write are guaranteed to agree — then re-runs discovery
 * AGAIN after writing and returns the fresh row, mirroring
 * agent-rules.ts's writeAgentRule/getAgentRule read-back pattern. Throws
 * (never returns null/undefined) on every failure mode — callers map each
 * error type to an HTTP status. */
export async function toggleSkillEnabled(
  cwd: string,
  agent: SkillAgent,
  name: string,
  enabled: boolean,
): Promise<SkillInfo> {
  // Defense in depth (CodeQL: js/remote-property-injection,
  // js/tainted-path-adjacent write) — both writers re-check this
  // independently too (see skill-name.ts's own header), but checking here
  // FIRST means a bad name never gets as far as a discovery re-run or a
  // filesystem write, and produces the same clean classifySkillToggleError
  // 400 as every other rejection this function can produce. In practice
  // unreachable through `name` alone (see skill-name.ts's header on why
  // `resolveSkillForToggle` can only ever match an already-parsed
  // frontmatter name), but this function's contract shouldn't depend on
  // that discipline holding forever.
  assertSafeSkillName(name);

  const before = await listProjectSkills(cwd);
  const resolved = resolveSkillForToggle(before, agent, name);
  if (!resolved.ok) {
    if (resolved.reason === "not-found") throw new SkillNotFoundError(agent, name);
    if (resolved.reason === "ambiguous") throw new SkillAmbiguousError(agent, name);
    if (resolved.reason === "claude-code-plugin-sourced") {
      throw new ClaudeCodeSkillPluginSourcedError(name);
    }
    if (resolved.reason === "claude-code-basename-collision") {
      throw new ClaudeCodeSkillBasenameCollisionError(name);
    }
    throw new SkillNotToggleableError(agent);
  }

  // Independent review, PR #469 — this used to be `if (agent === "codex")
  // {...} else {...}`, relying entirely on resolveSkillForToggle's earlier
  // TOGGLEABLE_SKILL_AGENTS filter to keep `agent` one of just these two.
  // That's true today, but the moment a third agent is added to
  // TOGGLEABLE_SKILL_AGENTS (issue #467), resolveSkillForToggle would let it
  // through as `ok: true` and this `else` would silently route that agent's
  // write into opencode's config file. A `default` that throws instead of
  // falling into the opencode branch turns that into a loud error at the
  // moment it happens, rather than a silent misdirected write — SkillAgent
  // has more members than TOGGLEABLE_SKILL_AGENTS (claude-code, agy are
  // read-only), so this can't be a compile-time-exhaustive switch, only a
  // runtime guard.
  //
  // claude-code's writer takes `path.basename(resolved.skill.sourceDir)`,
  // not `name` — see claude-code-skills.ts's header for why its selector is
  // the directory basename rather than the frontmatter name every other
  // agent uses.
  switch (agent) {
    case "codex":
      writeCodexSkillEnabled(name, enabled);
      break;
    case "opencode":
      writeOpenCodeSkillEnabled(name, enabled);
      break;
    case "claude-code":
      writeClaudeCodeSkillEnabled(cwd, path.basename(resolved.skill.sourceDir), enabled);
      break;
    default:
      throw new SkillNotToggleableError(agent);
  }

  const after = await listProjectSkills(cwd);
  const updated = resolveSkillForToggle(after, agent, name);
  // Between the write above and this re-read, the skill directory itself
  // cannot have disappeared (this function didn't touch it) and the name
  // cannot have BECOME ambiguous (the write only ever flips a boolean, it
  // never creates a new skill directory) — so `updated.ok` is guaranteed
  // true in practice. Falling back to the pre-write row rather than
  // asserting/throwing keeps this function's contract simple (always
  // resolves to a SkillInfo on success) even in a theoretical race with an
  // external process editing the filesystem concurrently.
  return updated.ok ? updated.skill : resolved.skill;
}

export interface SkillToggleErrorClassification {
  statusCode: number;
  message: string;
}

/** Maps every `toggleSkillEnabled`/writer failure to an HTTP status — the
 * ONE place that mapping is defined, imported by both the primary route
 * (routes/skills.ts, a local project) and the agent-side route
 * (routes/internal.ts), so a local write and a remote-hosted write that hit
 * the exact same underlying failure always produce the exact same status
 * and message (services/host-error-reply.ts's forwardHostRequestError
 * forwards a remote 4xx's body/status verbatim, so this is what a primary
 * caller actually sees for either topology). Returns `null` for anything
 * this function doesn't recognize — callers rethrow rather than mask an
 * unexpected error as a generic response. */
export function classifySkillToggleError(err: unknown): SkillToggleErrorClassification | null {
  if (err instanceof SkillNotFoundError) return { statusCode: 404, message: err.message };
  if (err instanceof SkillAmbiguousError) return { statusCode: 409, message: err.message };
  if (err instanceof SkillNotToggleableError) return { statusCode: 400, message: err.message };
  if (err instanceof CodexSkillUserAuthoredError) return { statusCode: 400, message: err.message };
  if (err instanceof CodexSkillsConfigParseError) return { statusCode: 400, message: err.message };
  if (err instanceof OpenCodeConfigParseError) return { statusCode: 400, message: err.message };
  if (err instanceof OpenCodeSkillUserAuthoredError) {
    return { statusCode: 400, message: err.message };
  }
  if (err instanceof ClaudeCodeSettingsParseError) return { statusCode: 400, message: err.message };
  if (err instanceof ClaudeCodeSkillUserAuthoredError) {
    return { statusCode: 400, message: err.message };
  }
  if (err instanceof ClaudeCodeSkillProjectOverrideError) {
    return { statusCode: 400, message: err.message };
  }
  if (err instanceof ClaudeCodeSkillPluginSourcedError) {
    return { statusCode: 400, message: err.message };
  }
  // 409, not 400 — same "conflict between two discovered rows" semantics as
  // SkillAmbiguousError just above, only keyed on directory basename rather
  // than frontmatter name (see claude-code-skills.ts's header for why).
  if (err instanceof ClaudeCodeSkillBasenameCollisionError) {
    return { statusCode: 409, message: err.message };
  }
  if (err instanceof InvalidSkillNameError) return { statusCode: 400, message: err.message };
  return null;
}

export const __testing = {
  parseSkillFrontmatter,
  parseAgentOrCommandFrontmatter,
  withReadDeadline,
  FS_READ_DEADLINE_MS,
  scanSkillDirs,
  scanFileDirs,
  attachEnabledByAgent,
};
