import type { CloneResult } from "./git-clone.js";
import type { GitBranchOpResult } from "./git-branch-ops.js";
import type { CommitDetail, CommitLogEntry } from "./git-log.js";
import type { CloneHealth, RepairOutcome, RepairPlan } from "./git-doctor.js";
import type { GitDiffStats } from "./git-diff.js";
import type { GitBranchInfo, GitWorktreeInfo } from "./git-refs.js";
import type { GitHubRepoRef } from "./git-remote.js";
import type { GitPullResult } from "./git-pull.js";
import { toGitStatusFailure, type GitStatusResult } from "./git-status.js";
import { GIT_CLONE_TIMEOUT_MS } from "./git-run.js";

// The `/internal/git-*` request builders of RemoteHostClient (issue #2404).
// Each takes the client's own `request` (bound), so every call still goes
// through RemoteHostTransport — signing, assertAllowedUrl and
// redirect:"manual" live there and nowhere in this file. Imports only
// type/leaf modules, never the remote-host-client façade.
//
// The client's own `resolveGit*` methods stay as one-line delegators, so no
// caller changes; their doc comments describe the contract.

/** The client's `request`, bound. An omitted timeout means the client default. */
export type GitRequest = <T>(path: string, init?: RequestInit, timeoutMs?: number) => Promise<T>;

/** git-clone.ts's GIT_CLONE_TIMEOUT_MS is 10 min (one `git clone`), plus the
 * round-trip and the post-clone branch lookup. */
const GIT_CLONE_REQUEST_TIMEOUT_MS = GIT_CLONE_TIMEOUT_MS + 60_000;
/** git-status.ts's GIT_TIMEOUT_MS is 5s (one `git status`). */
const GIT_STATUS_FRESH_REQUEST_TIMEOUT_MS = 10_000;
// Issue #1851 — the health check runs `git fsck --connectivity-only`; the
// doctor's per-call budget is 30s, so 2x plus round-trip headroom.
const GIT_HEALTH_REQUEST_TIMEOUT_MS = 75_000;
// Issue #1896 — the repair does quarantine, fetch --prune, index rebuild and
// a second fsck; several 30s calls' worth.
const GIT_REPAIR_REQUEST_TIMEOUT_MS = 180_000;
// Issue #1672 — guarded checkout/create/rebase sit above the agent's worst case
// so a proxy timeout never reports a healthy host as unreachable.
const GIT_BRANCH_OP_REQUEST_TIMEOUT_MS = 60_000;
const GIT_REBASE_REQUEST_TIMEOUT_MS = 150_000;

export function resolveGitHubRepo(request: GitRequest, cwd: string): Promise<GitHubRepoRef | null> {
  return request(`/internal/github-repo?cwd=${encodeURIComponent(cwd)}`);
}

export function resolveGitBranch(request: GitRequest, cwd: string): Promise<string | null> {
  return request(`/internal/git-branch?cwd=${encodeURIComponent(cwd)}`);
}

export function resolveGitStatus(
  request: GitRequest,
  cwd: string,
  opts?: { fresh?: boolean },
): Promise<GitStatusResult> {
  const url = `/internal/git-status?cwd=${encodeURIComponent(cwd)}${opts?.fresh ? "&fresh=1" : ""}`;
  return request<Omit<GitStatusResult, "problem"> & { problem?: unknown }>(
    url,
    undefined,
    opts?.fresh ? GIT_STATUS_FRESH_REQUEST_TIMEOUT_MS : undefined,
  ).then(({ problem, ...rest }) => {
    // Issue #1612: `problem` is optional (old agents omit it) and validated
    // here so nothing downstream trusts the agent's raw payload.
    const validated = toGitStatusFailure(problem);
    return validated ? { ...rest, problem: validated } : rest;
  });
}

export function resolveGitBranches(
  request: GitRequest,
  cwd: string,
  detail?: boolean,
): Promise<{
  branches: GitBranchInfo[];
  worktrees: GitWorktreeInfo[];
  remoteBranches: string[];
  // Absent on an older agent build; null when the agent found no usable default.
  defaultBranch?: string | null;
} | null> {
  return request(
    `/internal/git-branches?cwd=${encodeURIComponent(cwd)}${detail ? "&detail=1" : ""}`,
  );
}

export function resolveGitDiffStats(
  request: GitRequest,
  cwd: string,
  baseRef?: string,
  opts: { fresh?: boolean } = {},
): Promise<{ isRepo: boolean; stats: GitDiffStats | null; baseResolved?: boolean }> {
  let url = `/internal/git-diff?cwd=${encodeURIComponent(cwd)}`;
  if (baseRef) url += `&base=${encodeURIComponent(baseRef)}`;
  if (opts.fresh) url += "&fresh=1";
  return request(url);
}

