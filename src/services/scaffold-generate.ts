import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
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
// — reproduces identically unsandboxed) blocked doing the same live check
// for it; no extra bind is added for it here, so that remains a real,
// openly-undiscovered gap rather than a silently-assumed one.
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
// this module needs), and WITH that flag it blocks nothing — a live `echo
// pwned > /outside/path` under `agy -p --sandbox
// --dangerously-skip-permissions` wrote the file. agy's own denial message
// points at a `permissions.allow` allow-list in `settings.json`
// (`command(<target>)` rules) as the closer analogue to `claude`'s
// `--allowedTools` — untried here, real follow-up work. `opencode run`
// (1.18.29) still has no write-restriction flag at all, confirmed against
// its own `--help` — only `--auto`, which does the opposite (auto-approves
// everything). Now that process-level sandboxing is wired in, none of that
// CLI-level unverified-ness matters for containment on a host where bwrap
// is usable — bwrap blocks the write at the kernel/mount-namespace level
// regardless of which CLI flag was or wasn't passed.
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
 * surface). Issue #1081's own re-check (this module's header has the full
 * detail): codex's `--sandbox read-only` is a real, accepted flag but its
 * write-blocking behavior is unverified (usage-limited account, quota
 * resets 2026-09-28); agy DOES have a `--sandbox` flag as of 1.1.27 but it
 * isn't used here — it's unusable non-interactively (auto-denies
 * everything in headless mode without `--dangerously-skip-permissions`,
 * blocks nothing with it); opencode's plain `run` still has no
 * write-restriction flag at all. The worktree-isolation design above is
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
function buildBwrapBaseArgs(worktreePath: string, extraWritablePaths: string[]): string[] {
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
 * write," not "doesn't try to." `agy -p`'s own
 * PRE-EXISTING argument-parsing quirk (`-p` swallows the next arg as its
 * own prompt, reproduces identically with or without this sandbox —
 * unrelated to issue #1081, out of scope for it) blocked verifying its
 * filesystem needs the same way here; no extra bind is added for it, so if
 * it turns out to need one, that is a real, currently undiscovered gap —
 * not a silently assumed one.
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
 * work, not silently accepted scope creep. */
export function agentSandboxWritablePaths(agentCommand: string): string[] {
  const home = os.homedir();
  switch (agentCommand) {
    case "codex":
      return [path.join(home, ".codex")];
    case "opencode":
      return [path.join(home, ".local", "share", "opencode")];
    default:
      return [];
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
 * `mkdirSync` here is a new filesystem-write sink in a module that already
 * carries a documented CodeQL js/path-injection dismissal (see
 * `defaultSpawnGenerationTurn`'s own comment on `cwd`) — worth a quick
 * mental check if GHAS flags it fresh, though it should not: every path
 * this is ever called with comes from `agentSandboxWritablePaths`, which
 * only ever returns `os.homedir()` joined with a hardcoded literal
 * subpath, never anything request- or agent-output-derived. */
export function ensureSandboxWritablePathsExist(paths: string[]): void {
  for (const p of paths) {
    try {
      fs.mkdirSync(p, { recursive: true });
    } catch {
      // Best-effort — see this function's own comment.
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
): SandboxedInvocation {
  return {
    bin: "bwrap",
    args: [...buildBwrapBaseArgs(worktreePath, extraWritablePaths), "--", bin, ...args],
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
              "only protection in effect until this is resolved. See scaffold-generate.ts's " +
              "own header comment for detail.",
          );
        }
        return usable;
      });
  }
  return cachedCapability;
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
export const defaultSpawnGenerationTurn: SpawnGenerationTurn = async ({
  agentCommand,
  cwd,
  prompt,
  timeoutMs,
}) => {
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
  const sandboxUsable = await isSandboxCapable();
  let invocation = { bin, args };
  if (sandboxUsable) {
    const extraWritablePaths = agentSandboxWritablePaths(agentCommand);
    ensureSandboxWritablePathsExist(extraWritablePaths);
    invocation = wrapWithSandbox(bin, args, cwd, extraWritablePaths);
  }
  return new Promise<string>((resolve, reject) => {
    execFile(
      invocation.bin,
      invocation.args,
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
