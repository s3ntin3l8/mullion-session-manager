import { execFile, type ExecException } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { createWorktree, removeWorktree } from "./git-worktree.js";
import { deleteBranch } from "./git-branch-delete.js";
import { resolveHostBaseRef, viaRemote } from "./host-git.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { gitEnv } from "./git-env.js";
import {
  scaffoldSkillPath,
  scaffoldReviewerPath,
  CODEX_REVIEWER_DELEGATION_CLAUSE,
  SCAFFOLD_REGION_START,
  SCAFFOLD_REGION_END,
  MULLION_REGION_PLACEHOLDER,
} from "./mullion-scaffold.js";
import { parseSkillFrontmatter } from "./skills.js";
import { topLevelLines } from "./marked-region.js";
import type { ExistingInstructionsMode } from "../shared/constants.js";

// Issue #956 — replaces mullion-scaffold.ts's static placeholder skill/
// reviewer/AGENTS.md-region text with genuinely codebase-specific content, by
// spawning a real, read-only agent turn against the project's own repo and
// parsing its structured text output. This module is the ONLY place that
// invocation happens; routes/project-setup.ts's `/setup/generate` calls
// `generateScaffoldContent` and feeds the result into computeScaffold's
// `generated` option as plain data — computeScaffold itself never becomes
// agent-aware (see that module's own doc comment on why its purity matters).
//
// ## Why a SEPARATE, disposable worktree — not the scaffold's own preview
// worktree, and not the project's real checkout
//
// The pre-implementation review's gap #2 requires the generation agent to
// have read access to the codebase but NOT write authority over it. The
// tempting shortcut — run it inside the same `setup-<slug>` worktree
// preview/apply already create, and just trust it to only touch the three
// target files — does not actually hold up: `apply`'s own
// `commitWipChanges` (git-worktree.ts) stages with `git add -u` PLUS every
// untracked file, i.e. it commits whatever is ACTUALLY DIRTY in that
// worktree, not just computeScaffold's own entries. An agent turn that
// wandered off and "fixed" something else in that same worktree would have
// its edits silently swept into the PR by that very machinery — the exact
// "much bigger and scarier diff than intended" failure mode the issue warns
// about, and no per-CLI tool-permission flag would save us from it once the
// two worktrees are the same directory.
//
// So generation runs in ITS OWN throwaway worktree (a fresh `git worktree
// add`, same baseRef machinery preview uses), and the ONLY thing that ever
// crosses back out of it is the plain text captured from the agent
// process's stdout. That worktree is force-removed (git-worktree.ts's
// `removeWorktree`, `--force`, tolerant of a dirty tree) in a `finally`
// block regardless of success or failure.
//
// Placement matters too, and is worth being precise about what it does and
// does not buy: `createWorktree`'s `baseDir` is deliberately set below to a
// path UNDER THE OS TEMP DIR, not `<project.cwd>/.mullion-worktrees` (where
// `setup-<slug>` itself lives). An unrestricted agent process with Bash
// access could otherwise `cd ../..` straight out of a worktree nested
// inside the project root and either touch the live checkout directly or
// land inside `setup-<slug>` — where `commitWipChanges`'s `git add -u` +
// untracked-file sweep would pull whatever it left there into the PR,
// which is precisely the failure this design exists to prevent. Placing
// the scratch worktree in a wholly unrelated part of the filesystem means
// a relative-path escape no longer lands anywhere that matters.
//
// Be honest about what this is and isn't: real process-level sandboxing IS
// now wired in here, WHEN `bwrap` (bubblewrap) is present and actually
// usable on this host — see `wrapWithSandbox` and `isSandboxCapable` below.
// The confirmed-working invocation (unchanged from the original spike,
// issue #1081, 2026-09-05, this repo's own dev sandbox):
//
//   bwrap --ro-bind / / --dev /dev --proc /proc --bind <scratch worktree>
//     <scratch worktree> --die-with-parent -- <agent bin> <agent args...>
//
// — deliberately NOT `--unshare-net`, since the agent CLI itself needs
// network access to reach its own model API. This blocks a write outside
// the bound path (EROFS — re-confirmed live on this box as part of this
// issue's own test suite), permits the punched-out scratch worktree (the
// more specific `--bind` for that path is listed AFTER the broader
// `--ro-bind /`, which is what lets it override the read-only mount for
// that one path — reordering those two flags would silently make the
// worktree read-only too, though today's read-only `git log`/`diff`/
// `show` commands would still work fine even then, since they never write
// anything; the writable bind exists for the agent CLI's own use of its
// cwd, not for git's benefit), and — the load-bearing property — still
// lets `execFile`'s own `timeout` kill the sandboxed process via SIGTERM
// with no orphaned children, because `--die-with-parent` ties bwrap's own
// lifetime (and therefore everything it launched) to its immediate
// parent.
//
// A second live re-check (2026-09-06, same box) found the worktree bind
// ALONE is not enough for every agent this module supports: `codex` and
// `opencode` both write to their own state/log directories under `$HOME`
// on every invocation (a session-rollout file under `~/.codex`, a log file
// under `~/.local/share/opencode`) and hard-fail with EROFS if they can't,
// even for a read-only generation turn — `claude` needed no such extra
// bind. `wrapWithSandbox`'s `extraWritablePaths` parameter and
// `agentSandboxWritablePaths` (see their own comments) close that gap with
// an additional `--bind-try` per agent, re-verified live afterward: both
// agents proceeded past the filesystem error to a real model-turn attempt.
// `agy`'s own pre-existing argument-parsing bug (unrelated to this sandbox
// — reproduced identically unsandboxed, and separately fixed in
// `buildInvocation` below, issue #1130) originally blocked doing the same
// live check for it. Re-run after that fix (2026-09-07, same box): under
// the exact production bwrap argv, agy completed cleanly (exit 0, correct
// stdout) while emitting 22 tolerated EROFS events under
// `~/.gemini/antigravity-cli/` (log, crashes, conversations, cache, mcp,
// presence) — the same "tries but doesn't need to" class already
// documented above for `claude`. No extra bind is added for it — see
// `agentSandboxWritablePaths`'s own comment for the verified detail.
//
// Presence of the `bwrap` binary on `PATH` is NOT treated as sufficient —
// the real gate is the kernel's `unprivileged_userns_clone` sysctl, which
// varies by host and can't be read reliably (some kernels expose it under
// a different path, or via AppArmor policy instead of sysctl). So instead
// of `command -v bwrap`, `isSandboxCapable` runs an actual smoke probe
// (`bwrap --ro-bind / / --dev /dev --proc /proc --bind <tmpdir> <tmpdir>
// --die-with-parent -- /bin/true` — the same base flags as the real
// invocation, minus any per-agent extra binds, which are checked
// separately by re-verifying live per agent as described above) once per
// process and caches the boolean result — see that function's own comment
// for the caching/reset seam. When the probe fails, generation falls back
// to exactly today's unsandboxed `execFile` call, with a one-time
// `console.warn` naming what protection is being skipped — a graceful
// degrade, not a hard failure, since plenty of self-hosted production
// hosts (containers/LXC without unprivileged user namespaces, hardened
// kernels) genuinely can't run bwrap. `deploy/install.sh`/
// `deploy/README.md` list it as an OPTIONAL prerequisite, not a hard one,
// for exactly that reason.
//
// What sandboxing does NOT change: only `claude`'s `--allowedTools` below
// is a CONFIRMED write-blocking flag among the four agents' own CLI
// surfaces (independent of the process-level sandbox). Issue #1081's
// earlier re-check of the other three (2026-09-05, this repo's own dev
// sandbox — see that issue's own comments for the exact commands) still
// holds and is worth keeping as documented context: `codex exec --sandbox
// read-only` is a REAL, accepted flag (`codex exec`'s own startup banner
// echoes back `sandbox: read-only`), but whether it actually blocks a
// write is still UNVERIFIED — this account's codex usage was rate-limited
// (quota resets 2026-09-28) before a real model turn could be driven far
// enough to try one. `agy -p` DOES now carry a `--sandbox` flag (agy
// 1.1.27; it did not when this comment was first written) but it is NOT
// usable here: without `--dangerously-skip-permissions` it auto-denies
// every tool call in headless/print mode (including the read-only ones
// this module needs — confirmed live: a tool-using prompt returns empty
// stdout, identical sandboxed and unsandboxed, i.e. this is agy's own
// permission gate, not bwrap), and WITH that flag it blocks nothing — a
// live `echo pwned > /outside/path` under `agy -p --sandbox
// --dangerously-skip-permissions` wrote the file. `buildInvocation` below
// therefore DOES pass `--dangerously-skip-permissions` (issue #1130) —
// the tool access it buys is a hard requirement for this module's own
// prompt ("your entire job is to READ the codebase"), not optional — and
// relies entirely on bwrap for containment, same as this paragraph
// describes. agy's own denial message points at a `permissions.allow`
// allow-list in `settings.json` (`command(<target>)` rules) as the closer
// analogue to `claude`'s `--allowedTools` — untried here, real follow-up
// work. `opencode run`
// (1.18.29) still has no write-restriction flag at all, confirmed against
// its own `--help` — only `--auto`, which does the opposite (auto-approves
// everything). opencode is now fail-closed on the no-bwrap fallback (#1153),
// same as agy — running unsandboxed would provide full write/exec access as
// the server user with no CLI-level restriction to fall back on. On a host
// where bwrap is usable, bwrap blocks the write at the kernel/mount-namespace
// level regardless of which CLI flag was or wasn't passed.
//
// What IS still structurally guaranteed regardless of whether bwrap is
// available on a given host, and regardless of whether any of those
// per-CLI flags hold: the diff/PR pipeline (computeScaffold →
// writeScaffoldEntries → the `setup-<slug>` worktree) never reads from,
// stages, or diffs anywhere the generation agent could have written — the
// only channel between the two is this function's own parsed stdout,
// feeding three hardcoded target paths. On a host without a usable bwrap,
// a write the agent makes ANYWHERE ELSE on disk is real (this design
// cannot prevent that on such a host), but it is never picked up by the
// machinery that produces the PR a human reviews. This structural
// guarantee is the backstop; bwrap, where available, is now real
// belt-and-suspenders on top of it, not a replacement for it.
//
// ## Why a direct one-shot subprocess call, not PtyManager/createSessionRecord
//
// Every existing agent spawn in this codebase (Task Master's claim/retry/
// review, manual terminal launches) is a full interactive PTY session
// attached via `dtach`, whose completion is observed asynchronously via
// hooks/task-reconciler polling — there is no existing "spawn one turn,
// synchronously capture its final text output" primitive to extend (grepped
// for one before writing this; none exists). Building the job-queue +
// status-polling machinery that would let generation run as a proper
// background PTY session is real, valuable follow-up work (see the PR
// description / issue tracker for the filed follow-up), but is out of
// scope for this issue's own narrowed checklist. For v1, `/setup/generate`
// blocks on a direct child_process call to the resolved agent's own
// documented non-interactive/print mode, bounded by `timeoutMs` — the
// same posture the route's own rate limit already assumes ("a real, costly
// turn", not an instant call), just made explicit here too.
export const DEFAULT_GENERATION_TIMEOUT_MS = 5 * 60 * 1000;

export class UnsupportedGenerationAgentError extends Error {
  constructor(agentCommand: string) {
    super(
      `"${agentCommand}" has no non-interactive generation mode wired up yet — ` +
        `supported: claude, codex, opencode, agy`,
    );
    this.name = "UnsupportedGenerationAgentError";
  }
}

export class GenerationWorktreeError extends Error {
  constructor(detail: string) {
    super(`Could not create a scratch worktree for generation: ${detail}`);
    this.name = "GenerationWorktreeError";
  }
}

export class GenerationSpawnError extends Error {
  constructor(agentCommand: string, detail: string) {
    super(`"${agentCommand}" generation turn failed: ${detail}`);
    this.name = "GenerationSpawnError";
  }
}

export class GenerationOutputError extends Error {
  constructor(detail: string) {
    super(`Generation agent's output could not be used: ${detail}`);
    this.name = "GenerationOutputError";
  }
}

/** How the generation turn treats instruction content that already exists in
 * the repo outside Mullion's own marked regions (issue #2316). `keep` is the
 * historical behavior: leave it alone. `report` also returns a list of lines
 * that contradict or duplicate the committed conventions, for a human to act
 * on. `restructure` also returns a rewritten AGENTS.md (and, optionally, text
 * moved out of it into CONTRIBUTING.md) for the human to review in the diff. */
export type { ExistingInstructionsMode };

export const CONFLICT_KINDS = ["contradicts", "duplicates", "misplaced"] as const;
export type ConflictKind = (typeof CONFLICT_KINDS)[number];

export interface ScaffoldConflict {
  file: string;
  excerpt: string;
  kind: ConflictKind;
  note: string;
}

