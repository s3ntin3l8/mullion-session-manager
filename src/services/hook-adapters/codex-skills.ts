// Issue #463 — Skills Manager, Codex enable/disable half. Writes the user's
// real `~/.codex/config.toml`, never a Mullion-owned scratch file — same
// "write the user's real config" decision the plan already made for
// hooks.json (codex.ts).
//
// Verified empirically against codex-cli 0.145.0 in a scratch CODEX_HOME
// before writing any of this (see the plan doc's verification section for
// the full transcript):
//
// 1. The selector that actually gates a skill's visibility in Codex's
//    model-visible skills list is `name` (the skill's frontmatter name), NOT
//    `path`. A `[[skills.config]]` entry keyed by `path` is accepted by the
//    TOML schema (type-checked — a non-string `path` is rejected with
//    "expected path string") but has no observed effect on visibility.
// 2. Duplicate `name` entries resolve LAST-WINS, in both directions
//    ([true, false] -> hidden; [false, true] -> shown). This is what makes
//    "flip in place if a Mullion block exists, else append a new one" safe:
//    an appended block always wins over anything earlier in the file.
// 3. An entry for a `name` that matches no discovered skill is a silent
//    no-op (confirmed: exit 0, no error, every other skill still listed) —
//    so a Mullion-marked block left behind after the user deletes the skill
//    directory it once matched is harmless litter, not a bricked config.
// 4. Codex does NOT de-duplicate skills by name across directories — two
//    distinct SKILL.md files in different directories that happen to share
//    a frontmatter `name` are BOTH discovered and BOTH toggled together by
//    one `name`-keyed entry, with no way to target just one. This module
//    only ever receives an already-disambiguated name (skills.ts's
//    attachEnabledByAgent refuses — enabledByAgent: null — before a caller
//    can even reach here); it does not re-check ambiguity itself.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { resolveCodexHome } from "./codex.js";

const MULLION_SKILL_MARKER = "# mullion-managed";

interface ParsedSkillConfigEntry {
  name?: unknown;
  enabled?: unknown;
}

/** Mirrors mergeCodexHooks' own "cannot parse, leaving it untouched"
 * posture (codex.ts) — a config.toml present but unparseable (or, on the
 * write path, an entries table that doesn't match the shape smol-toml
 * expects) must never be blindly overwritten. */
export class CodexSkillsConfigParseError extends Error {
  constructor(filePath: string, cause: unknown) {
    super(`cannot parse existing ${filePath}, leaving it untouched`, { cause });
    this.name = "CodexSkillsConfigParseError";
  }
}

/** A `name` already has a real, non-Mullion-marked `[[skills.config]]` entry
 * — refuse to manage it rather than silently overriding the user's own
 * choice (an append would win due to last-wins semantics even without
 * touching their block). Surfaced read-only in the UI, same posture as
 * codex.ts's `isMullionOwned` vs `isMullionOwnedByAnyRelease` split for
 * hooks.json. */
export class CodexSkillUserAuthoredError extends Error {
  constructor(name: string) {
    super(`skills.config already has a user-authored entry for "${name}"`);
    this.name = "CodexSkillUserAuthoredError";
  }
}

function resolveConfigTomlPath(): string {
  return path.join(resolveCodexHome(), "config.toml");
}

function readConfigTomlText(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "";
    throw new CodexSkillsConfigParseError(filePath, err);
  }
}

function parseSkillConfigEntries(filePath: string, text: string): ParsedSkillConfigEntry[] {
  if (text.length === 0) return [];
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(text) as Record<string, unknown>;
  } catch (err) {
    throw new CodexSkillsConfigParseError(filePath, err);
  }
  const skills = parsed.skills as { config?: unknown } | undefined;
  return Array.isArray(skills?.config) ? (skills.config as ParsedSkillConfigEntry[]) : [];
}

/** The authoritative enabled state for every named `skills.config` entry —
 * `name` -> `enabled`, last entry wins for a repeated name (see the file
 * header). Entries keyed by `path` are ignored: verified `path` has no
 * effect on visibility, so it can never be the thing controlling what this
 * function reports. Never throws on a missing file (no entries at all, same
 * as skills.ts's own "missing file is normal" contract) — only a genuinely
 * unparseable file propagates. */
