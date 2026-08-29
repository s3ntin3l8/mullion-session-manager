import path from "node:path";
import { upsertMarkedRegion } from "./marked-region.js";
import { MARKER_START, MARKER_END } from "./project-briefing.js";
import { isDangerousSkillName } from "./hook-adapters/skill-name.js";
import type { DockControl } from "./project-config.js";

// PR-6 (scaffold Mullion integration as a PR) — the zero-repo-change
// delivery mechanisms PR-1 through PR-5 built (the shipped bundle,
// per-project skills/reviewer authored from the UI) only ever apply
// Mullion's own tooling automatically; the FEATURES they deliver — a
// project's own briefing region, a project's own skill, a project's own
// reviewer subagent — still need somewhere to live if a repo wants them
// committed and shared with the team rather than authored per-project in
// Mullion's own UI (project-tooling.ts). This module computes exactly
// those files, as plain data, with NO filesystem access of its own — the
// caller (routes/project-setup.ts) is responsible for reading
// `existingFiles` off disk (or a remote host, once issue #895 lands) and
// for actually writing `ScaffoldEntry[]` into a real worktree before
// diffing/committing it. Pure in, pure out: the exact same call with the
// exact same inputs always produces the exact same output, which is what
// lets the setup route's own preview/apply split be provably the same
// bytes (preview computes and shows this array; apply recomputes it
// against the SAME inputs it read for preview and writes it — see that
// route's own doc comment for how a stale preview is rejected instead of
// silently re-diffing against contents that already changed underneath
// it).

export class InvalidScaffoldSlugError extends Error {
  constructor(slug: string) {
    super(`"${slug}" is not a safe slug for a scaffolded project`);
    this.name = "InvalidScaffoldSlugError";
  }
}

/** A slug becomes multiple path segments below (`.claude/skills/<slug>/`,
 * `.claude/agents/<slug>-reviewer.md`, `.agents/skills/<slug>/`) — reuses
 * hook-adapters/skill-name.ts's own guard (path separators, `.`/`..`,
 * control characters, dangerous object-key names) rather than a second,
 * independently-drifting validator for the same "safe to join into a
 * path" property PR-5 already had to get right for the same reason. */
export function isValidScaffoldSlug(slug: string): boolean {
  return slug.length > 0 && !isDangerousSkillName(slug);
}

export interface ScaffoldOptions {
  /** Names the project's own skill (`.claude/skills/<slug>/SKILL.md`,
   * `.agents/skills/<slug>/SKILL.md`) and reviewer subagent
   * (`.claude/agents/<slug>-reviewer.md`) — and appears in the scaffolded
   * AGENTS.md briefing region's pointer text. Validated by the caller
   * (routes/project-setup.ts) via isValidScaffoldSlug before this module
   * ever sees it; computeScaffold itself still throws
   * InvalidScaffoldSlugError rather than silently emitting an unsafe path,
   * since a pure function's own caller-independence is the whole point of
   * writing it this way. */
  slug: string;
  /** Which byte-identical mirrors of AGENTS.md's briefing region to also
   * write/update — see docs on `scripts/check-briefing-sync.mjs` for why
   * these must carry the EXACT same region content as AGENTS.md, never a
   * per-file variation. Empty/absent: AGENTS.md only, no sync script. */
  mirrors?: Array<"GEMINI.md" | "AGENTS.override.md">;
  /** Default false: `.agents/skills/<slug>/SKILL.md` is a plain file
   * carrying the SAME content as `.claude/skills/<slug>/SKILL.md` (codex's
   * and agy's own project-scope skill discovery — see the plan's S6 spike:
   * both read a workspace-relative `.agents/skills/<slug>/SKILL.md`, not a
   * home-relative one). Set true to make it a real symlink into
   * `.claude/skills/<slug>` instead — this repo does that for itself, but
   * a symlink is a review-hostile diff, breaks on a Windows checkout
   * without `core.symlinks`, and trips some CI file scanners, so a
   * SCAFFOLD imposing that choice on someone else's repo needs to be an
   * explicit opt-in, not the default (plan's own PR-6 section). */
  symlinkAgentsSkills?: boolean;
  /** Default false: also scaffold an empty `.crs/dock.json`
   * (`{"controls": []}`, dock-config.ts's own writeDockConfig format) —
   * a harmless, valid starting point per docs/dock.md's own Quick Start,
   * left empty because this module has no way to know what commands are
   * actually useful for an arbitrary target repo; guessing wrong would be
   * worse than an empty file the project can hand-edit. */
  includeDockConfig?: boolean;
}