export interface GeneratedScaffoldContent {
  /** Absent on an instructions-only pass (the skill and reviewer already exist
   * and are not being refreshed, so the turn was not asked for them). */
  skill?: string;
  reviewer?: string;
  scaffoldRegion: string;
  /** Issue #1144, #1159 — whether the generation turn actually ran inside a
   * bwrap sandbox. `false` when sandboxing was opted out via
   * MULLION_SCAFFOLD_GENERATE_SANDBOX_ENABLED or when bwrap is unusable and
   * the agent is claude/codex (agy/opencode fail-closed instead, never
   * reaching this point unsandboxed). Surfaced in the /setup/generate
   * response so the primary/UI can warn the user. */
  sandboxed: boolean;
  /** Issue #1145 — post-generation heuristic: when the generated content
   * references concrete file paths but none of them appear to be real
   * repo-specific paths, this is `true`. A signal, not a hard failure —
   * the caller surfaces it as a warning; tightening to a failure is a
   * follow-up once confidence is high. Absent (undefined) when validation
   * was not run.
   *
   * Only surfaced via `/setup/generate`'s response — ProjectSetupPanel's
   * "Generate with agent" button shows it as a warning. `/setup/preview`
   * never carries it: the preview step runs no generation, so it can't know
   * the output yet. */
  possiblyGeneric?: boolean;
  /** `existingInstructions: "restructure"` only — the agent's proposed
   * AGENTS.md, containing exactly one `MULLION_REGION_PLACEHOLDER` line.
   * computeScaffold splices Mullion's region over that line. */
  agentsMdBody?: string;
  /** `restructure` only — procedural text the agent moved out of AGENTS.md,
   * appended to CONTRIBUTING.md inside its own marked region. Never replaces
   * anything already in CONTRIBUTING.md. */
  contributingAppend?: string;
  /** `report` only — findings for a human; nothing is written for them. */
  conflicts?: ScaffoldConflict[];
  /** `report` only — lines the agent returned that were not shown: not valid
   * JSON objects of the expected shape, or valid but past the 50-entry cap. */
  droppedConflictLines?: number;
  /** `restructure` only — heuristic: the rewrite looks like it lost more than
   * it should have (see `assessRewrite`). A signal for the reviewer, not a
   * failure. */
  possiblyLossy?: boolean;
}

/** `project_tooling.skill`/`.reviewerAgent`/`.briefing` DB drafts (see
 * project-tooling.ts) — read by the ROUTE, not this module, and passed in
 * only for the fields that don't already have a committed file (see the
 * issue's "DB draft: consulted once, pre-file only — then dead" section:
 * once a real file exists, the DB draft is never read for anything again,
 * generation included). `null`/`undefined`/empty all mean "nothing to
 * seed with" — the prompt below only mentions a seed section when it has
 * actual content to show. */
export interface GenerationSeed {
  skill?: string | null;
  reviewerAgent?: string | null;
  briefing?: string | null;
}

const SKILL_START = "<<<MULLION_SKILL_START>>>";
const SKILL_END = "<<<MULLION_SKILL_END>>>";
const REVIEWER_START = "<<<MULLION_REVIEWER_START>>>";
const REVIEWER_END = "<<<MULLION_REVIEWER_END>>>";
// Issue #1215 — this pair is request-scoped (the prompt below and
// extractSection's parse are updated together, in this same commit, and
// nothing persists the delimiter past a single generation turn), unlike
// mullion-scaffold.ts's SCAFFOLD_REGION_START/END — those are a wire
// format already committed into every previously-scaffolded repo's
// AGENTS.md and can't be renamed. This one carries no such history.
const GENERATED_REGION_START = "<<<MULLION_SCAFFOLD_REGION_START>>>";
const GENERATED_REGION_END = "<<<MULLION_SCAFFOLD_REGION_END>>>";
// Issue #2316 — request-scoped like the pairs above; only requested when
// `existingInstructions` is not "keep".
const AGENTS_MD_START = "<<<MULLION_AGENTS_MD_START>>>";
const AGENTS_MD_END = "<<<MULLION_AGENTS_MD_END>>>";
const CONTRIBUTING_APPEND_START = "<<<MULLION_CONTRIBUTING_APPEND_START>>>";
const CONTRIBUTING_APPEND_END = "<<<MULLION_CONTRIBUTING_APPEND_END>>>";
const CONFLICTS_START = "<<<MULLION_CONFLICTS_START>>>";
const CONFLICTS_END = "<<<MULLION_CONFLICTS_END>>>";

/** The generation agent never writes files itself (see this module's own
 * header) — it reports back by printing exactly these three delimited
 * sections to stdout, which `parseGeneratedOutput` below extracts. Kept as
 * a single exported function so the prompt text and the parser can never
 * drift out of sync with each other. */
export function buildGenerationPrompt(opts: {
  slug: string;
  seed: GenerationSeed;
  hasSkill: boolean;
  hasReviewer: boolean;
  hasScaffoldRegion: boolean;
  /** Issue #2316 — absent means "keep". */
  existingInstructions?: ExistingInstructionsMode;
  /** The text Mullion will commit as `## Workflow Conventions`; shown to the
   * agent in `report`/`restructure` so it can tell what contradicts it. */
  conventionsText?: string;
  /** Issue #2320 — the skill and reviewer already exist and are not being
   * refreshed, so only the region paragraph and the instructions output are
   * asked for. Requires a non-"keep" `existingInstructions`. */
  instructionsOnly?: boolean;
}): string {
  const { slug, seed, hasSkill, hasReviewer, hasScaffoldRegion } = opts;
  const mode = opts.existingInstructions ?? "keep";
  if (opts.instructionsOnly && mode !== "keep") return buildInstructionsOnlyPrompt(opts);
  const skillPath = scaffoldSkillPath(slug);
  const reviewerPath = scaffoldReviewerPath(slug);

  const seedLines: string[] = [];
  if (!hasSkill && seed.skill) {
    seedLines.push(
      `A draft skill description was previously saved via Mullion's UI — treat it as a strong ` +
        `hint for what to cover, not a final answer:\n---\n${seed.skill}\n---`,
    );
  }
  if (!hasReviewer && seed.reviewerAgent) {
    seedLines.push(
      `A draft reviewer description was previously saved via Mullion's UI — treat it as a ` +
        `strong hint, not a final answer:\n---\n${seed.reviewerAgent}\n---`,
    );
  }
  if (!hasScaffoldRegion && seed.briefing) {
    seedLines.push(
      `A short pinned briefing note already exists for this project — you may draw on it, ` +
        `but the AGENTS.md region you write is a different, longer-lived thing:\n---\n${seed.briefing}\n---`,
    );
  }
  const seedSection = seedLines.length > 0 ? `\n\n${seedLines.join("\n\n")}` : "";

  return (
    `You have READ-ONLY access to this repository. Do not create, edit, or delete any file — ` +
    `your entire job is to READ the codebase (source, tests, docs, config) and report back ` +
    `text; nothing you do in this session is committed or kept.\n\n` +
    `Analyze this codebase and write genuinely specific content for ` +
    `${mode === "keep" ? "three things" : "four things"} Mullion ` +
    `(the tool hosting this session) will commit on your behalf:\n\n` +
    `1. A skill file at \`${skillPath}\` — this repo's own non-obvious correctness invariants: ` +
    `the kind of mistake that looks reasonable in isolation but breaks an assumption another ` +
    `part of the codebase depends on. Independently useful to ANY agent working in this repo, ` +
    `not just during review — its description should invite that.\n` +
    `2. A reviewer subagent file at \`${reviewerPath}\` — a role guaranteed to consult the ` +
    `skill above during review specifically. It MUST explicitly instruct the reader to read ` +
    `\`${skillPath}\` first (name that exact path), the same way this repo's own ` +
    `\`.claude/agents/mullion-reviewer.md\` says "Read \`.claude/skills/mullion-review-` +
    `invariants/SKILL.md\` first; it's the compact checklist this review is built on." Never ` +
    `invent invariants independently of what you wrote in the skill — the reviewer's checklist ` +
    `IS the skill's content, applied. Its \`description:\` frontmatter field MUST include this ` +
    `exact clause, verbatim, appended after your own description text: "${CODEX_REVIEWER_DELEGATION_CLAUSE}" ` +
    `— this is the only mechanism by which codex's own delegation (\`spawn_agent\`) can ` +
    `discover this reviewer as a skill; omitting it makes the reviewer silently invisible to ` +
    `codex sessions.\n` +
    `3. A short AGENTS.md scaffold-region paragraph naming where the skill and reviewer live ` +
    `and when to use them. Do NOT include a "## Workflow Conventions" section or any branching/` +
    `review/commit-convention content — Mullion appends its own Workflow Conventions section ` +
    `after your paragraph, sourced from this install's own configured conventions, not from ` +
    `you. Report back the pointer paragraph only.` +
    `${instructionsItem(mode, opts.conventionsText)}${seedSection}\n\n` +
    `Report back EXACTLY this shape and nothing else outside these markers — no preamble, no ` +
    `commentary, no markdown fences around the markers themselves:\n\n` +
    `${SKILL_START}\n(full skill file contents, including YAML frontmatter with name/description)\n${SKILL_END}\n` +
    `${REVIEWER_START}\n(full reviewer file contents, including YAML frontmatter with name/description/tools/model)\n${REVIEWER_END}\n` +
    `${GENERATED_REGION_START}\n(the scaffold-region paragraph only)\n${GENERATED_REGION_END}\n` +
    instructionsOutputShape(mode)
  );
}

/** Issue #2320 — the prompt for a report/restructure pass over a repo whose
 * skill and reviewer already exist: just the region paragraph (which names
 * them) and the instructions item. */
function buildInstructionsOnlyPrompt(opts: {
  slug: string;
  seed: GenerationSeed;
  hasScaffoldRegion: boolean;
  existingInstructions?: ExistingInstructionsMode;
  conventionsText?: string;
}): string {
  const mode = opts.existingInstructions ?? "keep";
  const skillPath = scaffoldSkillPath(opts.slug);
  const reviewerPath = scaffoldReviewerPath(opts.slug);
  const briefing =
    !opts.hasScaffoldRegion && opts.seed.briefing
      ? `\n\nA short pinned briefing note already exists for this project — you may draw on it, ` +
        `but the AGENTS.md region you write is a different, longer-lived thing:\n---\n${opts.seed.briefing}\n---`
      : "";
  return (
    `You have READ-ONLY access to this repository. Do not create, edit, or delete any file — ` +
    `your entire job is to READ the codebase (source, tests, docs, config) and report back ` +
    `text; nothing you do in this session is committed or kept.\n\n` +
    `Read this codebase and write content for two things Mullion (the tool hosting this ` +
    `session) will commit on your behalf. The repo's skill (\`${skillPath}\`) and reviewer ` +
    `(\`${reviewerPath}\`) already exist; do not write them, but read them first so ` +
    `the paragraph describes what they actually say.\n\n` +
    `1. A short AGENTS.md scaffold-region paragraph naming where that skill and reviewer live ` +
    `and when to use them. Do NOT include a "## Workflow Conventions" section or any branching/` +
    `review/commit-convention content — Mullion appends its own Workflow Conventions section ` +
    `after your paragraph, sourced from this install's own configured conventions, not from ` +
    `you. Report back the pointer paragraph only.` +
    `${instructionsItem(mode, opts.conventionsText, 2)}${briefing}\n\n` +
    `Report back EXACTLY this shape and nothing else outside these markers — no preamble, no ` +
    `commentary, no markdown fences around the markers themselves:\n\n` +
    `${GENERATED_REGION_START}\n(the scaffold-region paragraph only)\n${GENERATED_REGION_END}\n` +
    instructionsOutputShape(mode)
  );
}

/** Issue #2316 — the fourth item of the prompt, only for `report` and
 * `restructure`. Kept as its own function so the keep-mode prompt stays
 * byte-identical to what it was before this option existed. */
function instructionsItem(
  mode: ExistingInstructionsMode,
  conventionsText: string | undefined,
  itemNumber = 4,
): string {
  if (mode === "keep") return "";
  const conventions =
    conventionsText && conventionsText.trim().length > 0
      ? `\n\nThe workflow conventions Mullion will commit into AGENTS.md (inside its own ` +
        `region) are:\n---\n${conventionsText.trim()}\n---`
      : "";
  const scope =
    `Look at AGENTS.md, CLAUDE.md and CONTRIBUTING.md (whichever exist), ignoring anything ` +
    `between \`<!-- mullion:...:start -->\` and \`<!-- mullion:...:end -->\` markers — ` +
    `Mullion owns those. Workflow rules (branching, commit/PR titles, merging, reviews, ` +
    `review-bot handling, issue filing, cleanup, pre-push checks) belong to the conventions ` +
    `above, not to the repo's own instructions.`;
  if (mode === "report") {
    return (
      `\n${itemNumber}. A conflicts report. ${scope} List every passage outside those regions that ` +
      `contradicts the conventions (kind "contradicts"), restates them (kind "duplicates"), ` +
      `or is a workflow rule that does not belong in the repo's own instructions ` +
      `(kind "misplaced"). One JSON object per line, with exactly the keys ` +
      `"file", "excerpt" (the passage, at most 200 characters), "kind", "note" (one ` +
      `sentence on why). If there are none, write the single word none.${conventions}`
    );
  }
  return (
    `\n${itemNumber}. A restructured AGENTS.md. ${scope} Return the COMPLETE proposed AGENTS.md. Its ` +
    `layout: the title and a short intro; then a line containing only ` +
    `${MULLION_REGION_PLACEHOLDER} (Mullion replaces that line with its own region — write ` +
    `it exactly once, replace any existing Mullion region with it, and never write ` +
    `workflow conventions yourself); then \`## Repo specifics\` (how THIS repo applies those ` +
    `conventions: its real commands, gates, CI quirks and footguns, stated as facts, not ` +
    `rules); then the repo's existing invariants and command sections. Drop passages that ` +
    `contradict or restate the conventions. Do not delete anything else that is repo-specific: ` +
    `procedural detail that is not a rule (long how-tos, tool-pinning procedures) goes to ` +
    `CONTRIBUTING.md instead — return it verbatim as a CONTRIBUTING append, with a short ` +
    `pointer left in AGENTS.md. Keep wording of kept passages unchanged.${conventions}`
  );
}

