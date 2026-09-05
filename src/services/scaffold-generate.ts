import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { createWorktree, removeWorktree } from "./git-worktree.js";
import { deleteBranch } from "./git-branch-delete.js";
import { resolveHostBaseRef } from "./host-git.js";
import { gitEnv } from "./git-env.js";
import { scaffoldSkillPath, scaffoldReviewerPath } from "./mullion-scaffold.js";

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
// Be honest about what this is NOT: this process is not sandboxed
// (chroot/container/seccomp) — nothing stops an agent that already knows
// `project.cwd`'s absolute path from writing there directly (e.g. `echo x
// > /abs/path/to/project/file`), and only `claude`'s `--allowedTools`
// below is a CONFIRMED write-blocking flag among the four agents this
// module supports (`codex`'s `--sandbox read-only` is plausible but
// unverified here; `opencode run` and `agy -p` carry no write-restriction
// flag at all in this repo's own knowledge — see `buildInvocation`'s
// per-agent comments). What IS structurally guaranteed, regardless of
// whether any of those flags actually hold: the diff/PR pipeline
// (computeScaffold → writeScaffoldEntries → the `setup-<slug>` worktree)
// never reads from, stages, or diffs anywhere the generation agent could
// have written — the only channel between the two is this function's own
// parsed stdout, feeding three hardcoded target paths. A write the agent
// makes ANYWHERE ELSE on disk is real (this design cannot prevent that),
// but it is never picked up by the machinery that produces the PR a human
// reviews. Real process-level sandboxing is real, valuable follow-up work
// (see the PR description's own filed-issues list), not something this
// issue's own scope covers.
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

export interface GeneratedScaffoldContent {
  skill: string;
  reviewer: string;
  briefingRegion: string;
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
const BRIEFING_START = "<<<MULLION_BRIEFING_START>>>";
const BRIEFING_END = "<<<MULLION_BRIEFING_END>>>";

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
  hasBriefingRegion: boolean;
}): string {
  const { slug, seed, hasSkill, hasReviewer, hasBriefingRegion } = opts;
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
  if (!hasBriefingRegion && seed.briefing) {
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
    `Analyze this codebase and write genuinely specific content for three things Mullion ` +
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
    `IS the skill's content, applied.\n` +
    `3. A short AGENTS.md briefing-region paragraph naming where the skill and reviewer live ` +
    `and when to use them.${seedSection}\n\n` +
    `Report back EXACTLY this shape and nothing else outside these markers — no preamble, no ` +
    `commentary, no markdown fences around the markers themselves:\n\n` +
    `${SKILL_START}\n(full skill file contents, including YAML frontmatter with name/description)\n${SKILL_END}\n` +
    `${REVIEWER_START}\n(full reviewer file contents, including YAML frontmatter with name/description/tools/model)\n${REVIEWER_END}\n` +
    `${BRIEFING_START}\n(the briefing paragraph only)\n${BRIEFING_END}\n`
  );
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
 * contents, and enforces the one cross-file invariant a prompt instruction
 * alone can't guarantee: the reviewer body must actually name the skill's
 * real path, not just have been ASKED to (issue's "skill<->reviewer
 * relationship must be explicit" section) — checked here, not left to
 * hope, so a generation pass that drifts fails loudly instead of silently
 * shipping a reviewer with no real cross-reference. */
export function parseGeneratedOutput(raw: string, slug: string): GeneratedScaffoldContent {
  const skill = extractSection(raw, SKILL_START, SKILL_END, "skill");
  const reviewer = extractSection(raw, REVIEWER_START, REVIEWER_END, "reviewer");
  const briefingRegion = extractSection(raw, BRIEFING_START, BRIEFING_END, "briefing region");

  const skillPath = scaffoldSkillPath(slug);
  if (!reviewer.includes(skillPath)) {
    throw new GenerationOutputError(
      `reviewer content never references the skill's own path (${skillPath}) — ` +
        `regenerate rather than commit a reviewer with no real cross-reference`,
    );
  }

  return { skill, reviewer, briefingRegion };
}

export interface SpawnGenerationTurnOptions {
  agentCommand: string;
  cwd: string;
  prompt: string;
  timeoutMs: number;
}

export type SpawnGenerationTurn = (opts: SpawnGenerationTurnOptions) => Promise<string>;

/** Per-agent argv for a single, non-interactive, read-restricted turn.
 * Every flag here is a REAL, documented flag of that CLI — `-p`/`exec`/
 * `run` are all independently confirmed against each adapter's own
 * `initialPromptArgs` comment in hook-adapters/*.ts (see this module's
 * header). What is NOT independently verified against a live binary for
 * every one of these four CLIs is that the tool-restriction flag actually
 * blocks every write path (`--allowedTools` is confirmed Claude Code
 * surface; codex's `--sandbox read-only`, opencode's plain `run`, and
 * agy's `-p` carry no confirmed write-blocking flag in this repo — flagged
 * plainly rather than asserted). The worktree-isolation design above is
 * what the actual "never reaches disk" guarantee rests on regardless of
 * whether any of these flags hold in practice. */
function buildInvocation(agentCommand: string, prompt: string): { bin: string; args: string[] } {
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
        args: ["-p", `-i=${prompt}`],
      };
    default:
      throw new UnsupportedGenerationAgentError(agentCommand);
  }
}

