import type { FastifyInstance, FastifyReply } from "fastify";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { projects } from "../db/schema.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import { gitEnv } from "../services/git-env.js";
import {
  computeScaffold,
  isValidScaffoldSlug,
  InvalidScaffoldSlugError,
  scaffoldSkillPath,
  scaffoldReviewerPath,
  type ScaffoldOptions,
} from "../services/mullion-scaffold.js";
import { MARKER_START } from "../services/project-briefing.js";
import {
  createWorktree,
  deriveWorktreePath,
  commitWipChanges,
  removeWorktree,
  type CreateWorktreeResult,
} from "../services/git-worktree.js";
import { getFileDiff } from "../services/git-diff.js";
import { deleteBranch } from "../services/git-branch-delete.js";
import { resolveHostBaseRef, resolveRepoRef, pushHostBranch } from "../services/host-git.js";
import { resolveGitHubToken } from "../services/github-integration.js";
import { createPullRequest, findPullRequestByHead } from "../services/github-write.js";
import { GitHubApiError } from "../services/github.js";
import { getStoredSettings } from "../services/settings.js";
import {
  readProjectSkill,
  readProjectReviewerAgent,
  readProjectBriefing,
} from "../services/project-tooling.js";
import {
  generateScaffoldContent,
  UnsupportedGenerationAgentError,
  GenerationWorktreeError,
  GenerationSpawnError,
  GenerationOutputError,
  type GeneratedScaffoldContent,
} from "../services/scaffold-generate.js";

// Issue: apply Mullion tooling to other repos, Layer 3 (PR-6) — the
// zero-repo-change delivery mechanisms PR-1 through PR-5 built only ever
// apply automatically; a project that actually wants a committed briefing
// region, skill, and reviewer subagent (shared with the team via git,
// discoverable by codex/agy which have no ephemeral overlay — see the
// plan's per-CLI coverage table) needs those files scaffolded into its own
// repo. This route reuses the Task Master promote path end to end
// (git-worktree.ts's createWorktree -> write -> commitWipChanges ->
// git-push.ts's pushBranch -> github-write.ts's createPullRequest, with
// task-promote.ts's 422-then-findPullRequestByHead recovery) rather than
// inventing a second "write files to a repo and open a PR" pipeline —
// github-write.ts has no content-write API at all, so local-worktree-then-
// push is the only route, and it happens to be the one that yields a real,
// reviewable diff for free.
//
// Scoped to hostId === LOCAL_HOST_ID projects for now — host-git.ts has no
// primitive to write arbitrary file content onto a REMOTE host's own
// filesystem (only status/base-ref/push/repo-ref, all read-or-push, never
// "put these new files there"). Filed as issue #895 rather than guessed at
// here; a remote-hosted project's setup request gets a clear 501, not a
// silent no-op or (worse) a write against the wrong filesystem.
//
// Preview and apply are split, per the plan's own "pure function, current
// contents in, target contents out" framing: preview creates (or reuses) a
// scratch worktree, writes computeScaffold's output into it, and diffs the
// result against that worktree's own HEAD via git-diff.ts (a fresh
// worktree's checked-out files ARE "current contents", so writing new
// content over them and diffing against HEAD is exactly the diff a human
// would see git-add and commit) — reusing git-diff.ts rather than a
// separate string-vs-string differ this repo doesn't otherwise have.
// Apply's own request carries back the exact previewId that write produced
// so a stale preview (the underlying repo changed between preview and
// apply) can't be blindly re-applied — see PREVIEW_TTL_MS below.

const SETUP_RATE_LIMIT = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

// Issue #956 — deliberately its OWN, much stricter bucket, not a share of
// SETUP_RATE_LIMIT above. Preview/apply are a cheap, pure-function
// worktree-diff pass; `/setup/generate` spawns a real agent turn (real
// tokens, real time, real spend) — a different cost class entirely, and
// one where 10/min would let a single confused client burn a lot of money
// before anyone notices. `@fastify/rate-limit` scopes a per-route `config.
// rateLimit` override to that route alone by default (verified against
// this route file's own preview/apply, which already run two independent
// 10/min buckets off the exact same SETUP_RATE_LIMIT object with no
// cross-talk), so a distinct config object here is sufficient for a
// genuinely separate bucket — no custom keyGenerator needed. `max: 5` is
// one of the values app.ts's own assertNoRateLimitMaxCollision comment
// already enumerates as a per-route limiter's max elsewhere in this repo
// ("5/10/20/30/60/90/120/200/1000") — reusing a documented value here
// rather than introducing a new one that comment would need updating for.
// Sharing that number with another route's own limiter is fine regardless
// (that check only compares a per-route max against `RATE_LIMIT_MAX`, the
// global default, never between two different routes' own limiters).
const GENERATE_RATE_LIMIT = { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } };

