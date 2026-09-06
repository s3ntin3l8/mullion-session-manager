// #484 — host-aware counterparts of git-status.ts/git-refs.ts/git-push.ts's
// local-only shell-outs, for the handful of Task Master callers
// (task-promote.ts, task-claim.ts) that hold only a `(hostId, path)` pair
// (and, for a push, a GitHub token) rather than a session id — the shape
// SessionBackend's cwd-scoped, credential-free interface isn't built for.
// Deliberately NOT added to SessionBackend: every existing method there is
// credential-free, and threading a GitHub token through it would be the
// wrong shape for the one caller (pushHostBranch) that needs one.
//
// Modeled on resolveRepoRef (originally github-webhook.ts, moved into this
// module below as part of routes/projects.ts's GitHub-route dedup) — same
// `(app, {cwd, hostId})`-shaped local/remote dispatch, same reason it lives
// here rather than in git-status.ts/git-refs.ts/git-push.ts themselves:
// those modules deliberately have no FastifyInstance import.
import type { FastifyInstance } from "fastify";
import { getGitStatus, isGitRepo, type GitStatus } from "./git-status.js";
import { resolveDefaultBaseRef, resolveCommitSha } from "./git-refs.js";
import { pushBranch, type PushResult } from "./git-push.js";
import { parseGitRemote, type GitHubRepoRef } from "./git-remote.js";
import { getFileDiff } from "./git-diff.js";
import { commitWipChanges, type CommitWipChangesResult } from "./git-worktree.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import {
  getRemoteHostClient,
  HostRequestError,
  HostUnreachableError,
} from "./remote-host-client.js";

export type HostGitResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      /** The agent responded but doesn't recognize this route yet (an old
       * agent build predating #484's proxy routes) — a version-skew gap,
       * not a connectivity problem. */
      reason: "unsupported";
    }
  | {
      ok: false;
      /** The host couldn't be reached at all (network failure, timeout, SSRF
       * guard). */
      reason: "unreachable";
      detail: string;
    };

/** Runs `fn` against the remote client for `hostId`, mapping its two error
 * types onto HostGitResult's discriminated failure shape — every one of the
 * three exported functions below shares this exact dispatch.
 *
 * Independent review, PR #590 — `HostRequestError` is raised for ANY 4xx
 * `request()` gets back (a genuine `resolveWithinRoots` 400, a schema
 * validation 400, a 401 surviving the one credential-refresh retry — not
 * just a 404 from a route an old agent build doesn't have), so only a
 * `statusCode === 404` is actually the "this host's agent build predates
 * #484's proxy routes" version-skew signal `"unsupported"` claims to be.
 * Any other 4xx is a real request-level failure this host CAN service in
 * principle, so it's treated the same as `"unreachable"` — not the durable-
 * sounding "unsupported, update your agent build" a caller like
 * task-promote.ts would otherwise surface for what might be a `cwd`
 * misconfiguration, and not silently conflated with a genuine transport
 * failure either (the original `err.message` carries the real reason).
 *
 * `getRemoteHostClient(app, hostId)` itself (called inside the try, not
 * before it) can throw a plain `Error` synchronously — a project row
 * pointing at a `hostId` with no matching `hosts` row, or one with a null
 * `baseUrl` (defense in depth: `DELETE /api/hosts/:id` without `cascade`
 * 409s on a referencing project, so this shouldn't occur via normal use,
 * but nothing enforces it at the DB layer). Independent review, PR #590 —
 * this module's every caller (task-promote.ts's preparePromotion/
 * resolveBaseBranch/pushForPromotion) has no try/catch of its own around
 * these calls, unlike task-claim.ts's dispatchClaimedTask/retryTask, which each wrap
 * an equivalent `resolveBackend`-can-throw-synchronously risk in their own
 * outer try/catch specifically for this. Rather than require every current
 * and future caller of this module to duplicate that defense, any
 * non-Host*Error thrown here is treated the same as a genuine
 * `HostUnreachableError` — this host cannot be reached in any sense that
 * matters to the caller — instead of propagating as an uncaught throw that
 * would otherwise surface as a raw 500, contradicting this module's own
 * "never a 500" contract. */
