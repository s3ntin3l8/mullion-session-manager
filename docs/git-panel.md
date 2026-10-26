# GitPanel — branch and worktree management (#442)

GitPanel gives a project's branches and worktrees a management UI, layered
on top of the existing read-only branch/worktree listing and the sidebar's
git-status polling. Open it via the sidebar's Source Control section
(`SourceControlSection.tsx`'s "Open Git Panel" action, issue #433) or the
command palette ("Git: `<project>`") — not the Dock, which is a separate,
shared rail of per-project monitors (see [`dock.md`](dock.md)). It works for
local- and multi-host (remote-hosted) projects alike, proxying through the
same `SessionBackend`/`/internal/*` pattern the rest of Mullion's
remote-host support uses.

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

| Endpoint                                 | Method | Notes                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/projects/:id/git-branches`         | GET    | Branches + worktrees + remote branches. `?detail=1` additionally computes `isMerged` per branch. Rate-limited 30/min.                                                                                                                                                                                                                             |
| `/api/projects/:id/git-fetch`            | POST   | Manual `git fetch origin` trigger. Rate-limited 10/min.                                                                                                                                                                                                                                                                                           |
| `/api/projects/:id/git-pull`             | POST   | Fast-forward `git pull --ff-only` (`git merge --ff-only @{u}`). Rate-limited 10/min.                                                                                                                                                                                                                                                              |
| `/api/projects/:id/git-branch-delete`    | POST   | `{ name, force? }`. POST, not DELETE — a branch name can contain `/`. Rate-limited 10/min.                                                                                                                                                                                                                                                        |
| `/api/projects/:id/git-worktree-remove`  | POST   | `{ worktreePath, force? }`. Rate-limited 10/min.                                                                                                                                                                                                                                                                                                  |
| `/api/projects/:id/git-worktree-prune`   | POST   | No body. Rate-limited 10/min.                                                                                                                                                                                                                                                                                                                     |
| `/api/projects/:id/git-log`              | GET    | Paged `git log --topo-order` (`skip`, `limit` ≤ 200, `scope=all\|head`) for the sidebar's History graph. Optional `cwd` must be one of `git worktree list`. Remote-host projects are served by the host agent's `/internal/git-log` (204 from an agent that predates it, 502 if it rejects the request, 503 if unreachable). Rate-limited 60/min. |
| `/api/projects/:id/git-commit/:sha`      | GET    | One commit's message and `--numstat` file list (renames report the new path). Same `cwd` rule; remote hosts go through `/internal/git-commit`. Rate-limited 60/min.                                                                                                                                                                               |
| `/api/projects/:id/git-commit/:sha/file` | GET    | `?path=` — that file's patch within the commit (remote hosts: `/internal/git-commit-file`). Rate-limited 60/min.                                                                                                                                                                                                                                  |

## The sidebar's Git view

The right sidebar's Git view (`right-sidebar/GitSidebarView.tsx`) composes
four collapsible sections (open/closed state is kept per user in
`localStorage`): **Changes** (the source-control section with inline working-tree
diffs), **Branches** (ahead/behind, last-commit age, merged tag — fetched with
`?detail=1` — the PR's phase chip, and two-step branch deletion with `Force`
override), **Worktrees** (the sessions running in each, a selector that scopes
History to a worktree, `Prune stale`, and two-step worktree removal with `Force`
override) and **History** (a lane graph computed by `git/graphLayout.ts`, ref
chips, per-commit files and diffs, "Load more" paging). Mutations in either the
sidebar or `GitPanel` bump the store's `gitRefreshTrigger` counter so the
sidebar's detailed branch list and commit history re-fetch immediately. History
and commit detail work on remote-host projects too, proxied through the host
agent (`/internal/git-log`, `/internal/git-commit`, `/internal/git-commit-file`).

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

## The background "tidy-up" git does on its own

Sometimes, after a command like `git fetch` or `git commit`, git asks itself
_"while I'm here, should I tidy up this repository?"_ — and sometimes the
answer is yes. It then starts a **background** job that packs and reorganises
the repository's internal files.

That is a git feature, and it is on by default. It is normally harmless. It
becomes a problem in one narrow situation: **if something writes to the
repository at the same moment.** The tidy-up can delete a file that a
half-finished commit is in the middle of writing, and the commit then fails
with a confusing message — _"missing object"_ — pointing at a file that is not
really missing, just eaten ([#1836](https://github.com/s3ntin3l8/mullion-session-manager/issues/1836)).

Your own git does exactly this. Mullion does not introduce the behaviour — but
it adds triggers, and it adds them **on a timer**: the background auto-fetch
runs every `gitAutoFetchIntervalSeconds` (300 by default) in every project
whose auto-fetch is on, whether or not you are looking.

### What Mullion does about it

Every git command Mullion runs — the auto-fetch sweep, the **Fetch** and
**Pull** buttons, the fetch before a push, the WIP commit in a task worktree
— carries `-c gc.auto=0`, which answers "no" to the tidy-up question **for
that one command**. Nothing is written anywhere: not your repository's
config, not your global config, not your files. Your own git keeps tidying up
exactly as it does today.

The same override rides in the environment of an agent session, so an agent's
own `git commit` does not trigger the tidy-up either. That one is scoped to
the session — it ends with it. The cost is that your repository does not
auto-tidy for the length of a session, so it accumulates loose objects until
your own git packs them later.

### What it does NOT cover

- **Your own git.** If you run `git fetch` or `git commit` in your terminal
  while Mullion is working in the same repository, your command can still
  trigger the tidy-up. Mullion cannot prevent that without changing your
  repository's settings, which is your call, not ours.
- **Other tools** that write to the repository.

If you want the tidy-up off in a repository you share with Mullion, turn it
off yourself — one command, in that repository:

```sh
git config gc.auto 0
```

and run `git gc` by hand when you want it, ideally when nothing else is
writing.

### Finding out whether it happened

If a repository does get damaged — by your own git, or by another tool — the
Git panel has a **Check** button. It runs a read-only health check on the
repository and says plainly whether it is whole, and if not, what is wrong with
it (how many zero-byte objects, how many `git fsck` errors).

### Repairing it from the panel

When the check finds damage, the panel offers a **Repair** button. It is
never a one-click button: it arms first, and before you arm it the panel
shows what the repair would do —

> Repair will quarantine 3 damaged object(s), fetch from origin, and rebuild
> 2 index(es). Damaged objects are MOVED into a quarantine directory inside
> the git directory — nothing is deleted.

— and only the second click runs it. A damaged object is **moved**, never
deleted, so the clone's object store can be put back by hand if the repair
turns out to have been the wrong idea.

The repair reports what it actually did: how many objects were moved (and
where), whether the refs came back from origin, which indexes were rebuilt,
which were left alone (and why), and whether the clone is whole again. An
object that was never committed and is not on the remote cannot be recovered
by anything — the panel says so plainly rather than calling the clone whole.

For a project on a **remote host**, the repair runs on that host, on the
agent that owns the clone.

### Repairing it by hand

The same repair is available from the command line, on the machine that holds
the clone:

```sh
make git-doctor APPLY=1 DIR=/path/to/the/clone
```

The command line is also the only way to force the index rebuild when the
staged content is not in the working tree — the panel never offers that,
because `--force` discards what you staged.

`DIR` is the clone to work on; it defaults to the current directory, so
`make git-doctor` from inside a clone inspects that clone. The repair never
deletes anything — a damaged object is MOVED into a `gc-quarantine-*`
directory inside the clone's git directory, where it can still be recovered by
hand.

In a **release install** there is no `make` and no `tsx`; the script itself is
in the install, and the compiled doctor sits next to it in `dist/`:

```sh
node scripts/git-doctor.mjs --apply /path/to/the/clone
```

For a clone on a remote host, run it there (the same Mullion checkout, on
that host).

### Turning Mullion's fetches off entirely

If you would rather Mullion did not fetch in a repository at all, that is
already a setting:

- **per project** — the auto-fetch toggle in the Git panel (`autoFetch: false`);
- **everywhere** — set `gitAutoFetchIntervalSeconds` to `0` in Settings →
  Projects.

Mullion still fetches when you click **Fetch** or **Pull**, and before it
pushes a branch.

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