function instructionsOutputShape(mode: ExistingInstructionsMode): string {
  if (mode === "report") {
    return `${CONFLICTS_START}\n(one JSON object per line, or the word none)\n${CONFLICTS_END}\n`;
  }
  if (mode === "restructure") {
    return (
      `${AGENTS_MD_START}\n(the complete proposed AGENTS.md)\n${AGENTS_MD_END}\n` +
      `${CONTRIBUTING_APPEND_START}\n(text moved to CONTRIBUTING.md, or omit this section)\n${CONTRIBUTING_APPEND_END}\n`
    );
  }
  return "";
}

function extractSection(raw: string, start: string, end: string, label: string): string {
  const startIdx = raw.indexOf(start);
  if (startIdx === -1) {
    throw new GenerationOutputError(`missing ${label} section (no ${start} marker found)`);
  }
  const contentStart = startIdx + start.length;
  const endIdx = raw.indexOf(end, contentStart);
  if (endIdx === -1) {
    throw new GenerationOutputError(`missing ${label} section (no matching ${end} marker found)`);
  }
  const content = raw.slice(contentStart, endIdx).trim();
  if (content.length === 0) {
    throw new GenerationOutputError(`${label} section was empty`);
  }
  return content + "\n";
}

/** Parses the generation agent's raw stdout into the three target-file
 * contents, and enforces two cross-cutting invariants a prompt instruction
 * alone can't guarantee — checked here, not left to hope, so a generation
 * pass that drifts fails loudly instead of silently shipping broken
 * content: (1) the reviewer body must actually name the skill's real path,
 * not just have been ASKED to (issue's "skill<->reviewer relationship must
 * be explicit" section); (2) the reviewer's `description:` frontmatter
 * field specifically must carry the CODEX_REVIEWER_DELEGATION_CLAUSE
 * verbatim (issue #943) — without it, the generated reviewer's codex
 * mirror exists on disk but is never actually discoverable by codex's
 * `spawn_agent` delegation. */
export function parseGeneratedOutput(
  raw: string,
  slug: string,
  instructions?: {
    mode?: ExistingInstructionsMode;
    originalAgentsMd?: string;
    /** Issue #2320 — the turn was not asked for a skill or reviewer. */
    instructionsOnly?: boolean;
  },
): GeneratedScaffoldContent {
  const instructionsOnly = instructions?.instructionsOnly === true;
  const skill = instructionsOnly ? undefined : extractSection(raw, SKILL_START, SKILL_END, "skill");
  const reviewer = instructionsOnly
    ? undefined
    : extractSection(raw, REVIEWER_START, REVIEWER_END, "reviewer");
  const scaffoldRegion = extractSection(
    raw,
    GENERATED_REGION_START,
    GENERATED_REGION_END,
    "scaffold region",
  );

  const skillPath = scaffoldSkillPath(slug);
  if (reviewer !== undefined && !reviewer.includes(skillPath)) {
    throw new GenerationOutputError(
      `reviewer content never references the skill's own path (${skillPath}) — ` +
        `regenerate rather than commit a reviewer with no real cross-reference`,
    );
  }
  // Hermes review, PR #1188 — the original version of this check tested
  // the clause against the WHOLE reviewer section (`reviewer.includes(...)`),
  // but discoverability depends only on the `description:` frontmatter
  // field: that's the one thing deriveCodexReviewerSkillContent
  // (mullion-scaffold.ts) actually copies into the codex mirror. A
  // generation pass that put the clause in the reviewer's BODY text but
  // not its description would have passed the old check while still
  // shipping an undiscoverable mirror — exactly the silent failure this
  // fail-loud gate exists to prevent. Parsing the frontmatter and
  // checking its description specifically closes that gap; a reviewer
  // whose frontmatter doesn't even parse is rejected too, since that
  // would silently drop the codex mirror downstream regardless of what
  // its body says (mullion-scaffold.ts's own doc comment on
  // deriveCodexReviewerSkillContent).
  const parsedReviewer = reviewer === undefined ? null : parseSkillFrontmatter(reviewer);
  if (
    reviewer !== undefined &&
    (!parsedReviewer || !parsedReviewer.description.includes(CODEX_REVIEWER_DELEGATION_CLAUSE))
  ) {
    throw new GenerationOutputError(
      `reviewer content's description frontmatter field never includes the required ` +
        `codex-delegation clause ("${CODEX_REVIEWER_DELEGATION_CLAUSE}") — regenerate rather ` +
        `than commit a reviewer codex's spawn_agent delegation can't discover`,
    );
  }

  const base: GeneratedScaffoldContent = {
    skill,
    reviewer,
    scaffoldRegion,
    sandboxed: false,
    possiblyGeneric: false,
  };
  const mode = instructions?.mode ?? "keep";
  // The skill and reviewer bodies are free text and may legitimately quote
  // these section markers (Mullion's own repo contains them), so the extra
  // sections are looked for only AFTER the scaffold-region section the prompt
  // asks to come first, never in the text before it.
  const regionEnd = raw.indexOf(GENERATED_REGION_END, raw.indexOf(GENERATED_REGION_START));
  const afterRegion = regionEnd === -1 ? raw : raw.slice(regionEnd + GENERATED_REGION_END.length);
  // Where to look for one of the extra sections. Normally after the scaffold
  // region. A complete but misordered answer (the section placed earlier) is
  // still found when its start marker occurs exactly once in the whole output:
  // that loses nothing, and a skill that merely quotes the markers still can't
  // outrank a section the agent wrote itself, because then the marker occurs
  // in `afterRegion` too (or twice overall).
  const haystackFor = (start: string): string =>
    afterRegion.includes(start) || raw.split(start).length - 1 !== 1 ? afterRegion : raw;
  if (mode === "report") {
    // The prompt always asks for this section (the word `none` when there is
    // nothing), so an absent or empty one is a protocol violation, not "no
    // conflicts": reading it as an empty list would show an all-clear.
    const conflictsSection = optionalSection(
      haystackFor(CONFLICTS_START),
      CONFLICTS_START,
      CONFLICTS_END,
    );
    if (conflictsSection === null) {
      throw new GenerationOutputError(
        "the conflicts section is missing or empty (the agent should have written `none` if " +
          "there were none) — regenerate rather than read that as 'no conflicts'",
      );
    }
    const { conflicts, dropped } = parseConflicts(conflictsSection);
    return { ...base, conflicts, droppedConflictLines: dropped };
  }
  if (mode === "restructure") {
    const agentsMdBody = parseRestructuredAgentsMd(haystackFor(AGENTS_MD_START));
    const appendRaw = optionalSection(
      haystackFor(CONTRIBUTING_APPEND_START),
      CONTRIBUTING_APPEND_START,
      CONTRIBUTING_APPEND_END,
    );
    const contributingAppend =
      appendRaw && !/^none\.?$/i.test(appendRaw) ? appendRaw + "\n" : undefined;
    if (contributingAppend && MULLION_MARKER_RE.test(contributingAppend)) {
      throw new GenerationOutputError(
        "the CONTRIBUTING append carries a Mullion marker — regenerate rather than commit it",
      );
    }
    return {
      ...base,
      agentsMdBody,
      contributingAppend,
      possiblyLossy: assessRewrite(
        instructions?.originalAgentsMd ?? "",
        agentsMdBody,
        contributingAppend,
      ),
    };
  }
  return base;
}

/** Like `extractSection`, but a section that is absent or empty is `null`
 * rather than an error. A section that STARTS and never ends is still an
 * error: it means the output was cut off mid-way. */
function optionalSection(raw: string, start: string, end: string): string | null {
  const startIdx = raw.indexOf(start);
  if (startIdx === -1) return null;
  const contentStart = startIdx + start.length;
  const endIdx = raw.indexOf(end, contentStart);
  if (endIdx === -1) {
    throw new GenerationOutputError(`unterminated section (no matching ${end} marker found)`);
  }
  const content = raw.slice(contentStart, endIdx).trim();
  return content.length > 0 ? content : null;
}

/** Any Mullion region marker, whatever its name or case. Mullion itself only
 * matches its own exact, case-sensitive markers, but one that merely looks
 * like one would still confuse the sync checker and a human reader. */
const MULLION_MARKER_RE = /mullion:[\w-]+:(start|end)/i;

const MAX_CONFLICTS = 50;
const MAX_CONFLICT_EXCERPT = 200;
const MAX_CONFLICT_NOTE = 400;

/** One JSON object per line; a line that is not a valid, correctly-shaped
 * object is counted and dropped rather than failing a turn that already spent
 * minutes of agent time. */
