import type { FastifyInstance } from "fastify";
import {
  existsSync,
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
  type ScaffoldOptions,
} from "../services/mullion-scaffold.js";
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

const previewSchema = {
  body: {
    type: "object",
    required: ["slug"],
    additionalProperties: false,
    properties: {
      slug: { type: "string", minLength: 1, maxLength: 64 },
      mirrors: {
        type: "array",
        items: { type: "string", enum: ["GEMINI.md", "AGENTS.override.md"] },
        maxItems: 2,
        uniqueItems: true,
      },
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
function scaffoldableRelPaths(slug: string, options: ScaffoldOptions): string[] {
  const mirrors = options.mirrors ?? [];
  return [
    "AGENTS.md",
    ...mirrors,
    path.join(".claude", "skills", slug, "SKILL.md"),
    path.join(".claude", "agents", `${slug}-reviewer.md`),
  ];
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
    try {
      existingFiles[relPath] = readFileSync(resolveWithin(cwd, relPath), "utf8");
    } catch {
      // Absent (or unreadable) — computeScaffold treats a missing key as
      // "doesn't exist yet" and creates it fresh, same posture as every
      // other soft-failure read in this codebase.
    }
  }
  return existingFiles;
}

function writeScaffoldEntries(
  worktreePath: string,
  entries: ReturnType<typeof computeScaffold>,
): void {
  for (const entry of entries) {
    const targetPath = resolveWithin(worktreePath, entry.path);
    mkdirSync(path.dirname(targetPath), { recursive: true });
    if (entry.kind === "symlink") {
      // Hermes review, PR #896 — the old code swallowed EVERY EEXIST,
      // assuming whatever was already there was a matching symlink from a
      // previous preview. That's wrong on a same-slug re-preview that
      // switches FROM the plain-file variant TO the symlink variant (or
      // vice versa, or after a hand-edit): the existing entry can be a
      // directory or a stale symlink to a different target, and silently
      // leaving it in place means apply commits content the user didn't
      // actually opt into. Only skip the create when what's already there
      // is a symlink pointing at the EXACT target we'd create anyway
      // (content-compare-then-skip, same posture as
      // mullion-bundle.ts's syncSkillDir); anything else is removed and
      // replaced.
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
        mirrors: request.body.mirrors,
        symlinkAgentsSkills: request.body.symlinkAgentsSkills,
        includeDockConfig: request.body.includeDockConfig,
      };
      if (!isValidScaffoldSlug(options.slug)) {
        return reply.badRequest(`"${options.slug}" is not a safe slug`);
      }

      const seed = `setup-${options.slug}`;
      const liveSlugPreview = findLiveSlugPreview(projectId, options.slug);
      const worktreeResult = await reuseOrCreateWorktree(
        app,
        project.hostId,
        project.cwd,
        seed,
        liveSlugPreview,
      );
      if (!worktreeResult.created || !worktreeResult.path || !worktreeResult.branch) {
        return reply.internalServerError(
          worktreeResult.detail ?? `Could not create a scratch worktree (${worktreeResult.reason})`,
        );
      }

      const relPaths = scaffoldableRelPaths(options.slug, options);
      const existingFiles = readExistingFiles(worktreeResult.path, relPaths);
      let entries;
      try {
        entries = computeScaffold(existingFiles, options);
      } catch (err) {
        if (err instanceof InvalidScaffoldSlugError) return reply.badRequest(err.message);
        throw err;
      }
      writeScaffoldEntries(worktreeResult.path, entries);
      // `git diff HEAD` never shows an untracked file, staged or not —
      // every entry here is brand new (or a mirror the target repo never
      // had before), so without staging them first getFileDiff below would
      // silently return null for every single one and the preview would
      // show an empty diff. `git add -A` here is purely to make the
      // upcoming diff/preview complete; commitWipChanges (apply) does its
      // own equivalent staging pass regardless of what's already staged.
      execFileSync("git", ["-C", worktreeResult.path, "add", "-A"], {
        stdio: "pipe",
        env: gitEnv(),
      });

      const diffs = await Promise.all(
        entries.map(async (entry) => {
          if (entry.kind === "symlink") return null;
          return getFileDiff(worktreeResult.path!, entry.path);
        }),
      );
      const diff = diffs.filter((d): d is string => Boolean(d)).join("\n");

      const previewId = randomUUID();
      previews.set(previewId, {
        projectId,
        worktreePath: worktreeResult.path,
        branch: worktreeResult.branch,
        slug: options.slug,
        createdAt: Date.now(),
      });

      return {
        previewId,
        diff,
        files: entries.map((entry) => entry.path),
      };
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
          body: "Adds a Mullion briefing region, a project skill, and a reviewer subagent — scaffolded by Mullion's setup flow, not hand-written. Review and edit the placeholder sections before merging.",
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
