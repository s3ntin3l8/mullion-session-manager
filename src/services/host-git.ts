// #484 — host-aware counterparts of git-status.ts/git-refs.ts/git-push.ts's
// local-only shell-outs, for the handful of Task Master callers
// (task-promote.ts, task-claim.ts) that hold only a `(hostId, path)` pair
// (and, for a push, a GitHub token) rather than a session id — the shape
// SessionBackend's cwd-scoped, credential-free interface isn't built for.
// Deliberately NOT added to SessionBackend: every existing method there is
// credential-free, and threading a GitHub token through it would be the
// wrong shape for the one caller (pushHostBranch) that needs one.
//
// Modeled on resolveRepoRef (github-webhook.ts) — same
// `(app, {cwd, hostId})`-shaped local/remote dispatch, same reason it lives
// here rather than in git-status.ts/git-refs.ts/git-push.ts themselves:
// those modules deliberately have no FastifyInstance import.
import type { FastifyInstance } from "fastify";
import { getGitStatus, isGitRepo, type GitStatus } from "./git-status.js";
import { resolveDefaultBaseRef, resolveCommitSha } from "./git-refs.js";
import { pushBranch, type PushResult } from "./git-push.js";
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
 * three exported functions below shares this exact dispatch. */
async function viaRemote<T>(
  app: FastifyInstance,
  hostId: string,
  fn: (client: ReturnType<typeof getRemoteHostClient>) => Promise<T>,
): Promise<HostGitResult<T>> {
  try {
    const value = await fn(getRemoteHostClient(app, hostId));
    return { ok: true, value };
  } catch (err) {
    if (err instanceof HostRequestError) return { ok: false, reason: "unsupported" };
    if (err instanceof HostUnreachableError) {
      return { ok: false, reason: "unreachable", detail: err.message };
    }
    throw err;
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