export function parseConflicts(section: string | null): {
  conflicts: ScaffoldConflict[];
  dropped: number;
} {
  const conflicts: ScaffoldConflict[] = [];
  let dropped = 0;
  if (!section || /^none\.?$/i.test(section.trim())) return { conflicts, dropped };
  for (const line of section.split("\n")) {
    const text = line.trim();
    if (text.length === 0 || /^```/.test(text)) continue;
    try {
      const v = JSON.parse(text) as Record<string, unknown>;
      if (
        typeof v.file === "string" &&
        typeof v.excerpt === "string" &&
        typeof v.note === "string" &&
        typeof v.kind === "string" &&
        (CONFLICT_KINDS as readonly string[]).includes(v.kind)
      ) {
        if (conflicts.length < MAX_CONFLICTS) {
          conflicts.push({
            file: v.file.slice(0, 200),
            excerpt: v.excerpt.slice(0, MAX_CONFLICT_EXCERPT),
            kind: v.kind as ConflictKind,
            note: v.note.slice(0, MAX_CONFLICT_NOTE),
          });
        } else {
          // Valid, but past the cap: counted so the UI can say some were left out.
          dropped += 1;
        }
        continue;
      }
    } catch {
      // fall through to the drop below
    }
    dropped += 1;
  }
  return { conflicts, dropped };
}

/** Validates the agent's proposed AGENTS.md. The prompt asks for these
 * properties; a prompt alone can't guarantee them, so they are checked here
 * and a violation fails the turn loudly instead of committing a file that
 * would carry two regions or no region. */
function parseRestructuredAgentsMd(raw: string): string {
  const body = extractSection(raw, AGENTS_MD_START, AGENTS_MD_END, "restructured AGENTS.md");
  const occurrences = body.split(MULLION_REGION_PLACEHOLDER).length - 1;
  const lines = body.split("\n");
  const top = topLevelLines(lines);
  // A placeholder inside a code fence, an HTML comment or frontmatter would
  // have Mullion's region (whose conventions text may itself contain a fence)
  // spliced into that block.
  const placeholderLines = lines.filter(
    (l, i) => top[i] && l.trim() === MULLION_REGION_PLACEHOLDER,
  );
  if (occurrences !== 1 || placeholderLines.length !== 1) {
    throw new GenerationOutputError(
      `restructured AGENTS.md must contain ${MULLION_REGION_PLACEHOLDER} exactly once, on its own ` +
        `top-level line, outside any code block or comment (found ${occurrences}) — regenerate`,
    );
  }
  if (MULLION_MARKER_RE.test(body)) {
    throw new GenerationOutputError(
      "restructured AGENTS.md carries a Mullion marker of its own — it must use only the " +
        "placeholder line; regenerate",
    );
  }
  if (/^##\s+Workflow Conventions\s*$/im.test(body)) {
    throw new GenerationOutputError(
      "restructured AGENTS.md has its own '## Workflow Conventions' section — Mullion's region " +
        "supplies that; regenerate",
    );
  }
  return body;
}

function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Heuristic (issue #2316): did the rewrite lose more than a restructure
 * should? True when the rewrite plus anything moved to CONTRIBUTING.md is
 * under 30% of the original's size (Mullion's own region, which the original
 * may already carry, is excluded from the original), or when the original
 * has at least four `##` sections and more than 60% of their titles appear
 * nowhere in the rewrite or the moved text. Dropping the workflow rules is
 * the point of a restructure, so a single vanished section is expected; this
 * only catches wholesale loss. A signal for the reviewer, never a failure. */
export function assessRewrite(
  originalAgentsMd: string,
  rewrite: string,
  contributingAppend?: string,
): boolean {
  const startIdx = originalAgentsMd.indexOf(SCAFFOLD_REGION_START);
  const endIdx = startIdx === -1 ? -1 : originalAgentsMd.indexOf(SCAFFOLD_REGION_END, startIdx);
  const original =
    startIdx !== -1 && endIdx > startIdx
      ? originalAgentsMd.slice(0, startIdx) +
        originalAgentsMd.slice(endIdx + SCAFFOLD_REGION_END.length)
      : originalAgentsMd;
  if (original.trim().length === 0) return false;
  const kept = rewrite.replace(MULLION_REGION_PLACEHOLDER, "") + (contributingAppend ?? "");
  if (kept.trim().length < original.trim().length * 0.3) return true;
  const lines = original.split("\n");
  const top = topLevelLines(lines);
  const titles = lines
    .filter((l, i) => top[i] && /^##\s+\S/.test(l))
    .map((l) => normalizeForCompare(l.replace(/^##\s+/, "")))
    .filter((t) => t.length > 0);
  if (titles.length < 4) return false;
  const haystack = normalizeForCompare(kept);
  const vanished = titles.filter((t) => !haystack.includes(t)).length;
  return vanished / titles.length > 0.6;
}

/**
 * Post-generation heuristic (issue #1145): checks whether the generated
 * content references concrete file paths from the repo. A turn that read
 * nothing from the repo (e.g. agy with all tool calls denied, or a
 * misconfigured permission set) produces plausible-looking but generic
 * content with no real file references.
 *
 * Returns `{ possiblyGeneric: true }` when the content references paths
 * (embedded in the text) but none of them appear to be real
 * repo-specific paths — a signal that the agent may have fabricated
 * plausible-sounding paths rather than reading real files. Content that
 * references no paths at all (pure prose with zero path tokens) is NOT
 * flagged — that's a different problem (missing specificity) this
 * heuristic does not cover.
 *
 * On first-time generates the scaffold files don't exist yet, so this
 * checks whether paths look plausible (have real extensions, follow
 * reasonable conventions) rather than checking physical existence —
 * otherwise valid content that references `.claude/skills/<slug>/SKILL.md`
 * would false-positive as generic before it's committed.
 *
 * A signal, not a hard failure. The caller surfaces it as a warning;
 * tightening to a failure is a follow-up once confidence is high.
 */
export function validateGenerationOutput(
  content: GeneratedScaffoldContent,
  _cwd: string,
): { possiblyGeneric: boolean; referencedPaths: string[] } {
  // Match file path references: src/foo.ts, lib/bar.js, test/baz.test.ts, etc.
  const pathPattern =
    /(?:^|\s|`|\()([A-Za-z0-9_/.-]+\.(?:ts|js|mjs|tsx|jsx|json|md|yaml|yml|toml|sh))\b/g;
  const allText = `${content.skill ?? ""}\n${content.reviewer ?? ""}\n${content.scaffoldRegion}`;
  const referencedPaths = new Set<string>();
  let match;
  while ((match = pathPattern.exec(allText)) !== null) {
    referencedPaths.add(match[1]);
  }

  if (referencedPaths.size === 0) {
    // No path tokens at all — a different problem (missing specificity)
    // this heuristic does not cover.
    return { possiblyGeneric: false, referencedPaths: [] };
  }

  // Instead of checking filesystem existence (which false-positives on
  // first-time generates when the scaffold files don't exist yet), check
  // whether the referenced paths look like real repo-specific files.
  const plausiblePaths = [...referencedPaths].filter((p) => {
    if (p.includes("..") || path.isAbsolute(p)) return false;
    // Reject obviously generic / placeholder patterns
    const segments = p.split("/");
    if (segments.length === 1) return false; // bare filename like `file.ts`
    if (segments.some((s) => /^(example|sample|placeholder|foo|bar|baz)$/i.test(s))) return false;
    if (/^src\/example\//i.test(p)) return false;
    // Deeper nesting is a strong signal of real content (generic templates
    // tend to produce shallow paths like `src/index.ts`)
    if (segments.length >= 3) return true;
    // Two-segment paths with reasonable dir names are plausible
    if (segments.length === 2) {
      const dir = segments[0];
      // Reject generic directory names
      if (/^(src|lib|test|tests|docs|config)$/i.test(dir)) return true;
      return false;
    }
    return false;
  });

  return {
    possiblyGeneric: plausiblePaths.length === 0,
    referencedPaths: plausiblePaths,
  };
}

export interface SpawnGenerationTurnOptions {
  agentCommand: string;
  cwd: string;
  prompt: string;
  timeoutMs: number;
  /** Issue #1133 — whether bwrap sandboxing may be applied at all, from
   * `MULLION_SCAFFOLD_GENERATE_SANDBOX_ENABLED` on whichever host actually
   * spawns this turn. Optional and defaults to `true` (sandboxing stays
   * mandatory unless a caller explicitly opts out) so every existing
   * caller/test that predates this field keeps its current behavior
   * unchanged. `false` does NOT mean "bwrap is unusable" — it means the
   * wrap is skipped even when bwrap IS usable; `defaultSpawnGenerationTurn`
   * treats the two as the same "not sandboxed" outcome for the agy
   * fail-closed guard below, but keeps the two apart in its own error
   * message. */
  sandbox?: boolean;
}

export type SpawnGenerationTurn = (opts: SpawnGenerationTurnOptions) => Promise<string>;

/** Per-agent argv for a single, non-interactive, read-restricted turn.
 * Every flag here is a REAL, documented flag of that CLI — `-p`/`exec`/
 * `run` are all independently confirmed against each adapter's own
 * `initialPromptArgs` comment in hook-adapters/*.ts (see this module's
 * header). What is NOT independently verified against a live binary for
 * every one of these four CLIs is that the tool-restriction flag actually
 * blocks every write path (`--allowedTools` is confirmed Claude Code
 * surface). Issue #1081's own re-check (this module's header has the full
 * detail): codex's `--sandbox read-only` is a real, accepted flag but its
 * write-blocking behavior is unverified (usage-limited account, quota
 * resets 2026-09-28); agy DOES have a `--sandbox` flag as of 1.1.27, but it
 * blocks nothing once tool calls are enabled at all (this module's header
 * has the live `echo pwned` detail) — containment for it rests entirely on
 * `wrapWithSandbox`'s bwrap wrap, same as the other three; opencode's plain
 * `run` still has no write-restriction flag at all. The worktree-isolation
 * design above is what the actual "never reaches disk" guarantee rests on
 * regardless of whether any of these flags hold in practice.
 *
 * `agy`'s own argv (issue #1130) needs two things together, not one:
 * `-p=<prompt>` — NOT `-p <prompt>` or `-p -i=<prompt>` (a previous,
 * shipped form of this function) — because agy's own flag parser treats
 * whatever token immediately follows a bare `-p` as an unrelated
 * positional, silently dropping the real prompt (agy's own error message,
 * reproduced live: `-p took "-i=..." as its prompt, so the intended prompt
 * was left as an argument and ignored`); and
 * `--dangerously-skip-permissions`, because agy auto-denies every tool
 * call in headless/print mode without it — including the read-only ones
 * this module's prompt requires (`buildGenerationPrompt`: "your entire job
 * is to READ the codebase") — confirmed live: a tool-using prompt without
 * this flag returns empty stdout, sandboxed and unsandboxed alike, so a
 * turn that merely stops erroring but still lacks this flag can complete
 * having read nothing and silently author content blind.
 *
 * Deliberately does NOT also add `--mode accept-edits`, unlike
 * `launch-plan.ts`'s SKIP_PERMISSION_FLAGS.agy entry for a different,
 * interactive, write-capable spawn path. That entry's own comment records
 * a real incident (Task Master trial 220921 / PR #743): agy has a
 * SEPARATE, sticky, global `agentMode` setting
 * (`~/.gemini/antigravity-cli/settings.json`) that
 * `--dangerously-skip-permissions` alone does NOT override, and a host
 * left in `agentMode: "plan"` silently refuses every `write_to_file` even
 * with that flag set. This module's own turn is read-only by prompt
 * design (`buildGenerationPrompt`: "Do not create, edit, or delete any
 * file"), so that failure mode should not apply here — and this was
 * checked, not merely assumed: this repo's own dev box had
 * `agentMode: "plan"` at verification time (2026-09-07,
 * test/e2e/scaffold-generate-agy.e2e.test.ts's own live run), and agy's
 * READ tool calls still succeeded under `-p=<prompt>
 * --dangerously-skip-permissions` alone — the write-refusal in the
 * `launch-plan.ts` incident is specific to write tool calls, not reads. If
 * a future change to this module's own prompt ever asks the agent to
 * write anything, this reasoning no longer holds and `--mode accept-edits`
 * would need to be re-evaluated the same way. */
// Hermes review, PR #1152 — exported (was module-private) so the exact
// argv can be pinned by a real, CI-enforced unit test rather than relying
// solely on the agy-gated e2e (test/e2e/scaffold-generate-agy.e2e.test.ts),
// which skips wherever agy isn't installed, including CI's own test-e2e
// job. Issue #1130's whole bug was a subtle argv mistake (a bare `-p`
// swallowing the next token as its own prompt) that this module's own
// mocked-spawn tests couldn't have caught either — a plain equality
// assertion on this function's return value closes that gap for any
// future accidental reorder/typo.
export function buildInvocation(
  agentCommand: string,
  prompt: string,
): { bin: string; args: string[] } {
  switch (agentCommand) {
    case "claude":
      return {
        bin: "claude",
        args: [
          "-p",
          "--allowedTools",
          "Read,Grep,Glob,Bash(git log:*),Bash(git diff:*),Bash(git show:*),Bash(find:*),Bash(ls:*)",
          "--",
          prompt,
        ],
      };
    case "codex":
      return {
        bin: "codex",
        args: ["exec", "--sandbox", "read-only", "--", prompt],
      };
    case "opencode":
      return {
        bin: "opencode",
        args: ["run", "--", prompt],
      };
    case "agy":
      return {
        bin: "agy",
        args: [`-p=${prompt}`, "--dangerously-skip-permissions"],
      };
    default:
      throw new UnsupportedGenerationAgentError(agentCommand);
  }
}

/** Result shape for `wrapWithSandbox` — deliberately the same `{ bin, args
 * }` shape `buildInvocation` returns, so a caller can treat "wrapped" and
 * "unwrapped" invocations identically. Issue #1101 (a later, stacked PR)
 * reuses this exact function for a new agent-side remote-generation-turn
 * handler — keep the first three parameters (`bin`, `args`, `worktreePath`
 * — no dependency on this module's own types) stable for that reuse; the
 * fourth (`extraWritablePaths`) is additive and defaults to empty, so a
 * caller with none can still invoke this exactly as before. */
export interface SandboxedInvocation {
  bin: string;
  args: string[];
}

/** Shared by `wrapWithSandbox` (real invocations) and
 * `buildBwrapSmokeTestInvocation` (the capability probe, and the test
 * suite's own sync gate for the live tests — see that test file) so the
 * two can never silently drift apart: a future flag change only has to
 * happen in this one place. `worktreePath` is bound with a hard `--bind`
 * (it is guaranteed to exist — `generateScaffoldContent` only ever calls
 * this after `createWorktree` succeeds — so a missing path here SHOULD be
 * a loud failure, not a silent skip). `extraWritablePaths` are bound with
 * `--bind-try` instead: these are optional, may not exist on a given host
 * (e.g. an agent CLI that has never run there yet), and a missing one
 * should never turn into a sandbox failure. Bind order matters and must
 * not be changed casually: the more specific, writable binds only
 * override the broader `--ro-bind / /` because they are listed after it —
 * bwrap applies bind mounts in argument order. Reordering would silently
 * make every bound-writable path read-only again. */
function buildBwrapBaseArgs(
  worktreePath: string,
  extraWritablePaths: string[],
  fakeHome?: string,
): string[] {
  return [
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--bind",
    worktreePath,
    worktreePath,
    ...extraWritablePaths.flatMap((p) => ["--bind-try", p, p]),
    // When a fakeHome is provided, bind it writable and set HOME so the
    // CLI resolves all $HOME-relative writes (state dirs, credentials,
    // tmp) inside the disposable worktree instead of the operator's real
    // HOME. This is the mechanism that makes the narrowed binds actually
    // work: without it, the CLI would write to the real ~/.codex/ or
    // ~/.local/share/opencode/ regardless of what --bind-try targets.
    ...(fakeHome
      ? [
          "--bind",
          fakeHome,
          fakeHome,
          "--setenv",
          "HOME",
          fakeHome,
          // /tmp is read-only here (--ro-bind / /); point TMPDIR at a directory
          // inside the writable fake HOME instead.
          "--setenv",
          "TMPDIR",
          path.join(fakeHome, "tmp"),
        ]
      : []),
    "--die-with-parent",
  ];
}

/** Per-agent extra writable binds, additive to the scratch worktree bind.
 * Issue #1081's live re-check (this module's own header) found the bare
 * worktree bind is NOT sufficient for every agent this module supports —
 * `codex` and `opencode` both write to their own state/log directories
 * under `$HOME` on every invocation and hard-fail (EROFS) if they can't,
 * even for a read-only generation turn. Verified live on a real dev
 * sandbox (2026-09-06): `codex exec` fails with "failed to initialize
 * in-process app-server client: Read-only file system" unless `~/.codex`
 * is writable; `opencode run` fails with "Unknown: FileSystem.open
 * (~/.local/share/opencode/log/opencode.log)" unless that directory is
 * writable. Both were re-verified live after adding the corresponding
 * bind below — codex proceeded to a real (rate-limited, no-cost) turn,
 * opencode proceeded to a real model call. `claude -p` needed no extra
 * bind to complete successfully (confirmed live, no `--bind-try`
 * entries) — but it is not silent about it: `strace` on that same live
 * run shows Claude Code repeatedly attempting several housekeeping
 * writes under `$HOME` (plugin-cache `.in_use` lock files, MCP
 * auth-cache, a per-run `session-env/<uuid>` directory,
 * `.claude.json`/`.claude.json.lock` atomic-rename writes) that all fail
 * silently with EROFS and are tolerated — this is "doesn't need to
 * write," not "doesn't try to." `agy`'s own PRE-EXISTING argument-parsing
 * quirk (fixed in `buildInvocation`, issue #1130) originally blocked
 * verifying its filesystem needs the same way here. Re-verified live after
 * that fix (2026-09-07, same box, same production bwrap argv `agy` runs
 * under today): `agy` also needs no extra bind — it completed cleanly
 * (exit 0, correct stdout) with the bare worktree bind alone, same
 * "doesn't need to write" class as `claude` above (22 tolerated EROFS
 * events under `~/.gemini/antigravity-cli/`: log, crashes, conversations,
 * cache, mcp, presence). This is now a verified result, not an
 * undiscovered gap.
 *
 * Be honest about the tradeoff this makes: these are directory-level binds
 * (`~/.codex`, `~/.local/share/opencode`), not narrowed to just the one
 * file each agent was observed writing — which means each agent's own
 * credential file (`~/.codex/auth.json`, `~/.local/share/opencode/
 * auth.json`) is writable inside the sandbox too, not just its log/session
 * state. A compromised or badly-behaved generation turn could corrupt the
 * operator's real, non-sandboxed codex/opencode auth on this host — a
 * genuinely smaller but real mutation surface than "the entire
 * filesystem" (the pre-#1081 baseline), not a zero one. Narrowing this
 * further (e.g. bind-mounting only the exact session/log file each CLI
 * needs) was deliberately not attempted: opencode's own session state
 * lives in `opencode.db` (confirmed via file mtime, not just the log
 * directory the first error message named), so a log-only bind would
 * likely just move the EROFS failure rather than remove it, and codex's
 * mid-turn (not just startup) write behavior can't be verified further
 * until its rate limit resets (2026-09-28, see this module's header) —
 * so a narrower bind can't be verified either. Tracked as real follow-up
 * work, not silently accepted scope creep (issue #1131).
 *
 * Issue #1131's eventual write-surface audit must NOT narrow these binds
 * by simply shadowing the credential file read-only (e.g. keeping the
 * directory `--bind-try` and adding a later, more-specific `--ro-bind-try`
 * over just the credential file). That was prototyped: it works
 * mechanically (opencode completed a real turn with `auth.json`
 * read-only), but both CLIs rotate their own credentials in place —
 * `~/.codex/auth.json` carries `tokens.refresh_token` + `last_refresh`,
 * and `~/.local/share/opencode/auth.json` carries an OAuth provider entry
 * with `refresh`/`access`/`expires` — so a read-only credential file
 * breaks the agent the first time its access token expires mid-turn: a
 * "works for two weeks, then breaks for everyone at once" failure. Any
 * narrower bind the audit lands on must leave the credential file
 * writable.
 *
 * Issue #1131's strace audit (2026-09-15) narrowed these from whole-
 * directory binds to the minimal file set each agent actually writes to
 * during a non-interactive generation turn. The audit found:
 *
 * codex writes to: `queue_1.sqlite` + WAL, `state_5.sqlite` + WAL,
 * `cache/remote_plugin_catalog/` (temp files), `thread-writer-locks/`
 * (coordination lock), `sessions/<date>/rollout-*.jsonl` (session
 * rollout), and unlinks `shell_snapshots/`, `*-sqlite-shm`,
 * `*-sqlite-wal` for cleanup. It does NOT write to `auth.json` (read-
 * only during generation), `config.toml`, `hooks.json`, or `skills/`.
 *
 * opencode writes to: `log/opencode.log`, `opencode.db` + WAL + SHM,
 * `snapshot/<hash>/` (git snapshot data). It does NOT write to
 * `auth.json` (read-only during generation), `account.json`, or
 * `mcp-auth.json`.
 *
 * Both CLIs' credential files (`auth.json`) MUST remain writable for
 * token rotation even though they're not written during a typical
 * generation turn — an access token expiring mid-turn triggers an
 * in-place credential update. */
export type AgentSandboxWritablePaths = { dirs: string[]; files: string[] };

export function agentSandboxWritablePaths(
  agentCommand: string,
  homeOverride?: string,
): AgentSandboxWritablePaths {
  const home = homeOverride ?? os.homedir();
  switch (agentCommand) {
    case "codex": {
      const codexHome = path.join(home, ".codex");
      return {
        dirs: [
          path.join(codexHome, "cache", "remote_plugin_catalog"),
          path.join(codexHome, "thread-writer-locks"),
          // sessions/<date>/rollout-*.jsonl — dynamic date subdirectories
          // created by codex at runtime; bwrap lacks glob support, so the
          // parent dir is the narrowest practical bind.
          path.join(codexHome, "sessions"),
          // sqlite files experience unlink+recreate cycles (journal, tmp)
          // that break under single-file --bind-try: unlinking detaches
          // the source inode, and recreate lands on the read-only rootfs.
          // Binding the parent dir is the narrowest option that survives
          // this pattern while still excluding config.toml, hooks.json,
          // and skills/.
          codexHome,
        ],
        files: [path.join(codexHome, "auth.json")],
      };
    }
    case "opencode": {
      const opencodeData = path.join(home, ".local", "share", "opencode");
      return {
        dirs: [
          path.join(opencodeData, "log"),
          // snapshot/<hash>/ — dynamic hash subdirectories created by
          // opencode at runtime; same dir-level bind rationale as codex's
          // sessions/ above.
          path.join(opencodeData, "snapshot"),
          // repos/ — created on first run; discovered via narrowed-set
          // live test (the original strace ran under the wide dir bind
          // where this directory already existed).
          path.join(opencodeData, "repos"),
        ],
        files: [
          path.join(opencodeData, "opencode.db"),
          path.join(opencodeData, "opencode.db-wal"),
          path.join(opencodeData, "opencode.db-shm"),
          path.join(opencodeData, "auth.json"),
        ],
      };
    }
    case "claude": {
      // Claude Code's OAuth login. Without it the sandboxed turn starts logged
      // out ("Not logged in · Please run /login", exit 1). Only this one file is
      // seeded: the operator's real ~/.claude (settings, hooks, session
      // history) is never bound into the sandbox.
      return { dirs: [], files: [path.join(home, ".claude", ".credentials.json")] };
    }
    default:
      return { dirs: [], files: [] };
  }
}

/** `wrapWithSandbox`'s `extraWritablePaths` are bound with `--bind-try`
 * (see `buildBwrapBaseArgs`'s own comment), which bwrap defines as
 * skipping the bind ENTIRELY when the source is missing — it does not
 * create anything. That is correct for a path that has never existed and
 * never will, but WRONG for these specific per-agent state directories: a
 * freshly provisioned host (or one where this particular agent has simply
 * never run before) genuinely has no `~/.codex`/`~/.local/share/opencode`
 * yet, `--bind-try` would then silently skip the bind, and the directory
 * would stay read-only under the broader `--ro-bind / /` — so the very
 * first `mkdir`/write codex or opencode does there fails with EROFS all
 * over again, on exactly the hosts where the fix in
 * `agentSandboxWritablePaths` was supposed to help most. Called before
 * `wrapWithSandbox` so the path is guaranteed to exist by the time bwrap's
 * `--bind-try` runs. Best-effort (`mkdirSync`'s own error is swallowed,
 * not surfaced) — if directory creation somehow still fails (e.g. a
 * permissions oddity unrelated to sandboxing), the behavior degrades to
 * exactly the pre-existing `--bind-try`-skips-a-missing-path case, not a
 * new failure mode.
 *
 * `mkdirSync` and `writeFileSync` here are filesystem-write sinks, and
 * every path reaching them comes from `agentSandboxWritablePaths(fakeHome)`
 * — a hardcoded literal subpath under the disposable HOME, whose own root
 * derives from the scratch worktree path (CodeQL js/path-injection, alert
 * #302). `root` enforces that containment at the sink itself: each entry
 * is `path.resolve`d and skipped unless it sits strictly inside `root`, so
 * a future entry that escaped the disposable HOME (an absolute literal, a
 * `..` segment) is dropped rather than created on the real filesystem.
 *
 * Issue #1131 narrowed `agentSandboxWritablePaths` from whole-directory
 * binds to specific files (e.g. `opencode.db`, `auth.json`) and
 * subdirectories (e.g. `log/`, `snapshot/`). This function now handles
 * both: directories via `mkdirSync(p, { recursive: true })` (unchanged),
 * and files via `mkdirSync` on the parent directory + `writeFileSync` to
 * create an empty file if missing. The file MUST be created (not just the
 * parent dir) because `--bind-try` binds the exact source path — if the
 * source file doesn't exist, the bind is skipped entirely, and the
 * destination stays read-only under `--ro-bind / /`. Creating an empty
 * file is safe: the agent CLI will overwrite it on first write. */
export function ensureSandboxWritablePathsExist(
  paths: { dirs: string[]; files: string[] },
  root: string,
): void {
  const rootPrefix = path.resolve(root) + path.sep;
  for (const entry of paths.dirs) {
    const p = path.resolve(entry);
    if (!p.startsWith(rootPrefix)) continue;
    try {
      fs.mkdirSync(p, { recursive: true });
    } catch {
      // Best-effort — see this function's own comment.
    }
  }
  for (const entry of paths.files) {
    const p = path.resolve(entry);
    if (!p.startsWith(rootPrefix)) continue;
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      // A symlink checked out of the repo must not redirect the placeholder.
      if (!resolvesInside(root, path.dirname(p))) continue;
      // createFile if missing — not writeFileSync (which would clobber
      // existing content). `wx` fails with EEXIST if the file already
      // exists, which is the desired outcome.
      fs.writeFileSync(p, "", { flag: "wx" });
    } catch {
      // Best-effort — same degradation as the dir case above.
    }
  }
}

/** True when `dir`, with every symlink resolved, is still inside `root`. */
function resolvesInside(root: string, dir: string): boolean {
  try {
    const realRoot = fs.realpathSync(root);
    const realDir = fs.realpathSync(dir);
    return realDir === realRoot || realDir.startsWith(realRoot + path.sep);
  } catch {
    return false;
  }
}

/** The credential files `createAgentSandboxHome` seeds into the disposable
 * HOME and `persistAgentSandboxAuth` copies back (codex/opencode `auth.json`,
 * claude `.credentials.json`). */
function isSeededCredentialFile(file: string): boolean {
  const base = path.basename(file);
  return base === "auth.json" || base === ".credentials.json";
}

/** Creates a disposable HOME directory inside the scratch worktree for a
 * sandboxed generation turn, seeding it with only the files the CLI needs
 * to write to. The operator's real ~/.codex or ~/.local/share/opencode
 * is never mounted inside the sandbox — all writes land here instead.
 *
 * This is the mechanism that makes the narrowed binds actually protect
 * the operator's state: without a fake HOME, the CLI resolves all
 * $HOME-relative writes to the real HOME regardless of what
 * `--bind-try` targets are specified.
 *
 * Returns the fake HOME path and the writable paths (dirs + files)
 * relative to it, ready for `ensureSandboxWritablePathsExist` and
 * `wrapWithSandbox`.
 *
 * CodeQL's js/path-injection flags `worktreePath` here (the same
 * "real mitigation, not a CodeQL-recognized sanitizer shape" pattern
 * documented at defaultSpawnGenerationTurn's own comment, lines
 * 1036-1049): `worktreePath` is always `cwd` from
 * `defaultSpawnGenerationTurn`, which is the scratch generation worktree
 * from `createWorktree` — never user-controlled; the only
 * request-derived input is `slug`, gated by `isValidScaffoldSlug` at the
 * route boundary. All paths here are `path.join(worktreePath,
 * ".agent-home")` + hardcoded literal subpaths from
 * `agentSandboxWritablePaths`, which itself joins a home override with
 * hardcoded `[A-Za-z0-9/-_]+` subpaths. Dismissed in GHAS as a false
 * positive via the Security API rather than reshaping already-verified-
 * safe code to chase a query that doesn't model manual containment
 * checks as sanitizers. */
export function createAgentSandboxHome(
  worktreePath: string,
  agentCommand: string,
): {
  fakeHome: string;
  writablePaths: { dirs: string[]; files: string[] };
  /** The credential files this call actually copied in. */
  seeded: string[];
} {
  const fakeHome = path.join(worktreePath, ".agent-home");
  // MUST materialize .agent-home unconditionally — bwrap's `--bind`
  // (unlike `--bind-try`) refuses to start when its source is missing.
  // For agy the writablePaths list is empty (confirmed live to need none),
  // so ensureSandboxWritablePathsExist alone wouldn't create it and every
  // sandboxed agy turn would hard-fail at bwrap startup.
  // Best-effort: if the parent worktree doesn't exist or isn't writable
  // (e.g. in tests that pass a nonexistent cwd to exercise error paths),
  // bwrap's own spawn will surface the real failure — we don't mask it
  // here. Non-recursive for exactly that reason, and the writable-path
  // creation below is skipped unless .agent-home now exists: its own
  // `recursive: true` mkdirs would otherwise materialize a missing
  // worktree themselves and mask that failure all the same.
  // The scratch worktree is a CHECKOUT OF THE PROJECT REPO, so whatever the repo
  // tracks under `.agent-home` (a symlink, or a planted
  // `.claude/.credentials.json`) is already there. The sandbox HOME must be
  // ours alone: remove it first. rmSync does not follow a symlink, it removes
  // the link itself.
  try {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  } catch {
    // Fall through — the mkdir below / bwrap's --bind surface a real problem.
  }
  let homeReady = true;
  try {
    fs.mkdirSync(fakeHome);
  } catch {
    // Fall through — bwrap's --bind will produce the real error.
    homeReady = false;
  }
  const writablePaths = agentSandboxWritablePaths(agentCommand, fakeHome);
  // Credential files THIS call copied in. Only these are ever copied back by
  // persistAgentSandboxAuth: a file the sandbox merely contains is not ours.
  const seeded: string[] = [];
  // Seed the real credentials BEFORE ensureSandboxWritablePathsExist: that call
  // creates an empty placeholder for every file in `writablePaths.files` (bwrap
  // needs a bind source), which would otherwise make the COPYFILE_EXCL copy
  // below fail with EEXIST and leave a 0-byte credential file.
  //
  // Seed from the operator's real HOME if the file exists — the CLI needs valid
  // credentials to reach its model API. If it doesn't (fresh host, or an API key
  // in the environment instead), the CLI will fail at auth, which is the correct
  // degradation; it is logged.
  const realHome = os.homedir();
  if (homeReady) {
    for (const f of writablePaths.files) {
      if (!isSeededCredentialFile(f)) continue;
      const realAuth = f.replace(fakeHome, () => realHome);
      try {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        if (!resolvesInside(fakeHome, path.dirname(f))) continue;
        // COPYFILE_EXCL instead of an existsSync pre-check (CodeQL
        // js/file-system-race, alert #301): no check-then-use window. The home
        // was just emptied, so nothing can be in the way.
        fs.copyFileSync(realAuth, f, fs.constants.COPYFILE_EXCL);
        seeded.push(f);
      } catch (err) {
        // ENOENT: the operator has no such file (fresh host, or an API key in
        // the environment). Anything else is unexpected. Either way the agent
        // starts unauthenticated, so say so.
        console.warn(
          "[scaffold-generate] no credentials seeded for %s (%s): %s",
          agentLogLabel(agentCommand),
          f.endsWith(".credentials.json") ? ".credentials.json" : "auth.json",
          String((err as NodeJS.ErrnoException).code ?? "error").replace(/[\r\n]+/g, " "),
        );
      }
    }
    ensureSandboxWritablePathsExist(writablePaths, fakeHome);
    // The sandboxed command's TMPDIR (see buildBwrapBaseArgs): /tmp is
    // read-only inside the sandbox, and tools such as `tac` (used by the nvm
    // CLI wrapper) write temp files there.
    try {
      fs.mkdirSync(path.join(fakeHome, "tmp"), { recursive: true });
    } catch {
      // Best-effort — bwrap's own spawn surfaces a real failure.
    }
  }
  return { fakeHome, writablePaths, seeded };
}

/** Copies any rotated auth.json from the disposable fake HOME back to the
 * operator's real HOME, so a provider with single-use refresh tokens (or
 * any other in-place credential rotation) sees the fresh credentials on
 * the next turn. Without this, the rotated token is discarded with the
 * scratch worktree and the operator's real auth.json keeps re-seeding the
 * same (now potentially invalidated) original token.
 *
 * Security: the rotated auth.json is ONLY copied back if it passes ALL
 * of these checks:
 *   1. Parses as valid JSON
 *   2. Is a non-empty object (not array, primitive, or null)
 *   3. Preserves the real file's top-level key set — legitimate rotation
 *      changes values, never schema; this defense-in-depth check rejects
 *      a compromised turn that writes a credential-shaped but structurally
 *      different document
 *
 * A compromised turn that fails any check leaves the real auth.json
 * untouched — the exact "trust nothing the sandbox produced" posture
 * this PR took for every other state file. The real auth.json stays
 * read-only from the sandbox's perspective, and only validated rotated
 * credentials propagate back.
 *
 * The write is atomic: write to `<realAuth>.tmp.<random>` and `rename`
 * to the target. A crash mid-write leaves the original real auth.json
 * intact (the .tmp is orphaned, not a corruption of the live file).
 *
 * CodeQL's js/path-injection flags `fakeHome` / `realHome` here (same
 * "real mitigation, not a CodeQL-recognized sanitizer shape" pattern as
 * the existing dismissal at defaultSpawnGenerationTurn, lines 1036-1049):
 * `fakeHome` is always `path.join(worktreePath, ".agent-home")` where
 * `worktreePath` is the scratch generation worktree from `createWorktree`
 * (validated via `isSafeAbsolutePath` + `sanitizeRefComponent`); `realHome`
 * is `os.homedir()`, hardcoded server-side; the only request-derived input
 * is `slug`, gated by `isValidScaffoldSlug` at the route boundary.
 * Dismissed in GHAS as a false positive via the Security API rather than
 * reshaping already-verified-safe code to chase a query that doesn't
 * model manual containment checks as sanitizers. */
export function persistAgentSandboxAuth(
  fakeHome: string,
  writablePaths: { files: string[] },
): void {
  const realHome = os.homedir();
  for (const f of writablePaths.files) {
    if (!isSeededCredentialFile(f)) continue;
    // A link in the sandbox HOME must not make this read an arbitrary file.
    if (!resolvesInside(fakeHome, path.dirname(f))) continue;
    const realAuth = f.replace(fakeHome, () => realHome);
    try {
      // Read both files first — no pre-flight existsSync check, which
      // would open a TOCTOU window (CodeQL js/file-system-race flagged
      // exactly that pattern). If either is missing, the read throws
      // and the catch skips this file.
      const sandboxed = fs.readFileSync(f, "utf8");
      const real = fs.readFileSync(realAuth, "utf8");
      if (sandboxed === real) continue; // No rotation happened
      // Parse both — we need the real file's key set for shape matching.
      const parsedSandboxed: unknown = JSON.parse(sandboxed);
      const parsedReal: unknown = JSON.parse(real);
      if (
        typeof parsedSandboxed !== "object" ||
        parsedSandboxed === null ||
        Array.isArray(parsedSandboxed) ||
        Object.keys(parsedSandboxed as Record<string, unknown>).length === 0
      ) {
        // Malformed or empty — skip copy-back to avoid corrupting real auth.
        continue;
      }
      // Schema shape check: the rotated document must preserve the real
      // file's exact top-level key set. Legitimate rotation changes
      // values, never adds/removes keys; a compromised turn that writes
      // a credential-shaped but structurally different document fails
      // this check and leaves the real auth.json untouched.
      if (typeof parsedReal !== "object" || parsedReal === null || Array.isArray(parsedReal)) {
        // Real file isn't a JSON object — schema check is inapplicable,
        // skip rather than risk corrupting a non-standard layout.
        continue;
      }
      const realKeys = Object.keys(parsedReal as Record<string, unknown>).sort();
      const sandboxedKeys = Object.keys(parsedSandboxed as Record<string, unknown>).sort();
      if (
        realKeys.length !== sandboxedKeys.length ||
        !realKeys.every((k, i) => k === sandboxedKeys[i])
      ) {
        // Key set differs — skip copy-back.
        continue;
      }
      // Atomic write: tmp file + rename. A crash mid-write leaves the
      // original real auth.json intact (the .tmp is orphaned, not a
      // corruption of the live file). The random suffix avoids races
      // between concurrent generation turns, which are not possible
      // today (defaultSpawnGenerationTurn is awaited per turn) but the
      // pattern is correct as a forward-compatible invariant.
      const tmpPath = `${realAuth}.tmp.${randomUUID()}`;
      fs.writeFileSync(tmpPath, sandboxed, { mode: 0o600 });
      fs.renameSync(tmpPath, realAuth);
    } catch {
      // Best-effort — copy-back failure (missing file, parse error, I/O
      // error) degrades to re-auth prompt, not a sandbox error. Clean
      // up any orphaned .tmp from a partial write.
      try {
        const dir = path.dirname(realAuth);
        for (const entry of fs.readdirSync(dir)) {
          if (entry.startsWith(`${path.basename(realAuth)}.tmp.`)) {
            fs.unlinkSync(path.join(dir, entry));
          }
        }
      } catch {
        // Best-effort cleanup — ignore.
      }
    }
  }
}

/** Given the resolved binary, its args, and the scratch worktree's
 * absolute path, returns the `bwrap`-wrapped invocation to hand to
 * `execFile` in place of the original. This is the EXACT confirmed
 * invocation from this module's own header comment:
 *
 *   bwrap --ro-bind / / --dev /dev --proc /proc --bind <worktreePath>
 *     <worktreePath> [--bind-try <extra> <extra> ...] --die-with-parent
 *     -- <bin> <args...>
 *
 * `extraWritablePaths` defaults to empty so a caller that has none (e.g.
 * issue #1101's later, stacked reuse of this same function for a new
 * agent-side remote-generation-turn handler) can still call this with
 * just the original three arguments — see `SandboxedInvocation`'s own
 * comment on why that reuse matters. `--die-with-parent` is what lets
 * `execFile`'s own `timeout` kill the whole sandboxed subtree via SIGTERM
 * with no orphaned children (verified live as part of issue #1081) —
 * never drop it. Deliberately no `--unshare-net`: the agent CLI itself
 * needs network access to reach its own model API. */
export function wrapWithSandbox(
  bin: string,
  args: string[],
  worktreePath: string,
  extraWritablePaths: string[] = [],
  fakeHome?: string,
): SandboxedInvocation {
  return {
    bin: "bwrap",
    args: [...buildBwrapBaseArgs(worktreePath, extraWritablePaths, fakeHome), "--", bin, ...args],
  };
}

/** Injectable probe seam — production uses `probeBwrapSmokeTest` below;
 * tests inject a fake so the cached-capability behavior can be exercised
 * without depending on this exact machine's `bwrap` availability. */
export type SandboxCapabilityProbe = () => Promise<boolean>;

/** Exported purely so the test suite's own synchronous `describeIfBwrap`
 * gate (see test/services/scaffold-generate.test.ts) can run the IDENTICAL
 * invocation this probe uses, rather than hand-duplicating a second,
 * possibly-divergent flag list that could pass or fail differently from
 * the real thing. There is no real scratch worktree at probe time, so
 * `os.tmpdir()` stands in for it — the same directory family
 * `generateScaffoldContent` already uses as `baseDir` for every scratch
 * worktree, so it is guaranteed to exist and be writable by this process
 * on every host this runs on. No `extraWritablePaths` here deliberately —
 * this probe proves the base bwrap/kernel mechanics work (bind mounts,
 * `--dev`/`--proc`, `--die-with-parent`, unprivileged user namespaces),
 * not that every per-agent path a specific CLI needs is covered; that is
 * what `agentSandboxWritablePaths` above is for, checked against reality
 * (not merely presence) the same live way — see its own comment. */
export function buildBwrapSmokeTestInvocation(): SandboxedInvocation {
  const probeBindPath = os.tmpdir();
  return {
    bin: "bwrap",
    args: [...buildBwrapBaseArgs(probeBindPath, []), "--", "/bin/true"],
  };
}

/** The real probe: actually runs a trivial no-op `bwrap` invocation and
 * treats a clean exit as "usable." Deliberately NOT `command -v bwrap` —
 * the real blocker in practice is the kernel's `unprivileged_userns_clone`
 * sysctl (or an equivalent AppArmor/kernel-hardening restriction), which
 * presence-on-PATH says nothing about; only actually running it proves
 * anything. */
function probeBwrapSmokeTest(): Promise<boolean> {
  const { bin, args } = buildBwrapSmokeTestInvocation();
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 5000 }, (err) => {
      resolve(!err);
    });
  });
}

/** Module-scope cache — the probe above is a real subprocess spawn, so
 * re-running it on every single `generateScaffoldContent` call would add
 * real latency to every scaffold generation turn for no benefit: bwrap's
 * usability on a given host does not change during a process's lifetime.
 * Cached as a lazily-created promise (not a plain boolean) so concurrent
 * callers during the very first check all await the same in-flight probe
 * rather than each kicking off their own. `resetSandboxCapabilityCache`
 * exists purely for tests — production code never calls it. */
let cachedCapability: Promise<boolean> | null = null;

export function resetSandboxCapabilityCache(): void {
  cachedCapability = null;
}

/** Returns whether sandboxing via `bwrap` is usable on this host, running
 * the (real or injected) smoke probe at most once per process — see the
 * module-scope cache above. On a failed probe, logs a warning naming
 * exactly what protection is being skipped and returns `false`; callers
 * are expected to fall back to today's unsandboxed `execFile` behavior
 * (graceful degrade, not a hard failure — see this module's own header for
 * why an arbitrary self-hosted host may genuinely lack a usable bwrap). */
export function isSandboxCapable(
  probe: SandboxCapabilityProbe = probeBwrapSmokeTest,
): Promise<boolean> {
  if (cachedCapability === null) {
    cachedCapability = probe()
      .catch(() => false)
      .then((usable) => {
        if (!usable) {
          console.warn(
            "[scaffold-generate] bwrap is not usable on this host (binary missing, or the " +
              "kernel/policy does not permit unprivileged user namespaces) — scaffold " +
              "generation turns will run WITHOUT process-level sandboxing; the structural " +
              "guarantee (the scratch worktree never feeds the PR pipeline directly) is the " +
              "only protection in effect until this is resolved. claude and codex retain " +
              "their own CLI-level tool restriction even unsandboxed; opencode has none " +
              "(full write/exec as the server user) and agy now refuses to run at all on " +
              "this fallback rather than doing the same (issue #1130). See " +
              "scaffold-generate.ts's own header comment for detail.",
          );
        }
        return usable;
      });
  }
  return cachedCapability;
}

/** The server-controlled parent directory every scratch generation
 * worktree is created under — see `runGenerationTurnInScratchWorktree`'s
 * `baseDir` comment for why it's `os.tmpdir()`-rooted and wholly unrelated
 * to the project checkout. Also the containment root
 * `defaultSpawnGenerationTurn` holds its `cwd` to. */
export function scaffoldGenerateBaseDir(): string {
  return path.join(os.tmpdir(), "mullion-scaffold-generate");
}

const FAILURE_LOG_TAIL_CHARS = 2000;
const FAILURE_MESSAGE_TAIL_CHARS = 300;

/** Noise an agent CLI prints that says nothing about why the turn failed. */
const HARMLESS_STDERR_LINE = /^Warning: no stdin data received in \d+s/i;

/** Credentials an agent turn could echo (it can read its own credentials file).
 * Applied to every tail that is logged or put in the 502 message. */
const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[\w-]+/g,
  /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g,
  /("?(?:access|refresh|id)_?[Tt]oken"?\s*[:=]\s*)"?[^"\s,}]+"?/g,
  /\bBearer\s+[\w.~+/=-]+/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, prefix) =>
      typeof prefix === "string" ? `${prefix}"[redacted]"` : "[redacted]",
    );
  }
  return out;
}

/** A fixed label for the agent in log lines. The agent command arrives from a
 * request or project setting; the log gets only the literal it matched, never
 * the caller's string. */
function agentLogLabel(agentCommand: string): string {
  switch (agentCommand) {
    case "claude":
      return "claude";
    case "codex":
      return "codex";
    case "opencode":
      return "opencode";
    case "agy":
      return "agy";
    default:
      return "unknown agent";
  }
}

function tail(text: string | Buffer | undefined, max: number): string {
  const t = redactSecrets((text ?? "").toString()).trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
}

type ExecFailure = Pick<ExecException, "code" | "killed" | "signal" | "message">;

function describeExit(err: ExecFailure): string {
  if (err.killed || err.signal) return `killed by ${err.signal ?? "a signal"}`;
  if (typeof err.code === "number") return `exit code ${err.code}`;
  // A spawn error (ENOENT, EACCES, …): the code alone says nothing, the message does.
  return (err.message ?? "unknown error").split("\n")[0].slice(0, 200);
}

/** The message of a failed generation turn: how it ended, then the tail of what
 * the CLI printed. stdout is included because `claude -p` reports its errors
 * there ("Not logged in"), and known-harmless stderr lines are dropped so they
 * cannot mask the real cause. Bounded: the message ends up in a 502 body. */
export function describeSpawnFailure(
  err: ExecFailure,
  stdout: string | Buffer | undefined,
  stderr: string | Buffer | undefined,
): string {
  const cleanedStderr = (stderr ?? "")
    .toString()
    .split("\n")
    .filter((line) => !HARMLESS_STDERR_LINE.test(line.trim()))
    .join("\n");
  const parts = [describeExit(err)];
  const out = tail(stdout, FAILURE_MESSAGE_TAIL_CHARS);
  const errText = tail(cleanedStderr, FAILURE_MESSAGE_TAIL_CHARS);
  if (out) parts.push(`stdout: ${out}`);
  if (errText) parts.push(`stderr: ${errText}`);
  return parts.join(" — ");
}

/** The real, production spawn — a bare, argv-array `execFile` (never a
 * shell string: the prompt embeds arbitrary repo-derived and DB-seed text,
 * so this avoids shell-injection risk entirely rather than relying on
 * quoting it correctly). Overridable via `generateScaffoldContent`'s own
 * `spawn` parameter so tests never actually invoke a real CLI/LLM call —
 * same "inject the one seam that does real I/O" shape as this codebase's
 * other externally-mockable service boundaries.
 *
 * `cwd` is `worktreeResult.path` from `createWorktree` (which itself runs
 * `isSafeAbsolutePath` on the project cwd and gates the seed through
 * `sanitizeRefComponent`, which collapses anything outside
 * `[A-Za-z0-9_.-]` to `-` and rejects empty-after-sanitize), always placed
 * under the server-controlled `scaffoldGenerateBaseDir()`. That placement
 * is enforced again here, at the spawn itself (CodeQL js/path-injection,
 * alert #303): `cwd` is `path.resolve`d and refused unless it sits
 * strictly inside `scaffoldGenerateBaseDir()`, so an agent turn — which
 * writes into its cwd — can never be pointed at the real project checkout
 * or anywhere else on disk. */
export const defaultSpawnGenerationTurn: SpawnGenerationTurn = async ({
  agentCommand,
  cwd,
  prompt,
  timeoutMs,
  sandbox,
}) => {
  const spawnCwd = path.resolve(cwd);
  if (!spawnCwd.startsWith(scaffoldGenerateBaseDir() + path.sep)) {
    throw new GenerationSpawnError(
      agentCommand,
      `refusing to run outside the scratch generation worktree root (cwd "${cwd}")`,
    );
  }
  const { bin, args } = buildInvocation(agentCommand, prompt);
  // `cwd` here is always the scratch generation worktree (see
  // `generateScaffoldContent` below) — never the real project checkout —
  // so it is exactly the path `wrapWithSandbox` should punch a writable
  // hole for.
  // `isSandboxCapable` only gates on whether bwrap/the kernel mechanics it
  // needs work AT ALL (see that function's own comment) — it does not
  // predict whether THIS call's specific bind set will succeed. If a
  // wrapped invocation fails for a bwrap-specific reason `isSandboxCapable`
  // didn't cover, it surfaces as an ordinary `GenerationSpawnError` rather
  // than transparently retrying unsandboxed: distinguishing "bwrap itself
  // failed to mount something" from "the agent CLI genuinely errored" isn't
  // reliably decidable from an exit code/stderr alone, so no such retry is
  // attempted here — a known, accepted limitation, not an oversight.
  //
  // Issue #1133 — `sandbox ?? true` is the config opt-out
  // (MULLION_SCAFFOLD_GENERATE_SANDBOX_ENABLED). Short-circuits BEFORE
  // calling `isSandboxCapable()` when explicitly disabled: there is no
  // reason to pay for a real bwrap smoke-test probe (and no reason to log
  // its "bwrap is not usable" warning, which would be misleading here —
  // bwrap may well be usable, sandboxing was just turned off) when the
  // result would be discarded either way.
  const sandboxRequested = sandbox ?? true;
  const sandboxUsable = sandboxRequested ? await isSandboxCapable() : false;
  // Hermes review, PR #1152 — `--dangerously-skip-permissions` (added to
  // agy's own argv above, issue #1130) is the only flag here that GRANTS
  // tool access rather than restricting it; claude's `--allowedTools` and
  // codex's `--sandbox read-only` are real (if imperfectly verified) CLI-
  // level restrictions that still apply on this exact no-bwrap fallback.
  // Before #1130, agy was effectively inert on this fallback (it
  // auto-denied every tool call without that flag) — safe by accident, not
  // by design. Now that it has real tool access, an unsandboxed agy turn
  // has full write+exec as the server user, with only the prompt's own
  // advisory "do not create/edit/delete" instruction as a stop — on
  // arbitrary repo/seed content, a real prompt-injection surface. Fail
  // closed here rather than silently degrade the way the other two agents
  // (claude, codex) do: this specific exposure is new as of #1130's own
  // fix, so it gets a guard scoped to it. opencode's plain `run` has the
  // identical no-restriction-flag gap (this module's own header) and is
  // now also fail-closed (#1153).
  // Hermes review, PR #1152/#1164 — shared per-agent fail-closed guard for
  // agents that lack CLI-level write-restriction flags. agy's
  // --dangerously-skip-permissions (#1130) GRANTS tool access rather than
  // restricting it; opencode's plain `run` has the identical no-restriction-
  // flag gap (this module's header). Both must fail closed when bwrap is
  // unavailable or sandboxing was explicitly opted out, rather than silently
  // degrading the way claude/codex do. The map keeps the two blocks'
  // wording in one place so they can't drift apart — the per-agent params
  // are the agent name, the reason-specific explanation, and an optional
  // remedy that overrides the generic "to use this agent here" advice.
  const SANDBOX_REQUIRED_AGENTS: Record<
    string,
    { prefix: string; fallback: string; remedy?: { unusable: string; disabled: string } }
  > = {
    agy: {
      prefix: "agy requires a usable bwrap sandbox for scaffold generation",
      fallback:
        "--dangerously-skip-permissions (needed for agy to read the repo at all) would " +
        "leave it with full write/exec access as the server user and no CLI-level " +
        "restriction to fall back on. ",
    },
    opencode: {
      prefix: "opencode requires a usable bwrap sandbox for scaffold generation",
      fallback:
        "opencode run has no CLI-level write-restriction flag to fall back on, " +
        "leaving it with full write/exec access as the server user. ",
      remedy: {
        unusable:
          "Install/enable bwrap on this host, or switch to claude/codex for scaffold generation.",
        disabled:
          "Re-enable sandboxing on this host, or switch to claude/codex for scaffold generation.",
      },
    },
  };
  const agentSandboxGuard = SANDBOX_REQUIRED_AGENTS[agentCommand];
  if (!sandboxUsable && agentSandboxGuard) {
    // Issue #1133 — this guard fires identically whether bwrap is merely
    // unusable OR sandboxing was explicitly opted out via
    // MULLION_SCAFFOLD_GENERATE_SANDBOX_ENABLED=false: the opt-out is not
    // an escape hatch for these agents, since bwrap is their only
    // containment once their respective unrestricted flags are in play (this
    // module's own header). The message is reason-aware purely so an
    // operator who deliberately set the opt-out isn't told to go install
    // bwrap.
    const reason = sandboxRequested
      ? "bwrap is not usable on this host"
      : "sandboxing was explicitly disabled (MULLION_SCAFFOLD_GENERATE_SANDBOX_ENABLED=false)";
    const remedy = sandboxRequested
      ? (agentSandboxGuard.remedy?.unusable ??
        "Install/enable bwrap on this host to use this agent here.")
      : (agentSandboxGuard.remedy?.disabled ??
        "Re-enable sandboxing on this host (or use a different agent) to use this agent here.");
    throw new GenerationSpawnError(
      agentCommand,
      `${agentSandboxGuard.prefix} — ${reason}, and without it, ${agentSandboxGuard.fallback}` +
        remedy,
    );
  }
  let invocation = { bin, args };
  let sandboxHome:
    { fakeHome: string; writablePaths: { files: string[] }; seeded: string[] } | undefined;
  if (sandboxUsable) {
    // Create a disposable HOME inside the scratch worktree so the CLI's
    // writes (state dirs, sqlite, tmp files) land here instead of the
    // operator's real HOME. The fake HOME is seeded with auth.json from
    // the real HOME (if it exists) so the CLI can reach its model API.
    const { fakeHome, writablePaths, seeded } = createAgentSandboxHome(spawnCwd, agentCommand);
    sandboxHome = { fakeHome, writablePaths, seeded };
    // Spread dirs + files into a flat string[] — wrapWithSandbox and
    // bwrap's --bind-try don't distinguish between them.
    invocation = wrapWithSandbox(
      bin,
      args,
      spawnCwd,
      [...writablePaths.dirs, ...writablePaths.files],
      fakeHome,
    );
  }
  // Built out here, not inline in the Promise executor below: CodeQL's
  // containment barrier (the `spawnCwd.startsWith` guard above) only
  // applies within the function it dominates, not inside a nested closure.
  const execOptions = {
    cwd: spawnCwd,
    env: gitEnv(),
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  };
  return new Promise<string>((resolve, reject) => {
    const child = execFile(invocation.bin, invocation.args, execOptions, (err, stdout, stderr) => {
      // Copy back any rotated auth.json from the disposable HOME to the
      // real HOME — see persistAgentSandboxAuth's own comment for why
      // this matters for single-use refresh tokens. Done on both success
      // and failure paths: a turn that crashed after rotating auth still
      // has fresh credentials worth propagating.
      if (sandboxHome) {
        // Only files this turn seeded are copied back; anything else in the
        // sandbox HOME is not ours.
        persistAgentSandboxAuth(sandboxHome.fakeHome, { files: sandboxHome.seeded });
      }
      if (err) {
        console.warn(
          "[scaffold-generate] %s generation turn failed (%s) stdout tail: %s | stderr tail: %s",
          agentLogLabel(agentCommand),
          String(describeExit(err)).replace(/[\r\n]+/g, " "),
          String(tail(stdout, FAILURE_LOG_TAIL_CHARS)).replace(/[\r\n]+/g, " "),
          String(tail(stderr, FAILURE_LOG_TAIL_CHARS)).replace(/[\r\n]+/g, " "),
        );
        reject(new GenerationSpawnError(agentCommand, describeSpawnFailure(err, stdout, stderr)));
        return;
      }
      resolve(stdout);
    });
    // The child is never given input. An open, silent stdin pipe makes
    // `claude -p` wait 3 s and print a "no stdin data received" warning.
    // An instantly-dead child makes the write end of stdin fail with EPIPE;
    // without a listener that surfaces as an unhandled 'error' event.
    child?.stdin?.on?.("error", () => {});
    child?.stdin?.end();
  });
};

/** The `outcome`-discriminated result `/internal/run-generation-turn`
 * returns (issue #1101) — ALWAYS a 200, never an HTTP status for an
 * application-level failure (unsupported agent CLI, scratch-worktree
 * creation failure, the spawn itself failing). Same "200 + reason
 * envelope, never a git-level refusal as a 5xx" convention as
 * `DeleteBranchResult`/`CreateWorktreeResult` elsewhere in this codebase —
 * chosen deliberately here because `host-git.ts`'s `viaRemote` (which this
 * module's own remote dispatch reuses for the outer HTTP-level
 * unreachable/version-skew split) only distinguishes a 404 from
 * "everything else": carrying these three distinguishable local error
 * classes as HTTP status instead would collapse them into one
 * indistinguishable `"unreachable"` bucket by the time they reached
 * `generateScaffoldContent`'s remote branch below. */
export type GenerationTurnResult =
  | { outcome: "ok"; stdout: string; sandboxed: boolean }
  | { outcome: "unsupported-agent"; detail: string }
  | { outcome: "worktree-error"; detail: string }
  | { outcome: "spawn-error"; detail: string };

export interface RunGenerationTurnInScratchWorktreeOptions {
  /** The REAL project checkout — the generation worktree is branched off
   * `baseRef`, exactly like preview/apply's own scratch worktree, but is a
   * separate `git worktree add` (own path, own branch), never the same
   * directory as the `setup-<slug>` one preview/apply use. */
  cwd: string;
  slug: string;
  baseRef: string;
  agentCommand: string;
  prompt: string;
  timeoutMs: number;
  /** Issue #1133 — forwarded verbatim to `spawn`'s own `sandbox` option;
   * see `SpawnGenerationTurnOptions.sandbox`'s doc comment. Each caller
   * (the primary for a LOCAL_HOST_ID project, `/internal/run-generation-turn`'s
   * agent-side handler for a remote one) resolves this from ITS OWN
   * `app.config.MULLION_SCAFFOLD_GENERATE_SANDBOX_ENABLED` before calling
   * in — this function has no `app` to read that from itself. */
  sandbox?: boolean;
  /** Test-only seam — production always omits this and gets
   * `defaultSpawnGenerationTurn`. Never settable over the wire: the new
   * `/internal/run-generation-turn` route (issue #1101) always omits it
   * too, for the same reason — letting a caller choose what actually
   * executes here would defeat the sandboxing this function's own spawn
   * step applies. */
  spawn?: SpawnGenerationTurn;
}

/**
 * The worktree-lifecycle + sandboxed-spawn core this module's header
 * describes: stands up a disposable scratch worktree OUTSIDE `cwd`'s own
 * directory tree, runs one generation turn inside it, and always tears the
 * worktree (and its branch) down again before returning or throwing — see
 * this module's header for why that's the actual write-scope enforcement,
 * not just tidiness.
 *
 * Issue #1101 factors this out of `generateScaffoldContent` (which still
 * calls it directly, unchanged, for a `LOCAL_HOST_ID` project) so
 * `/internal/run-generation-turn`'s own agent-side handler — which runs
 * this SAME logic on a remote-hosted project's own filesystem — calls the
 * IDENTICAL create -> sandboxed-spawn -> teardown implementation rather
 * than a hand-duplicated copy. That reuse is what carries `wrapWithSandbox`/
 * `isSandboxCapable`/`agentSandboxWritablePaths`/
 * `ensureSandboxWritablePathsExist` to the remote path too — every one of
 * them already runs unconditionally inside `defaultSpawnGenerationTurn`,
 * which this function calls via the same `spawn` seam
 * `generateScaffoldContent` always used.
 */
export async function runGenerationTurnInScratchWorktree(
  opts: RunGenerationTurnInScratchWorktreeOptions,
): Promise<string> {
  const spawn = opts.spawn ?? defaultSpawnGenerationTurn;

  // Unique per call, not `gen-<slug>` — unlike preview/apply's own
  // `setup-<slug>` worktree (deliberately STABLE so a re-preview reuses
  // it), this scratch worktree is torn down in the `finally` below before
  // this function ever returns, so there is no "reuse the live one"
  // concept here at all. A stable seed would instead risk a leftover
  // directory from a crashed/killed prior run colliding with the next
  // `createWorktree` call ("a branch/path already exists") — a random
  // suffix sidesteps that entirely rather than adding stale-worktree
  // detection for a path nothing is ever meant to reuse.
  const seed = `gen-${opts.slug}-${randomUUID().slice(0, 8)}`;
  // `baseDir` deliberately outside `opts.cwd` entirely — see this module's
  // header for why placement (not just teardown) is part of gap #2's
  // enforcement. `os.tmpdir()` rather than a fixed repo-relative path: no
  // relationship to `opts.cwd` at all, so there is nothing for a relative
  // `cd ../..` inside the generation worktree to walk back into. This
  // holds identically for a remote-hosted project too (issue #1101):
  // `os.tmpdir()` here resolves against whichever process actually runs
  // this function — this module's own process for `LOCAL_HOST_ID`, or the
  // remote agent's own process when called from
  // `/internal/run-generation-turn`'s handler — so the "wholly unrelated
  // part of the filesystem" property is never diluted by threading a
  // caller-supplied `baseDir` across the wire (which would also have
  // reopened the exact PROJECTS_ROOTS-containment question every other
  // `/internal/*` path argument in this codebase is deliberately held to).
  const baseDir = scaffoldGenerateBaseDir();
  const worktreeResult = await createWorktree({
    cwd: opts.cwd,
    baseRef: opts.baseRef,
    seed,
    baseDir,
  });
  if (!worktreeResult.created || !worktreeResult.path || !worktreeResult.branch) {
    throw new GenerationWorktreeError(
      worktreeResult.detail ?? `could not create a scratch worktree (${worktreeResult.reason})`,
    );
  }
  const { path: worktreePath, branch } = worktreeResult;

  try {
    return await spawn({
      agentCommand: opts.agentCommand,
      cwd: worktreePath,
      prompt: opts.prompt,
      timeoutMs: opts.timeoutMs,
      sandbox: opts.sandbox,
    });
  } finally {
    await removeWorktree(worktreePath, opts.cwd);
    await deleteBranch(opts.cwd, branch, { force: true }).catch(() => {
      // Best-effort — a leftover disposable branch from a scratch
      // generation worktree is untidy, never unsafe: the random suffix
      // above means it never collides with a later `/setup/generate` call.
    });
  }
}

export interface GenerateScaffoldContentOptions {
  app: FastifyInstance;
  hostId: string;
  /** The REAL project checkout — the generation worktree is branched off
   * its resolved base ref, exactly like preview/apply's own scratch
   * worktree, but is a separate `git worktree add` (own path, own branch),
   * never the same directory as the `setup-<slug>` one preview/apply use. */
  cwd: string;
  slug: string;
  agentCommand: string;
  seed: GenerationSeed;
  hasSkill: boolean;
  hasReviewer: boolean;
  hasScaffoldRegion: boolean;
  /** Issue #2316 — absent means "keep" (the historical behavior). */
  existingInstructions?: ExistingInstructionsMode;
  /** The conventions text Mullion will commit; shown to the agent in
   * `report`/`restructure`. */
  conventionsText?: string;
  /** The repo's current AGENTS.md, for `assessRewrite`. */
  originalAgentsMd?: string;
  /** Issue #2320 — skill and reviewer already exist and are not being
   * refreshed: ask only for the region paragraph and the instructions output.
   * Ignored (treated as false) for `keep`. */
  instructionsOnly?: boolean;
  timeoutMs?: number;
  /** Issue #1133 — LOCAL_HOST_ID only. The route resolves this from ITS
   * OWN `app.config.MULLION_SCAFFOLD_GENERATE_SANDBOX_ENABLED` and passes
   * it in (`opts.app` here is only ever used for `resolveHostBaseRef`/
   * `viaRemote`, never read directly by this function — see the
   * `fakeApp`/"never touched on the LOCAL_HOST_ID path" comment on this
   * function's own test suite). For a remote host, this is deliberately
   * NOT forwarded — `/internal/run-generation-turn`'s agent-side handler
   * reads the REMOTE agent's own config instead, the same "each host reads
   * its own app.config" split `RunGenerationTurnInScratchWorktreeOptions.sandbox`'s
   * doc comment describes. */
  sandbox?: boolean;
  /** Test-only seam, and LOCAL_HOST_ID only (see
   * `RunGenerationTurnInScratchWorktreeOptions.spawn`'s own doc comment for
   * why it can't and doesn't extend to a remote host) — production always
   * omits this and gets `defaultSpawnGenerationTurn`. */
  spawn?: SpawnGenerationTurn;
}

/**
 * Runs one read-only generation turn and returns the parsed
 * skill/reviewer/scaffold-region content — on whichever host owns
 * `opts.cwd` (issue #1101). For `LOCAL_HOST_ID`, calls
 * `runGenerationTurnInScratchWorktree` directly, in this process. For a
 * remote host, dispatches to the new `/internal/run-generation-turn` route
 * (via `RemoteHostClient.resolveRunGenerationTurn`), which runs the
 * IDENTICAL `runGenerationTurnInScratchWorktree` on the agent's own
 * filesystem instead — see that function's own doc comment for why this is
 * genuine reuse, not a parallel implementation. Always tears the scratch
 * worktree (and its branch) down on whichever host actually created it
 * before returning or throwing — see this module's header for why that's
 * the actual write-scope enforcement, not just tidiness.
 */
export async function generateScaffoldContent(
  opts: GenerateScaffoldContentOptions,
): Promise<GeneratedScaffoldContent> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS;

  // Validate before paying for a worktree (or, for a remote host, a network
  // round trip) at all — an unsupported agent should fail fast, not after
  // standing up (and then tearing down) a scratch checkout for nothing.
  buildInvocation(opts.agentCommand, "");

  const baseRefResult = await resolveHostBaseRef(opts.app, opts.hostId, opts.cwd);
  const baseRef =
    baseRefResult.ok && baseRefResult.value.baseRef ? baseRefResult.value.baseRef : "HEAD";

  const instructionsOnly =
    opts.instructionsOnly === true &&
    opts.hasSkill &&
    opts.hasReviewer &&
    (opts.existingInstructions ?? "keep") !== "keep";
  const prompt = buildGenerationPrompt({
    slug: opts.slug,
    seed: opts.seed,
    hasSkill: opts.hasSkill,
    hasReviewer: opts.hasReviewer,
    hasScaffoldRegion: opts.hasScaffoldRegion,
    existingInstructions: opts.existingInstructions,
    conventionsText: opts.conventionsText,
    instructionsOnly,
  });

  let raw: string;
  let sandboxed: boolean;
  if (!opts.hostId || opts.hostId === LOCAL_HOST_ID) {
    raw = await runGenerationTurnInScratchWorktree({
      cwd: opts.cwd,
      slug: opts.slug,
      baseRef,
      agentCommand: opts.agentCommand,
      prompt,
      timeoutMs,
      sandbox: opts.sandbox,
      spawn: opts.spawn,
    });
    // Issue #1144, #1159 — determine sandboxed status for the local path.
    // The config opt-out short-circuits before isSandboxCapable() in
    // defaultSpawnGenerationTurn, so the same logic applies here.
    const sandboxRequested = opts.sandbox !== false;
    sandboxed = sandboxRequested && (await isSandboxCapable());
  } else {
    // `viaRemote` (host-git.ts) — same HostRequestError/HostUnreachableError
    // mapping every other host-aware primitive in this codebase reuses. Its
    // `"unsupported"` reason here means a 404 from the agent — an old build
    // predating this route entirely (version skew), not "this agentCommand
    // isn't supported" (that's `GenerationTurnResult`'s own
    // `"unsupported-agent"` outcome below, carried inside a successful
    // `ok: true` response instead — see that type's own doc comment for
    // why).
    const result = await viaRemote(opts.app, opts.hostId, (client) =>
      client.resolveRunGenerationTurn(
        opts.cwd,
        opts.slug,
        baseRef,
        opts.agentCommand,
        prompt,
        timeoutMs,
      ),
    );
    if (!result.ok) {
      throw new GenerationSpawnError(
        opts.agentCommand,
        result.reason === "unsupported"
          ? "This host's agent build doesn't support generating scaffold content remotely yet — update the agent build (see issue #1101)."
          : result.detail,
      );
    }
    const turn = result.value;
    if (turn.outcome === "unsupported-agent") {
      throw new UnsupportedGenerationAgentError(opts.agentCommand);
    }
    if (turn.outcome === "worktree-error") throw new GenerationWorktreeError(turn.detail);
    if (turn.outcome === "spawn-error")
      throw new GenerationSpawnError(opts.agentCommand, turn.detail);
    raw = turn.stdout;
    sandboxed = turn.sandboxed ?? false;
  }

  const parsed = parseGeneratedOutput(raw, opts.slug, {
    mode: opts.existingInstructions,
    originalAgentsMd: opts.originalAgentsMd,
    instructionsOnly,
  });
  // On an instructions-only pass only the region paragraph is agent-produced
  // (the skill and reviewer fields are absent), and it is still worth checking
  // for fabricated paths.
  const possiblyGeneric = validateGenerationOutput(parsed, opts.cwd).possiblyGeneric;
  return { ...parsed, sandboxed, possiblyGeneric };
}