// Exported (unlike the rest of this module's internals) so host-files.ts's
// readHostFiles/writeHostFiles — a sibling dispatcher for a distinct concern
// (arbitrary file content, not git plumbing) that still needs the exact
// same HostGitResult error-mapping — can reuse it rather than duplicating
// it. See host-files.ts's own header comment for why that primitive lives
// in its own file instead of being added directly below.
export async function viaRemote<T>(
  app: FastifyInstance,
  hostId: string,
  fn: (client: ReturnType<typeof getRemoteHostClient>) => Promise<T>,
): Promise<HostGitResult<T>> {
  try {
    const value = await fn(getRemoteHostClient(app, hostId));
    return { ok: true, value };
  } catch (err) {
    if (err instanceof HostRequestError) {
      if (err.statusCode === 404) return { ok: false, reason: "unsupported" };
      return { ok: false, reason: "unreachable", detail: err.message };
    }
    const detail =
      err instanceof HostUnreachableError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, reason: "unreachable", detail };
  }
}

/**
 * `{ isRepo, status }` for `cwd` on whichever host owns it — always a
 * `forceFresh` read (never the cached one), since every current caller
 * (task-promote.ts's dirty-tree gate) needs the same "don't serve a stale
 * clean" guarantee `getGitStatus`'s own `forceFresh` doc comment describes.
 * Local calls never fail (`getGitStatus` never throws), so this only ever
 * returns `ok: false` for a remote host.
 */
export async function resolveHostGitStatus(
  app: FastifyInstance,
  hostId: string,
  cwd: string,
): Promise<HostGitResult<{ isRepo: boolean; status: GitStatus | null }>> {
  if (hostId === LOCAL_HOST_ID) {
    if (!isGitRepo(cwd)) return { ok: true, value: { isRepo: false, status: null } };
    const status = await getGitStatus(cwd, { forceFresh: true });
    return { ok: true, value: { isRepo: true, status } };
  }
  return viaRemote(app, hostId, (client) => client.resolveGitStatus(cwd, { fresh: true }));
}

/**
 * `{ baseRef, sha }` for `cwd` on whichever host owns it — wraps
 * `resolveDefaultBaseRef` + `resolveCommitSha` locally, `/internal/git-base-ref`
 * remotely. Never fails locally (both wrapped functions have their own
 * never-throws, worst-case-"HEAD"/null contract); only ever returns
 * `ok: false` for a remote host.
 */
export async function resolveHostBaseRef(
  app: FastifyInstance,
  hostId: string,
  cwd: string,
): Promise<HostGitResult<{ baseRef: string; sha: string | null }>> {
  if (hostId === LOCAL_HOST_ID) {
    const baseRef = await resolveDefaultBaseRef(cwd);
    const sha = await resolveCommitSha(cwd, baseRef);
    return { ok: true, value: { baseRef, sha } };
  }
  return viaRemote(app, hostId, (client) => client.resolveHostBaseRef(cwd));
}

/**
 * Pushes `branch` from `cwd` to `origin`, on whichever host owns `cwd` —
 * `pushBranch` locally, `/internal/git-push` remotely. `cwd` must be the
 * task's worktree path (task-promote.ts's only caller already passes
 * `task.worktreePath`), never the bare project root. The token crosses the
 * wire exactly once for a remote host, over the same signed, IP-pinned
 * channel every other internal proxy call already uses — see
 * RemoteHostClient.resolvePushBranch's own comment on why it's never logged.
 */
export async function pushHostBranch(
  app: FastifyInstance,
  hostId: string,
  cwd: string,
  branch: string,
  token: string,
): Promise<HostGitResult<PushResult>> {
  if (hostId === LOCAL_HOST_ID) {
    const value = await pushBranch(cwd, branch, token);
    return { ok: true, value };
  }
  return viaRemote(app, hostId, (client) => client.resolvePushBranch(cwd, branch, token));
}

/**
 * Best-effort unified diff for a single file against HEAD, on whichever
 * host owns `cwd` — `getFileDiff` locally, the ALREADY-EXISTING
 * `/internal/git-file-diff` route (issue #262, via
 * `client.resolveGitFileDiff`) remotely. Unlike this module's other
 * dispatchers, the remote route/client pair here predates issue #895 — this
 * just adds the missing `host-git.ts`-shaped wrapper so
 * routes/project-setup.ts's scaffold preview can get a per-file diff
 * without reaching into `RemoteHostClient` directly, the same as every
 * other caller in this file. `value: null` means "no diff" (matches HEAD,
 * not a repo, or the git call failed) — never itself a `HostGitResult`
 * failure; `ok: false` is reserved for "couldn't ask this host at all".
 */