export type ScaffoldEntry =
  | { path: string; kind: "file"; contents: string }
  | { path: string; kind: "symlink"; target: string };

const SKILL_TEMPLATE_BODY = (slug: string) => `# ${slug}

This is a starter skill scaffolded by Mullion. Replace the placeholder
section below with this repository's own non-obvious correctness rules —
the kind of mistake that looks reasonable in isolation but breaks an
assumption another part of the codebase depends on.

## (Replace this section with a real invariant)

Describe an invariant here: what it is, why it exists, and the "red flag"
pattern a reviewer should watch for when it's violated.

## Test conventions

(Describe where tests live, what running them looks like, and any
non-obvious test-isolation rules this repo relies on.)
`;

function skillFileContents(slug: string): string {
  return (
    `---\n` +
    `name: ${slug}\n` +
    `description: "Repo-specific correctness invariants for this codebase — read this before reviewing or writing a diff here. Replace this description with a short sentence naming the actual invariants below."\n` +
    `---\n\n${SKILL_TEMPLATE_BODY(slug)}`
  );
}

function reviewerAgentFileContents(slug: string): string {
  return (
    `---\n` +
    `name: ${slug}-reviewer\n` +
    `description: "Review a diff or PR in this repo for correctness against this repo's own domain invariants, not just general code quality. Use this before declaring a change done, or when asked for a review pass specific to this codebase."\n` +
    `tools: Read, Grep, Glob, Bash\n` +
    `model: inherit\n` +
    `---\n\n` +
    `You are reviewing a change in this repository. Your job is to catch\n` +
    `violations of this repo's own domain invariants — the kind of mistake\n` +
    `that looks reasonable in isolation but breaks an assumption another part\n` +
    `of the codebase depends on. Read \`.claude/skills/${slug}/SKILL.md\` first;\n` +
    `it's the compact checklist this review is built on.\n\n` +
    `## What to check, in order\n\n` +
    `1. (Replace this with your repo's own invariants.)\n` +
    `2. **General correctness and test coverage** — the things any careful\n` +
    `   reviewer checks regardless of repo: does the diff do what it claims,\n` +
    `   are edge cases covered, do the new/changed tests actually exercise the\n` +
    `   changed behavior rather than just asserting it doesn't throw.\n\n` +
    `## How to report\n\n` +
    `For each finding: file, line if applicable, what's wrong, and — for\n` +
    `invariant violations specifically — which invariant it breaks and why\n` +
    `that matters. If you find nothing, say so plainly rather than\n` +
    `manufacturing a nitpick to seem thorough.\n`
  );
}

function briefingRegionBody(slug: string): string {
  return (
    `This repository uses [Mullion](https://github.com/s3ntin3l8/mullion-session-manager)\n` +
    `to run AI coding agents. A project-specific skill and reviewer subagent for\n` +
    `this repo live at \`.claude/skills/${slug}/SKILL.md\` and\n` +
    `\`.claude/agents/${slug}-reviewer.md\` — read the skill before making\n` +
    `changes, and use the reviewer subagent (or \`/code-review\`) before\n` +
    `declaring a change done.`
  );
}

