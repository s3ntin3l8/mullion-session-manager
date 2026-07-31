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
// stay read-only (`enabledByAgent[agent]` is always `null` for them — see
// #467, filed as the follow-up rather than guessed at here) — both need a
// materially different write mechanism this slice doesn't build. A skill's
// body (the SKILL.md content after its frontmatter) is never read into
// memory or returned — only name/description, per the plan's explicit
// warning (tessera's own /skill and /command endpoints return full
// content/template, which should not be stored or logged).
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

import { readdir as readdirAsync, open as openAsync, stat as statAsync } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expandHome } from "./project-config.js";
import { resolveCodexHome } from "./hook-adapters/codex.js";
import {
  readCodexSkillEnabledMap,
  writeCodexSkillEnabled,
  CodexSkillsConfigParseError,
  CodexSkillUserAuthoredError,
} from "./hook-adapters/codex-skills.js";
import {
  readOpenCodeSkillEnabledMap,
  writeOpenCodeSkillEnabled,
  OpenCodeConfigParseError,
} from "./hook-adapters/opencode-skills.js";
import { assertSafeSkillName, InvalidSkillNameError } from "./hook-adapters/skill-name.js";

export type SkillAgent = "claude-code" | "codex" | "opencode" | "agy";
export type SkillScope = "builtin" | "global" | "project";

// Kept in one place so skills.ts, the routes, and the writer-selection
// switch never drift apart on which agents actually support a write.
export const TOGGLEABLE_SKILL_AGENTS: readonly SkillAgent[] = ["codex", "opencode"];

export interface SkillInfo {
  name: string;
  description: string;
  sourceDir: string;
  scope: SkillScope;
  agents: SkillAgent[];
  // `null` means "not toggleable for this agent" — either the agent doesn't
  // support a write yet (claude-code, agy), the skill's name is ambiguous
  // for this agent (see the file header), or that agent's config couldn't
  // be read (malformed config.toml/opencode.json — a listing-time read
  // failure degrades to "not toggleable," it never fails the whole
  // request; see attachEnabledByAgent).
  enabledByAgent: Partial<Record<SkillAgent, boolean | null>>;
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
  const installedPath = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json");
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
 * no second pass — no TOCTOU between the two). */
function skillsSharingName(skills: SkillInfo[], agent: SkillAgent, name: string): SkillInfo[] {
  return skills.filter((skill) => skill.agents.includes(agent) && skill.name === name);
}

/** Populates every skill's `enabledByAgent` in place, given the FULL
 * discovery result (see skillsSharingName's doc comment for why ambiguity
 * must be computed from this same list, not a second query). A toggle-
 * capable agent's config read failure (malformed config.toml/opencode.json)
 * degrades every one of that agent's skills to `null` ("not toggleable")
 * rather than failing the whole listing — same "one unreadable thing
 * shouldn't take down the whole request" posture as this file's own
 * EACCES/EPERM handling. */
