// Issue #467 — Skills Manager, Claude Code enable/disable half. Two
// findings, both live-verified this session (never against the real
// `~/.claude` — a scratch HOME with a borrowed-then-immediately-deleted
// copy of the real `~/.claude/.credentials.json` so `claude -p` could
// authenticate), overturn what a static reading of Claude Code 2.1.220's
// bundle suggests:
//
// 1. The `skillOverrides` key is the skill's DIRECTORY BASENAME
//    (`path.basename(sourceDir)`), not its frontmatter `name`. Seeded a
//    probe skill whose directory name ("probe-skill-dir") and frontmatter
//    `name` ("probeFrontmatterName") deliberately differed, then asked
//    `claude -p` to report its own injected skill listing verbatim across
//    settings variants:
//      a) baseline                                         -> visible, listed as "probe-skill-dir"
//      b) skillOverrides: {"probe-skill-dir": "off"}       -> HIDDEN
//      c) skillOverrides: {"probeFrontmatterName": "off"}  -> still visible (wrong key, no effect)
//      e) skillOverrides: {"probe-skill-dir": "on"}        -> visible again (round-trip control)
//    This also confirms the write path is real for a bare
//    `~/.claude/skills/<dir>/SKILL.md` entry — it is NOT plugin-sourced
//    (plugin-sourced skills are a hard no-op for skillOverrides, per the
//    bundle's `jFe` resolver early-returning "on" for `source === "plugin"`
//    — that's exactly Mullion's own `builtin` scope for claude-code, see
//    skills.ts's attachEnabledByAgent, which never calls this module's
//    writer for a builtin-scope skill).
//
// 2. When two discovered SkillInfo rows (e.g. a project-scope and a
//    global-scope skill) share the same directory basename, Claude Code
//    loads only ONE of them — reproducibly the global one, across two
//    separate live runs — the other is genuinely invisible to the model,
//    not "also toggled together" the way Codex/opencode's frontmatter-name
//    collision works (both of theirs really do get flipped by one write). A
//    third, unconfounded probe (a uniquely-named project-only skill with no
//    global counterpart) confirmed project-scope skills genuinely load from
//    `<cwd>/.claude/skills` when there's no collision, and that `-p` mode's
//    documented trust-dialog skip isn't what suppressed the project-scope
//    entry — this is real basename shadowing at discovery time. See
//    skills.ts's resolveSkillForToggle / attachEnabledByAgent, which compute
//    this collision from the same discovery result a GET already returned.
//
// `~/.claude/settings.json`'s `skillOverrides` merges across scopes with
// project taking precedence over user (`projectSettings?.skillOverrides?.[x]
// ?? userSettings?.skillOverrides?.[x]`, per the installed bundle) — so a
// user-scope write here can be silently ineffective when a project-scope
// entry already exists for the same basename; see
// ClaudeCodeSkillProjectOverrideError.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertSafeSkillName, isDangerousSkillName, InvalidSkillNameError } from "./skill-name.js";

const SKILL_OVERRIDE_VALUES = ["on", "name-only", "user-invocable-only", "off"] as const;
type ClaudeCodeSkillOverrideValue = (typeof SKILL_OVERRIDE_VALUES)[number];

function isSkillOverrideValue(value: unknown): value is ClaudeCodeSkillOverrideValue {
  return typeof value === "string" && (SKILL_OVERRIDE_VALUES as readonly string[]).includes(value);
}

export class ClaudeCodeSettingsParseError extends Error {
  constructor(filePath: string, cause: unknown) {
    super(`cannot parse existing ${filePath}, leaving it untouched`, { cause });
    this.name = "ClaudeCodeSettingsParseError";
  }
}

/** `basename` already has a `skillOverrides` value Mullion's boolean can't
 * represent (`"name-only"` / `"user-invocable-only"`) — a real, deliberate
 * choice, not ambiguous or missing state. Refuse rather than clobber it,
 * same posture as Codex/opencode's own *UserAuthoredError classes. */
export class ClaudeCodeSkillUserAuthoredError extends Error {
  constructor(basename: string, value: string) {
    super(
      `"${basename}" already has a skillOverrides value ("${value}") Mullion's on/off toggle ` +
        `can't represent — refusing to overwrite it`,
    );
    this.name = "ClaudeCodeSkillUserAuthoredError";
  }
}

/** A project-scope settings file already has an entry for `basename`.
 * Claude Code's own project-over-user precedence means a write to the
 * user-scope file this module targets would be silently ineffective on the
 * next read — refuse rather than write something that looks like it
 * succeeded but changes nothing observable. */