export async function resolveHostFileDiff(
  app: FastifyInstance,
  hostId: string,
  cwd: string,
  filePath: string,
): Promise<HostGitResult<string | null>> {
  if (hostId === LOCAL_HOST_ID) {
    return { ok: true, value: await getFileDiff(cwd, filePath) };
  }
  return viaRemote(app, hostId, async (client) => {
    const { patch } = await client.resolveGitFileDiff(cwd, filePath);
    return patch;
  });
}

/**
 * Salvages uncommitted work in `cwd` into a single commit, on whichever
 * host owns it — `commitWipChanges` locally, a new `/internal/git-commit-wip`
 * route remotely (issue #895: routes/project-setup.ts's `/setup/apply` is
 * the first caller that needs this off the local filesystem — see that
 * route's own comment on why `commitWipChanges` alone was silently wrong
 * for a remote-hosted project's scaffold branch before this existed).
 *
 * Also the WIP-salvage entry point for task-reconciler.ts's
 * `failReviewingGate` (issue #1100) — that caller runs this FIRST, before
 * its own status CAS, and treats it as the capability probe too: `ok: true`
 * (whether or not anything was actually dirty — a clean tree just returns
 * `{ committed: false }`) means the host can service the salvage, so the
 * caller proceeds with failing the task; `ok: false` (`"unsupported"` — an
 * agent build predating this route — or `"unreachable"`) means it can't
 * find out either way, so it fails open instead of stranding the task with
 * a dirty worktree and no salvage commit.
 */
export async function commitHostWipChanges(
  app: FastifyInstance,
  hostId: string,
  cwd: string,
  message?: string,
): Promise<HostGitResult<CommitWipChangesResult>> {
  if (hostId === LOCAL_HOST_ID) {
    return { ok: true, value: await commitWipChanges(cwd, message) };
  }
  return viaRemote(app, hostId, (client) => client.resolveCommitWipChanges(cwd, message));
}

/**
 * The GitHub `owner/repo` a project's `cwd` resolves to, on whichever host
 * owns it — `parseGitRemote(cwd)` locally (uncaught: a throwing
 * `parseGitRemote` is a real bug, not a "host unreachable" condition, so it
 * propagates same as every other local branch in this module), the agent's
 * `resolveGitHubRepo(cwd)` remotely via the shared `viaRemote` dispatch.
 * `value: null` means "no github.com remote configured", not an error —
 * `ok: false` is reserved for "couldn't determine this at all" (host
 * unreachable / doesn't support the route yet).
 *
 * Moved here from github-webhook.ts (originally #484, relocated as part of
 * routes/projects.ts's GitHub-route dedup) — most of its callers
 * (task-promote.ts, task-github-sync.ts, task-watcher.ts,
 * webhook-reconciler.ts via registerProjectWebhook, routes/webhooks.ts)
 * aren't webhook-specific; this module is where the rest of the
 * host-aware git dispatch already lives.
 */
export async function resolveRepoRefResult(
  app: FastifyInstance,
  project: { cwd: string; hostId: string },
): Promise<HostGitResult<GitHubRepoRef | null>> {
  if (project.hostId === LOCAL_HOST_ID) {
    return { ok: true, value: parseGitRemote(project.cwd) };
  }
  return viaRemote(app, project.hostId, (client) => client.resolveGitHubRepo(project.cwd));
}

/**
 * `resolveRepoRefResult`, collapsed to `GitHubRepoRef | null` — the shape
 * every existing caller (webhook registration/sync, Task Master's
 * promote/sync/watcher paths) wants: none of them need to distinguish
 * "host unreachable" from "no GitHub remote configured", they just want to
 * skip/no-op either way. Only routes/projects.ts's GitHub routes need that
 * distinction (503 vs. 204) — they call `resolveRepoRefResult` directly.
 */
export async function resolveRepoRef(
  app: FastifyInstance,
  project: { cwd: string; hostId: string },
): Promise<GitHubRepoRef | null> {
  const result = await resolveRepoRefResult(app, project);
  return result.ok ? result.value : null;
}