function attachEnabledByAgent(skills: SkillInfo[]): SkillInfo[] {
  const ambiguousNames = new Map<SkillAgent, Set<string>>();
  for (const agent of TOGGLEABLE_SKILL_AGENTS) {
    const namesSeen = new Set<string>();
    const namesAmbiguous = new Set<string>();
    for (const skill of skills) {
      if (!skill.agents.includes(agent)) continue;
      if (namesSeen.has(skill.name)) namesAmbiguous.add(skill.name);
      namesSeen.add(skill.name);
    }
    ambiguousNames.set(agent, namesAmbiguous);
  }

  const enabledMaps = new Map<SkillAgent, Map<string, boolean> | null>();
  for (const agent of TOGGLEABLE_SKILL_AGENTS) {
    if (!skills.some((skill) => skill.agents.includes(agent))) continue;
    try {
      enabledMaps.set(
        agent,
        agent === "codex" ? readCodexSkillEnabledMap() : readOpenCodeSkillEnabledMap(),
      );
    } catch {
      enabledMaps.set(agent, null);
    }
  }

  for (const skill of skills) {
    for (const agent of skill.agents) {
      if (!TOGGLEABLE_SKILL_AGENTS.includes(agent)) {
        skill.enabledByAgent[agent] = null;
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
  | { ok: false; reason: "not-found" | "ambiguous" | "not-toggleable" };

/** Validates a `{agent, name}` write request against a FRESH discovery
 * result (the route layer re-runs discovery for this, per the plan's "the
 * client never sends a path" decision — see routes/skills.ts) before ever
 * calling a writer. Refuses (never guesses) exactly the same two cases
 * `attachEnabledByAgent` already marks `null` for a GET, plus the
 * unresolvable-agent case up front. */
export function resolveSkillForToggle(
  skills: SkillInfo[],
  agent: SkillAgent,
  name: string,
): ResolveSkillForToggleResult {
  if (!TOGGLEABLE_SKILL_AGENTS.includes(agent)) return { ok: false, reason: "not-toggleable" };
  const matches = skillsSharingName(skills, agent, name);
  if (matches.length === 0) return { ok: false, reason: "not-found" };
  if (matches.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, skill: matches[0] };
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
  return attachEnabledByAgent(await scanSkillDirs(dirs));
}

/** Global + builtin skills only, no project context — GET /api/skills,
 * deliberately primary-host-only (see the plan: a remote host's global
 * skill dirs are that host's own, not the primary's; a per-host selector
 * for this endpoint is left for a follow-up rather than guessed at here). */
export async function listGlobalSkills(): Promise<SkillInfo[]> {
  const dirs = [...globalSkillDirs(), ...(await builtinSkillDirs())];
  return attachEnabledByAgent(await scanSkillDirs(dirs));
}

export class SkillNotFoundError extends Error {
  constructor(agent: SkillAgent, name: string) {
    super(`No ${agent} skill named "${name}" was found`);
    this.name = "SkillNotFoundError";
  }
}

export class SkillAmbiguousError extends Error {
  constructor(agent: SkillAgent, name: string) {
    super(
      `"${name}" matches more than one discovered ${agent} skill (different directories, same ` +
        `frontmatter name) — ${agent}'s own enable/disable selector can't target just one`,
    );
    this.name = "SkillAmbiguousError";
  }
}

export class SkillNotToggleableError extends Error {
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
    throw new SkillNotToggleableError(agent);
  }

  if (agent === "codex") {
    writeCodexSkillEnabled(name, enabled);
  } else {
    writeOpenCodeSkillEnabled(name, enabled);
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
 * and message (routes/agent-rules.ts's forwardHostRequestError forwards a
 * remote 4xx's body/status verbatim, so this is what a primary caller
 * actually sees for either topology). Returns `null` for anything this
 * function doesn't recognize — callers rethrow rather than mask an
 * unexpected error as a generic response. */
export function classifySkillToggleError(err: unknown): SkillToggleErrorClassification | null {
  if (err instanceof SkillNotFoundError) return { statusCode: 404, message: err.message };
  if (err instanceof SkillAmbiguousError) return { statusCode: 409, message: err.message };
  if (err instanceof SkillNotToggleableError) return { statusCode: 400, message: err.message };
  if (err instanceof CodexSkillUserAuthoredError) return { statusCode: 400, message: err.message };
  if (err instanceof CodexSkillsConfigParseError) return { statusCode: 400, message: err.message };
  if (err instanceof OpenCodeConfigParseError) return { statusCode: 400, message: err.message };
  if (err instanceof InvalidSkillNameError) return { statusCode: 400, message: err.message };
  return null;
}

export const __testing = {
  parseSkillFrontmatter,
  withReadDeadline,
  FS_READ_DEADLINE_MS,
  scanSkillDirs,
  attachEnabledByAgent,
};
