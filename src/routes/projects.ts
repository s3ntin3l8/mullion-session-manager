import type { FastifyInstance, FastifyReply } from "fastify";
import path from "node:path";
import net from "node:net";
import { and, eq, inArray, sql } from "drizzle-orm";
import { projects, sessions, tasks, webhookRegistrations } from "../db/schema.js";
import {
  discoverCandidates,
  expandHome,
  parseProjectsRootsEnv,
  resolveProjectActions,
  resolveProjectDock,
  type DiscoveredCandidate,
} from "../services/project-config.js";
import { getStoredSettings } from "../services/settings.js";
import { KNOWN_AGENTS } from "../services/agent-detect.js";
import { resolveGlobalPresets } from "./actions.js";
import { LOCAL_HOST_ID, getHostRow } from "../services/host-registry.js";
import { getRemoteHostClient, HostRequestError } from "../services/remote-host-client.js";
import { portFromUrl } from "../plugins/preview-proxy.js";
import { resolveBackend } from "../services/session-backend.js";
import type { GitHubRepoRef } from "../services/git-remote.js";
import { resolveRepoRefResult } from "../services/host-git.js";
import { readGitBranch } from "../services/git-branch.js";
import { listExistingProjectRuleFileNames } from "../services/agent-rules.js";
import { getGitStatus, isGitRepo, type GitStatus } from "../services/git-status.js";
import {
  getDiffStats,
  getDefaultBaseRef,
  getFileDiff,
  type GitDiffStats,
} from "../services/git-diff.js";
import { runGitFetch } from "../services/git-fetch.js";
import { runGitPull } from "../services/git-pull.js";
import { runGitInit } from "../services/git-init.js";
import {
  assertProjectDir,
  createProjectDir,
  ProjectDirError,
  type ProjectDirIssue,
} from "../services/project-dir.js";
import {
  listBranches,
  listRemoteBranches,
  listWorktrees,
  resolveDefaultBaseRefForPicker,
  type GitBranchInfo,
  type GitWorktreeInfo,
} from "../services/git-refs.js";
import type { DeleteBranchResult } from "../services/git-branch-delete.js";
import type { RemoveListedWorktreeResult } from "../services/git-worktree.js";
import { getIntegration, getToken, resolveGitHubToken } from "../services/github-integration.js";
import {
  GitHubApiError,
  getRepoStatus,
  getPRsStatus,
  computePRSummary,
  getWorkflowRunJobs,
  getJobLogs,
} from "../services/github.js";
import {
  buildWebhookUrl,
  getWebhookSecret,
  registerProjectWebhook,
  unregisterHook,
} from "../services/github-webhook.js";
import { detectDevServerPortForSessionIds } from "../services/dev-server-detect.js";
import {
  getComposeServices,
  mapServicesToProject,
  toDockControls,
  shellQuote,
  pullComposeImageQuietly,
  inspectImageId,
  type ComposeService,
} from "../services/docker-service-detect.js";
import { createSessionRecord } from "../services/session-lifecycle.js";

interface CreateProjectBody {
  name: string;
  cwd: string;
  hostId?: string;
  // Confirm-first directory creation (leaf-only — see project-dir.ts):
  // the initial POST without this flag 400s with code PROJECT_DIR_MISSING
  // when `cwd` doesn't exist yet; the modal re-submits with `createDir:
  // true` once the user confirms.
  createDir?: boolean;
  // Only applied when this request actually created the directory
  // (createDir + a fresh dir, not an already-existing one).
  gitInit?: boolean;
}

interface UpdateProjectBody {
  name?: string;
  cwd?: string;
  // Bare port ("5173") or a full "scheme://host:port" URL — see schema.ts.
  // `null` clears a previously-set value.
  devServerUrl?: string | null;
  // Per-project auto-fetch override — null means "inherit from global setting"
  // (src/plugins/git-fetcher.ts). The GET /api/projects response already
  // includes this column via the project row spread.
  autoFetch?: boolean | null;
  // Phase 6 Task Master (6.2/#215) — per-project override of
  // launchers.defaultAgent / the optional advisory review agent. `null`
  // clears a previously-set value (falls back to the next precedence
  // tier — see task-agent-resolve.ts).
  defaultAgent?: string | null;
  defaultReviewAgent?: string | null;
  // Per-project only, no install-wide tier — same posture as
  // defaultReviewAgent above. `null`/`false` = off; default-off matters,
  // see schema.ts's own doc comment on these two columns.
  mergeOnApprove?: boolean | null;
  autoApprove?: boolean | null;
  // #756 — per-project override of the resolved auto-return round cap.
  // `null` clears it (falls back to the install default,
  // resolveMaxAutoReturnRounds/DEFAULT_MAX_AUTO_RETURN_ROUNDS in
  // task-reconciler.ts) — unlike mergeOnApprove/autoApprove above, this HAS
  // an install-wide default that works for every project, so a global
  // fallback tier is useful here where it wasn't for those two.
  maxAutoReturnRounds?: number | null;
  // #761 — per-project only, no install-wide tier — same posture as
  // mergeOnApprove/autoApprove above: whether this repo's commit history
  // follows Conventional Commits is a property of that repo, not a
  // Mullion-wide default.
  conventionalCommitTitles?: boolean | null;
  // Same confirm-first contract as CreateProjectBody, above.
  createDir?: boolean;
  gitInit?: boolean;
}

interface DiscoveredProject extends DiscoveredCandidate {
  isRegistered: boolean;
}

const createProjectSchema = {
  body: {
    type: "object",
    required: ["name", "cwd"],
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1 },
      cwd: { type: "string", minLength: 1 },
      hostId: { type: "string", minLength: 1 },
      createDir: { type: "boolean" },
      gitInit: { type: "boolean" },
    },
  },
};

const updateProjectSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      name: { type: "string", minLength: 1 },
      cwd: { type: "string", minLength: 1 },
      devServerUrl: { type: ["string", "null"], minLength: 1 },
      autoFetch: { type: ["boolean", "null"] },
      defaultAgent: { type: ["string", "null"], enum: [...KNOWN_AGENTS, null] },
      defaultReviewAgent: { type: ["string", "null"], enum: [...KNOWN_AGENTS, null] },
      mergeOnApprove: { type: ["boolean", "null"] },
      autoApprove: { type: ["boolean", "null"] },
      maxAutoReturnRounds: { type: ["integer", "null"], minimum: 1 },
      conventionalCommitTitles: { type: ["boolean", "null"] },
      createDir: { type: "boolean" },
      gitInit: { type: "boolean" },
    },
  },
};

// Maps a ProjectDirError's discriminator to the 400 body's machine-readable
// `code` — the frontend keys its "Create folder" affordance off exactly
// PROJECT_DIR_MISSING (see CreateProjectModal.tsx) so a parent-missing typo
// is a dead end in the UI rather than offering to build a directory tree.
const PROJECT_DIR_ISSUE_CODES: Record<ProjectDirIssue, string> = {
  missing: "PROJECT_DIR_MISSING",
  "parent-missing": "PROJECT_PARENT_MISSING",
  "not-a-directory": "PROJECT_PATH_NOT_A_DIRECTORY",
  "parent-not-a-directory": "PROJECT_PARENT_NOT_A_DIRECTORY",
  symlink: "PROJECT_PATH_IS_SYMLINK",
  unreadable: "PROJECT_DIR_UNREADABLE",
  "create-failed": "PROJECT_DIR_CREATE_FAILED",
};

function projectDirErrorBody(err: ProjectDirError) {
  return {
    statusCode: 400,
    error: "Bad Request",
    message: err.message,
    code: PROJECT_DIR_ISSUE_CODES[err.issue],
  };
}

// Issue #28's per-project dev-server field — the authoritative, manually-set
// fallback the preview proxy resolves against (auto-discovery, a later
// phase, only ever pre-fills this; it never overrides it). Accepts either a
// bare port, since "the project's dev server" is usually all a user actually
// knows, or a full URL for the uncommon case (non-default host/path). This
// only checks shape (a well-formed port/URL) — it deliberately does not
// reject a host component like "http://localhost:5173" for a remote-hosted
// project, because that host is never actually used for one: the preview
// proxy forces the connection to the owning agent's own loopback and only
// forwards the port/path from here (see schema.ts's devServerUrl comment).
const DEV_SERVER_PORT_ONLY = /^\d{1,5}$/;

/** The single shape parser both isValidDevServerUrl (write-time, below) and
 * dev-server-status's remote branch (read-time — resolving what to forward
 * to the agent) build on. Hermes review, PR #533: one implementation is what
 * stops the two from drifting apart, which is exactly what happened before
 * this PR (the write-time validator never range-checked a full URL's port;
 * the read-time need introduced here does). Accepts a bare port or a full
 * http(s) URL, range-checking the port either way; returns null for
 * anything that parses as neither shape. The host is deliberately dropped
 * from the return value: for a remote-hosted project the agent always
 * probes its own loopback, never a caller-supplied host (see
 * dev-server-status's own comment, and schema.ts's devServerUrl comment —
 * "only the port is forwarded, never the host"). */
function parseDevServerTarget(value: string): { port: number; scheme: "http" | "https" } | null {
  if (DEV_SERVER_PORT_ONLY.test(value)) {
    const port = Number(value);
    return port >= 1 && port <= 65535 ? { port, scheme: "http" } : null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const port = portFromUrl(url);
    if (port < 1 || port > 65535) return null;
    return { port, scheme: url.protocol === "https:" ? "https" : "http" };
  } catch {
    return null;
  }
}

// Exported for routes/sessions.ts's dev-server accept route (issue #404),
// which patches this same column via the same validation rule.
export function isValidDevServerUrl(value: string): boolean {
  return parseDevServerTarget(value) !== null;
}

/**
 * Resolve the effective set of scan roots: settings.projectRoots (edited
 * from Settings -> Projects & discovery) wins when non-empty; an empty
 * settings array falls back to the deploy-time PROJECTS_ROOTS env var, so a
 * fresh install keeps working from its env config until someone actually
 * edits roots from the UI. DB-backed, so only meaningful on the primary —
 * an "agent" role (issue #26) has no settings and always uses
 * parseProjectsRootsEnv(app.config.PROJECTS_ROOTS) directly instead (see
 * routes/internal.ts).
 */
function resolveProjectRoots(app: FastifyInstance): string[] {
  const projectRoots = getStoredSettings(app.db).projectRoots;
  if (projectRoots.length > 0) return projectRoots.map(expandHome);

  return parseProjectsRootsEnv(app.config.PROJECTS_ROOTS);
}

/** Shared by every `?ids=`/`?sessionIds=` batch query param below (git-
 * statuses, git-diff-stats) — a comma-separated list of positive integers,
 * silently dropping anything malformed rather than 400ing (a stray
 * non-numeric id from a stale/racing client is just "nothing to report for
 * that one," not a client error worth failing the whole batch over). */
