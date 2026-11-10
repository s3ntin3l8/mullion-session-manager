import type { FastifyInstance } from "fastify";
import path from "node:path";
import { parseGitRemote } from "../services/git-remote.js";
import { readGitBranch } from "../services/git-branch.js";
import { getGitStatus, getGitStatusFailure, isGitRepo } from "../services/git-status.js";
import { getDiffStats, getDefaultBaseRef, getFileDiff } from "../services/git-diff.js";
import {
  getCommitDetail,
  getCommitFileDiff,
  getCommitLog,
  isSafeRepoPath,
  isValidSha,
} from "../services/git-log.js";
import {
  listBranches,
  listRemoteBranches,
  listWorktrees,
  resolveDefaultBaseRef,
  resolveDefaultBaseRefForPicker,
  resolveCommitSha,
} from "../services/git-refs.js";
import { runGitFetch } from "../services/git-fetch.js";
import { inspectGitClone, planRepair, repairGitClone } from "../services/git-doctor.js";
import { isCloneBusy, markCloneBusy, releaseClone } from "../services/git-clone-busy.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import { runGitPull } from "../services/git-pull.js";
import { checkoutBranch, createBranch, rebaseBranch } from "../services/git-branch-ops.js";
import type { GitBranchOpResult } from "../services/git-branch-ops.js";
import { pushBranch } from "../services/git-push.js";
import { cloneCheckout } from "../services/git-clone.js";
import {
  gitPullSchema,
  gitCheckoutSchema,
  gitBranchCreateSchema,
  gitRebaseSchema,
  gitPushSchema,
  gitCloneSchema,
  gitRepairSchema,
} from "./internal-schemas.js";
import type {
  GitPullBody,
  GitCheckoutBody,
  GitBranchCreateBody,
  GitRebaseBody,
  GitPushBody,
  GitCloneBody,
  GitRepairBody,
} from "./internal-schemas.js";
import { INTERNAL_RATE_LIMIT, GIT_CLONE_RATE_LIMIT } from "./internal-rate-limits.js";
import { requireWithinRoots } from "./internal-roots.js";

/**
 * The agent's the git routes (github-repo through git-clone) routes. Registered from `internalRoutes` so they sit
 * behind its auth hook and share its rate limits.
 */