const generateSchema = {
  body: {
    type: "object",
    required: ["slug"],
    additionalProperties: false,
    properties: {
      slug: { type: "string", minLength: 1, maxLength: 64 },
      includeContributingPointer: { type: "boolean" },
      symlinkAgentsSkills: { type: "boolean" },
      includeDockConfig: { type: "boolean" },
      // Issue #1082(c) — diff-aware refresh. Absent/empty means today's
      // conservative default (never overwrite an already-committed file);
      // naming a target here is the caller's explicit opt-in to discarding
      // whatever hand-edits it carries past the original scaffold. Same
      // "explicit opt-in to a destructive-ish action" shape as this repo's
      // own git-branch-delete/git-worktree-remove `force?: boolean` body
      // flags (projects.ts) — a plain, named, defaulted-off field, not a
      // new confirmation protocol invented for this one route.
      refresh: {
        type: "array",
        items: { type: "string", enum: ["skill", "reviewer"] },
        maxItems: 2,
        uniqueItems: true,
      },
    },
  },
};

const previewSchema = {
  body: {
    type: "object",
    required: ["slug"],
    additionalProperties: false,
    properties: {
      slug: { type: "string", minLength: 1, maxLength: 64 },
      // Issue #942 — see ScaffoldOptions.includeContributingPointer's own
      // doc comment (mullion-scaffold.ts).
      includeContributingPointer: { type: "boolean" },
      symlinkAgentsSkills: { type: "boolean" },
      includeDockConfig: { type: "boolean" },
    },
  },
};

const applySchema = {
  body: {
    type: "object",
    required: ["previewId"],
    additionalProperties: false,
    properties: {
      previewId: { type: "string", minLength: 1 },
    },
  },
};

export class PathEscapeError extends Error {
  constructor(root: string, relPath: string) {
    super(`Refusing to resolve "${relPath}" outside of "${root}"`);
    this.name = "PathEscapeError";
  }
}

/** Joins `root` and `relPath`, then verifies the result is still inside
 * `root` before returning it — CodeQL (js/path-injection), PR #896: every
 * path here is built from a project's own `cwd`/worktree path plus a
 * `slug` already validated by isValidScaffoldSlug (no separators, no `..`,
 * no dangerous property names), so this is defense-in-depth rather than
 * the only guard — but a manual containment check right at the join, not
 * just an earlier regex check three call frames away, is the shape CodeQL
 * (and a future reader) can actually verify by looking at THIS line alone.
 * Throws PathEscapeError rather than silently truncating or refusing —
 * every current caller already only ever calls this with slug-validated
 * inputs, so reaching the throw means something upstream regressed. */
function resolveWithin(root: string, relPath: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relPath);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new PathEscapeError(resolvedRoot, relPath);
  }
  return target;
}

// Every path computeScaffold can ever emit, read up front so preview always
// sees the CURRENT on-disk content (a previous scaffold's own output,
// hand-edited content, or nothing) rather than assuming a fresh repo.
// Includes the `.agents/skills/<slug>` mirror (file or symlink form,
// mode-dependent) and `.crs/dock.json` too — Hermes review, PR #896 round
// 2: computeScaffold now skips regenerating the starter skill/reviewer/
// dock-config once something's already there, so their existence has to
// actually be probed here, not just the region-upsert targets.
function scaffoldableRelPaths(slug: string, options: ScaffoldOptions): string[] {
  const paths = [
    "AGENTS.md",
    // Issue #942 (this restructure) — CLAUDE.md is unconditional, same
    // reasoning as AGENTS.md above (not opt-in like CONTRIBUTING.md below):
    // without this, readExistingFiles below never sees a real repo's own
    // CLAUDE.md, computeScaffold treats it as absent, and the apply path
    // would silently OVERWRITE a real, possibly 200-line CLAUDE.md with a
    // scaffold-only `@AGENTS.md` import file instead of upserting into it.
    "CLAUDE.md",
    path.join(".claude", "skills", slug, "SKILL.md"),
    path.join(".claude", "agents", `${slug}-reviewer.md`),
    options.symlinkAgentsSkills
      ? path.join(".agents", "skills", slug)
      : path.join(".agents", "skills", slug, "SKILL.md"),
  ];
  if (options.includeDockConfig) paths.push(path.join(".crs", "dock.json"));
  // Issue #942 — without this, readExistingFiles below never sees a real
  // repo's CONTRIBUTING.md, computeScaffold treats it as absent, and the
  // apply path would silently OVERWRITE a real Code-of-Conduct/dev-setup
  // file with a pointer-only one instead of upserting into it.
  if (options.includeContributingPointer) paths.push("CONTRIBUTING.md");
  return paths;
}