function parseIdListParam(param: string | undefined): number[] {
  if (!param) return [];
  return param
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

interface SessionCwdTarget {
  sessionId: number;
  hostId: string;
  cwd: string;
}

/**
 * Effective cwd per session (`liveCwd ?? row.cwd ?? project.cwd`) joined to
 * its project's `hostId` — the shared "which host, which path" resolution
 * used by both the batch git-status and git-diff-stats session endpoints
 * below (issue #202). This is the plan's deliberate deviation from a
 * `session.worktreePath` column: `sessions.cwd` is already passed verbatim
 * as the spawn cwd with no confinement to the project root (see
 * sessions.ts's getOrCreate), so a worktree session's cwd can already point
 * anywhere — no schema change needed to derive it.
 *
 * `liveCwd` (issue: sidebar worktree display) is this process's own in-memory
 * PtyManager state — the shell's OSC-7-announced cwd, which reflects a
 * manual `cd` after launch that `sessions.cwd` (written once, at creation)
 * never does. Only merged for a LOCAL session: `app.pty` here only tracks
 * sessions this process itself spawned/attached (same caveat as this file's
 * detectedDevServerPort above) — a remote session's live cwd lives in that
 * agent's own PtyManager instead, out of reach from here. (The plain session
 * list's `Session.liveCwd` field, unlike this function, IS remote-aware —
 * see services/session-live-info.ts's withLiveInfo, which goes through resolveBackend(hostId)
 * .liveStatus() and therefore reaches the owning host's own PtyManager
 * regardless of which host that is. Extending that same reach to this
 * function's batch git-status/diff-stats resolution would need a new
 * remote-side endpoint; deferred as a known gap for remote-hosted worktree
 * sessions rather than silently assumed to already work.)
 *
 * A `liveCwd` is a self-reported value (a hook message, or an OSC-7 PTY
 * announcement), not one this process already validated — `isGitRepo`'s
 * absolute-path + no-".."-segment + `.git`-exists guard must pass before
 * it's trusted as a `git -C` target, same as every other cwd this file
 * hands to git. A `liveCwd` that fails that check (stale, mid-typo, a shell
 * integration bug) just falls back to the DB cwd, same "nothing to show"
 * posture as this function's other gaps.
 *
 * Issue: worktree/branch detection — passing `isGitRepo` alone isn't
 * enough: an agent piggybacking its cwd on every hook event (see
 * forwarder-core.mjs's mapClaudeCodeEvent) can wander into ANY repo it
 * happens to visit, not just this project's own worktrees — observed live
 * as a session's `liveCwd` landing in `~/.claude/projects/...` (that
 * particular case was harmless only because it's not itself a git repo).
 * Adopting a foreign repo's cwd here would resolve and display THAT repo's
 * branch under this project. So `liveCwd` is only trusted when it resolves
 * to this project's own repository — at or below one of `listWorktrees`'
 * paths for `project.cwd` (which always includes the main checkout itself,
 * per that function's own `isMain` doc comment) — falling back to the DB
 * cwd otherwise, same posture as the `isGitRepo` check above.
 *
 * A session id with no matching row (already deleted, or a stale/racing
 * client) or whose project has since been deleted is simply omitted from
 * the result — same "nothing to show" posture as every other best-effort
 * lookup in this file, not an error.
 */
async function resolveSessionCwdTargets(
  app: FastifyInstance,
  sessionIds: number[],
): Promise<SessionCwdTarget[]> {
  if (sessionIds.length === 0) return [];
  const sessionRows = app.db
    .select({ id: sessions.id, cwd: sessions.cwd, projectId: sessions.projectId })
    .from(sessions)
    .where(inArray(sessions.id, sessionIds))
    .all();
  if (sessionRows.length === 0) return [];

  const projectIds = [...new Set(sessionRows.map((s) => s.projectId))];
  const projectRows = app.db.select().from(projects).where(inArray(projects.id, projectIds)).all();
  const projectById = new Map(projectRows.map((p) => [p.id, p]));

  const targets: SessionCwdTarget[] = [];
  // Cached per project, not per session: sessions sharing a project also
  // share its worktree list, and `listWorktrees` spawns a real `git`
  // process — no reason to pay for that once per session in the same batch.
  // Stores the full GitWorktreeInfo (with branch names) so the liveBranch
  // fallback below can match worktree by branch name.
  const worktreesByProject = new Map<number, GitWorktreeInfo[]>();
  const ensureWorktreeInfos = async (projectId: number, projectCwd: string) => {
    let infos = worktreesByProject.get(projectId);
    if (infos === undefined) {
      const worktrees = await listWorktrees(projectCwd);
      infos = worktrees ?? [];
      worktreesByProject.set(projectId, infos);
    }
    return infos;
  };
  for (const row of sessionRows) {
    const project = projectById.get(row.projectId);
    if (!project) continue;
    let cwd = row.cwd ?? project.cwd;
    if (project.hostId === LOCAL_HOST_ID) {
      const ptySession = app.pty.get(String(row.id));
      const liveCwd = ptySession?.liveCwd;
      const liveBranch = ptySession?.liveBranch;

      // Phase 1: liveCwd check (existing behavior) — the shell's OSC-7 or
      // hook-reported cwd, only trusted when it's within one of this
      // project's own worktree paths (see the function's doc comment).
      let resolved = false;
      if (liveCwd && isGitRepo(liveCwd)) {
        const worktreeInfos = await ensureWorktreeInfos(project.id, project.cwd);
        if (
          isWithinAnyWorktree(
            liveCwd,
            worktreeInfos.map((w) => w.path),
          )
        ) {
          cwd = liveCwd;
          resolved = true;
        }
      }

      // Phase 2: liveBranch fallback (issue: sidebar worktree detection) —
      // opencode's vcs.branch.updated / worktree.ready events report the
      // correct branch name but never carry the worktree path (see
      // Sidebar.tsx's comment on this gap). When liveCwd didn't resolve,
      // check if liveBranch matches a non-main worktree's branch — if so,
      // use that worktree's path as the effective cwd so the per-session
      // git status resolves against the worktree's actual filesystem.
      if (!resolved && liveBranch) {
        const worktreeInfos = await ensureWorktreeInfos(project.id, project.cwd);
        const matched = worktreeInfos.find((w) => w.branch === liveBranch && !w.isMain);
        if (matched) cwd = matched.path;
      }
    }
    targets.push({ sessionId: row.id, hostId: project.hostId, cwd });
  }
  return targets;
}

/** True when `candidate` IS one of `worktreePaths`, or is nested below one
 * of them — never a bare string-prefix compare (`/repo-2` must not match a
 * `worktreePaths` entry of `/repo`). Both sides are `path.resolve`d first so
 * a `..`-free but non-canonical path (e.g. a trailing slash) still matches
 * correctly.
 *
 * Known, accepted tradeoff (flagged in review — see PR #335): a `candidate`
 * inside a git SUBMODULE of one of these worktrees has its own separate
 * `.git` (so it passes the caller's `isGitRepo` check) but is never itself
 * one of `git worktree list`'s own entries, so it's rejected here and falls
 * back to the session's static cwd rather than showing the submodule's own
 * branch. Treating a submodule as "this project's own repo" for
 * branch-tracking purposes would be the wrong call anyway — it's a distinct
 * repository with its own independent branch/HEAD — so this is the correct
 * side to fail on, not just an unhandled gap. */
function isWithinAnyWorktree(candidate: string, worktreePaths: string[]): boolean {
  const resolvedCandidate = path.resolve(candidate);
  return worktreePaths.some((worktreePath) => {
    const resolvedWorktree = path.resolve(worktreePath);
    return (
      resolvedCandidate === resolvedWorktree ||
      resolvedCandidate.startsWith(resolvedWorktree + path.sep)
    );
  });
}

// Issue #442 — the two primary-side guards that run BEFORE delegating to a
// SessionBackend's deleteBranch/removeListedWorktree: both need the DB
// (tasks, sessions) and, for the live-session guard, app.pty — neither of
// which git-branch-delete.ts/git-worktree.ts have access to (deliberately
// kept DB-free and unit-testable standalone — see the plan's binding
// decision on why these guards live in the route, not the service).

/**
 * A `mullion/task-<N>` branch referenced by a task in a resumable state
 * refuses manual deletion unless `force` — `resumeTaskWorktree` (issue
 * #483) checks that branch out for Retry, and it 502s `worktree-failed`
 * once it's gone (see docs/tasks.md's Worktree lifecycle section). Returns
 * the task id when a match is found, else `null`.
 */
const RESUMABLE_TASK_STATUSES = ["claimed", "in_progress", "reviewing", "failed"] as const;

function branchClaimedByResumableTask(
  app: FastifyInstance,
  projectId: number,
  branchName: string,
): number | null {
  const [row] = app.db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, projectId),
        eq(tasks.branchName, branchName),
        inArray(tasks.status, RESUMABLE_TASK_STATUSES),
      ),
    )
    .all();
  return row?.id ?? null;
}

/**
 * Session ids (by id) whose effective cwd sits under `worktreePath` — the
 * user-facing worktree-removal route's live-session guard. `sessions.cwd`
 * is nullable, so the `row.cwd ?? project.cwd` fallback is mandatory (same
 * as resolveSessionCwdTargets above). For `LOCAL_HOST_ID` only, merges
 * `app.pty.get(String(id))?.liveCwd` when `isGitRepo(liveCwd)` passes —
 * CLAUDE.md's rule that live process state lives only in PtyManager's
 * in-memory map and must be merged, not read from the DB column alone.
 * Also matches `tasks.worktreePath` equality (schema.ts) — a durable
 * reference that survives the worker session's own removal (its `status`
 * flips to killed/exited, but the row and its `sessionId` FK both persist;
 * only a hard row delete would null it out via `onDelete: "set null"`).
 * Scoped to the same `RESUMABLE_TASK_STATUSES` as `branchClaimedByResumable
 * Task` above (independent review on PR #505) — a `done`/`cancelled` task's
 * `worktreePath` is never nulled on that transition either, so without this
 * filter a worktree left behind by an old, finished task would forever
 * report a misleading "active session" for a session that may have exited
 * long ago.
 *
 * Known gap (same one the batch git-status endpoint above already
 * documents): for a remote-hosted project the PTYs live on the agent, so
 * only the DB half of this guard applies here.
 */
function sessionsUnderWorktree(
  app: FastifyInstance,
  project: { id: number; hostId: string; cwd: string },
  worktreePath: string,
): number[] {
  const matched = new Set<number>();

  const activeRows = app.db
    .select({ id: sessions.id, cwd: sessions.cwd })
    .from(sessions)
    .where(and(eq(sessions.projectId, project.id), eq(sessions.status, "active")))
    .all();
  for (const row of activeRows) {
    let effectiveCwd = row.cwd ?? project.cwd;
    if (project.hostId === LOCAL_HOST_ID) {
      const liveCwd = app.pty.get(String(row.id))?.liveCwd;
      if (liveCwd && isGitRepo(liveCwd)) effectiveCwd = liveCwd;
    }
    if (isWithinAnyWorktree(effectiveCwd, [worktreePath])) matched.add(row.id);
  }

  const resolvedTarget = path.resolve(worktreePath);
  const taskRows = app.db
    .select({ sessionId: tasks.sessionId, worktreePath: tasks.worktreePath })
    .from(tasks)
    .where(and(eq(tasks.projectId, project.id), inArray(tasks.status, RESUMABLE_TASK_STATUSES)))
    .all();
  for (const t of taskRows) {
    if (
      t.sessionId !== null &&
      t.worktreePath !== null &&
      path.resolve(t.worktreePath) === resolvedTarget
    ) {
      matched.add(t.sessionId);
    }
  }

  return [...matched];
}