// Byte-for-byte the same script this repo ships at scripts/check-briefing-
// sync.mjs — already fully generic (self-locating root, no repo-specific
// path baked in — verified this session before writing this module), so
// it's copied verbatim rather than templated.
const CHECK_BRIEFING_SYNC_SCRIPT = `#!/usr/bin/env node
// Verifies every briefing-carrying file (AGENTS.md, GEMINI.md, and
// AGENTS.override.md when present) carries the exact same
// mullion:briefing region — an out-of-sync region silently shadows
// whatever AGENTS.md says for whichever agent reads the OTHER file
// instead. Scaffolded by Mullion; safe to edit or remove once this
// project no longer needs multiple briefing-carrying files kept in sync.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.BRIEFING_SYNC_ROOT ?? path.resolve(scriptDir, "..");

const START = "<!-- mullion:briefing:start -->";
const END = "<!-- mullion:briefing:end -->";

function extractRegion(text) {
  const startIdx = text.indexOf(START);
  if (startIdx === -1) return null;
  const contentStart = startIdx + START.length;
  const endIdx = text.indexOf(END, contentStart);
  if (endIdx === -1) return null;
  return text.slice(contentStart, endIdx).trim();
}

const FILES = ["AGENTS.md", "GEMINI.md"];
if (existsSync(path.join(root, "AGENTS.override.md"))) {
  FILES.push("AGENTS.override.md");
}

let firstRegion = null;
let firstFile = null;
let failed = false;

for (const file of FILES) {
  const filePath = path.join(root, file);
  if (!existsSync(filePath)) continue;
  const text = readFileSync(filePath, "utf8");
  const region = extractRegion(text);
  if (region === null) {
    console.error(\`\${file}: no mullion:briefing region found\`);
    failed = true;
    continue;
  }
  if (firstRegion === null) {
    firstRegion = region;
    firstFile = file;
    continue;
  }
  if (region !== firstRegion) {
    console.error(\`\${file}: briefing region does not match \${firstFile}\`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}
console.log(\`OK — \${FILES.filter((f) => existsSync(path.join(root, f))).join(", ")} carry identical briefing regions.\`);
`;

/**
 * Computes the target file set for scaffolding Mullion's tooling into a
 * project — pure, no I/O (see this module's own header for the full
 * "preview and apply are provably the same bytes" reasoning). `existingFiles`
 * is keyed by repo-relative path; a path absent from the map (or mapped to
 * `undefined`) means "this file doesn't exist yet" — computeScaffold
 * creates it fresh (a bare region for AGENTS.md, a full starter file for
 * everything else) rather than requiring the caller to pre-populate every
 * possible path with an empty string.
 *
 * Always returns at least AGENTS.md, the two `.claude/` starter files, and
 * `.agents/skills/<slug>` — the entries `ScaffoldOptions` genuinely make
 * optional (mirrors, the sync script, `.crs/dock.json`) are the only ones
 * that can be absent from the result.
 */
export function computeScaffold(
  existingFiles: Record<string, string | undefined>,
  options: ScaffoldOptions,
): ScaffoldEntry[] {
  if (!isValidScaffoldSlug(options.slug)) {
    throw new InvalidScaffoldSlugError(options.slug);
  }
  const { slug } = options;
  const entries: ScaffoldEntry[] = [];

  const region = briefingRegionBody(slug);
  const briefingTargets = ["AGENTS.md", ...(options.mirrors ?? [])];
  for (const target of briefingTargets) {
    const existing = existingFiles[target] ?? "";
    entries.push({
      path: target,
      kind: "file",
      contents: upsertMarkedRegion(existing, MARKER_START, MARKER_END, region),
    });
  }

  entries.push({
    path: path.join(".claude", "skills", slug, "SKILL.md"),
    kind: "file",
    contents: skillFileContents(slug),
  });
  entries.push({
    path: path.join(".claude", "agents", `${slug}-reviewer.md`),
    kind: "file",
    contents: reviewerAgentFileContents(slug),
  });

  if (options.symlinkAgentsSkills) {
    entries.push({
      path: path.join(".agents", "skills", slug),
      kind: "symlink",
      // Relative from `.agents/skills/<slug>` (three path segments deep)
      // back up to the repo root, then down into `.claude/skills/<slug>` —
      // relative, not absolute, so the symlink resolves correctly
      // regardless of where the repo is checked out.
      target: path.join("..", "..", "..", ".claude", "skills", slug),
    });
  } else {
    entries.push({
      path: path.join(".agents", "skills", slug, "SKILL.md"),
      kind: "file",
      contents: skillFileContents(slug),
    });
  }

  if ((options.mirrors?.length ?? 0) > 0) {
    entries.push({
      path: path.join("scripts", "check-briefing-sync.mjs"),
      kind: "file",
      contents: CHECK_BRIEFING_SYNC_SCRIPT,
    });
  }

  if (options.includeDockConfig) {
    const emptyControls: DockControl[] = [];
    entries.push({
      path: path.join(".crs", "dock.json"),
      kind: "file",
      contents: JSON.stringify({ controls: emptyControls }, null, 2) + "\n",
    });
  }

  return entries;
}