function readExistingFiles(cwd: string, relPaths: string[]): Record<string, string | undefined> {
  // CodeQL (js/remote-property-injection), PR #896 — `relPath` is a
  // slug-derived string used as an object key below; `Object.create(null)`
  // removes the prototype entirely, so even a (currently unreachable,
  // isValidScaffoldSlug already rejects it) `__proto__`/`constructor`/
  // `prototype` value would land as an ordinary own property with no
  // special behavior, rather than relying solely on the upstream slug
  // check to keep this safe — same "guard the sink too, not just the
  // caller" posture skill-name.ts's own header documents for the identical
  // class of finding.
  const existingFiles: Record<string, string | undefined> = Object.create(null);
  for (const relPath of relPaths) {
    const resolved = resolveWithin(cwd, relPath);
    try {
      existingFiles[relPath] = readFileSync(resolved, "utf8");
    } catch (err) {
      // A directory (or a symlink to one — e.g. a previously-scaffolded
      // `.agents/skills/<slug>` in symlink mode) can't be read as text,
      // but computeScaffold still needs to know it EXISTS so a
      // re-scaffold doesn't clobber it (Hermes review, PR #896 round 2).
      // Empty string is a safe existence-only sentinel: computeScaffold
      // never actually reads this path's text content, only checks
      // `!== undefined`.
      if ((err as NodeJS.ErrnoException).code === "EISDIR") {
        existingFiles[relPath] = "";
      }
      // Otherwise absent/unreadable — computeScaffold treats a missing
      // key as "doesn't exist yet" and creates it fresh, same posture as
      // every other soft-failure read in this codebase.
    }
  }
  return existingFiles;
}

/** Issue #1082(c) — the ONLY mechanism that makes a refresh actually
 * overwrite an already-committed file: computeScaffold's own "create once,
 * never overwrite" rule (mullion-scaffold.ts) keys entirely off whether
 * `existingFiles[path] !== undefined`, so the sole way to make it emit a
 * fresh entry for a path it would otherwise treat as "leave alone" is to
 * make that path look absent to it — without touching computeScaffold's
 * own rule (which every non-refresh caller, preview included, still
 * depends on staying conservative by default). Returns a NEW null-prototype
 * record (same defensive posture as readExistingFiles above, for the same
 * CodeQL js/remote-property-injection reasoning — `refreshedPaths` here are
 * always scaffoldSkillPath/scaffoldReviewerPath's own slug-derived output,
 * but cloning this way costs nothing and keeps the guard uniform) rather
 * than mutating the caller's own `existingFiles`, which
 * generateScaffoldContent's hasSkill/hasReviewer/hasBriefingRegion
 * parameters must keep reading unmodified (see the route's own comment on
 * why those booleans are computed BEFORE this function ever runs). */
function withoutRefreshedPaths(
  existingFiles: Record<string, string | undefined>,
  refreshedPaths: string[],
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = Object.create(null);
  for (const key of Object.keys(existingFiles)) {
    if (!refreshedPaths.includes(key)) result[key] = existingFiles[key];
  }
  return result;
}

/** Ensures `dirPath` is a real directory before a plain file write into it
 * — Hermes review, PR #896 round 2: a same-slug re-preview that switches
 * OFF `symlinkAgentsSkills` leaves a stale symlink at exactly this path
 * (from the earlier symlink-mode preview); `mkdirSync(dirPath,
 * {recursive:true})` on a path that already exists as a symlink throws
 * (reproduced: ENOENT), so the plain-file write below never even got a
 * chance to run. Removing a stale symlink first mirrors the reverse fix
 * writeScaffoldEntries' own symlink branch already applies. */
function ensureRealDir(dirPath: string): void {
  try {
    if (lstatSync(dirPath).isSymbolicLink()) {
      rmSync(dirPath, { recursive: true, force: true });
    }
  } catch {
    // ENOENT — nothing there yet, mkdirSync below creates it fresh.
  }
  mkdirSync(dirPath, { recursive: true });
}