export function registerGitRoutes(app: FastifyInstance): void {
  // Owner/repo derivation for a remote-host project's GitHub widget (issue
  // #27) — a remote project's cwd is a path on *this* agent's filesystem,
  // so reading its .git/config has to happen here, not on the primary (same
  // reasoning as /internal/actions and /internal/dock above). The actual
  // GitHub API calls still happen on the primary, which is the only side
  // holding the credential (routes/projects.ts).
  app.get<{ Querystring: { cwd?: string } }>(
    "/internal/github-repo",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      return parseGitRemote(resolvedCwd);
    },
  );

  // Always-on branch label (issue #96) for a remote-hosted project — same
  // "this reads *this* agent's own filesystem" reasoning as /internal/
  // github-repo above, just backed by git-branch.ts's pure HEAD read instead
  // of git-remote.ts's config parse. Unlike every other route in this file,
  // the payload is a bare string (or null), not an object/array — Fastify
  // only auto-JSON-encodes those; a returned string is sent as raw
  // text/plain by default. Explicit content-type + JSON.stringify keeps this
  // a well-formed `RemoteHostClient.request<T>()` response like every other
  // /internal/* route (see remote-host-client.ts's resolveGitBranch, which
  // expects to `res.json()` it straight into a `string | null`).
  app.get<{ Querystring: { cwd?: string } }>(
    "/internal/git-branch",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      reply.type("application/json");
      return JSON.stringify(readGitBranch(resolvedCwd));
    },
  );

  // Fuller git status (issue #76) — branch/hash/ahead-behind/file-list — for
  // a remote-hosted project's Source Control and sidebar badge. Backed by
  // git-status.ts's `git status --porcelain=v2 --branch` shell-out, which
  // has to run on *this* agent's own filesystem for the same reason
  // /internal/github-repo and /internal/git-branch do.
  //
  // Returns `{ isRepo, status }` rather than bare `GitStatus | null` (as this
  // used to) so the primary's /api/projects/:id/git-status route can tell
  // "not a repo" (durable — `isRepo: false`) apart from "repo exists but git
  // status failed transiently" (`isRepo: true, status: null`) for a remote
  // host exactly the same way it already can for a local one via
  // `isGitRepo`/`getGitStatus`. Always 200 with a JSON body — this endpoint's
  // own transient git failures aren't the primary's "host unreachable" 5xx,
  // they're carried in the body instead, so RemoteHostClient's generic 5xx ->
  // HostUnreachableError handling doesn't swallow the distinction.
  // `?fresh=1` (#484) bypasses getGitStatus's own cache — task-promote.ts's
  // dirty-tree gate needs this the same way it already does for a local
  // promotion (see getGitStatus's own `forceFresh` doc comment): a stale
  // "clean" read served from up to CACHE_TTL_MS ago could let a push
  // silently exclude work an agent committed moments before approve ran.
  // Every other caller (the sidebar polls) omits it and keeps the
  // cached read.
  app.get<{ Querystring: { cwd?: string; fresh?: string } }>(
    "/internal/git-status",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd, fresh } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      if (!isGitRepo(resolvedCwd)) {
        return { isRepo: false, status: null };
      }
      const status = await getGitStatus(resolvedCwd, { forceFresh: fresh === "1" });
      if (status) return { isRepo: true, status };
      // Issue #1612: say *why* git status failed so the primary can show more
      // than "not a repo or host unreachable". Additive — an old primary
      // ignores the extra key; an old agent simply omits it.
      const problem = getGitStatusFailure(resolvedCwd);
      return problem ? { isRepo: true, status, problem } : { isRepo: true, status };
    },
  );

  // Diff stats (issue #202) for a remote-hosted session's effective cwd —
  // same reasoning and `{ isRepo, stats }` shape as /internal/git-status
  // just above (git-diff.ts's `git diff [base]...HEAD --numstat` shell-out
  // has to run on *this* agent's own filesystem, and this route's own
  // transient git failures need to stay distinguishable from "host
  // unreachable" the same way).
  app.get<{ Querystring: { cwd?: string; base?: string; fresh?: string } }>(
    "/internal/git-diff",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd, base, fresh } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      if (!isGitRepo(resolvedCwd)) {
        return { isRepo: false, stats: null };
      }
      const autoBase = base === "AUTO" ? getDefaultBaseRef(resolvedCwd) : null;
      const effectiveBase = base === "AUTO" ? (autoBase ?? undefined) : base;
      const stats = await getDiffStats(resolvedCwd, effectiveBase, { fresh: fresh === "1" });
      // `AUTO` that resolves to nothing falls back to `git diff HEAD`, which is
      // empty on a clean tree whatever the branch holds. `baseResolved` lets a
      // caller (the workflow gate) tell that apart from a verified-empty diff.
      return base === "AUTO"
        ? { isRepo: true, stats, baseResolved: autoBase !== null }
        : { isRepo: true, stats };
    },
  );

  // Per-file unified diff (issue #262) for a remote-hosted session — runs
  // `git diff [base]...HEAD -- <path>` on this agent's own filesystem,
  // returning the raw unified diff text or null.
  app.get<{ Querystring: { cwd?: string; path?: string; base?: string } }>(
    "/internal/git-file-diff",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd, path: filePath, base } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      if (!filePath) return reply.badRequest("path query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      if (!isGitRepo(resolvedCwd)) return { patch: null };

      const resolvedPath = path.isAbsolute(filePath)
        ? path.relative(resolvedCwd, filePath)
        : filePath;
      if (resolvedPath.startsWith("..")) return { patch: null };

      const effectiveBase = base === "AUTO" ? (getDefaultBaseRef(resolvedCwd) ?? undefined) : base;
      const patch = await getFileDiff(resolvedCwd, resolvedPath, effectiveBase);
      return { patch };
    },
  );

  // History for the right sidebar's Git view on a remote-hosted project
  // (issue #1969) — git-log.ts's `git log`/`git show` shell-outs have to run
  // on *this* agent's own filesystem. `cwd` is the project root; the optional
  // `worktree` scopes the query to one of its worktrees and is accepted only
  // if `git worktree list` reports it, so it can never point git at an
  // arbitrary directory. A rejected worktree answers `{ forbidden: true }`
  // (200) so the caller can tell it from "host unreachable".
  async function resolveHistoryCwd(
    root: string,
    worktree: string | undefined,
  ): Promise<string | null> {
    if (worktree === undefined || worktree === root) return root;
    const worktrees = await listWorktrees(root);
    return worktrees?.find((w) => w.path === worktree)?.path ?? null;
  }

  app.get<{
    Querystring: { cwd?: string; worktree?: string; skip?: string; limit?: string; scope?: string };
  }>("/internal/git-log", INTERNAL_RATE_LIMIT, async (request, reply) => {
    const { cwd, worktree, scope } = request.query;
    if (!cwd) return reply.badRequest("cwd query param is required");
    const root = requireWithinRoots(app, reply, cwd, "cwd");
    if (root === null) return;
    const skip = request.query.skip === undefined ? 0 : Number(request.query.skip);
    const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
    if (!Number.isInteger(skip) || skip < 0 || !Number.isInteger(limit) || limit < 1) {
      return reply.badRequest("skip and limit must be non-negative integers");
    }
    if (scope !== undefined && scope !== "all" && scope !== "head") {
      return reply.badRequest("scope must be all or head");
    }
    const target = await resolveHistoryCwd(root, worktree);
    if (target === null) return { commits: null, forbidden: true };
    return { commits: await getCommitLog(target, { skip, limit, all: scope !== "head" }) };
  });

  app.get<{ Querystring: { cwd?: string; worktree?: string; sha?: string } }>(
    "/internal/git-commit",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd, worktree, sha } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      if (!sha || !isValidSha(sha)) return reply.badRequest("Invalid commit id");
      const root = requireWithinRoots(app, reply, cwd, "cwd");
      if (root === null) return;
      const target = await resolveHistoryCwd(root, worktree);
      if (target === null) return { detail: null, forbidden: true };
      return { detail: await getCommitDetail(target, sha) };
    },
  );

  app.get<{ Querystring: { cwd?: string; worktree?: string; sha?: string; path?: string } }>(
    "/internal/git-commit-file",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd, worktree, sha, path: file } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      if (!sha || !isValidSha(sha) || !file || !isSafeRepoPath(file)) {
        return reply.badRequest("Invalid commit id or path");
      }
      const root = requireWithinRoots(app, reply, cwd, "cwd");
      if (root === null) return;
      const target = await resolveHistoryCwd(root, worktree);
      if (target === null) return { patch: null, forbidden: true };
      return { patch: await getCommitFileDiff(target, sha, file) };
    },
  );

  // Local branches + worktrees (issue #162) for a remote-hosted project's
  // Source Control — same reasoning as /internal/git-status: git-refs.ts's
  // `for-each-ref`/`worktree list` shell-outs have to run on *this* agent's
  // own filesystem.
  app.get<{ Querystring: { cwd?: string; detail?: string } }>(
    "/internal/git-branches",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd, detail } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      const [branches, worktrees, remoteBranches, defaultBranch] = await Promise.all([
        listBranches(resolvedCwd, { detail: detail === "1" }),
        listWorktrees(resolvedCwd),
        listRemoteBranches(resolvedCwd),
        resolveDefaultBaseRefForPicker(resolvedCwd),
      ]);
      if (!branches || !worktrees || !remoteBranches) return null;
      return { branches, worktrees, remoteBranches, defaultBranch };
    },
  );

  // Issue #1851 — the READ-ONLY clone health check, for a remote-hosted
  // project's clone. Like every other filesystem-touching route in this file,
  // it goes through resolveWithinRoots. It never mutates anything.
  app.get<{ Querystring: { cwd?: string } }>(
    "/internal/git-health",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      return await inspectGitClone(resolvedCwd);
    },
  );

  // Issue #1896 — the clone REPAIR on this agent's own filesystem, and the
  // read-only PLAN of what it would do.
  //
  // Without `confirm` this returns the plan, computed from reads only —
  // nothing is touched. With `confirm: true` the repair runs: it moves the
  // damaged objects into a quarantine directory inside the git dir (nothing
  // is ever deleted), fetches from origin and rebuilds the worktree
  // indexes. The primary asks for that only after the user confirmed it.
  //
  // Like every other filesystem-touching route in this file, it goes through
  // requireWithinRoots — the repair's cwd must be inside this agent's
  // PROJECTS_ROOTS, exactly like the check's.
  //
  // The request body is NOT logged: it names a path, and this file's other
  // routes keep their bodies out of the log for the same reason.
  app.post<{ Body: GitRepairBody }>(
    "/internal/git-repair",
    { ...INTERNAL_RATE_LIMIT, schema: gitRepairSchema },
    async (request, reply) => {
      const { cwd, confirm } = request.body;
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      if (confirm !== true) {
        return await planRepair(resolvedCwd);
      }
      // The clone is the resource: a fetch in flight on it (the primary's
      // auto-fetch sweep, say) would fail this repair's ref update.
      if (isCloneBusy(LOCAL_HOST_ID, resolvedCwd)) {
        return reply.conflict("A git operation is already running for this repository.");
      }
      markCloneBusy(LOCAL_HOST_ID, resolvedCwd);
      try {
        const lines: string[] = [];
        const outcome = await repairGitClone(resolvedCwd, { log: (line) => lines.push(line) });
        app.log.info({ lines }, "git repair finished");
        return outcome;
      } finally {
        releaseClone(LOCAL_HOST_ID, resolvedCwd);
      }
    },
  );

  // Runs `git fetch origin` on the given cwd — for a remote-hosted project's
  // background auto-fetch (src/plugins/git-fetcher.ts) and manual Fetch
  // button (POST /api/projects/:id/git-fetch). Like every other filesystem-
  // touching route in this file, it goes through resolveWithinRoots. Returns
  // { success, error? } rather than throwing on git-level failures, so the
  // primary can distinguish "fetch ran and succeeded" from "fetch ran but
  // the remote was unreachable" from "host unreachable" (a 5xx from request()).
  app.get<{ Querystring: { cwd?: string } }>(
    "/internal/git-fetch",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      // Optional read token for a private repo: a header on the signed
      // channel, never the query string (which lands in access logs).
      const rawToken = request.headers["x-mullion-git-token"];
      const token = typeof rawToken === "string" && rawToken !== "" ? rawToken : undefined;
      // A repair is running on this clone (issue #1896): it fetches and
      // rewrites the indexes itself, and a second fetch in that window would
      // fail its ref update and make a healthy clone look broken. Skip it —
      // the next tick will fetch.
      if (isCloneBusy(LOCAL_HOST_ID, resolvedCwd)) {
        // `skipped`, not `success: false`: the clone was busy, which is not a
        // failure — the next tick will fetch. The primary must not log this
        // as "git fetch failed" or surface it as an error on the Fetch button.
        return {
          success: false,
          skipped: true,
          error: "a git operation is already running for this clone",
        };
      }
      markCloneBusy(LOCAL_HOST_ID, resolvedCwd);
      try {
        return await runGitFetch(resolvedCwd, token);
      } finally {
        releaseClone(LOCAL_HOST_ID, resolvedCwd);
      }
    },
  );

  // Issue #745 — runs a fast-forward `git pull` on the given cwd for a
  // remote-hosted project's Pull button (POST /api/projects/:id/git-pull).
  // Goes through resolveWithinRoots. Returns GitPullResult ({ pulled, reason?, detail? })
  // matching runGitPull's shape.
  app.post<{ Body: GitPullBody }>(
    "/internal/git-pull",
    { ...INTERNAL_RATE_LIMIT, schema: gitPullSchema },
    async (request, reply) => {
      const { cwd } = request.body;
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      // A pull fetches AND merges, and the merge writes the index a repair
      // rewrites — so it claims the clone, and skips it when a git operation
      // is already working on it (issue #1896).
      if (isCloneBusy(LOCAL_HOST_ID, resolvedCwd)) {
        return { pulled: false, reason: "busy", detail: "a git operation is already running" };
      }
      markCloneBusy(LOCAL_HOST_ID, resolvedCwd);
      try {
        return await runGitPull(resolvedCwd);
      } finally {
        releaseClone(LOCAL_HOST_ID, resolvedCwd);
      }
    },
  );

  // Issue #1672 — the guarded checkout / create / rebase of a remote-hosted
  // project's checkout, on THIS agent's filesystem. Each claims the clone
  // like /internal/git-pull above: all three rewrite the index a repair
  // rewrites. Always 200 with a reason envelope for a git-level refusal.
  // The "an active session works here" guard ran on the primary already —
  // it needs the sessions table, which the agent's own copy does not hold.
  const withClaimedClone = async (
    cwd: string,
    op: () => Promise<GitBranchOpResult>,
  ): Promise<GitBranchOpResult> => {
    if (isCloneBusy(LOCAL_HOST_ID, cwd)) {
      return { ok: false, reason: "busy", detail: "a git operation is already running" };
    }
    markCloneBusy(LOCAL_HOST_ID, cwd);
    try {
      return await op();
    } finally {
      releaseClone(LOCAL_HOST_ID, cwd);
    }
  };

  app.post<{ Body: GitCheckoutBody }>(
    "/internal/git-checkout",
    { ...INTERNAL_RATE_LIMIT, schema: gitCheckoutSchema },
    async (request, reply) => {
      const { cwd, branch } = request.body;
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      return await withClaimedClone(resolvedCwd, () => checkoutBranch(resolvedCwd, branch));
    },
  );

  app.post<{ Body: GitBranchCreateBody }>(
    "/internal/git-branch-create",
    { ...INTERNAL_RATE_LIMIT, schema: gitBranchCreateSchema },
    async (request, reply) => {
      const { cwd, name, startPoint, checkout } = request.body;
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      return await withClaimedClone(resolvedCwd, () =>
        createBranch(resolvedCwd, name, startPoint, { checkout }),
      );
    },
  );

  app.post<{ Body: GitRebaseBody }>(
    "/internal/git-rebase",
    { ...INTERNAL_RATE_LIMIT, schema: gitRebaseSchema },
    async (request, reply) => {
      const { cwd, onto } = request.body;
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      return await withClaimedClone(resolvedCwd, () => rebaseBranch(resolvedCwd, onto));
    },
  );

  // #484 — resolves the repository's default base ref (and pins it to a
  // commit SHA) on THIS agent's own filesystem, for a remote-hosted task
  // claim/promotion. Wraps resolveDefaultBaseRef + resolveCommitSha
  // (git-refs.ts) — note resolveDefaultBaseRef runs `git fetch origin`
  // first, so this is not a free call. Mirrors that function's own
  // never-throws contract: a non-repo cwd resolves `{ baseRef: "HEAD", sha:
  // null }`, exactly the local last-resort fallback, not an error.
  app.get<{ Querystring: { cwd?: string } }>(
    "/internal/git-base-ref",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      const baseRef = await resolveDefaultBaseRef(resolvedCwd);
      const sha = await resolveCommitSha(resolvedCwd, baseRef);
      return { baseRef, sha };
    },
  );

  // #484 — pushes a task's branch to `origin` on THIS agent's own
  // filesystem, for a remote-hosted task's promotion. `cwd` is always the
  // task's worktree path (under `<project.cwd>/.mullion-worktrees/`, so
  // within PROJECTS_ROOTS the same way /internal/git-worktree/remove's
  // worktreePath already is), never the bare project root. The token
  // travels once, over this already-signed, IP-pinned internal channel —
  // never logged: git-push.ts's own redact() strips it from every returned
  // `detail` before this responds, and this route does not log its request
  // body. See git-push.ts's own header comment for the https-only
  // http.extraHeader caveat this doesn't change.
  app.post<{ Body: GitPushBody }>(
    "/internal/git-push",
    { ...INTERNAL_RATE_LIMIT, schema: gitPushSchema },
    async (request, reply) => {
      const { cwd, branch, token } = request.body;
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      return await pushBranch(resolvedCwd, branch, token);
    },
  );

  // Mullion-owned checkout: clones into this agent's first PROJECTS_ROOTS
  // entry (git-clone.ts). The target is derived from the validated `name`
  // and checked against the roots there, so no `cwd` crosses the wire. The
  // token is never logged and git-run.ts's redact() strips it from `detail`.
  app.post<{ Body: GitCloneBody }>(
    "/internal/git-clone",
    { ...GIT_CLONE_RATE_LIMIT, schema: gitCloneSchema },
    async (request) => cloneCheckout(app, request.body),
  );
}
