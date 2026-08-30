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
import { assertSafeSkillName, isDangerousSkillName, InvalidSkillNameError } from "./skill-name.js";
import { escapeTomlBasicString } from "./shared.js";

// Hermes review, PR #469 — flagged that a user-authored comment reading
// exactly this string, immediately above the user's own `[[skills.config]]`
// block, is indistinguishable from a block Mullion wrote and would be
// treated (and flipped) as Mullion's own. No text marker can fully rule
// this out — the same accepted tradeoff applies to `isMullionOwned`'s
// substring match in codex.ts. Kept deliberately specific (not just
// "# managed") to make an accidental real-world collision exceedingly
// unlikely; a colliding block is also recoverable (the user's `enabled`
// value gets flipped, not deleted or corrupted).
const MULLION_SKILL_MARKER = "# mullion-managed — written by Mullion's Skills Manager, do not edit";

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

// Hermes review, PR #469 — all three were originally anchored with a bare
// `\s*$`, requiring nothing but whitespace after the value. TOML allows a
// trailing `# comment` after any value on its own line (smol-toml parses
// `name = "foo"  # note` identically to `name = "foo"`, verified directly).
// A user who adds an inline comment to a Mullion-managed line — a
// completely ordinary thing to do to a file you're allowed to hand-edit —
// used to make `findMarkedBlock` miss its own block: smol-toml still
// reports the entry (`hasExistingEntry` true) but the line-scan doesn't
// recognize it as Mullion's, so the write throws
// CodexSkillUserAuthoredError against a block Mullion itself wrote (same
// misjudgment class as the #460 ownership-predicate lesson). All three are
// now comment-tolerant.
const HEADER_LINE_RE = /^\[\[skills\.config\]\]\s*(?:#.*)?$/;
const NAME_LINE_RE = /^\s*name\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/;
// Captures the leading `enabled = ` prefix (group 1) and any trailing
// whitespace/comment (group 2) separately from the boolean itself, so a
// flip can preserve both rather than clobbering a user-added comment.
const ENABLED_LINE_RE = /^(\s*enabled\s*=\s*)(?:true|false)(\s*(?:#.*)?)$/;

interface SkillConfigBlock {
  name: string | null;
  isMarked: boolean;
  enabledLineIndex: number;
  enabledLinePrefix: string;
  enabledLineSuffix: string;
}

/** Scans every `[[skills.config]]` block in file order — marked or not — so
 * callers can reason about which entry actually WINS (last-wins, verified
 * empirically — see the file header) rather than just which one is
 * Mullion's. Hermes review, PR #469: `findMarkedBlock`'s original
 * first-match-wins scan could locate and flip Mullion's own block even when
 * a LATER, non-Mullion entry for the same name existed further down the
 * file — Codex would still obey that later entry (last-wins), so the flip
 * silently had no effect on what the model actually sees. Determining the
 * winner requires visiting every block for a name in order, not just the
 * first Mullion-marked one. */
function scanSkillConfigBlocks(lines: string[]): SkillConfigBlock[] {
  const blocks: SkillConfigBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    // Hermes review, PR #469, round 3 — prefix match rather than exact
    // equality, for symmetry with the value-line regexes' own comment
    // tolerance. The marker line is already a full-line comment, so any
    // trailing text a user appends (e.g. extending the note) is just more
    // comment content, not a real trailing `# comment` — no separate `#` is
    // needed the way there is on a `name = "foo"` value line.
    const isMarked = lines[i].trim().startsWith(MULLION_SKILL_MARKER);
    const headerLineIndex = isMarked ? i + 1 : i;
    if (headerLineIndex >= lines.length || !HEADER_LINE_RE.test(lines[headerLineIndex].trim())) {
      continue;
    }
    let nameLineValue: string | null = null;
    let enabledMatch: RegExpExecArray | null = null;
    let enabledLineIndex = -1;
    for (let j = headerLineIndex + 1; j < lines.length; j++) {
      const trimmed = lines[j].trim();
      if (trimmed.startsWith("[")) break;
      const nameMatch = NAME_LINE_RE.exec(lines[j]);
      if (nameMatch) nameLineValue = unescapeTomlBasicString(nameMatch[1]);
      const match = ENABLED_LINE_RE.exec(lines[j]);
      if (match) {
        enabledMatch = match;
        enabledLineIndex = j;
      }
    }
    if (enabledMatch) {
      blocks.push({
        name: nameLineValue,
        isMarked,
        enabledLineIndex,
        enabledLinePrefix: enabledMatch[1],
        enabledLineSuffix: enabledMatch[2],
      });
    }
    // The header line itself was already consumed as part of this block —
    // without this, the next iteration re-visits it and misreads it as a
    // second, unmarked block start for the same entry (isMarked would be
    // false since the header line isn't the marker text), producing a
    // phantom duplicate that always "wins" as the last-scanned match.
    i = headerLineIndex;
  }
  return blocks;
}

function unescapeTomlBasicString(raw: string): string {
  return raw.replace(/\\(.)/g, "$1");
}

/** Flips `enabled` in place inside the WINNING Mullion-marked block for
 * `name`, or appends a brand-new marked block when no entry exists yet.
 * Never calls a TOML stringifier — round-tripping through smol-toml's own
 * `stringify` would drop every comment and reformat the user's hand-authored
 * file (see the plan's TOML-library research). Refuses (throws) rather than
 * writing when `name` already has a real, non-Mullion entry — including when
 * that entry is a LATER, non-marked block that would win over an earlier
 * Mullion block under last-wins (Hermes review, PR #469: the original
 * first-marked-block-wins scan could flip a Mullion block that a later
 * user-authored duplicate had already overridden, silently writing a change
 * Codex would never actually observe) — or when the file doesn't parse.
 * `hasExistingEntry` comes from the authoritative smol-toml parse (catches
 * any TOML string syntax); `scanSkillConfigBlocks` is a text-level scan used
 * only to locate which block wins and whether it's ours, since smol-toml
 * gives values, not source positions. If the parse sees an entry the
 * line-scan cannot locate at all (unrecognized formatting), that is treated
 * the same as an unmanaged user entry — refuse rather than guess. */
export function writeCodexSkillEnabled(name: string, enabled: boolean): void {
  assertSafeSkillName(name);
  const filePath = resolveConfigTomlPath();
  const text = readConfigTomlText(filePath);
  const entries = parseSkillConfigEntries(filePath, text);
  const hasExistingEntry = entries.some((e) => typeof e.name === "string" && e.name === name);

  const lines = text.length === 0 ? [] : text.split("\n");
  const matchingBlocks = scanSkillConfigBlocks(lines).filter((b) => b.name === name);
  const winner = matchingBlocks.length > 0 ? matchingBlocks[matchingBlocks.length - 1] : null;

  if (winner && winner.isMarked) {
    lines[winner.enabledLineIndex] =
      `${winner.enabledLinePrefix}${enabled}${winner.enabledLineSuffix}`;
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

  // CodeQL (network data written to file) — a call to assertSafeSkillName
  // at the top of this function alone was not recognized as a barrier
  // guarding this write, so the same check is repeated here, inline,
  // immediately dominating it. Redundant with the earlier call in the
  // success path, but this is what actually satisfies the taint-tracking
  // query for the write itself.
  if (isDangerousSkillName(name)) throw new InvalidSkillNameError(name);
  mkdirSync(path.dirname(filePath), { recursive: true });
  let output = lines.join("\n");
  if (!output.endsWith("\n")) output += "\n";
  writeFileSync(filePath, output);
}