function writeScaffoldEntries(
  worktreePath: string,
  entries: ReturnType<typeof computeScaffold>,
): void {
  for (const entry of entries) {
    const targetPath = resolveWithin(worktreePath, entry.path);
    if (entry.kind === "symlink") {
      mkdirSync(path.dirname(targetPath), { recursive: true });
      // Hermes review, PR #896 round 1 — the old code swallowed EVERY
      // EEXIST, assuming whatever was already there was a matching
      // symlink from a previous preview. That's wrong on a same-slug
      // re-preview that switches FROM the plain-file variant TO the
      // symlink variant (or vice versa, or after a hand-edit): the
      // existing entry can be a directory or a stale symlink to a
      // different target, and silently leaving it in place means apply
      // commits content the user didn't actually opt into. Only skip the
      // create when what's already there is a symlink pointing at the
      // EXACT target we'd create anyway (content-compare-then-skip, same
      // posture as mullion-bundle.ts's syncSkillDir); anything else is
      // removed and replaced.
      let alreadyCorrect = false;
      try {
        alreadyCorrect = readlinkSync(targetPath) === entry.target;
      } catch {
        // Not a symlink (ENOENT: nothing there yet; EINVAL: a real file/
        // directory sits there instead) — fall through to remove+create.
      }
      if (!alreadyCorrect) {
        rmSync(targetPath, { recursive: true, force: true });
        symlinkSync(entry.target, targetPath);
      }
    } else {
      ensureRealDir(path.dirname(targetPath));
      writeFileSync(targetPath, entry.contents);
    }
  }
}

/** Reuses a previous preview's own scratch worktree ONLY when `liveSlugPreview`
 * (an unexpired preview record for this exact project+slug, from the
 * `previews` map) confirms it's still the CURRENT preview-before-apply
 * window — e.g. the user tweaked an option and clicked Preview again.
 * Otherwise, a worktree already sitting at the predicted path is stale
 * (either already applied — its HEAD now holds the scaffold commit itself,
 * so diffing against that HEAD would show "no changes" even though the
 * project's real base branch has since moved on — or an abandoned/expired
 * preview) and is removed via git-worktree.ts's own removeWorktree (proper
 * `git worktree remove` + prune, not a bare `rmSync` that would leave
 * dangling `.git/worktrees/` metadata behind) before a fresh one is
 * created — and, since removing the worktree does NOT also delete the
 * branch it had checked out, the stale `mullion/<seed>` branch is deleted
 * too: createWorktree always creates a FRESH branch of that exact name
 * (`git worktree add -b <branch> ...`, never reusing an existing one), so
 * leaving the old branch behind would make that call fail with "a branch
 * named ... already exists" the very next time this runs. Hermes review,
 * PR #896, round 1. */
async function reuseOrCreateWorktree(
  app: FastifyInstance,
  hostId: string,
  cwd: string,
  seed: string,
  liveSlugPreview: PreviewRecord | null,
): Promise<CreateWorktreeResult> {
  const predictedPath = deriveWorktreePath(cwd, seed);
  if (
    liveSlugPreview &&
    liveSlugPreview.worktreePath === predictedPath &&
    existsSync(predictedPath)
  ) {
    return { created: true, path: predictedPath, branch: `mullion/${seed}` };
  }
  if (existsSync(predictedPath)) {
    await removeWorktree(predictedPath, cwd);
    await deleteBranch(cwd, `mullion/${seed}`, { force: true });
  }
  const baseRefResult = await resolveHostBaseRef(app, hostId, cwd);
  const baseRef =
    baseRefResult.ok && baseRefResult.value.baseRef ? baseRefResult.value.baseRef : "HEAD";
  return createWorktree({ cwd, baseRef, seed });
}

interface PreviewRecord {
  projectId: number;
  worktreePath: string;
  branch: string;
  slug: string;
  createdAt: number;
}

// In-memory only, primary-only, short-lived — a preview is a "here's what
// would happen" artifact for one interactive UI session, not durable state
// (same posture as hooks.ts's pending-gate map or pty-manager's stashSeed:
// ephemeral server-side state a restart is fine to drop). Evicted lazily on
// access rather than a timer, since nothing else ever needs to enumerate
// live previews.
const PREVIEW_TTL_MS = 15 * 60 * 1000;
const previews = new Map<string, PreviewRecord>();

function getLivePreview(previewId: string): PreviewRecord | null {
  const record = previews.get(previewId);
  if (!record) return null;
  if (Date.now() - record.createdAt > PREVIEW_TTL_MS) {
    previews.delete(previewId);
    return null;
  }
  return record;
}

/** Finds an unexpired preview already covering this exact project+slug —
 * reuseOrCreateWorktree's own signal for "still the same preview-before-
 * apply window" vs. "stale, remove and start fresh" (see that function's
 * own doc comment). A linear scan over `previews`, not a secondary index:
 * this map is small (one entry per in-flight interactive preview) and
 * short-lived, so the O(n) cost here is never worth a second data
 * structure to keep in sync. */