export class ClaudeCodeSkillProjectOverrideError extends Error {
  constructor(basename: string) {
    super(
      `"${basename}" already has a project-scope skillOverrides entry, which takes precedence ` +
        `over the user-scope settings.json Mullion writes to — toggling here would have no effect`,
    );
    this.name = "ClaudeCodeSkillProjectOverrideError";
  }
}

/** Two discovered skills (e.g. a project-scope and a global-scope one)
 * share a directory basename. Claude Code's `skillOverrides` selector is
 * that basename, and live verification this session showed it loads only
 * ONE of two same-basename skills at all — the other is invisible to the
 * model, so a toggle can't be reliably attributed to either row. */
export class ClaudeCodeSkillBasenameCollisionError extends Error {
  constructor(name: string) {
    super(
      `"${name}"'s skill directory shares its name with another discovered Claude Code skill in a ` +
        `different scope — Claude Code loads only one of them and Mullion can't tell which, so ` +
        `neither is toggleable`,
    );
    this.name = "ClaudeCodeSkillBasenameCollisionError";
  }
}

/** The matched skill lives under an installed plugin's directory
 * (Mullion's own `builtin` scope for claude-code). `skillOverrides` is a
 * hard no-op for plugin-sourced skills — Claude Code's bundle early-returns
 * "on" for anything with `source === "plugin"` without ever consulting it —
 * so there is no write this module could make that would have any effect. */
export class ClaudeCodeSkillPluginSourcedError extends Error {
  constructor(name: string) {
    super(
      `"${name}" is provided by an installed plugin — Claude Code has no per-skill override for ` +
        `plugin-sourced skills; disable the containing plugin instead (e.g. "claude plugin disable")`,
    );
    this.name = "ClaudeCodeSkillPluginSourcedError";
  }
}

function resolveUserSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

function parseSettingsJson(filePath: string, text: string): Record<string, unknown> {
  if (text.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ClaudeCodeSettingsParseError(filePath, err);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ClaudeCodeSettingsParseError(filePath, new Error("top level must be an object"));
  }
  return parsed as Record<string, unknown>;
}

function extractSkillOverrides(config: Record<string, unknown>): Record<string, unknown> {
  const overrides = config.skillOverrides;
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) return {};
  return overrides as Record<string, unknown>;
}

/** Untainted: `resolveUserSettingsPath()` never depends on caller input, so
 * this generic reader is safe for the user-scope file — it is never called
 * with a project-scope (cwd-derived) path. Project-scope reads deliberately
 * do NOT go through this function — see `readProjectSkillOverrides` below
 * for why. */
function readUserSettingsJson(filePath: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    throw new ClaudeCodeSettingsParseError(filePath, err);
  }
  return parseSettingsJson(filePath, text);
}

/** Resolves, validates, AND reads a project-scope settings file in one
 * function body — deliberately NOT split into a "resolve a validated path"
 * producer plus a separate generic "read this path" consumer (an earlier
 * version of this file was structured that way and CodeQL's
 * `js/path-injection` query still flagged the read, issue #467's own CI run:
 * the validating function and the `readFileSync` sink were in different
 * functions, and the sink function was also called from other sites with
 * varying taint status, so the query couldn't attribute the barrier to this
 * specific call path). This instead mirrors `agent-rules.ts`'s
 * `resolveTargetPath` callers exactly: the containment check and the fs sink
 * live in the same function, close enough that the query's dataflow
 * analysis recognizes the check as a real barrier — "compute the exact value
 * once, validate THAT value, use THAT SAME value unchanged," with no
 * cross-function hop for the tainted `cwd` in between. `fileName` is always
 * one of two fixed literals, never caller-supplied. */