export function readCodexSkillEnabledMap(): Map<string, boolean> {
  const filePath = resolveConfigTomlPath();
  const text = readConfigTomlText(filePath);
  const entries = parseSkillConfigEntries(filePath, text);

  const result = new Map<string, boolean>();
  for (const entry of entries) {
    if (typeof entry.name === "string" && typeof entry.enabled === "boolean") {
      result.set(entry.name, entry.enabled);
    }
  }
  return result;
}

const HEADER_LINE_RE = /^\[\[skills\.config\]\]$/;
const NAME_LINE_RE = /^\s*name\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/;
const ENABLED_LINE_RE = /^\s*enabled\s*=\s*(?:true|false)\s*$/;

function unescapeTomlBasicString(raw: string): string {
  return raw.replace(/\\(.)/g, "$1");
}

function escapeTomlBasicString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

interface MarkedBlockLocation {
  enabledLineIndex: number;
}

/** Scans raw lines for a `# mullion-managed` marker immediately followed by
 * a `[[skills.config]]` header whose block's `name` matches `targetName`,
 * and returns the index of that block's `enabled` line. smol-toml gives
 * values, not source positions, so locating the block to flip is a
 * text-level scan, not something the parse result can answer — the parse
 * result (readCodexSkillEnabledMap) is only used to decide whether a name
 * with NO marked block found is user-authored (refuse) or simply absent
 * (append). Anchored per-line, not a release/version marker (same #460
 * lesson: never embed anything that changes across Mullion upgrades). */
function findMarkedBlock(lines: string[], targetName: string): MarkedBlockLocation | null {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== MULLION_SKILL_MARKER) continue;
    const headerLineIndex = i + 1;
    if (headerLineIndex >= lines.length || !HEADER_LINE_RE.test(lines[headerLineIndex].trim())) {
      continue;
    }
    let nameLineValue: string | null = null;
    let enabledLineIndex = -1;
    for (let j = headerLineIndex + 1; j < lines.length; j++) {
      const trimmed = lines[j].trim();
      if (trimmed.startsWith("[")) break;
      const nameMatch = NAME_LINE_RE.exec(lines[j]);
      if (nameMatch) nameLineValue = unescapeTomlBasicString(nameMatch[1]);
      if (ENABLED_LINE_RE.test(lines[j])) enabledLineIndex = j;
    }
    if (nameLineValue === targetName && enabledLineIndex !== -1) {
      return { enabledLineIndex };
    }
  }
  return null;
}

/** Flips `enabled` in place inside an already Mullion-marked block for
 * `name`, or appends a brand-new marked block when none exists yet. Never
 * calls a TOML stringifier — round-tripping through smol-toml's own
 * `stringify` would drop every comment and reformat the user's hand-authored
 * file (see the plan's TOML-library research). Refuses (throws) rather than
 * writing when `name` already has a real, non-Mullion entry, or when the
 * file doesn't parse — never blind-overwrites the user's real config.toml. */
export function writeCodexSkillEnabled(name: string, enabled: boolean): void {
  const filePath = resolveConfigTomlPath();
  const text = readConfigTomlText(filePath);
  const entries = parseSkillConfigEntries(filePath, text);
  const hasExistingEntry = entries.some((e) => typeof e.name === "string" && e.name === name);

  const lines = text.length === 0 ? [] : text.split("\n");
  const location = findMarkedBlock(lines, name);

  if (location) {
    lines[location.enabledLineIndex] = `enabled = ${enabled}`;
  } else {
    if (hasExistingEntry) {
      throw new CodexSkillUserAuthoredError(name);
    }
    if (lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
    lines.push(
      MULLION_SKILL_MARKER,
      "[[skills.config]]",
      `name = "${escapeTomlBasicString(name)}"`,
      `enabled = ${enabled}`,
    );
  }

  mkdirSync(path.dirname(filePath), { recursive: true });
  let output = lines.join("\n");
  if (!output.endsWith("\n")) output += "\n";
  writeFileSync(filePath, output);
}