/**
 * #490b — `enableWebhooks` only ever registers a hook for the projects
 * that exist at the moment it's called; a project added afterward gets no
 * hook and nothing detects it until the periodic reconciler's next pass
 * (up to `RECONCILE_INTERVAL_MS` later — see webhook-reconciler.ts). This
 * closes the common case immediately: called from the create/update
 * handlers below, a no-op whenever webhooks aren't enabled or the token/
 * secret aren't both available. Best-effort by design — `registerProjectWebhook`
 * itself never throws, logging and recording the failure instead (see its
 * own doc comment), so this never blocks the project create/update
 * response on a GitHub round trip failing.
 */
async function maybeRegisterProjectWebhook(
  app: FastifyInstance,
  row: { id: number; cwd: string; hostId: string },
): Promise<void> {
  try {
    if (!getIntegration(app).webhookEnabled) return;
    const token = getToken(app);
    const secret = getWebhookSecret(app);
    if (!token || !secret) return;

    const webhookUrl = buildWebhookUrl(app);
    // A cwd change can point this project at a different repo than the one
    // it was last registered against. Capture the old registration first —
    // if the repo really did change, its hook is now orphaned (still live
    // on GitHub, still delivering events, but for a repo nothing here
    // tracks anymore) and needs tearing down once the new repo is handled.
    const previous = app.db
      .select({
        owner: webhookRegistrations.owner,
        repo: webhookRegistrations.repo,
        hookId: webhookRegistrations.hookId,
      })
      .from(webhookRegistrations)
      .where(eq(webhookRegistrations.projectId, row.id))
      .get();

    await registerProjectWebhook(app, row, token, webhookUrl, secret);

    if (previous?.hookId) {
      const current = app.db
        .select({ owner: webhookRegistrations.owner, repo: webhookRegistrations.repo })
        .from(webhookRegistrations)
        .where(eq(webhookRegistrations.projectId, row.id))
        .get();
      if (current && (current.owner !== previous.owner || current.repo !== previous.repo)) {
        await unregisterHook(token, previous.owner, previous.repo, webhookUrl).catch((err) => {
          app.log.warn(
            { err, projectId: row.id, owner: previous.owner, repo: previous.repo },
            "Could not unregister webhook for project's previous repo",
          );
        });
      }
    }
  } catch (err) {
    // Genuinely best-effort (see this function's own doc comment above):
    // a project create/update must never fail because the GitHub
    // integration subsystem is in a bad state.
    app.log.warn({ err, projectId: row.id }, "Could not register webhook for project");
  }
}

interface ProjectRepoContext {
  project: typeof projects.$inferSelect;
  repoRef: GitHubRepoRef;
  token: string;
}

interface LoadProjectRepoContextOptions {
  /** Folded into the "host unreachable"/"agent rejected" log messages
   * below, e.g. "github status", "jobs", "logs" — mirrors each route's own
   * previous per-site wording. */
  unavailableLabel: string;
  /** How to turn a resolved `repoRef` into a token. Defaults to the
   * `resolveGitHubToken(app, repoRef, "read")` (#489) App-token-with-PAT-
   * fallback path every GitHub route below uses — except `/github/prs`,
   * which has always read the shared PAT directly via `getToken(app)`
   * instead (no `#489 remaining scope` comment ever covered it). That's a
   * pre-existing inconsistency, not something this refactor fixes — it's
   * preserved as-is via this override rather than silently normalized. */
  resolveToken?: (repoRef: GitHubRepoRef) => Promise<string | null>;
}

/**
 * The ~28-line preamble every `/api/projects/:id/github*` route below
 * shared verbatim (project lookup, host-aware repo-ref resolution, token
 * resolution), each with its own 400/404/503/204 short-circuits. Sends the
 * appropriate reply and returns `null` the moment any step comes up short;
 * returns the fully-resolved `{ project, repoRef, token }` otherwise.
 *
 * Repo-ref resolution goes through `resolveRepoRefResult` (host-git.ts) —
 * NOT the null-collapsing `resolveRepoRef` used elsewhere — because these
 * routes are the one place that needs to tell "host unreachable" (503)
 * apart from "no github.com remote configured" (204); see host-git.ts's
 * own doc comments on both functions.
 */
async function loadProjectRepoContext(
  app: FastifyInstance,
  reply: FastifyReply,
  projectId: number,
  options: LoadProjectRepoContextOptions,
): Promise<ProjectRepoContext | null> {
  if (!Number.isInteger(projectId)) {
    reply.badRequest("Invalid project id");
    return null;
  }

  const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
  if (!project) {
    reply.notFound();
    return null;
  }

  const result = await resolveRepoRefResult(app, project);
  if (!result.ok) {
    // "unsupported" (an old agent build predating the resolveGitHubRepo
    // route — a bare 404) vs. "unreachable" (anything else: a real
    // transport failure, or the agent responding with a non-404 rejection)
    // — both were collapsed into a single unconditional "host unreachable"
    // 503 by every one of these routes before this refactor except
    // `/github/prs` (Hermes review, PR #244), which alone distinguished
    // *any* agent-level rejection (`HostRequestError`, any status) from a
    // real connectivity failure. That's narrower than what `/github/prs`
    // used to do — a non-404 rejection now logs as "unreachable" rather
    // than "agent rejected" — but the debugging value survives: `detail`
    // carries the agent's own `HTTP <status>` message either way (see
    // `HostRequestError`'s constructor, remote-host-client.ts), and every
    // site now gets the 404-vs-everything-else split in its log message,
    // not just `/github/prs`. The 503 response itself is unchanged either
    // way, for every reason.
    const message =
      result.reason === "unsupported"
        ? `agent rejected github-repo request, ${options.unavailableLabel} unavailable`
        : `host unreachable, ${options.unavailableLabel} unavailable`;
    app.log.warn(
      {
        hostId: project.hostId,
        reason: result.reason,
        detail: result.reason === "unreachable" ? result.detail : undefined,
      },
      message,
    );
    reply.serviceUnavailable(`Host ${project.hostId} is unreachable`);
    return null;
  }

  const repoRef = result.value;
  if (!repoRef) {
    reply.code(204);
    return null;
  }

  const resolveToken = options.resolveToken ?? ((ref) => resolveGitHubToken(app, ref, "read"));
  const token = await resolveToken(repoRef);
  if (!token) {
    reply.code(204);
    return null;
  }

  return { project, repoRef, token };
}