function readProjectSkillOverrides(
  cwd: string,
  fileName: "settings.json" | "settings.local.json",
): Record<string, unknown> {
  const dir = path.resolve(path.join(cwd, ".claude"));
  const resolved = path.join(dir, fileName);
  const withinDir = resolved === dir || resolved.startsWith(dir + path.sep);
  if (!withinDir) {
    throw new Error(`Refusing to build a path outside its project directory: ${fileName}`);
  }

  let text: string;
  try {
    text = readFileSync(resolved, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    throw new ClaudeCodeSettingsParseError(resolved, err);
  }
  return extractSkillOverrides(parseSettingsJson(resolved, text));
}

/** Project-scope settings files, in ASCENDING precedence order (later
 * entries win) — `settings.json` is the shared, checked-in file;
 * `settings.local.json` is the personal, gitignored override, the same
 * "local wins over shared" convention this repo's own
 * `.claude/settings.local.json` follows. */
function readProjectSkillOverridesInOrder(cwd: string): Record<string, unknown>[] {
  return [
    readProjectSkillOverrides(cwd, "settings.json"),
    readProjectSkillOverrides(cwd, "settings.local.json"),
  ];
}

/** Effective (project-shadows-user) `skillOverrides` state for every
 * basename mentioned anywhere across user + project scope, keyed by
 * directory basename — used by `attachEnabledByAgent`, which only calls
 * this when a project `cwd` is available (see that function's own comment
 * on why a cwd-less global listing degrades every claude-code skill to
 * `null` instead of calling this at all: without `cwd`, a project-scope
 * entry that would shadow whatever this reports can't be ruled out).
 *
 * Value is `boolean` when representable (`"on"`/absent -> `true`, `"off"`
 * -> `false`) or `null` when the real value is `"name-only"` /
 * `"user-invocable-only"` — a real, deliberate choice, distinct from "not
 * toggleable." Returns every raw key found (not just ones some caller
 * already knows about), same completeness posture as the Codex/opencode
 * readers. */
export function readClaudeCodeSkillEnabledMap(cwd: string): Map<string, boolean | null> {
  const raw = new Map<string, ClaudeCodeSkillOverrideValue>();
  const allOverrides = [
    extractSkillOverrides(readUserSettingsJson(resolveUserSettingsPath())),
    ...readProjectSkillOverridesInOrder(cwd),
  ];
  for (const overrides of allOverrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (isSkillOverrideValue(value)) raw.set(key, value);
    }
  }
  const result = new Map<string, boolean | null>();
  for (const [key, value] of raw) {
    if (value === "off") result.set(key, false);
    else if (value === "on") result.set(key, true);
    else result.set(key, null); // "name-only" / "user-invocable-only"
  }
  return result;
}

/** Read-modify-write `~/.claude/settings.json`'s `skillOverrides[dirBasename]`
 * — see this file's header for why the key is the directory basename, not
 * the skill's frontmatter name. No atomic write / temp file / rename,
 * matching codex-skills.ts / opencode-skills.ts exactly.
 *
 * `enabled: true` DELETES the key (absent = "on", matching
 * writeOpenCodeSkillEnabled's reasoning — an explicit "on" would look
 * user-authored on a later read) unless the current value isn't exactly
 * "off" (then it's left alone: not this writer's own state to touch).
 * `enabled: false` writes "off", refusing
 * (ClaudeCodeSkillUserAuthoredError) over an existing "name-only" /
 * "user-invocable-only" entry.
 *
 * Refuses (ClaudeCodeSkillProjectOverrideError) whenever EITHER project
 * settings file already has any entry for this basename — see that error's
 * own doc comment. */
export function writeClaudeCodeSkillEnabled(
  cwd: string,
  dirBasename: string,
  enabled: boolean,
): void {
  assertSafeSkillName(dirBasename);

  for (const overrides of readProjectSkillOverridesInOrder(cwd)) {
    const existing = overrides[dirBasename];
    if (isSkillOverrideValue(existing)) {
      throw new ClaudeCodeSkillProjectOverrideError(dirBasename);
    }
  }

  const filePath = resolveUserSettingsPath();
  const config = readUserSettingsJson(filePath);
  const existingOverrides = extractSkillOverrides(config);

  // CodeQL (js/remote-property-injection) — assertSafeSkillName above alone
  // was not recognized as a barrier guarding the dynamic property accesses
  // below in PR #469's equivalent writers; the same check is repeated here,
  // inline, immediately dominating the sink. Object.create(null) is
  // additional structural defense — a null-prototype object has no
  // `__proto__` accessor for even an unvalidated key to reach.
  if (isDangerousSkillName(dirBasename)) throw new InvalidSkillNameError(dirBasename);
  const overrides: Record<string, unknown> = Object.assign(Object.create(null), existingOverrides);

  if (enabled) {
    // Only delete when the current value is EXACTLY "off", the one value
    // this writer itself ever produces — an explicit "on" or an
    // unrepresentable value the disable path already refused to touch is
    // left alone, same posture as writeOpenCodeSkillEnabled's own enable
    // path.
    if (overrides[dirBasename] === "off") delete overrides[dirBasename];
  } else {
    const current = overrides[dirBasename];
    if (isSkillOverrideValue(current) && current !== "off" && current !== "on") {
      throw new ClaudeCodeSkillUserAuthoredError(dirBasename, current);
    }
    overrides[dirBasename] = "off";
  }

  const merged = { ...config, skillOverrides: overrides };
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(merged, null, 2)}\n`);
}