/** The real, production spawn — a bare, argv-array `execFile` (never a
 * shell string: the prompt embeds arbitrary repo-derived and DB-seed text,
 * so this avoids shell-injection risk entirely rather than relying on
 * quoting it correctly). Overridable via `generateScaffoldContent`'s own
 * `spawn` parameter so tests never actually invoke a real CLI/LLM call —
 * same "inject the one seam that does real I/O" shape as this codebase's
 * other externally-mockable service boundaries.
 *
 * CodeQL's js/path-injection flags `cwd` here, the same "real mitigation,
 * not a CodeQL-recognized sanitizer shape" pattern this repo already
 * documents at opencode-session-transfer.ts:240-252 / git-worktree.ts /
 * git-branch-delete.ts. `cwd` is `worktreeResult.path` from
 * `createWorktree` (which itself runs `isSafeAbsolutePath` on the project
 * cwd and gates the seed through `sanitizeRefComponent`, which collapses
 * anything outside `[A-Za-z0-9_.-]` to `-` and rejects empty-after-sanitize);
 * `baseDir` is hardcoded server-side to `path.join(os.tmpdir(),
 * "mullion-scaffold-generate")` — never user-controlled; the only
 * request-derived input is `slug`, gated by `isValidScaffoldSlug` at the
 * route boundary. Dismissed in GHAS as a false positive via the Security
 * API rather than reshaping already-verified-safe code to chase a query
 * that doesn't model manual containment checks as sanitizers (see
 * opencode-session-transfer.ts:240-252 for the longer rationale). */
export const defaultSpawnGenerationTurn: SpawnGenerationTurn = ({
  agentCommand,
  cwd,
  prompt,
  timeoutMs,
}) => {
  const { bin, args } = buildInvocation(agentCommand, prompt);
  return new Promise<string>((resolve, reject) => {
    execFile(
      bin,
      args,
      { cwd, env: gitEnv(), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new GenerationSpawnError(agentCommand, stderr?.trim() || err.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
};

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
  hasBriefingRegion: boolean;
  timeoutMs?: number;
  /** Test-only seam — production always omits this and gets
   * `defaultSpawnGenerationTurn`. */
  spawn?: SpawnGenerationTurn;
}

/**
 * Runs one read-only generation turn in its own disposable worktree and
 * returns the parsed skill/reviewer/briefing-region content. Always tears
 * the scratch worktree (and its branch) down before returning or throwing
 * — see this module's header for why that's the actual write-scope
 * enforcement, not just tidiness.
 */
export async function generateScaffoldContent(
  opts: GenerateScaffoldContentOptions,
): Promise<GeneratedScaffoldContent> {
  const spawn = opts.spawn ?? defaultSpawnGenerationTurn;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS;

  // Validate before paying for a worktree at all — an unsupported agent
  // should fail fast, not after standing up (and then tearing down) a
  // scratch checkout for nothing.
  buildInvocation(opts.agentCommand, "");

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
  const baseRefResult = await resolveHostBaseRef(opts.app, opts.hostId, opts.cwd);
  const baseRef =
    baseRefResult.ok && baseRefResult.value.baseRef ? baseRefResult.value.baseRef : "HEAD";
  // `baseDir` deliberately outside `opts.cwd` entirely — see this module's
  // header for why placement (not just teardown) is part of gap #2's
  // enforcement. `os.tmpdir()` rather than a fixed repo-relative path: no
  // relationship to `opts.cwd` at all, so there is nothing for a relative
  // `cd ../..` inside the generation worktree to walk back into.
  const baseDir = path.join(os.tmpdir(), "mullion-scaffold-generate");
  const worktreeResult = await createWorktree({ cwd: opts.cwd, baseRef, seed, baseDir });
  if (!worktreeResult.created || !worktreeResult.path || !worktreeResult.branch) {
    throw new GenerationWorktreeError(
      worktreeResult.detail ?? `could not create a scratch worktree (${worktreeResult.reason})`,
    );
  }
  const { path: worktreePath, branch } = worktreeResult;

  try {
    const prompt = buildGenerationPrompt({
      slug: opts.slug,
      seed: opts.seed,
      hasSkill: opts.hasSkill,
      hasReviewer: opts.hasReviewer,
      hasBriefingRegion: opts.hasBriefingRegion,
    });
    const raw = await spawn({
      agentCommand: opts.agentCommand,
      cwd: worktreePath,
      prompt,
      timeoutMs,
    });
    return parseGeneratedOutput(raw, opts.slug);
  } finally {
    await removeWorktree(worktreePath, opts.cwd);
    await deleteBranch(opts.cwd, branch, { force: true }).catch(() => {
      // Best-effort — a leftover disposable branch from a scratch
      // generation worktree is untidy, never unsafe: the random suffix
      // above means it never collides with a later `/setup/generate` call.
    });
  }
}