function findLiveSlugPreview(projectId: number, slug: string): PreviewRecord | null {
  for (const [previewId, record] of previews) {
    if (record.projectId !== projectId || record.slug !== slug) continue;
    if (Date.now() - record.createdAt > PREVIEW_TTL_MS) {
      previews.delete(previewId);
      continue;
    }
    return record;
  }
  return null;
}

// Issue #956 — `/setup/preview` and the new `/setup/generate` (which is,
// per the issue's own framing, "extending the apply step's existing
// worktree/diff/PR machinery, not replacing it") share the exact same
// tail: stand up (or reuse) the `setup-<slug>` scratch worktree, run
// computeScaffold against its current contents, write the resulting
// entries, diff them, and stash a PreviewRecord so the existing `/setup/
// apply` route can commit/push/PR it completely unchanged. The only thing
// `/setup/generate` does differently is pass a non-empty `options.generated`
// through — computeScaffold and everything below it neither knows nor
// cares where that content came from (see mullion-scaffold.ts's own doc
// comment on why that has to stay true). Split into `ensureSetupWorktree`
// + `finishPreview` (rather than one function) so `/setup/generate` can
// read `existingFiles` — hence hasSkill/hasReviewer/hasBriefingRegion —
// from the SAME worktree instance that goes on to decide computeScaffold's
// entries, instead of a second, independent read against `project.cwd`
// that could answer a different question (a feature branch checked out,
// an uncommitted local edit, ...) than the one the scratch worktree's own
// resolved base ref actually reflects.
type PreviewComputation =
  | { ok: true; previewId: string; diff: string; files: string[] }
  | { ok: false; status: 400 | 500; message: string };

interface ReadyWorktree {
  path: string;
  branch: string;
}

// Also avoids standing up two worktrees for one `/setup/generate` call:
// `reuseOrCreateWorktree` would otherwise see a path that exists but isn't
// a KNOWN live preview (no PreviewRecord registered yet on a first call)
// and remove+recreate it.
async function ensureSetupWorktree(
  app: FastifyInstance,
  project: { cwd: string; hostId: string },
  projectId: number,
  slug: string,
): Promise<{ ok: true; worktree: ReadyWorktree } | { ok: false; message: string }> {
  const seed = `setup-${slug}`;
  const liveSlugPreview = findLiveSlugPreview(projectId, slug);
  const worktreeResult = await reuseOrCreateWorktree(
    app,
    project.hostId,
    project.cwd,
    seed,
    liveSlugPreview,
  );
  if (!worktreeResult.created || !worktreeResult.path || !worktreeResult.branch) {
    return {
      ok: false,
      message:
        worktreeResult.detail ?? `Could not create a scratch worktree (${worktreeResult.reason})`,
    };
  }
  return { ok: true, worktree: { path: worktreeResult.path, branch: worktreeResult.branch } };
}

// Issue #956 — the shared tail of both `/setup/preview` and `/setup/
// generate`: given an already-standing `setup-<slug>` worktree and the
// `existingFiles` read from it, run computeScaffold, write the resulting
// entries, diff them, and stash a PreviewRecord so `/setup/apply` can
// commit/push/PR it completely unchanged.
async function finishPreview(
  projectId: number,
  options: ScaffoldOptions,
  worktree: ReadyWorktree,
  existingFiles: Record<string, string | undefined>,
): Promise<PreviewComputation> {
  let entries;
  try {
    entries = computeScaffold(existingFiles, options);
  } catch (err) {
    if (err instanceof InvalidScaffoldSlugError)
      return { ok: false, status: 400, message: err.message };
    throw err;
  }
  writeScaffoldEntries(worktree.path, entries);
  // `git diff HEAD` never shows an untracked file, staged or not — every
  // entry here is brand new (or a mirror the target repo never had
  // before), so without staging them first getFileDiff below would
  // silently return null for every single one and the preview would show
  // an empty diff. `git add -A` here is purely to make the upcoming diff/
  // preview complete; commitWipChanges (apply) does its own equivalent
  // staging pass regardless of what's already staged.
  execFileSync("git", ["-C", worktree.path, "add", "-A"], {
    stdio: "pipe",
    env: gitEnv(),
  });

  const diffs = await Promise.all(
    entries.map(async (entry) => {
      if (entry.kind === "symlink") return null;
      return getFileDiff(worktree.path, entry.path);
    }),
  );
  const diff = diffs.filter((d): d is string => Boolean(d)).join("\n");

  const previewId = randomUUID();
  previews.set(previewId, {
    projectId,
    worktreePath: worktree.path,
    branch: worktree.branch,
    slug: options.slug,
    createdAt: Date.now(),
  });

  return { ok: true, previewId, diff, files: entries.map((entry) => entry.path) };
}

