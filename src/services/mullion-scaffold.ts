import path from "node:path";
import { upsertMarkedRegion } from "./marked-region.js";
import { MARKER_START, MARKER_END } from "./project-briefing.js";
import { isDangerousSkillName } from "./hook-adapters/skill-name.js";
import type { DockControl } from "./project-config.js";

// Issue #942 — a SEPARATE marker pair from MARKER_START/MARKER_END above:
// those wrap a full mirrored copy of AGENTS.md's own briefing region (the
// thing this issue is retiring), while these wrap a one-line POINTER back
// to AGENTS.md instead. Reusing the same markers for both would make
// CHECK_BRIEFING_SYNC_SCRIPT's own "does this file re-acquire a
// mullion:briefing region" guard fire on every scaffolded GEMINI.md just
// for carrying the pointer it's SUPPOSED to carry — a new, distinct pair
// keeps "a full mirror reappeared" (bad) and "the pointer this scaffold
// itself wrote is present" (expected) unambiguous. Exported so tests (and
// this repo's own committed GEMINI.md, which has to use the identical
// literal) never risk drifting from a hardcoded copy of these strings.
export const POINTER_MARKER_START = "<!-- mullion:pointer:start -->";
export const POINTER_MARKER_END = "<!-- mullion:pointer:end -->";

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
  /** Issue #942 — was `Array<"GEMINI.md" | "AGENTS.override.md">`, each
   * mirror carrying a byte-identical copy of AGENTS.md's own briefing
   * region (kept in sync by `scripts/check-briefing-sync.mjs`).
   * `AGENTS.override.md` is no longer offered at all — per-agent
   * precedence (`src/services/agent-rules.ts`) lets it silently shadow
   * AGENTS.md for Codex, and this scaffold shouldn't hand a target repo a
   * second file with that footgun built in (an existing hand-authored
   * override is untouched; this only stops the scaffold from creating new
   * ones). `GEMINI.md`, when opted in, is now a one-line POINTER to
   * AGENTS.md, not a content mirror — see `agentsMdPointerBody` below —
   * so there's nothing left to keep byte-identical. */
  mirrors?: Array<"GEMINI.md">;
  /** Issue #942 — optional, opt-in only (a checkbox, never a default-on
   * mirror, since `CONTRIBUTING.md` is a human/GitHub convention Mullion
   * has no functional need to touch): upserts a short pointer paragraph
   * ("see AGENTS.md's Workflow Conventions section...") into
   * `CONTRIBUTING.md`, via the same marked-region upsert mechanism as
   * `GEMINI.md`'s pointer above — never the whole file, never touching
   * anything outside the marked region, so an existing Code-of-Conduct/
   * dev-setup file is left completely alone. Creates a fresh
   * `CONTRIBUTING.md` (pointer only) when the option is on and none
   * exists yet; when the option is off, `CONTRIBUTING.md` is never
   * created or touched, existing or not. */
  includeContributingPointer?: boolean;
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

// Issue #942 — GEMINI.md is no longer a content mirror; it's a one-line
// pointer back to AGENTS.md, the single source of truth every CLI already
// reads natively.
function agentsMdPointerBody(): string {
  return "Read `AGENTS.md`.";
}

// Issue #942 — CONTRIBUTING.md's process-rules section (branch conventions,
// PR title format, merge strategy, review process) genuinely overlaps with
// AGENTS.md's Workflow Conventions section (issue #937) — left
// independently maintained, the two drift the same way CLAUDE.md/GEMINI.md
// did before this issue. Pointer paragraph only, never the whole file.
function contributingPointerBody(): string {
  return "See `AGENTS.md`'s Workflow Conventions section for our process rules.";
}

/** Removes a pre-#942 byte-identical mirror region (the `MARKER_START`/
 * `MARKER_END` pair a scaffold used to write into `GEMINI.md`) before the
 * new pointer region is upserted into what's left. Without this, a
 * re-scaffold over a project that already adopted the old mirror option
 * would APPEND the new pointer region below the stale full-mirror content
 * instead of replacing it — and the freshly (re-)scaffolded
 * `check-briefing-sync.mjs` would then immediately fail against the very
 * `GEMINI.md` this scaffold just wrote, since that script fails the moment
 * `GEMINI.md` carries ANY `mullion:briefing:start/end` region at all. A
 * no-op when the old markers aren't present — the ordinary, post-#942
 * case. */