export async function projectsRoute(app: FastifyInstance) {
  // detectedDevServerPort is derived, not persisted (see dev-server-detect.ts):
  // a project's own devServerUrl column is the sole authoritative value, this
  // is only ever a suggestion the frontend may offer to pre-fill it with.
  // Batched as one extra query across every returned project's active dock
  // sessions, rather than one query per project — this list is polled on
  // every dashboard refresh, so an N+1 here would cost real latency for a
  // feature nobody may even be using.
  //
  // currentBranch (issue #96) rides along on this same response rather than
  // a per-project fetch — it's cheap for a local project (git-branch.ts's
  // pure HEAD read) and, for a remote one, no worse than one extra
  // /internal/git-branch round trip per project on an already-polled list.
  // A single unreachable remote host degrades that project's own
  // currentBranch to null rather than failing the whole list — the same
  // "widget just doesn't render" posture as the /github and /git-status
  // routes below, just without a status code to express it through here.
  app.get("/api/projects", async () => {
    const rows = app.db
      .select()
      .from(projects)
      .orderBy(sql`LOWER(${projects.name})`)
      .all();

    const activeDockSessions = app.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.kind, "dock"), eq(sessions.status, "active")))
      .all();
    const dockSessionIdsByProject = new Map<number, string[]>();
    for (const session of activeDockSessions) {
      const ids = dockSessionIdsByProject.get(session.projectId) ?? [];
      ids.push(String(session.id));
      dockSessionIdsByProject.set(session.projectId, ids);
    }

    return Promise.all(
      rows.map(async (row) => {
        let currentBranch: string | null;
        // Issue #431 — the sidebar's rule-file indicator (which of
        // CLAUDE.md/AGENTS.md/AGENTS.override.md/GEMINI.md this project
        // actually has), same "ride along on this already-polled list"
        // reasoning as currentBranch immediately above. A local project
        // does the cheap existsSync-only check directly; a remote one hits
        // the dedicated /internal/agent-rules/exists endpoint (Hermes
        // review, PR #458) — NOT /internal/agent-rules, which inlines full
        // content for all 12 targets (up to 512KB each) and would ship an
        // entire CLAUDE.md body on every sidebar mount for a names-only
        // need. A single unreachable remote host degrades that project's
        // own ruleFiles to an empty array, same "widget just doesn't
        // render" posture as currentBranch.
        let ruleFiles: string[];
        if (row.hostId === LOCAL_HOST_ID) {
          currentBranch = readGitBranch(row.cwd);
          ruleFiles = listExistingProjectRuleFileNames(row.cwd);
        } else {
          // Hermes review, PR #458 — these two used to await in series,
          // doubling this row's own latency even though the outer
          // Promise.all already runs every OTHER row concurrently. Each
          // keeps its own independent try/catch (a host failing one must
          // not also fail the other) via .catch() instead of a shared one.
          //
          // getRemoteHostClient() itself throws SYNCHRONOUSLY for a missing
          // host row or a null baseUrl (round 5 review caught this: it had
          // been hoisted out here, so that throw rejected this row's whole
          // map callback and 500'd the entire GET /api/projects instead of
          // just this project's own currentBranch/ruleFiles degrading) — so
          // it needs its own try/catch too, not just the two requests.
          try {
            const client = getRemoteHostClient(app, row.hostId);
            [currentBranch, ruleFiles] = await Promise.all([
              client.resolveGitBranch(row.cwd).catch((err: unknown) => {
                app.log.warn(
                  { hostId: row.hostId, projectId: row.id, err },
                  "host unreachable, currentBranch unavailable",
                );
                return null;
              }),
              // Names-only — see remote-host-client.ts's own doc comment on
              // resolveExistingRuleFileNames for why this isn't
              // resolveAgentRules (full content, up to 512KB x 12 targets).
              client.resolveExistingRuleFileNames(row.cwd).catch((err: unknown) => {
                app.log.warn(
                  { hostId: row.hostId, projectId: row.id, err },
                  "host unreachable, ruleFiles unavailable",
                );
                return [];
              }),
            ]);
          } catch (err) {
            app.log.warn(
              { hostId: row.hostId, projectId: row.id, err },
              "could not resolve remote host client, currentBranch/ruleFiles unavailable",
            );
            currentBranch = null;
            ruleFiles = [];
          }
        }
        return {
          ...row,
          currentBranch,
          ruleFiles,
          // Remote-hosted projects are skipped outright, not just "usually
          // null": app.pty only tracks sessions spawned/attached by this
          // same process, and a remote project's dock session lives in its
          // owning agent's own PtyManager instead — see dev-server-detect.ts's
          // own comment.
          detectedDevServerPort:
            row.hostId === LOCAL_HOST_ID
              ? detectDevServerPortForSessionIds(app, dockSessionIdsByProject.get(row.id) ?? [])
              : null,
        };
      }),
    );
  });

  // A real filesystem scan (readdirSync + existsSync per candidate), so
  // rate-limited more tightly than the app-wide default in security.ts —
  // both apply (this doesn't disable the global one, just tightens it for
  // this specific route). CodeQL's js/missing-rate-limiting query flagged
  // this route as unprotected before this was added — a genuine false
  // positive (the global limiter already covered it, confirmed live: 429s
  // kicked in past RATE_LIMIT_MAX on a real running instance) since the
  // query can't trace a rate limiter registered globally from a separate
  // plugin file back to this handler, but an explicit route-level limit
  // both satisfies that check directly and is independently reasonable
  // given the cost of this specific handler.
  app.get<{ Querystring: { hostId?: string } }>(
    "/api/projects/discover",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const hostId = request.query.hostId ?? LOCAL_HOST_ID;

      let candidates: DiscoveredCandidate[];
      if (hostId === LOCAL_HOST_ID) {
        candidates = discoverCandidates(resolveProjectRoots(app));
      } else {
        if (!getHostRow(app, hostId)) return reply.notFound(`Unknown host ${hostId}`);
        try {
          candidates = await getRemoteHostClient(app, hostId).discover();
        } catch (err) {
          app.log.warn({ hostId, err }, "host unreachable, discovery unavailable");
          return reply.serviceUnavailable(`Host ${hostId} is unreachable`);
        }
      }

      // Discovery is per-host (issue #26): a cwd on one host registering
      // as "already added" must never match a same-path project on a
      // different host, so the match key is (hostId, cwd), not cwd alone.
      const registeredCwds = new Set(
        app.db
          .select({ cwd: projects.cwd })
          .from(projects)
          .where(eq(projects.hostId, hostId))
          .all()
          .map((p) => p.cwd),
      );

      const discovered: DiscoveredProject[] = candidates.map((c) => ({
        ...c,
        isRegistered: registeredCwds.has(c.cwd),
      }));
      return discovered;
    },
  );

  // Merged launcher list for this project — see project-config.ts for the
  // precedence rules (package.json scripts / tasks.json / .crs/actions.json
  // layered over the global shell/agent/config presets from GET
  // /api/actions). Read-only: launching one of these is just the existing
  // POST /api/sessions using its `command` (and `id` as a stable label).
  app.get<{ Params: { id: string } }>("/api/projects/:id/actions", async (request, reply) => {
    const projectId = Number(request.params.id);
    if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

    const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
    if (!project) return reply.notFound();

    if (project.hostId === LOCAL_HOST_ID) {
      const globalPresets = await resolveGlobalPresets(app);
      return resolveProjectActions(project.cwd, globalPresets);
    }
    // Global presets (installed CLIs, global .crs/actions.json) come from
    // the remote agent's own host, not this process — see
    // remote-host-client.ts's resolveActions and routes/internal.ts's
    // /internal/actions, which resolves both halves host-side already.
    try {
      return await getRemoteHostClient(app, project.hostId).resolveActions(project.cwd);
    } catch (err) {
      app.log.warn({ hostId: project.hostId, err }, "host unreachable, actions unavailable");
      return reply.serviceUnavailable(`Host ${project.hostId} is unreachable`);
    }
  });

  // Issue #73 — every registered local-host project's cwd, used to decide
  // which project "owns" a discovered Compose service when project
  // directories nest (see docker-service-detect.ts's mapServicesToProject
  // doc comment for why the full list is needed rather than just the one
  // project's own cwd).
  function localProjectCwds(): string[] {
    return app.db
      .select({ cwd: projects.cwd })
      .from(projects)
      .where(eq(projects.hostId, LOCAL_HOST_ID))
      .all()
      .map((row) => row.cwd);
  }

  // Issue #73 — this project's own discovered Compose services (never
  // called for a non-local project). Shared by the dock route below and
  // the docker/check-update + docker/update routes further down, so the
  // discovery pass, project-ownership mapping, and dedupe logic all live in
  // exactly one place.
  async function discoveredServicesForProject(project: { cwd: string }): Promise<ComposeService[]> {
    const all = await getComposeServices();
    return mapServicesToProject(all, project.cwd, localProjectCwds());
  }

  // Dock controls for this project — persistent monitors (dev server, git
  // status, logs), distinct from one-shot launchers above. Read-only config;
  // turning one "on" is just POST /api/sessions with kind: "dock" (see
  // sessions.ts) using this control's own id/command/cwd.
  //
  // Issue #73 — for a local-host project, merges in a control per
  // discovered Docker Compose service, UNDER whatever `.crs/dock.json`
  // already configures (configured wins on an `id` collision — the issue's
  // "manual overrides win"). Local-host only: resolveProjectDock,
  // /internal/dock, and RemoteHostClient.resolveDock are untouched, so a
  // remote-hosted project simply never sees discovered controls (same
  // posture as dev-server port detection — docs/dock.md).
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/dock",
    // This route now shells out to `docker` for a local-host project, so it
    // gets its OWN rate-limit bucket rather than the app-wide default (a
    // route-level `config.rateLimit` replaces the global limiter for that
    // route entirely — @fastify/rate-limit's `onRoute` hook gives a route
    // either the global hook or its own, never both). Sized for the
    // frontend's 15s-per-column poll (Dock.tsx): 120/min covers ~30 columns
    // continuously polling from one IP, comfortably above any real
    // dashboard's column count, while the backend's own 10s discovery cache
    // (docker-service-detect.ts) means the actual `docker ps` cost per poll
    // stays flat regardless.
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
      if (!project) return reply.notFound();

      if (project.hostId === LOCAL_HOST_ID) {
        const configured = resolveProjectDock(project.cwd, app.config.CRS_CONFIG_DIR);
        if (!getStoredSettings(app.db).dock.dockerServices) return configured;

        const discovered = await discoveredServicesForProject(project);
        const discoveredControls = await toDockControls(discovered);
        const merged = new Map<
          string,
          (typeof discoveredControls)[number] | (typeof configured)[number]
        >();
        for (const control of discoveredControls) merged.set(control.id, control);
        for (const control of configured) merged.set(control.id, control);
        return [...merged.values()];
      }
      try {
        return await getRemoteHostClient(app, project.hostId).resolveDock(project.cwd);
      } catch (err) {
        app.log.warn({ hostId: project.hostId, err }, "host unreachable, dock unavailable");
        return reply.serviceUnavailable(`Host ${project.hostId} is unreachable`);
      }
    },
  );

  // Issue #73 — resolves `controlId` (the "docker:<project>:<service>" id
  // toDockControls() synthesizes) against THIS project's own discovery
  // result. This lookup is both the authorization boundary (you cannot
  // touch a stack that isn't linked to this project — a stale/foreign id
  // 404s) and the injection guard for the two routes below: neither ever
  // builds a docker/shell argument from the request body itself, only from
  // the matched ComposeService's own fields.
  //
  // Also enforces settings.dock.dockerServices here (Hermes review) rather
  // than only gating the GET .../dock merge: that GET route's own check was
  // documented as a "visibility kill-switch", but leaving these two POST
  // routes reachable by a still-valid controlId while the setting is off
  // made it something less than that in practice. Checking it here — the
  // one place both POST routes fall through — makes it a real kill-switch
  // for defense in depth, at the cost of no extra plumbing per route.
  async function resolveOwnedService(
    project: { cwd: string },
    controlId: unknown,
  ): Promise<ComposeService | null> {
    if (typeof controlId !== "string") return null;
    if (!getStoredSettings(app.db).dock.dockerServices) return null;
    const services = await discoveredServicesForProject(project);
    return services.find((s) => `docker:${s.composeProject}:${s.service}` === controlId) ?? null;
  }

  interface DockerControlBody {
    controlId: string;
  }

  // Shared by both POST .../docker/* routes below — without this, a POST
  // with no body (or the wrong shape) dereferences `request.body.controlId`
  // on `undefined` and 500s, unlike every other mutating route in this repo
  // (e.g. sessions.ts's createSessionSchema), which gets a clean 400 from an
  // explicit schema instead. resolveOwnedService's own `typeof controlId !==
  // "string"` guard only covers a wrong-TYPED field already past this gate.
  const dockerControlSchema = {
    body: {
      type: "object",
      required: ["controlId"],
      additionalProperties: false,
      properties: {
        controlId: { type: "string", minLength: 1 },
      },
    },
  } as const;

  // Runs a quiet `docker compose pull` for one service and compares the
  // resulting local image id against the currently-running container's own
  // `com.docker.compose.image` label — catches both "a new image exists
  // upstream" and "a newer image was already pulled but the container was
  // never recreated." Deliberately not the issue's literal
  // before/after-pull-digest diff (see the plan's rationale). A pull
  // failure (private registry, no image at all) is a 200 with
  // reason:"pull-failed", never a 5xx — "can't check" isn't a server error.
  app.post<{ Params: { id: string }; Body: DockerControlBody }>(
    "/api/projects/:id/docker/check-update",
    { schema: dockerControlSchema, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
      if (!project) return reply.notFound();
      if (project.hostId !== LOCAL_HOST_ID) {
        return reply.badRequest("Docker service management is only available for local projects");
      }

      const service = await resolveOwnedService(project, request.body.controlId);
      if (!service) return reply.notFound();

      if (service.buildOnly) {
        return { updateAvailable: false, reason: "build-only" as const };
      }

      const pulled = await pullComposeImageQuietly(service);
      if (!pulled) {
        return { updateAvailable: false, reason: "pull-failed" as const };
      }

      const latestImageId = await inspectImageId(service.imageRef);
      if (!latestImageId) {
        return { updateAvailable: false, reason: "pull-failed" as const };
      }

      return {
        updateAvailable: latestImageId !== service.imageId,
        currentImageId: service.imageId,
        latestImageId,
        imageRef: service.imageRef,
        checkedAt: new Date().toISOString(),
      };
    },
  );

  // Kicks off `docker compose pull && docker compose up -d` for the WHOLE
  // stack (not just the one service — per the issue, so the stack isn't
  // left internally inconsistent) as a `kind: "dock"` session, rather than
  // running it inline and blocking the response. A multi-minute `up -d`
  // behind a reverse proxy (this repo's own deploy/ Traefik config included)
  // would otherwise hit a proxy idle timeout while the command kept
  // running, leaving the user to retry and race the first invocation. The
  // response echoes back a synthesized, EPHEMERAL DockControl for the new
  // session — this control is never emitted by GET .../dock — because its
  // command is deliberately distinct from the service's own logs command
  // (so Dock.tsx's command-based session matching can't confuse an update
  // run with a log stream), which means no control from the normal list
  // would ever match the session the frontend just created. The frontend
  // prepends this control to its local list so the new session renders
  // through the ordinary monitor body.
  app.post<{ Params: { id: string }; Body: DockerControlBody }>(
    "/api/projects/:id/docker/update",
    { schema: dockerControlSchema, config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
      if (!project) return reply.notFound();
      if (project.hostId !== LOCAL_HOST_ID) {
        return reply.badRequest("Docker service management is only available for local projects");
      }

      const service = await resolveOwnedService(project, request.body.controlId);
      if (!service) return reply.notFound();
      if (service.buildOnly) {
        return reply.badRequest("This service has no registry image to pull");
      }

      const projectFlag = `-p ${shellQuote(service.composeProject)} --project-directory ${shellQuote(service.workingDir)}`;
      const command = `docker compose ${projectFlag} pull && docker compose ${projectFlag} up -d`;

      const result = await createSessionRecord(app, {
        projectId,
        command,
        kind: "dock",
        name: `Update ${service.composeProject}`,
      });
      if (!result.ok) {
        return reply.badGateway("Failed to start the update session");
      }

      return reply.code(201).send({
        sessionId: result.row.id,
        control: {
          id: `docker-update:${service.composeProject}`,
          title: `Update ${service.composeProject}`,
          command,
          source: "docker" as const,
        },
      });
    },
  );

  // Per-project GitHub status: open issue/PR counts + lists for whatever
  // repo this project's `origin` remote points at (issue #27). Degrades to
  // a bare 204 rather than erroring in every "not applicable" case — no
  // github.com remote, no GitHub account connected, or GitHub itself
  // rejecting the request (private repo without scope, rate limited, ...)
  // — see the plan's "widget just doesn't render" rule. A host that's
  // unreachable is the one case this treats as a real failure (503),
  // consistent with the actions/dock routes above.
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/github",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      const ctx = await loadProjectRepoContext(app, reply, projectId, {
        unavailableLabel: "github status",
      });
      if (!ctx) return;
      const { repoRef, token } = ctx;

      try {
        return await getRepoStatus(token, repoRef.owner, repoRef.repo);
      } catch (err) {
        if (!(err instanceof GitHubApiError)) throw err;
        app.log.warn(
          { owner: repoRef.owner, repo: repoRef.repo, statusCode: err.statusCode },
          "github status unavailable",
        );
        reply.code(204);
        return;
      }
    },
  );

  // Per-PR CI/CD status (issue #102) — reads from the warm cache populated
  // by the server-side background poller (github-pr-poller.ts). Returns 204
  // when the poller hasn't run yet or the repo has no open PRs (same
  // degradation pattern as the /github endpoint above). Rate-limited the
  // same as /github since this is still a per-project GitHub endpoint.
  //
  // Optional `?branch=<name>` (issue #202): filters the cached PR list down
  // to whichever PR (if any) has that branch as its head — a session row
  // wants only its own worktree's PR, not every open PR in the repo. The
  // frontend's sidebar doesn't actually call this per-session (fetching the
  // unfiltered list once per project and matching `headBranch` client-side
  // is cheaper), but the filter is a real, independently useful capability
  // of this route either way.
  app.get<{ Params: { id: string }; Querystring: { branch?: string } }>(
    "/api/projects/:id/github/prs",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { branch: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      // Remote-hosted projects (issue #222, follow-up to #102): repoRef
      // resolution goes via the agent, same as the /github endpoint above.
      // The per-PR cache is still keyed by owner/repo and populated by the
      // primary-side poller — this route only needs the ref to look it up.
      //
      // Token: deliberately `getToken(app)` (the shared PAT), NOT
      // `resolveGitHubToken(app, repoRef, "read")` like every other route
      // here — a pre-existing inconsistency (no `#489 remaining scope`
      // comment ever covered this route), preserved as-is rather than
      // silently normalized by this refactor.
      const ctx = await loadProjectRepoContext(app, reply, projectId, {
        unavailableLabel: "github prs status",
        resolveToken: () => Promise.resolve(getToken(app)),
      });
      if (!ctx) return;
      const { repoRef } = ctx;

      const status = getPRsStatus(repoRef.owner, repoRef.repo);
      if (!status || status.prs.length === 0) {
        reply.code(204);
        return;
      }

      const { branch } = request.query;
      if (branch === undefined) return status;

      const filtered = status.prs.filter((pr) => pr.headBranch === branch);
      if (filtered.length === 0) {
        reply.code(204);
        return;
      }
      return { prs: filtered, prSummary: computePRSummary(filtered) };
    },
  );

  // Jobs for a specific workflow run (issue #221 Phase 2) — returns the list
  // of jobs from the GitHub Actions API. Rate-limited like the other GitHub
  // endpoints (30/min).
  app.get<{ Params: { id: string; runId: string } }>(
    "/api/projects/:id/github/actions/:runId/jobs",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      const ctx = await loadProjectRepoContext(app, reply, projectId, {
        unavailableLabel: "jobs",
      });
      if (!ctx) return;
      const { repoRef, token } = ctx;

      const runId = Number(request.params.runId);
      if (!Number.isInteger(runId)) return reply.badRequest("runId must be an integer");

      const jobs = await getWorkflowRunJobs(token, repoRef.owner, repoRef.repo, runId);
      return jobs;
    },
  );

  // REST-style log route (issue #221 Phase 2) — mirrors the /logs endpoint
  // but with path params matching the frontend's expected URL pattern.
  app.get<{
    Params: { id: string; runId: string; jobId: string };
    Querystring: { lines?: string };
  }>(
    "/api/projects/:id/github/actions/:runId/jobs/:jobId/logs",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      const ctx = await loadProjectRepoContext(app, reply, projectId, {
        unavailableLabel: "logs",
      });
      if (!ctx) return;
      const { repoRef, token } = ctx;

      const runId = Number(request.params.runId);
      const jobId = Number(request.params.jobId);
      const lines = request.query.lines ? Number(request.query.lines) : 50;

      if (!Number.isInteger(runId) || !Number.isInteger(jobId)) {
        return reply.badRequest("runId and jobId must be integers");
      }

      const logText = await getJobLogs(token, repoRef.owner, repoRef.repo, jobId, lines);
      if (logText !== null) {
        return { log: logText, truncated: true, lineCount: lines };
      }

      const jobs = await getWorkflowRunJobs(token, repoRef.owner, repoRef.repo, runId);
      const job = jobs.find((j) => j.id === jobId);
      if (!job) {
        reply.code(204);
        return;
      }
      return { log: null, job, truncated: false, lineCount: 0 };
    },
  );

  // Job logs for a specific workflow run job (issue #221 Phase 2) — fetches
  // truncated log output from the GitHub Actions API. The frontend controls
  // truncation via ?lines=N (default 50). Rate-limited like the other GitHub
  // endpoints (30/min).
  app.get<{
    Params: { id: string };
    Querystring: { runId: string; jobId: string; lines?: string };
  }>(
    "/api/projects/:id/github/logs",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          required: ["runId", "jobId"],
          additionalProperties: false,
          properties: {
            runId: { type: "string" },
            jobId: { type: "string" },
            lines: { type: "string", pattern: "^\\d+$" },
          },
        },
      },
    },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      const ctx = await loadProjectRepoContext(app, reply, projectId, {
        unavailableLabel: "logs",
      });
      if (!ctx) return;
      const { repoRef, token } = ctx;

      const runId = Number(request.query.runId);
      const jobId = Number(request.query.jobId);
      const lines = request.query.lines ? Number(request.query.lines) : 50;

      if (!Number.isInteger(runId) || !Number.isInteger(jobId)) {
        return reply.badRequest("runId and jobId must be integers");
      }

      // First try fetching the log directly (REST API is simpler, just raw
      // plaintext). If that returns nothing, fall back to job details.
      const logText = await getJobLogs(token, repoRef.owner, repoRef.repo, jobId, lines);
      if (logText !== null) {
        return { log: logText, truncated: true, lineCount: lines };
      }

      // Fall back to return job details only.
      const jobs = await getWorkflowRunJobs(token, repoRef.owner, repoRef.repo, runId);
      const job = jobs.find((j) => j.id === jobId);
      if (!job) {
        reply.code(204);
        return;
      }
      return { log: null, job, truncated: false, lineCount: 0 };
    },
  );

  // Batch git-status for the sidebar's live-refresh loop: replaces N
  // parallel per-project requests with a single request (issue #76).
  // Accepts ?ids=1,2,3 (project ids) and returns `{ projects, sessions }`
  // where each is a `Record<id, GitStatus | null>` — `null` means "durably
  // not a git repo" (the per-project endpoint's 204 case). An id whose
  // status failed transiently (503-equivalent) is simply omitted from its
  // map, so the frontend preserves its last-known-good for that one.
  // Higher rate limit than the per-project endpoint since this replaces N
  // requests with 1.
  //
  // Optional `?sessionIds=10,11` (issue #202): per-session git status for
  // each session's *effective* cwd (`resolveSessionCwdTargets` above) —
  // most sessions share their project's own cwd (and therefore its status,
  // already computed above and served from the same git-status.ts cache),
  // but a session running in a worktree gets its own distinct status here.
  // Kept in a separate `sessions` map rather than merged into `projects`:
  // project ids and session ids are both plain positive integers from
  // different id spaces, so a merged flat map would be ambiguous about
  // which space a given key belonged to.
  app.get<{ Querystring: { ids?: string; sessionIds?: string } }>(
    "/api/projects/git-statuses",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            ids: { type: "string" },
            sessionIds: { type: "string" },
          },
        },
      },
    },
    async (request) => {
      const ids = parseIdListParam(request.query.ids);
      const sessionIds = parseIdListParam(request.query.sessionIds);

      const projectsResult: Record<string, GitStatus | null> = {};
      if (ids.length > 0) {
        const rows = app.db.select().from(projects).where(inArray(projects.id, ids)).all();

        for (const project of rows) {
          if (project.hostId === LOCAL_HOST_ID) {
            if (!isGitRepo(project.cwd)) {
              projectsResult[project.id] = null;
              continue;
            }
            const status = await getGitStatus(project.cwd);
            if (status) {
              projectsResult[project.id] = status;
            }
          } else {
            try {
              const remoteResult = await getRemoteHostClient(app, project.hostId).resolveGitStatus(
                project.cwd,
              );
              if (!remoteResult.isRepo) {
                projectsResult[project.id] = null;
              } else if (remoteResult.status) {
                projectsResult[project.id] = remoteResult.status;
              }
            } catch (err) {
              app.log.warn(
                { hostId: project.hostId, projectId: project.id, err },
                "batch git-status: remote host unreachable, omitting project",
              );
            }
          }
        }
      }

      const sessionsResult: Record<string, GitStatus | null> = {};
      if (sessionIds.length > 0) {
        const targets = await resolveSessionCwdTargets(app, sessionIds);
        for (const target of targets) {
          if (target.hostId === LOCAL_HOST_ID) {
            if (!isGitRepo(target.cwd)) {
              sessionsResult[target.sessionId] = null;
              continue;
            }
            const status = await getGitStatus(target.cwd);
            if (status) {
              sessionsResult[target.sessionId] = status;
            }
          } else {
            try {
              const remoteResult = await getRemoteHostClient(app, target.hostId).resolveGitStatus(
                target.cwd,
              );
              if (!remoteResult.isRepo) {
                sessionsResult[target.sessionId] = null;
              } else if (remoteResult.status) {
                sessionsResult[target.sessionId] = remoteResult.status;
              }
            } catch (err) {
              // A remote worktree cwd outside that agent's own
              // PROJECTS_ROOTS (resolveWithinRoots, routes/internal.ts)
              // surfaces here as a 4xx HostRequestError, not just the usual
              // HostUnreachableError — both just mean "omit this session,"
              // same as the project loop above.
              app.log.warn(
                { hostId: target.hostId, sessionId: target.sessionId, err },
                "batch git-status: remote host unavailable for session cwd, omitting",
              );
            }
          }
        }
      }

      return { projects: projectsResult, sessions: sessionsResult };
    },
  );

  // Diff stats (issue #202, greenfield) — files-changed + insertions/
  // deletions per session's effective cwd (git-diff.ts's `git diff [base]...HEAD
  // --numstat`). When `base` is set (e.g. `origin/main`), the diff is
  // computed against the merge-base of that ref instead of just HEAD,
  // surfacing the full branch delta even after commits. Batched the same
  // way as the git-statuses endpoint above and for the same reason (one
  // request per live-refresh tick, not one per session). `null` means "not
  // a repo, or nothing to diff yet"; an id whose stats failed transiently
  // is simply omitted.
  app.get<{ Querystring: { sessionIds?: string; base?: string } }>(
    "/api/projects/git-diff-stats",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            sessionIds: { type: "string" },
            base: { type: "string", pattern: "^(?!.*\\.\\.)[a-zA-Z0-9_./-]+$" },
          },
        },
      },
    },
    async (request) => {
      const { base } = request.query;
      const sessionIds = parseIdListParam(request.query.sessionIds);
      const result: Record<string, GitDiffStats | null> = {};
      if (sessionIds.length === 0) return result;

      const targets = await resolveSessionCwdTargets(app, sessionIds);
      for (const target of targets) {
        if (target.hostId === LOCAL_HOST_ID) {
          if (!isGitRepo(target.cwd)) {
            result[target.sessionId] = null;
            continue;
          }
          const effectiveBase =
            base === "AUTO" ? (getDefaultBaseRef(target.cwd) ?? undefined) : base;
          const stats = await getDiffStats(target.cwd, effectiveBase);
          if (stats) {
            result[target.sessionId] = stats;
          }
        } else {
          try {
            const remoteResult = await getRemoteHostClient(app, target.hostId).resolveGitDiffStats(
              target.cwd,
              base,
            );
            if (!remoteResult.isRepo) {
              result[target.sessionId] = null;
            } else if (remoteResult.stats) {
              result[target.sessionId] = remoteResult.stats;
            }
          } catch (err) {
            app.log.warn(
              { hostId: target.hostId, sessionId: target.sessionId, err },
              "batch git-diff-stats: remote host unavailable, omitting",
            );
          }
        }
      }

      return result;
    },
  );

  // Per-file unified diff (issue #262, follow-up to #177) — returns the raw
  // patch text for a specific file in a session's effective cwd, computed
  // against `<base>...HEAD` (defaults to `HEAD`). The frontend fetches this
  // on demand when the user clicks a file-change chip in the sidebar.
  // `null` in the response means "no changes to show"; a missing entry
  // means the session was transiently unavailable.
  //
  // Also accepts `projectId` as an alternative to `sessionId` (issue #433's
  // Source Control sidebar section, which has no session to anchor to — it
  // shows a project's own working-tree diff). Exactly one of the two must be
  // given; everything past cwd resolution is shared with the sessionId path.
  app.get<{
    Querystring: { sessionId?: string; projectId?: string; path?: string; base?: string };
  }>(
    "/api/projects/git-file-diff",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: {
            sessionId: { type: "string" },
            projectId: { type: "string" },
            path: { type: "string" },
            base: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { sessionId: sessionIdRaw, projectId: projectIdRaw } = request.query;
      const filePath = request.query.path;
      const base = request.query.base;
      if (!filePath || filePath.includes("..")) return reply.badRequest("Invalid path");
      if ((sessionIdRaw == null) === (projectIdRaw == null)) {
        return reply.badRequest("Provide exactly one of sessionId or projectId");
      }

      let target: { hostId: string; cwd: string };
      if (sessionIdRaw != null) {
        const sessionId = Number(sessionIdRaw);
        if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid sessionId");
        const targets = await resolveSessionCwdTargets(app, [sessionId]);
        if (targets.length === 0) return reply.notFound("Session not found");
        target = targets[0];
      } else {
        const projectId = Number(projectIdRaw);
        if (!Number.isInteger(projectId)) return reply.badRequest("Invalid projectId");
        const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
        if (!project) return reply.notFound("Project not found");
        target = { hostId: project.hostId, cwd: project.cwd };
      }

      if (target.hostId !== LOCAL_HOST_ID) {
        try {
          const remoteResult = await getRemoteHostClient(app, target.hostId).resolveGitFileDiff(
            target.cwd,
            filePath,
            base,
          );
          return { patch: remoteResult.patch ?? null };
        } catch (err) {
          app.log.warn(
            { hostId: target.hostId, sessionId: sessionIdRaw, projectId: projectIdRaw, err },
            "git-file-diff: remote host unavailable",
          );
          return { patch: null };
        }
      }

      if (!isGitRepo(target.cwd)) return { patch: null };

      // Resolve the file path relative to the target cwd.
      // The hook's file_change path can be absolute (Claude Code) or
      // relative (Codex); git needs a path relative to its -C directory.
      const resolvedPath = path.isAbsolute(filePath)
        ? path.relative(target.cwd, filePath)
        : filePath;
      if (resolvedPath.startsWith("..")) return { patch: null };

      const effectiveBase = base === "AUTO" ? (getDefaultBaseRef(target.cwd) ?? undefined) : base;
      const patch = await getFileDiff(target.cwd, resolvedPath, effectiveBase);
      return { patch };
    },
  );

  // Fuller git status for the GitPanel/sidebar badge (issue #76): branch,
  // short hash, ahead/behind vs. upstream, and per-file status — cloned from
  // the /github handler just above. Two distinct "nothing to show" cases,
  // deliberately given different status codes so the frontend can tell a
  // durable state apart from a recoverable one instead of collapsing both
  // into the same "not a git repository" render (the flicker/no-recovery bug
  // fixed alongside this route change):
  //   - 204: `cwd` genuinely isn't a git repo (or a remote host reports the
  //     same). Durable — no point retrying, no last-known-good to keep.
  //   - 503: `cwd` *is* a repo (or the remote host confirms as much) but
  //     `git status` itself failed transiently, or the remote host is
  //     unreachable. The frontend should keep showing its last-known-good
  //     status here rather than blanking to "not a repo".
  //
  // `?fresh=1` (issue #433, Hermes review on PR #506) opts into
  // getGitStatus's `forceFresh`, bypassing its CACHE_TTL_MS in-memory cache
  // — used by the sidebar's Source Control section and GitPanel's own
  // manual "Fetch" buttons, whose whole point is to show the state
  // immediately after a `git fetch`, not whatever was cached up to 5s
  // beforehand. The default 4s live-refresh poll never sets this, so the
  // cache still does its job for that path. Local only for now — a remote-
  // hosted project's Fetch button still shows the agent's own cached read
  // (same limitation GitPanel.tsx's handleFetch already had).
  app.get<{ Params: { id: string }; Querystring: { fresh?: string } }>(
    "/api/projects/:id/git-status",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
      if (!project) return reply.notFound();

      if (project.hostId === LOCAL_HOST_ID) {
        if (!isGitRepo(project.cwd)) {
          reply.code(204);
          return;
        }
        const status = await getGitStatus(project.cwd, { forceFresh: request.query.fresh === "1" });
        if (!status) return reply.serviceUnavailable("git status is temporarily unavailable");
        return status;
      }

      let remoteResult: { isRepo: boolean; status: GitStatus | null };
      try {
        remoteResult = await getRemoteHostClient(app, project.hostId).resolveGitStatus(project.cwd);
      } catch (err) {
        app.log.warn({ hostId: project.hostId, err }, "host unreachable, git status unavailable");
        return reply.serviceUnavailable(`Host ${project.hostId} is unreachable`);
      }
      if (!remoteResult.isRepo) {
        reply.code(204);
        return;
      }
      if (!remoteResult.status) {
        return reply.serviceUnavailable("git status is temporarily unavailable");
      }
      return remoteResult.status;
    },
  );

  // Local branches + worktrees for the GitPanel (issue #162's "worktree
  // awareness" — Mullion observes whatever worktrees exist, whoever created
  // them, rather than managing its own). Unlike /git-status, this is
  // deliberately NOT part of the sidebar's 4s live-refresh loop — the
  // frontend only calls this when the GitPanel is opened (git-refs.ts's own
  // doc comment on why). Same "widget just doesn't render" 204 degradation
  // as /git-status.
  app.get<{ Params: { id: string }; Querystring: { detail?: string } }>(
    "/api/projects/:id/git-branches",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
      if (!project) return reply.notFound();

      // Issue #442 — opt-in isMerged enrichment (extra base-resolution +
      // `git branch --merged` spawns), set only by the GitPanel's own
      // explicit fetch. The 60s background poll (store.ts's refreshGitRefs)
      // calls this route with no `detail` param, so it keeps paying for
      // exactly the one for-each-ref spawn it always has.
      const detail = request.query.detail === "1";

      let result: {
        branches: GitBranchInfo[];
        worktrees: GitWorktreeInfo[];
        remoteBranches: string[];
        // Issue #271 follow-up — the promote/launcher base-ref pickers'
        // default. `undefined` on an old remote host that hasn't been
        // upgraded yet (see the degradation convention at
        // shared/types.ts's own doc comment); `null` when this host
        // resolved it and found no usable default (no remote, or the
        // fallback chain bottomed out at "HEAD" — see
        // resolveDefaultBaseRefForPicker). Either way callers fall back to
        // the current branch.
        defaultBranch?: string | null;
      } | null;
      if (project.hostId === LOCAL_HOST_ID) {
        const [branches, worktrees, remoteBranches, defaultBranch] = await Promise.all([
          listBranches(project.cwd, { detail }),
          listWorktrees(project.cwd),
          listRemoteBranches(project.cwd),
          resolveDefaultBaseRefForPicker(project.cwd),
        ]);
        result =
          branches && worktrees && remoteBranches
            ? { branches, worktrees, remoteBranches, defaultBranch }
            : null;
      } else {
        try {
          result = await getRemoteHostClient(app, project.hostId).resolveGitBranches(
            project.cwd,
            detail,
          );
        } catch (err) {
          app.log.warn(
            { hostId: project.hostId, err },
            "host unreachable, git branches unavailable",
          );
          return reply.serviceUnavailable(`Host ${project.hostId} is unreachable`);
        }
      }
      if (!result) {
        reply.code(204);
        return;
      }
      return result;
    },
  );

  // Manual fetch trigger — POST /api/projects/:id/git-fetch runs
  // `git fetch origin` for this project now, regardless of auto-fetch
  // settings. Returns { success: boolean, error?: string }.
  const gitFetchParamsSchema = {
    params: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", pattern: "^[1-9][0-9]*$" } },
    },
  };
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/git-fetch",
    { schema: gitFetchParamsSchema, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
      if (!project) return reply.notFound();

      if (project.hostId === LOCAL_HOST_ID) {
        return await runGitFetch(project.cwd);
      }

      try {
        return await getRemoteHostClient(app, project.hostId).resolveGitFetch(project.cwd);
      } catch {
        return reply.serviceUnavailable(`Host ${project.hostId} is unreachable`);
      }
    },
  );

  // Manual fast-forward pull trigger (issue #745) — POST /api/projects/:id/git-pull
  // runs `git merge --ff-only @{u}` after fetching for this project.
  // Returns GitPullResult ({ pulled: boolean, reason?, detail? }).
  const gitPullParamsSchema = {
    params: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", pattern: "^[1-9][0-9]*$" } },
    },
  };
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/git-pull",
    { schema: gitPullParamsSchema, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
      if (!project) return reply.notFound();

      if (project.hostId === LOCAL_HOST_ID) {
        return await runGitPull(project.cwd);
      }

      try {
        return await getRemoteHostClient(app, project.hostId).resolveGitPull(project.cwd);
      } catch {
        return reply.serviceUnavailable(`Host ${project.hostId} is unreachable`);
      }
    },
  );

  // Issue #442 — GitPanel manual branch deletion. POST, not DELETE (a
  // branch name can contain "/"). Same write-tier rate limit as git-fetch
  // above, rather than git-status's 30/min.
  const gitBranchDeleteBodySchema = {
    body: {
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: {
        // maxLength (Hermes review on PR #505) — cheap defense-in-depth
        // against an oversized payload reaching the git spawn arg; harmless
        // either way (deleteBranch's own precheck just reports no-such-
        // branch for anything that doesn't resolve), but no real branch
        // name is remotely this long.
        name: { type: "string", minLength: 1, maxLength: 255 },
        force: { type: "boolean" },
      },
    },
  };
  app.post<{ Params: { id: string }; Body: { name: string; force?: boolean } }>(
    "/api/projects/:id/git-branch-delete",
    {
      schema: gitBranchDeleteBodySchema,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
      if (!project) return reply.notFound();

      const { name, force } = request.body;

      // Task-branch guard (binding decision #5). Force always overrides —
      // this is a UX safety net for the GitPanel's two-step confirm, not a
      // security boundary: anyone with host access to this project can
      // already run `git branch -D` directly in a terminal session with no
      // confirmation at all, so a caller sending `force: true` on the very
      // first request isn't bypassing anything the underlying host doesn't
      // already permit. What this fixes (Hermes review on PR #505): the
      // lookup used to be skipped ENTIRELY under `force`, so a force-delete
      // of a still-resumable task's branch left no trace anywhere. It now
      // always runs, and a force bypass is logged, so it's diagnosable
      // after the fact even though it remains permitted.
      const taskId = branchClaimedByResumableTask(app, project.id, name);
      if (taskId !== null) {
        if (!force) {
          const result:
            DeleteBranchResult | { deleted: false; reason: "task-branch"; detail: string } = {
            deleted: false,
            reason: "task-branch",
            detail: `#${taskId}`,
          };
          return result;
        }
        app.log.warn(
          { projectId: project.id, branchName: name, taskId },
          "force-deleting a branch referenced by a resumable task — its Retry will break",
        );
      }

      const backend = resolveBackend(app, project.hostId);
      try {
        return await backend.deleteBranch(project.cwd, name, { force });
      } catch (err) {
        app.log.warn({ hostId: project.hostId, err }, "host unreachable, git branch delete failed");
        return reply.serviceUnavailable(`Host ${project.hostId} is unreachable`);
      }
    },
  );

  // Issue #442 — GitPanel manual worktree removal. Validity gate is
  // membership in `listWorktrees` (git-worktree.ts's removeListedWorktree),
  // not a path prefix — see that function's own doc comment.
  const gitWorktreeRemoveBodySchema = {
    body: {
      type: "object",
      required: ["worktreePath"],
      additionalProperties: false,
      properties: {
        // maxLength (Hermes review on PR #505) — 4096, not 255: unlike
        // git-branch-delete's `name`, this is a full absolute path, not a
        // single ref-like string, and Linux's own PATH_MAX is 4096.
        worktreePath: { type: "string", minLength: 1, maxLength: 4096 },
        force: { type: "boolean" },
      },
    },
  };
  app.post<{ Params: { id: string }; Body: { worktreePath: string; force?: boolean } }>(
    "/api/projects/:id/git-worktree-remove",
    {
      schema: gitWorktreeRemoveBodySchema,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
      if (!project) return reply.notFound();

      const { worktreePath, force } = request.body;

      // The main worktree IS project.cwd — skip the live-session guard for
      // it (almost every session in a non-isolated project has an
      // effective cwd under it, which would otherwise report a confusing
      // "sessions-active" for what removeListedWorktree itself already
      // refuses as "is-main" regardless of force).
      const isMainWorktreeTarget = path.resolve(worktreePath) === path.resolve(project.cwd);

      // Live-session guard — same force-overrides-as-UX-safety-net posture
      // as the task-branch guard above (Hermes review on PR #505): the
      // lookup always runs (skipped only for the main worktree, which
      // `removeListedWorktree` itself already refuses as "is-main"
      // regardless of force), and a force bypass is logged rather than
      // silently skipped.
      if (!isMainWorktreeTarget) {
        const sessionIds = sessionsUnderWorktree(app, project, worktreePath);
        if (sessionIds.length > 0) {
          if (!force) {
            const result:
              | RemoveListedWorktreeResult
              | { removed: false; reason: "sessions-active"; detail: string } = {
              removed: false,
              reason: "sessions-active",
              detail: sessionIds.join(","),
            };
            return result;
          }
          app.log.warn(
            { projectId: project.id, worktreePath, sessionIds },
            "force-removing a worktree with active sessions under it",
          );
        }
      }

      const backend = resolveBackend(app, project.hostId);
      try {
        return await backend.removeListedWorktree(project.cwd, worktreePath, { force });
      } catch (err) {
        app.log.warn({ hostId: project.hostId, err }, "host unreachable, worktree remove failed");
        return reply.serviceUnavailable(`Host ${project.hostId} is unreachable`);
      }
    },
  );

  // Issue #442 — GitPanel "Prune stale" button: clears administrative
  // metadata for worktrees whose directory is already gone (`git worktree
  // prune`). Never removes a worktree that still exists on disk.
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/git-worktree-prune",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
      if (!project) return reply.notFound();

      const backend = resolveBackend(app, project.hostId);
      try {
        return await backend.pruneWorktreeMetadata(project.cwd);
      } catch (err) {
        app.log.warn({ hostId: project.hostId, err }, "host unreachable, worktree prune failed");
        return reply.serviceUnavailable(`Host ${project.hostId} is unreachable`);
      }
    },
  );

  app.post<{ Body: CreateProjectBody }>(
    "/api/projects",
    { schema: createProjectSchema, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { name, cwd, createDir, gitInit } = request.body;
      const hostId = request.body.hostId ?? LOCAL_HOST_ID;
      if (hostId !== LOCAL_HOST_ID && !getHostRow(app, hostId)) {
        return reply.badRequest(`Unknown hostId ${hostId}`);
      }
      // A remote project's directory lives on the agent's own filesystem,
      // not this process's — validating/creating it here against the
      // *primary's* disk would be actively wrong. Out of scope until a
      // dedicated /internal/* agent endpoint exists.
      if (createDir && hostId !== LOCAL_HOST_ID) {
        return reply.code(400).send({
          statusCode: 400,
          error: "Bad Request",
          message: `Mullion can't create a directory on host ${hostId} — create it there and try again.`,
          code: "PROJECT_DIR_REMOTE_UNSUPPORTED",
        });
      }
      // gitInit only has an effect when createDir also creates the
      // directory (see the block below) — without this, `gitInit: true`
      // alone silently does nothing and the response omits
      // `gitInitialized` entirely, giving the caller neither an error nor
      // a result to act on.
      if (gitInit && !createDir) {
        return reply.code(400).send({
          statusCode: 400,
          error: "Bad Request",
          message: "gitInit requires createDir.",
          code: "PROJECT_GIT_INIT_WITHOUT_CREATE_DIR",
        });
      }
      // The create-project modal's own placeholder is a literal `~/...`
      // path (ported from the design) — expand it the same way
      // PROJECTS_ROOTS/CRS_CONFIG_DIR already are, so a session spawned
      // against this project's cwd doesn't fail to resolve it. Only for
      // "local": a remote project's cwd expands against the *agent's* own
      // home dir, not this process's — see host-registry.ts/issue #26's
      // landmine #3 — so it's stored/forwarded raw instead.
      const resolvedCwd = hostId === LOCAL_HOST_ID ? path.resolve(expandHome(cwd)) : cwd;

      // Validate (and, if confirmed, create) the directory BEFORE the row
      // is inserted, so a rejected/failed create never leaves an orphan
      // project row. CodeQL flags the mkdir this feeds as js/path-injection
      // since resolvedCwd derives from request.body.cwd — dismissed as a
      // false positive at this boundary, same as before: /api/projects is
      // the authenticated-primary boundary, and a caller who can reach it
      // can already spawn a session against an arbitrary cwd (full code
      // execution), which is strictly more powerful than mkdir on the same
      // path. Same trust model as internal.ts's resolveWithinRoots
      // docstring for session-spawn cwd. What's new is leaf-only creation
      // and pre-planted-symlink hardening — see project-dir.ts.
      let dirCreated = false;
      let gitInitialized = false;
      if (hostId === LOCAL_HOST_ID) {
        try {
          assertProjectDir(resolvedCwd);
        } catch (err) {
          if (!(err instanceof ProjectDirError)) throw err;
          if (err.issue !== "missing" || !createDir) {
            return reply.code(400).send(projectDirErrorBody(err));
          }
          try {
            dirCreated = createProjectDir(resolvedCwd);
          } catch (createErr) {
            if (!(createErr instanceof ProjectDirError)) throw createErr;
            return reply.code(400).send(projectDirErrorBody(createErr));
          }
          if (gitInit && dirCreated) {
            const result = await runGitInit(resolvedCwd);
            gitInitialized = result.success;
            if (!result.success) {
              app.log.warn({ cwd: resolvedCwd, err: result.error }, "git init failed");
            }
          }
        }
      }

      const [created] = app.db
        .insert(projects)
        .values({ name, cwd: resolvedCwd, hostId })
        .returning()
        .all();
      await maybeRegisterProjectWebhook(app, created);
      reply.code(201);
      return createDir ? { ...created, dirCreated, gitInitialized } : created;
    },
  );

  // Partial update — a project's own edit modal reuses CreateProjectModal
  // pre-filled, submitting whichever of name/cwd changed. Applies the same
  // expandHome() tilde-expansion POST already does, so re-pointing a
  // project at a literal `~/...` path via edit resolves the same way an
  // initial create does, rather than silently producing an unspawnable cwd.
  app.patch<{ Params: { id: string }; Body: UpdateProjectBody }>(
    "/api/projects/:id",
    { schema: updateProjectSchema, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const [existing] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
      if (!existing) return reply.notFound();

      const {
        name,
        cwd,
        devServerUrl,
        autoFetch,
        defaultAgent,
        defaultReviewAgent,
        mergeOnApprove,
        autoApprove,
        maxAutoReturnRounds,
        conventionalCommitTitles,
        createDir,
        gitInit,
      } = request.body;
      if (
        devServerUrl !== undefined &&
        devServerUrl !== null &&
        !isValidDevServerUrl(devServerUrl)
      ) {
        return reply.badRequest("devServerUrl must be a 1-65535 port or a valid http(s) URL");
      }
      // Same rationale as POST's own gitInit-requires-createDir guard.
      if (gitInit && !createDir) {
        return reply.code(400).send({
          statusCode: 400,
          error: "Bad Request",
          message: "gitInit requires createDir.",
          code: "PROJECT_GIT_INIT_WITHOUT_CREATE_DIR",
        });
      }
      if (createDir && cwd === undefined) {
        return reply.code(400).send({
          statusCode: 400,
          error: "Bad Request",
          message: "createDir requires cwd.",
          code: "PROJECT_DIR_FLAG_WITHOUT_CWD",
        });
      }
      if (createDir && existing.hostId !== LOCAL_HOST_ID) {
        return reply.code(400).send({
          statusCode: 400,
          error: "Bad Request",
          message: `Mullion can't create a directory on host ${existing.hostId} — create it there and try again.`,
          code: "PROJECT_DIR_REMOTE_UNSUPPORTED",
        });
      }
      // The schema's `minProperties: 1` only guarantees the body isn't
      // completely empty — it doesn't guarantee it contains a field that
      // actually maps to a column. The two guards above already reject a
      // *truthy* createDir/gitInit with nothing else to act on; this catches
      // what's left — `{"createDir": false}` (or `{"gitInit": false}`)
      // alone, which is falsy and so skips both — before it can fall
      // through to `.update(projects).set({})` with an empty object (every
      // spread below is conditional on an undefined field), which
      // drizzle-orm throws on ("No values to set") — a 500, not a 400.
      if (
        name === undefined &&
        cwd === undefined &&
        devServerUrl === undefined &&
        autoFetch === undefined &&
        defaultAgent === undefined &&
        defaultReviewAgent === undefined &&
        mergeOnApprove === undefined &&
        autoApprove === undefined &&
        maxAutoReturnRounds === undefined &&
        conventionalCommitTitles === undefined
      ) {
        return reply.badRequest(
          "At least one of name, cwd, devServerUrl, autoFetch, defaultAgent, defaultReviewAgent, mergeOnApprove, autoApprove, maxAutoReturnRounds, or conventionalCommitTitles must be provided.",
        );
      }

      const resolvedCwd =
        cwd !== undefined && existing.hostId === LOCAL_HOST_ID
          ? path.resolve(expandHome(cwd))
          : cwd;

      // Validate/create BEFORE the row is updated — same ordering rationale
      // as POST. Skipped entirely when the cwd isn't actually changing: the
      // Edit modal always sends `cwd`, even when only the name changed, and
      // a project whose directory was since deleted must still be
      // renamable rather than getting stuck unable to save any edit.
      let dirCreated = false;
      let gitInitialized = false;
      if (
        cwd !== undefined &&
        existing.hostId === LOCAL_HOST_ID &&
        resolvedCwd !== undefined &&
        resolvedCwd !== existing.cwd
      ) {
        try {
          assertProjectDir(resolvedCwd);
        } catch (err) {
          if (!(err instanceof ProjectDirError)) throw err;
          if (err.issue !== "missing" || !createDir) {
            return reply.code(400).send(projectDirErrorBody(err));
          }
          try {
            dirCreated = createProjectDir(resolvedCwd);
          } catch (createErr) {
            if (!(createErr instanceof ProjectDirError)) throw createErr;
            return reply.code(400).send(projectDirErrorBody(createErr));
          }
          if (gitInit && dirCreated) {
            const result = await runGitInit(resolvedCwd);
            gitInitialized = result.success;
            if (!result.success) {
              app.log.warn({ cwd: resolvedCwd, err: result.error }, "git init failed");
            }
          }
        }
      }

      const updated = app.db
        .update(projects)
        .set({
          ...(name !== undefined ? { name } : {}),
          ...(cwd !== undefined ? { cwd: resolvedCwd } : {}),
          ...(devServerUrl !== undefined ? { devServerUrl } : {}),
          ...(autoFetch !== undefined ? { autoFetch } : {}),
          ...(defaultAgent !== undefined ? { defaultAgent } : {}),
          ...(defaultReviewAgent !== undefined ? { defaultReviewAgent } : {}),
          ...(mergeOnApprove !== undefined ? { mergeOnApprove } : {}),
          ...(autoApprove !== undefined ? { autoApprove } : {}),
          ...(maxAutoReturnRounds !== undefined ? { maxAutoReturnRounds } : {}),
          ...(conventionalCommitTitles !== undefined ? { conventionalCommitTitles } : {}),
        })
        .where(eq(projects.id, projectId))
        .returning()
        .all();
      if (updated.length === 0) return reply.notFound();
      // #490b — a cwd change can point this project at a different repo
      // (or a repo for the first time), so re-run registration the same
      // way create does. `registerProjectWebhook`'s own PATCH-on-conflict
      // behavior (github-webhook.ts) means re-registering an unchanged
      // repo is a harmless no-op, not a duplicate hook.
      if (cwd !== undefined) await maybeRegisterProjectWebhook(app, updated[0]);
      return createDir ? { ...updated[0], dirCreated, gitInitialized } : updated[0];
    },
  );

  // Fully terminates every session under this project (master + program,
  // not just our tracked attach-client — see PtyManager.terminate()) before
  // the row delete, whose ON DELETE CASCADE only removes the DB rows.
  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const projectId = Number(request.params.id);
    if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

    const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
    if (!project) return reply.notFound();

    const projectSessions = app.db
      .select()
      .from(sessions)
      .where(eq(sessions.projectId, projectId))
      .all();
    const backend = resolveBackend(app, project.hostId);
    await Promise.all(
      projectSessions.map((session) =>
        backend.terminate(String(session.id)).catch((err) => {
          // Best-effort, same as hosts.ts's cascade delete: an unreachable
          // host can't be told to terminate anything, and that must not
          // block deleting the (now orphaned-on-that-host) project row.
          app.log.warn(
            { hostId: project.hostId, sessionId: session.id, err },
            "project delete: best-effort session terminate failed",
          );
        }),
      ),
    );

    // #490b — best-effort: tear down this project's own webhook before
    // the row (and its cascade-deleted webhook_registrations record) is
    // gone. Reads owner/repo from the registration row itself, not a
    // fresh resolveRepoRef(project.cwd) — the project may already be
    // mid-delete on disk, and the registered repo is the one that
    // actually has the hook regardless of what the cwd resolves to now.
    const registration = app.db
      .select()
      .from(webhookRegistrations)
      .where(eq(webhookRegistrations.projectId, projectId))
      .get();
    if (registration?.hookId) {
      const token = getToken(app);
      if (token) {
        await unregisterHook(
          token,
          registration.owner,
          registration.repo,
          buildWebhookUrl(app),
        ).catch((err) => {
          app.log.warn(
            { err, projectId, owner: registration.owner, repo: registration.repo },
            "project delete: best-effort webhook unregister failed",
          );
        });
      }
    }

    const deleted = app.db.delete(projects).where(eq(projects.id, projectId)).returning().all();
    if (deleted.length === 0) return reply.notFound();
    reply.code(204);
  });

  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/dev-server-status",
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
      if (!project) return reply.notFound("Project not found");

      if (!project.devServerUrl) {
        return { online: false };
      }

      if (project.hostId !== LOCAL_HOST_ID) {
        // Only the port (+ scheme) is resolved and forwarded — never the
        // full URL or host — so a remote-hosted project can't turn this
        // route into a TCP-connect probe of arbitrary hosts reachable from
        // the agent. Same rule preview-proxy.ts already applies to remote
        // previews (portFromUrl, imported above).
        const target = parseDevServerTarget(project.devServerUrl);
        if (!target) return { online: false };
        try {
          return await getRemoteHostClient(app, project.hostId).getDevServerStatus(
            target.port,
            target.scheme,
          );
        } catch (err) {
          // This route's whole contract is a boolean, so an unreachable
          // agent or a version-skewed one rejecting the (new) query-param
          // shape both collapse to "not online" rather than a 500 — same
          // "never propagate a proxy failure as this route's own 500"
          // posture as the currentBranch/ruleFiles remote lookups above,
          // just returning false here instead of omitting a field, since
          // there's no partial-response shape for a single boolean. Logged
          // distinctly (Hermes review, PR #533) so "agent never responded"
          // is still distinguishable from "agent responded and rejected."
          const message =
            err instanceof HostRequestError
              ? "agent rejected dev-server-status request, reporting offline"
              : "host unreachable, reporting dev-server-status offline";
          app.log.warn({ hostId: project.hostId, projectId, err }, message);
          return { online: false };
        }
      }

      // Local: a bare port means "this same machine" (isValidDevServerUrl's
      // own comment) — pingDevServer needs a real URL, so resolve it the
      // same way preview-proxy.ts's resolveUpstreamBase does for a local
      // target. A full URL is honored as-is, including its own host (this
      // process trusts itself, same admin-trust level as hosts.ts's own
      // baseUrl) — only the remote branch above restricts to a bare
      // port/scheme, never a caller-supplied host.
      const localUrl = DEV_SERVER_PORT_ONLY.test(project.devServerUrl)
        ? `http://127.0.0.1:${project.devServerUrl}`
        : project.devServerUrl;
      const online = await pingDevServer(localUrl);
      return { online };
    },
  );
}

export function pingDevServer(urlStr: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const url = new URL(urlStr);
      const port = url.port ? parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80;
      const host = url.hostname || "localhost";
      const socket = net.connect({ host, port, timeout: timeoutMs }, () => {
        // For HTTP URLs, send a HEAD request to verify the server is
        // responding to HTTP, not just accepting TCP connections.
        // For HTTPS, TLS makes an inline request unworkable without the
        // tls module, so fall back to TCP-level only.
        if (url.protocol === "https:") {
          socket.end();
          resolve(true);
          return;
        }
        socket.write(`HEAD / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      });
      let responded = false;
      socket.on("data", (chunk: Buffer) => {
        if (responded) return;
        const text = chunk.toString("utf8");
        if (text.startsWith("HTTP/")) {
          responded = true;
          socket.end();
          resolve(true);
        }
      });
      socket.on("error", () => {
        if (!responded) resolve(false);
      });
      socket.on("close", () => {
        if (!responded) resolve(false);
      });
      socket.on("timeout", () => {
        socket.destroy();
        if (!responded) resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}