async function computeAndStorePreview(
  app: FastifyInstance,
  project: { cwd: string; hostId: string },
  projectId: number,
  options: ScaffoldOptions,
): Promise<PreviewComputation> {
  const ensured = await ensureSetupWorktree(app, project, projectId, options.slug);
  if (!ensured.ok) return { ok: false, status: 500, message: ensured.message };
  const relPaths = scaffoldableRelPaths(options.slug, options);
  const existingFiles = readExistingFiles(ensured.worktree.path, relPaths);
  return finishPreview(projectId, options, ensured.worktree, existingFiles);
}

function sendPreviewComputation(reply: FastifyReply, result: PreviewComputation) {
  if (!result.ok) {
    return result.status === 400
      ? reply.badRequest(result.message)
      : reply.internalServerError(result.message);
  }
  return { previewId: result.previewId, diff: result.diff, files: result.files };
}

export async function projectSetupRoute(app: FastifyInstance) {
  function getProjectOr404(projectId: number) {
    const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
    return project ?? null;
  }

  app.post<{
    Params: { id: string };
    Body: { slug: string } & Omit<ScaffoldOptions, "slug">;
  }>(
    "/api/projects/:id/setup/preview",
    { ...SETUP_RATE_LIMIT, schema: previewSchema },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      const project = getProjectOr404(projectId);
      if (!project) return reply.notFound();
      if (project.hostId !== LOCAL_HOST_ID) {
        return reply.code(501).send({
          message:
            "Scaffolding Mullion integration into a remote-hosted project isn't supported yet — see issue #895",
        });
      }

      const options: ScaffoldOptions = {
        slug: request.body.slug,
        includeContributingPointer: request.body.includeContributingPointer,
        symlinkAgentsSkills: request.body.symlinkAgentsSkills,
        includeDockConfig: request.body.includeDockConfig,
      };
      if (!isValidScaffoldSlug(options.slug)) {
        return reply.badRequest(`"${options.slug}" is not a safe slug`);
      }

      const result = await computeAndStorePreview(app, project, projectId, options);
      return sendPreviewComputation(reply, result);
    },
  );

  app.post<{
    Params: { id: string };
    Body: { slug: string; refresh?: Array<"skill" | "reviewer"> } & Omit<ScaffoldOptions, "slug">;
  }>(
    "/api/projects/:id/setup/generate",
    { ...GENERATE_RATE_LIMIT, schema: generateSchema },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      const project = getProjectOr404(projectId);
      if (!project) return reply.notFound();
      // Issue #956 — identical shape to `/setup/preview`'s own 501 above
      // (pre-existing precedent): the generation pass needs to read the
      // ACTUAL codebase, which only exists on the host that owns it.
      // Lifting this is issue #895's job, not this one's.
      if (project.hostId !== LOCAL_HOST_ID) {
        return reply.code(501).send({
          message:
            "Scaffolding Mullion integration into a remote-hosted project isn't supported yet — see issue #895",
        });
      }

      const options: ScaffoldOptions = {
        slug: request.body.slug,
        includeContributingPointer: request.body.includeContributingPointer,
        symlinkAgentsSkills: request.body.symlinkAgentsSkills,
        includeDockConfig: request.body.includeDockConfig,
      };
      if (!isValidScaffoldSlug(options.slug)) {
        return reply.badRequest(`"${options.slug}" is not a safe slug`);
      }

      // Stood up (or reused) FIRST, and its own `existingFiles` read used
      // for both the hasSkill/hasReviewer/hasBriefingRegion decision below
      // AND, later, computeScaffold's own entries — one worktree, one
      // read, one consistent answer to "does a committed file already
      // exist" (see ensureSetupWorktree's own doc comment: a second,
      // independent read against `project.cwd` could answer a DIFFERENT
      // question if the live checkout and the scratch worktree's resolved
      // base ref ever disagree).
      const ensured = await ensureSetupWorktree(app, project, projectId, options.slug);
      if (!ensured.ok) return reply.internalServerError(ensured.message);
      const relPaths = scaffoldableRelPaths(options.slug, options);
      const existingFiles = readExistingFiles(ensured.worktree.path, relPaths);
      const hasSkill = existingFiles[scaffoldSkillPath(options.slug)] !== undefined;
      const hasReviewer = existingFiles[scaffoldReviewerPath(options.slug)] !== undefined;
      const hasBriefingRegion = (existingFiles["AGENTS.md"] ?? "").includes(MARKER_START);

      // Issue #1082(c) — `refresh` is the caller's explicit, per-target
      // opt-in to regenerating an already-committed file (see the schema's
      // own doc comment above). Computed from the RAW request body, not
      // re-derived from hasSkill/hasReviewer, so naming a target that
      // doesn't exist yet is simply a no-op (computeScaffold already
      // creates a missing file unconditionally — nothing left to "refresh"
      // there).
      const refreshTargets = new Set(request.body.refresh ?? []);
      const refreshSkill = refreshTargets.has("skill");
      const refreshReviewer = refreshTargets.has("reviewer");

      // Issue #956 review follow-up, narrowed by issue #1082(c) — this used
      // to be an unconditional 409 whenever both files already existed,
      // since computeScaffold's own "create once, never overwrite" rule
      // (mullion-scaffold.ts) would silently throw away generation's entire
      // output for them, wasting a real agent turn (real tokens, real time,
      // real spend) for nothing but the AGENTS.md region. Naming either
      // target in `refresh` is the caller's explicit signal that THIS turn
      // is worth spending on — the short-circuit below now only fires when
      // nothing was asked to change, which is the one case a real refresh
      // path doesn't need to touch at all.
      if (hasSkill && hasReviewer && !refreshSkill && !refreshReviewer) {
        return reply.conflict(
          `.claude/skills/${options.slug}/SKILL.md and .claude/agents/${options.slug}-reviewer.md ` +
            // "already exist" — NOT "are already committed": `hasSkill`/
            // `hasReviewer` come from the scratch worktree's OWN working
            // tree (readExistingFiles), which a reused, still-uncommitted
            // preview window (reuseOrCreateWorktree's own doc comment) can
            // already show as present even before `/setup/apply` ever
            // commits anything — mullion-reviewer review, issue #1082(c).
            "already exist — generation only replaces placeholder content, it never " +
            'overwrites an existing file by default. Pass refresh: ["skill"] and/or ' +
            '["reviewer"] in the request body to explicitly regenerate one or both.',
        );
      }

      // Issue #956 — "resolve via the existing chain, project.defaultAgent
      // ?? settings.launchers.defaultAgent". Deliberately NOT
      // task-agent-resolve.ts's resolveAgentCommand: that helper also
      // parses an issue body's `Agent:` directive (meaningless here, there
      // is no issue) and falls back to `settings.taskMaster.defaultAgent`
      // — a DIFFERENT install-wide tier (settings.ts) than the one this
      // issue explicitly names.
      const agentCommand = project.defaultAgent ?? getStoredSettings(app.db).launchers.defaultAgent;

      let generated: GeneratedScaffoldContent;
      try {
        generated = await generateScaffoldContent({
          app,
          hostId: project.hostId,
          cwd: project.cwd,
          slug: options.slug,
          agentCommand,
          seed: {
            skill: readProjectSkill(app.db, project.id),
            reviewerAgent: readProjectReviewerAgent(app.db, project.id),
            briefing: readProjectBriefing(app.db, project.id),
          },
          hasSkill,
          hasReviewer,
          hasBriefingRegion,
        });
      } catch (err) {
        if (err instanceof UnsupportedGenerationAgentError) return reply.badRequest(err.message);
        if (err instanceof GenerationWorktreeError) return reply.internalServerError(err.message);
        if (err instanceof GenerationSpawnError || err instanceof GenerationOutputError) {
          return reply.badGateway(err.message);
        }
        throw err;
      }

      // Issue #1082(c) — the refreshed target(s), and ONLY those, are
      // stripped from the view computeScaffold's write pass sees; every
      // other path (including a non-refreshed skill/reviewer that already
      // exists) is left exactly as `existingFiles` reported it, so
      // computeScaffold's own "create once, never overwrite" rule leaves it
      // untouched. `hasSkill`/`hasReviewer` above were already computed off
      // the UNMODIFIED `existingFiles` — generateScaffoldContent's seed
      // logic (does a DB draft still apply?) must reflect what's actually
      // PRESENT right now (committed, or just an uncommitted write from a
      // reused preview window — see the 409 message's own comment above),
      // not what this request is about to overwrite.
      const refreshedPaths: string[] = [];
      if (refreshSkill) refreshedPaths.push(scaffoldSkillPath(options.slug));
      if (refreshReviewer) refreshedPaths.push(scaffoldReviewerPath(options.slug));
      const writeExistingFiles = withoutRefreshedPaths(existingFiles, refreshedPaths);

      const result = await finishPreview(
        projectId,
        { ...options, generated },
        ensured.worktree,
        writeExistingFiles,
      );
      return sendPreviewComputation(reply, result);
    },
  );

  app.post<{ Params: { id: string }; Body: { previewId: string } }>(
    "/api/projects/:id/setup/apply",
    { ...SETUP_RATE_LIMIT, schema: applySchema },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      const project = getProjectOr404(projectId);
      if (!project) return reply.notFound();

      const record = getLivePreview(request.body.previewId);
      if (!record || record.projectId !== projectId) {
        return reply.badRequest("This preview has expired or doesn't exist — run preview again");
      }

      const commitResult = await commitWipChanges(
        record.worktreePath,
        `chore: scaffold Mullion integration (${record.slug})`,
      );
      if (!commitResult.committed && commitResult.error) {
        return reply.internalServerError(commitResult.error);
      }

      // Issue #1082(a) — stamped here, not earlier: this is the point the
      // scaffold's files actually get committed (to the scratch worktree,
      // pushed as a PR or left as a local branch below — see
      // schema.ts's own doc comment on `projects.slug` for why that's still
      // "actually writes files" for this column's purposes even before a
      // PR merges). Sourced from `record.slug` (the previewed/applied
      // slug), never re-read from the request body, since this route has no
      // body field of its own beyond `previewId`.
      app.db.update(projects).set({ slug: record.slug }).where(eq(projects.id, projectId)).run();

      const repoRef = await resolveRepoRef(app, project);
      if (!repoRef) {
        previews.delete(request.body.previewId);
        return {
          ok: true,
          mode: "local-branch",
          branch: record.branch,
          detail: "No GitHub remote detected — committed locally, push it yourself when ready.",
        };
      }

      const token = await resolveGitHubToken(app, repoRef);
      if (!token) {
        previews.delete(request.body.previewId);
        return {
          ok: true,
          mode: "local-branch",
          branch: record.branch,
          detail: "No GitHub App/PAT configured — committed locally, push it yourself when ready.",
        };
      }

      const pushResult = await pushHostBranch(
        app,
        project.hostId,
        record.worktreePath,
        record.branch,
        token,
      );
      if (!pushResult.ok || !pushResult.value.ok) {
        const detail = !pushResult.ok
          ? pushResult.reason
          : (pushResult.value.detail ?? "push failed");
        return reply.internalServerError(`Could not push the scaffold branch: ${detail}`);
      }

      const baseRefResult = await resolveHostBaseRef(app, project.hostId, project.cwd);
      const baseRefRaw =
        baseRefResult.ok && baseRefResult.value.baseRef ? baseRefResult.value.baseRef : "main";
      const base = baseRefRaw.startsWith("origin/")
        ? baseRefRaw.slice("origin/".length)
        : baseRefRaw;

      try {
        const pr = await createPullRequest(token, repoRef.owner, repoRef.repo, {
          title: `chore: scaffold Mullion integration (${record.slug})`,
          head: record.branch,
          base,
          body: "Adds a Mullion briefing region to AGENTS.md, a CLAUDE.md @AGENTS.md import (Claude Code does not read AGENTS.md natively — the import is what loads it), a project skill, a reviewer subagent, and (if opted in) a CONTRIBUTING.md pointer — scaffolded by Mullion's setup flow, not hand-written. Review and edit the placeholder sections before merging.",
        });
        previews.delete(request.body.previewId);
        return { ok: true, mode: "pull-request", prUrl: pr.htmlUrl, prNumber: pr.number };
      } catch (err) {
        if (err instanceof GitHubApiError && err.statusCode === 422) {
          const existing = await findPullRequestByHead(
            token,
            repoRef.owner,
            repoRef.repo,
            `${repoRef.owner}:${record.branch}`,
          ).catch(() => null);
          if (existing) {
            previews.delete(request.body.previewId);
            return {
              ok: true,
              mode: "pull-request",
              prUrl: existing.htmlUrl,
              prNumber: existing.number,
            };
          }
        }
        const detail = err instanceof Error ? err.message : String(err);
        return reply.internalServerError(`Could not open a pull request: ${detail}`);
      }
    },
  );
}

// Exposes resolveWithin directly so a test can prove its own containment
// guard actually rejects an escape attempt — same "GitHub Advanced
// Security" test-exposure precedent as dock-config.ts's own
// `__testing = { resolveDockConfigPath }`.
export const __testing = { resolveWithin };
