import type { FastifyInstance } from "fastify";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
  type CreateWorktreeResult,
} from "../services/git-worktree.js";
import { getFileDiff } from "../services/git-diff.js";
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
  const existingFiles: Record<string, string | undefined> = {};
  for (const relPath of relPaths) {
    try {
      existingFiles[relPath] = readFileSync(path.join(cwd, relPath), "utf8");
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
    const targetPath = path.join(worktreePath, entry.path);
    mkdirSync(path.dirname(targetPath), { recursive: true });
    if (entry.kind === "symlink") {
      try {
        symlinkSync(entry.target, targetPath);
      } catch (err) {
        // EEXIST on a re-preview over the same reused worktree (see
        // reuseOrCreateWorktree below) — symlinkSync has no "overwrite"
        // mode, unlike writeFileSync. Safe to just leave a matching
        // symlink from a previous preview in place.
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    } else {
      writeFileSync(targetPath, entry.contents);
    }
  }
}

/** Reuses a previous preview's own scratch worktree (a re-preview after
 * tweaking options, e.g. adding a mirror) rather than failing on
 * createWorktree's own "path-exists" — that reason exists to protect
 * against colliding with something else's directory, not to block THIS
 * route's own idempotent "preview again" flow over a worktree only this
 * route ever creates or writes into. */
async function reuseOrCreateWorktree(
  app: FastifyInstance,
  hostId: string,
  cwd: string,
  seed: string,
): Promise<CreateWorktreeResult> {
  const predictedPath = deriveWorktreePath(cwd, seed);
  if (existsSync(predictedPath)) {
    return { created: true, path: predictedPath, branch: `mullion/${seed}` };
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
      const worktreeResult = await reuseOrCreateWorktree(app, project.hostId, project.cwd, seed);
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