export function resolveGitFileDiff(
  request: GitRequest,
  cwd: string,
  filePath: string,
  baseRef?: string,
): Promise<{ patch: string | null }> {
  let url = `/internal/git-file-diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(filePath)}`;
  if (baseRef) url += `&base=${encodeURIComponent(baseRef)}`;
  return request(url);
}

export function resolveGitLog(
  request: GitRequest,
  cwd: string,
  opts: { worktree?: string; skip: number; limit: number; scope: "all" | "head" },
): Promise<{ commits: CommitLogEntry[] | null; forbidden?: boolean }> {
  let url = `/internal/git-log?cwd=${encodeURIComponent(cwd)}&skip=${opts.skip}&limit=${opts.limit}&scope=${opts.scope}`;
  if (opts.worktree) url += `&worktree=${encodeURIComponent(opts.worktree)}`;
  return request(url);
}

export function resolveGitCommit(
  request: GitRequest,
  cwd: string,
  sha: string,
  worktree?: string,
): Promise<{ detail: CommitDetail | null; forbidden?: boolean }> {
  let url = `/internal/git-commit?cwd=${encodeURIComponent(cwd)}&sha=${encodeURIComponent(sha)}`;
  if (worktree) url += `&worktree=${encodeURIComponent(worktree)}`;
  return request(url);
}

export function resolveGitCommitFile(
  request: GitRequest,
  cwd: string,
  sha: string,
  filePath: string,
  worktree?: string,
): Promise<{ patch: string | null; forbidden?: boolean }> {
  let url = `/internal/git-commit-file?cwd=${encodeURIComponent(cwd)}&sha=${encodeURIComponent(sha)}&path=${encodeURIComponent(filePath)}`;
  if (worktree) url += `&worktree=${encodeURIComponent(worktree)}`;
  return request(url);
}

export function resolveGitFetch(
  request: GitRequest,
  cwd: string,
  token?: string,
): Promise<{ success: boolean; error?: string; skipped?: boolean }> {
  const url = `/internal/git-fetch?cwd=${encodeURIComponent(cwd)}`;
  // The optional read token rides a header on the signed channel, never the
  // URL. An agent too old to know it ignores the header and fetches plain.
  return token ? request(url, { headers: { "x-mullion-git-token": token } }) : request(url);
}

export function resolveGitHealth(request: GitRequest, cwd: string): Promise<CloneHealth> {
  return request(
    `/internal/git-health?cwd=${encodeURIComponent(cwd)}`,
    undefined,
    GIT_HEALTH_REQUEST_TIMEOUT_MS,
  );
}

export function resolveGitRepair(
  request: GitRequest,
  cwd: string,
  opts: { confirm?: boolean } = {},
): Promise<RepairPlan | RepairOutcome> {
  return request(
    "/internal/git-repair",
    { method: "POST", body: JSON.stringify({ cwd, confirm: opts.confirm === true }) },
    GIT_REPAIR_REQUEST_TIMEOUT_MS,
  );
}

export function resolveGitPull(request: GitRequest, cwd: string): Promise<GitPullResult> {
  return request("/internal/git-pull", {
    method: "POST",
    body: JSON.stringify({ cwd }),
  });
}

export function resolveGitCheckout(
  request: GitRequest,
  cwd: string,
  branch: string,
): Promise<GitBranchOpResult> {
  return request(
    "/internal/git-checkout",
    { method: "POST", body: JSON.stringify({ cwd, branch }) },
    GIT_BRANCH_OP_REQUEST_TIMEOUT_MS,
  );
}

export function resolveGitBranchCreate(
  request: GitRequest,
  cwd: string,
  name: string,
  startPoint: string,
  checkout?: boolean,
): Promise<GitBranchOpResult> {
  return request(
    "/internal/git-branch-create",
    { method: "POST", body: JSON.stringify({ cwd, name, startPoint, checkout }) },
    GIT_BRANCH_OP_REQUEST_TIMEOUT_MS,
  );
}

export function resolveGitRebase(
  request: GitRequest,
  cwd: string,
  onto?: string,
): Promise<GitBranchOpResult> {
  return request(
    "/internal/git-rebase",
    { method: "POST", body: JSON.stringify({ cwd, onto }) },
    GIT_REBASE_REQUEST_TIMEOUT_MS,
  );
}

export function resolveGitClone(
  request: GitRequest,
  url: string,
  name: string,
  token?: string,
): Promise<CloneResult> {
  return request(
    "/internal/git-clone",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, name, ...(token ? { token } : {}) }),
    },
    GIT_CLONE_REQUEST_TIMEOUT_MS,
  );
}
