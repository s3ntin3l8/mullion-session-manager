# GitPanel — branch and worktree management (#442)

The Dock's GitPanel gives a project's branches and worktrees a management
UI, layered on top of the existing read-only branch/worktree listing and
the sidebar's git-status polling. It works for local- and multi-host
(remote-hosted) projects alike, proxying through the same
`SessionBackend`/`/internal/*` pattern the rest of Mullion's remote-host
support uses.

## What you get

- **Branch list** with, on request, enrichment fields: upstream tracking
  branch, ahead/behind counts, whether the upstream is `[gone]` (deleted on
  the remote), last-commit-relative time, and whether the branch is merged
  into the resolved default base ref. The enrichment (`isMerged` and its
  extra `git branch --merged` spawn) is opt-in — the GitPanel's own fetch
  requests it explicitly; the sidebar's background poll does not, so it
  keeps paying for only the cheap `for-each-ref` call it always has.
- **Worktree list**, alongside the branches (`GET
/api/projects/:id/git-branches` returns both in one response, plus the
  project's remote branches).
- **Manual branch deletion** and **manual worktree removal**, each behind a
  two-step confirm in the UI backed by a `force` flag server-side.
- **Prune stale worktrees** — clears `git worktree`'s administrative
  metadata for entries whose directory is already gone, without touching
  anything that still exists on disk.
- **Fast-forward Pull** — advances the local working tree to match upstream
  (`git merge --ff-only @{u}`) after fetching, safely refusing if history
  has diverged or the tree is dirty.

## Endpoints

| Endpoint                                | Method | Notes                                                                                                                 |
| --------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------- |
| `/api/projects/:id/git-branches`        | GET    | Branches + worktrees + remote branches. `?detail=1` additionally computes `isMerged` per branch. Rate-limited 30/min. |
| `/api/projects/:id/git-fetch`           | POST   | Manual `git fetch origin` trigger. Rate-limited 10/min.                                                               |
| `/api/projects/:id/git-pull`            | POST   | Fast-forward `git pull --ff-only` (`git merge --ff-only @{u}`). Rate-limited 10/min.                                  |
| `/api/projects/:id/git-branch-delete`   | POST   | `{ name, force? }`. POST, not DELETE — a branch name can contain `/`. Rate-limited 10/min.                            |
| `/api/projects/:id/git-worktree-remove` | POST   | `{ worktreePath, force? }`. Rate-limited 10/min.                                                                      |
| `/api/projects/:id/git-worktree-prune`  | POST   | No body. Rate-limited 10/min.                                                                                         |

## Safety guards, and what `force` actually overrides

These guards are a **UX safety net for the GitPanel's two-step confirm, not
a security boundary** — anyone with host access to the project can already
run `git branch -D`/`git worktree remove` directly in a terminal session
with no confirmation at all. `force: true` on the very first request isn't
bypassing anything the underlying host doesn't already permit; what it
does is skip the _warning_, not the _action_.

- **Fast-forward pull refusals.** Pulling via the UI enforces `--ff-only`
  semantics. It never creates a merge commit or rebases automatically. A pull
  refuses cleanly if:
  - The working tree has uncommitted changes or merge conflicts (`dirty-tree`).
  - HEAD is detached (`detached-head`) or unborn (`unborn-head`).
  - No upstream tracking branch is configured (`no-upstream`).
  - Local commits have diverged from upstream (`not-fast-forward`).
    Sessions running in the main worktree do not block a pull as long as their
    working tree is clean (any uncommitted edits are caught by `dirty-tree`).
- **Task-branch refusal.** Deleting a `mullion/task-<N>` branch belonging
  to a task whose status is `claimed`/`in_progress`/`reviewing`/`failed`
  refuses (`reason: "task-branch"`, `detail: "#<taskId>"`) — the same
  status set [Task Master's Retry](tasks.md#lifecycle) checks out for
  resuming work. `force` overrides the refusal **and will break Retry**:
  once the branch is gone, `resumeTaskWorktree`'s `git worktree add` has
  nothing to check out and 502s `worktree-failed` — the same failure mode
  as a crashed retry attempt with no automatic cleanup (see
  [`tasks.md`](tasks.md#known-limitations)). The lookup always runs, even
  under `force` — a force bypass is logged (`app.log.warn`) rather than
  silently skipped, so a broken Retry is diagnosable after the fact.
- **Live-session guard.** Removing a worktree with sessions still running
  under it refuses (`reason: "sessions-active"`, `detail:` a comma-joined
  list of session ids) unless `force`. Skipped for the project's _main_
  worktree specifically (nearly every session's cwd resolves under it,
  which would otherwise report a confusing refusal for something
  `removeListedWorktree` already refuses on its own, unconditionally, as
  `reason: "is-main"`). A force bypass here is logged the same way.
- **Validity gate is membership, not a path prefix.** Deletion candidates
  are validated against `listWorktrees(cwd)`'s own output, not a
  `mullion-task-`/`dock-preview-` naming check — this must remove
  dock-preview worktrees, agent-created ones, and hand-made `git worktree
add` ones alike, none of which share a common prefix.

## Relationship to Task Master's own worktree lifecycle

Task Master's `mullion-task-<id>` worktrees already have their own
automatic reconciliation — created at claim time, removed on `→ done`/
`→ failed` when clean, with a boot-time orphan sweep and a fresh-claim-time
clear (see [`tasks.md`](tasks.md#worktree-lifecycle) and
`.claude/skills/mullion-review-invariants/SKILL.md`'s "two worktree
concepts" section). GitPanel's manual actions are the
human-triggered counterpart that covers **every** worktree, not just
task-scoped ones — and, per the task-branch guard above, can knowingly
break a task's own automatic lifecycle if used with `force` on a
resumable task's branch.