function stripLegacyBriefingMirror(text: string): string {
  const startIdx = text.indexOf(MARKER_START);
  if (startIdx === -1) return text;
  const endIdx = text.indexOf(MARKER_END, startIdx + MARKER_START.length);
  if (endIdx === -1) return text;
  return text.slice(0, startIdx) + text.slice(endIdx + MARKER_END.length);
}

// Functionally equivalent to the script this repo (Mullion) ships at
// scripts/check-briefing-sync.mjs — NOT byte-identical: that version's own
// header comments cite Mullion's own issue history (#716, #942), which has
// no meaning in a target repo this scaffold writes into. Both scripts guard
// the identical invariant: AGENTS.md is the single source of truth for the
// tier-1 briefing region, and neither GEMINI.md (now a plain pointer) nor
// an AGENTS.override.md (no longer offered by this scaffold at all, but
// not something Mullion can stop someone from hand-creating) should ever
// re-acquire a content-bearing copy of that region — Codex reads
// AGENTS.override.md *instead of* AGENTS.md when it exists
// (src/services/agent-rules.ts's precedence table), so a content-bearing
// copy there silently shadows the real briefing, and a content-bearing
// GEMINI.md just invites the two to drift again.
const CHECK_BRIEFING_SYNC_SCRIPT = `#!/usr/bin/env node
// Guards against a content-bearing mirror or override reappearing once
// AGENTS.md leads. AGENTS.md is this repo's single source of truth for the
// tier-1 briefing region; GEMINI.md is meant to stay a one-line pointer to
// it, and AGENTS.override.md (Codex reads it *instead of* AGENTS.md when it
// exists) is the one file that can still silently shadow AGENTS.md
// entirely. This fails loud the moment either file re-acquires its own
// \`<!-- mullion:briefing:start/end -->\` region — it does NOT compare region
// contents for equality; presence alone is the problem now. Deliberately
// does NOT check that AGENTS.md itself still has a region at all: that
// region is purely a scaffold upsert boundary here, not something anything
// reads back, so a project that hand-writes AGENTS.md without markers is
// not a regression this needs to catch. Scaffolded by Mullion; safe to
// edit or remove once this project no longer needs this guard.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.BRIEFING_SYNC_ROOT ?? path.resolve(scriptDir, "..");

const START = "<!-- mullion:briefing:start -->";
const END = "<!-- mullion:briefing:end -->";
const GUARDED_FILES = ["GEMINI.md", "AGENTS.override.md"];

function hasRegion(relPath) {
  const filePath = path.join(root, relPath);
  if (!existsSync(filePath)) return false;
  const src = readFileSync(filePath, "utf8");
  const startIdx = src.indexOf(START);
  const endIdx = src.indexOf(END, startIdx + START.length);
  return startIdx !== -1 && endIdx !== -1;
}

let failed = false;
for (const file of GUARDED_FILES) {
  if (hasRegion(file)) {
    console.log(
      \`\${file} carries its own \${START} ... \${END} region — AGENTS.md is the single source \` +
        \`of truth for the briefing now. Remove the region and replace \${file} with a one-line \` +
        "pointer to AGENTS.md instead.",
    );
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}
console.log("OK — no content-bearing briefing mirror or override found.");
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
 * Always returns at least an AGENTS.md entry (upserting the briefing
 * region is safe to repeat by design — see upsertMarkedRegion). The
 * starter skill/reviewer/`.crs/dock.json` entries, by contrast, are
 * "create once, never overwrite" (Hermes review, PR #896 round 2): each
 * is OMITTED from the result when `existingFiles` already shows something
 * at that path, so a re-scaffold over a repo that already committed or
 * hand-edited them leaves that content alone rather than silently
 * clobbering it with the generic starter text. The `.agents/skills/<slug>`
 * mirror is the one exception that's always (re-)emitted regardless —
 * it has no independent identity to preserve, it just carries whatever
 * the skill's resolved content is (freshly generated, or preserved from
 * an existing `.claude/skills` file) into codex/agy's own project-scope
 * discovery path.
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
  entries.push({
    path: "AGENTS.md",
    kind: "file",
    contents: upsertMarkedRegion(
      existingFiles["AGENTS.md"] ?? "",
      MARKER_START,
      MARKER_END,
      region,
    ),
  });

  // Issue #942 — GEMINI.md, when opted in, gets a one-line POINTER upserted
  // into its own marker pair (POINTER_MARKER_START/END, distinct from
  // MARKER_START/END above), never a copy of AGENTS.md's own region.
  // Preserves whatever else is already in the file (same "never touch
  // outside the marked region" posture as the CONTRIBUTING.md pointer
  // below) rather than overwriting the whole file.
  if (options.mirrors?.includes("GEMINI.md")) {
    const existingGemini = stripLegacyBriefingMirror(existingFiles["GEMINI.md"] ?? "");
    entries.push({
      path: "GEMINI.md",
      kind: "file",
      contents: upsertMarkedRegion(
        existingGemini,
        POINTER_MARKER_START,
        POINTER_MARKER_END,
        agentsMdPointerBody(),
      ),
    });
  }

  // Issue #942 — CONTRIBUTING.md pointer, opt-in only. Creates a fresh
  // pointer-only file when none exists (the checkbox itself IS the
  // "explicitly opts in to creating one" the option's own doc comment
  // requires — there's no separate, second opt-in), or upserts just the
  // marked region into an existing file, leaving Code-of-Conduct/dev-setup
  // content completely alone.
  if (options.includeContributingPointer) {
    entries.push({
      path: "CONTRIBUTING.md",
      kind: "file",
      contents: upsertMarkedRegion(
        existingFiles["CONTRIBUTING.md"] ?? "",
        POINTER_MARKER_START,
        POINTER_MARKER_END,
        contributingPointerBody(),
      ),
    });
  }

  // Hermes review, PR #896 round 2 — this used to emit the starter
  // skill/reviewer/dock-config UNCONDITIONALLY, silently clobbering a
  // target repo's own hand-edited (or previously-scaffolded-and-since-
  // customized) content on every re-run. Unlike the briefing region above
  // (explicitly marker-delimited and DESIGNED for repeated safe upserts),
  // these are one-time starter files a human is expected to edit
  // afterward — the safe, idempotent posture is "create if missing, never
  // touch if already there", the same convention scaffolding tools
  // generally use. `existingFiles[path] !== undefined` means the caller
  // (routes/project-setup.ts's readExistingFiles) found SOMETHING already
  // there — real content for a text file, or an empty-string existence
  // sentinel for a directory/symlink it can't read as text (see that
  // function's own doc comment).
  const skillPath = path.join(".claude", "skills", slug, "SKILL.md");
  const skillAlreadyExists = existingFiles[skillPath] !== undefined;
  // Whatever the skill's FINAL content is (freshly generated, or the
  // existing repo's own content preserved) is what the `.agents/skills`
  // mirror below copies — never its own independently-regenerated starter
  // text, which would silently diverge from a preserved `.claude/skills`
  // copy the moment a re-scaffold ran.
  const skillContent = existingFiles[skillPath] ?? skillFileContents(slug);
  if (!skillAlreadyExists) {
    entries.push({ path: skillPath, kind: "file", contents: skillContent });
  }

  const reviewerPath = path.join(".claude", "agents", `${slug}-reviewer.md`);
  if (existingFiles[reviewerPath] === undefined) {
    entries.push({
      path: reviewerPath,
      kind: "file",
      contents: reviewerAgentFileContents(slug),
    });
  }

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
    // Always (re-)written, regardless of skillAlreadyExists — this mirror
    // has no independent identity of its own to preserve; it exists only
    // to carry whatever `.claude/skills/<slug>/SKILL.md`'s content
    // resolved to above, in file form for codex/agy's own project-scope
    // discovery.
    entries.push({
      path: path.join(".agents", "skills", slug, "SKILL.md"),
      kind: "file",
      contents: skillContent,
    });
  }

  if (options.mirrors?.includes("GEMINI.md")) {
    entries.push({
      path: path.join("scripts", "check-briefing-sync.mjs"),
      kind: "file",
      contents: CHECK_BRIEFING_SYNC_SCRIPT,
    });
  }

  const dockConfigPath = path.join(".crs", "dock.json");
  if (options.includeDockConfig && existingFiles[dockConfigPath] === undefined) {
    const emptyControls: DockControl[] = [];
    entries.push({
      path: dockConfigPath,
      kind: "file",
      contents: JSON.stringify({ controls: emptyControls }, null, 2) + "\n",
    });
  }

  return entries;
}
