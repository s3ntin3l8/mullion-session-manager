# Disk cleanup

Settings → Storage → Disk cleanup frees space the host accumulates around
Mullion. It has a **safe** and an **aggressive** button; each tier below says
what it does in which. Every figure shown beforehand is an estimate, and
every removal re-checks the entry right before deleting it, so something that
started being used between the preview and the click is left alone.

The backend lives in `src/routes/system-resources.ts`; each tier is its own
service. Everything here is local to the machine the Mullion server runs on.

## Running a cleanup

A cleanup can take minutes (the temp tier re-scans `/tmp` before it deletes
anything), so it is a job on the server, not a request the page waits on.
`POST /api/storage/cleanup` (`{ mode, cacheDirs? }`) answers `202` with the job
and runs the sources one after another in the background; `GET
/api/storage/cleanup` is its status, and the page polls it every two seconds
while it runs. A reload or a second tab finds the job where it was (and its
buttons disabled), and the last finished job stays available so its result can
still be read. Only one job runs at a time (`409` otherwise).

`services/disk-cleanup-job.ts` holds the job; the route
(`routes/system-resources.ts`) decides which sources take part:

- Docker and temp files always, in either tier, unless their last measurement
  said they are unavailable (then they are listed as skipped, with the reason).
- Aggressive only: the opted-in caches (the ids the client sends **and** the
  saved settings both contain), opencode's database (skipped with a reason
  while opencode is running, can't be told, or is already compacting; left out
  entirely when there is nothing to reclaim), and stale developer worktrees
  (always, whatever the preview says, since fetching is the first thing it
  does).
- A source nobody has measured yet still runs: each prune re-checks its own
  safety. The measurements are never started just to make this decision.

Each source is independent: one failing (or freeing nothing) never stops the
next. When a source finishes, its held measurement is dropped, and when the
whole job finishes the page asks for fresh figures.

## How the figures are measured

Measuring can be slow (a `/tmp` with a million files takes a while even with
the walk's 16 concurrent syscalls), so no request waits for it. Each
inspection (Docker, temp files, caches, opencode, worktrees, the space report) is wrapped by
`services/measured-probe.ts`: a read starts a background run if the held
result is stale, waits about a second and a half, and otherwise answers
`state: "measuring"` with the last known figures (if any). The page polls
every two seconds while anything is measuring. At most one run per inspection
is ever in flight, `?refresh=1` (the Refresh button) joins a running one
instead of starting a second, and the freshness window (30 s for Docker,
30 minutes for the disk walks, so coming back to the page later shows figures
at once) counts from when a run _finishes_. A prune
drops the held result (and the space report's, which spans every source); a run still in flight can't be stopped, so its figure is thrown away and the next run starts only once it has ended.

Each answer carries `startedAt` (while a run is in flight) and `durationMs`
(of the run behind the figures), which is how the page shows "measuring… 1m
20s" and says that measuring carries on server-side if the page is left. Every
run is logged with its probe name and duration (`debug`, or `warn` from 10 s),
so the slow probe on a given host can be identified from the server log. In
production the disk walks are also measured once about 20 s after boot (not the
space report, which walks the whole home directory), so the first visit isn't a
cold start.

## Docker

`services/docker-storage.ts`. Safe prunes dangling images (any age), stopped
containers and unused networks older than 7 days, and build cache older than
24 hours. Aggressive drops the windows and also removes unused tagged images
(`docker system prune --all`). Volumes are never touched.

The aggressive estimate is the larger of the summary rows' `Reclaimable` and
the sum of the per-entry sizes in `docker system df -v` (unused images,
stopped containers, unused build cache of every type). On the containerd image
store the Build Cache row's `Reclaimable` is only the private part, far below
what the prune frees, so the rows alone understate it.

## Temp files

`services/temp-storage.ts`, over the top level of `os.tmpdir()`. It only
considers entries owned by the server's user, skips sockets and anything on
another filesystem, and has a denylist of live tool caches (`tmux-*`, `ssh-*`,
`systemd-private-*`, `dbus-*`, `mullion-*`, ...). An entry is judged by the
newest mtime anywhere in its tree: safe takes those untouched for 7 days,
aggressive for 24 hours, and aggressive also runs `npm cache clean`.

### Claude scratch under `claude-<uid>`

Claude Code keeps per-session scratch under
`claude-<uid>/<project>/<session-uuid>` and reads it back for as long as the
session lives, so mtime alone can't prove a session is finished. Liveness
comes from Claude Code's session registry (`<config dir>/sessions/<pid>.json`),
cross-checked against `/proc`:

- **Registries consulted.** The server's own config dir (`CLAUDE_CONFIG_DIR`,
  else `~/.claude`) plus the `CLAUDE_CONFIG_DIR` of every _active_ session
  that was started with its own (`sessions.env`); a session registers in its
  own config dir while the tmp dir is shared. The server's own registry
  must exist: a Claude Code too old to keep one looks the same as a missing
  one, and "no registry" must not read as "nothing is running". An extra
  dir that has gone away (or isn't a directory) just means nothing registers
  there. A config dir set any other way, such as inline in a session's launch
  command, isn't visible to Mullion; such a session is protected by the grace
  window alone.
- **Unknown means hands off.** If liveness can't be established (no `/proc`,
  an unreadable registry, an unparseable registry file whose process might
  still be running, a session whose `CLAUDE_CONFIG_DIR` is a relative path), the whole `claude-<uid>` tree is skipped, and the
  Settings page says why. An unparseable file named `<pid>.json` whose pid is
  gone is only skipped, with a warning listing the file, and the rest is
  cleaned as usual.
- **Windows.** A session that isn't running is removed after 24 hours in safe
  mode and after 10 minutes in aggressive mode, never sooner: that margin is
  what protects a session that is starting up, and the headless/SDK sessions
  that may not register at all.
- **`bundled-skills/<version>`** is removed under the same windows when no
  running session uses that Claude Code version. Versions in use come from
  the registry's `version` field and from the `claude` binaries actually
  running (`/proc/<pid>/exe`, which also covers unregistered sessions and a
  binary replaced by an upgrade). If any running session doesn't say which
  version it runs, no version dir is removed. The binary scan only
  recognises Claude Code's own `…/claude/versions/<version>` layout, so an
  unregistered session started from a different install (an npm global, say)
  isn't seen by it; that session is protected by the grace window alone.
- **Empty project dirs** are removed once they have sat empty for the same
  window, never in the pass that emptied them, so a session creating
  `proj` and then `proj/<uuid>` can't race the cleanup. `rmdir` refuses a dir
  that gained a child.
- **Loose entries**: other files and directories directly under `claude-<uid>`
  (logs, pid files, leftover work dirs) follow the general 7-day / 24-hour
  temp windows. A `*.pid` file whose process is still running is kept, and
  `emptyhome` and any project dir holding something other than session
  directories are never touched.

## Opt-in caches

`services/cache-storage.ts`. An opt-in allowlist of re-creatable caches
(Playwright browsers, Hugging Face models, pip, uv, ...), ticked in the settings
page and emptied in aggressive mode only. Most are under `~/.cache`; the
toolchain caches that live elsewhere in the home directory are listed with
`base: "home"`: the Go module cache (`~/go/pkg/mod`, default location only),
Gradle (`~/.gradle/caches`) and the Cargo registry (`~/.cargo/registry`). Emptying
Gradle's cache while a build runs can break that build. Go writes its module
files read-only, so only that cache is made writable and retried when a removal
fails with `EACCES`; symlinks are never followed or changed. The server only empties ids that
are both ticked in the stored settings and requested, so neither side can
widen the other.

## opencode's database

`services/opencode-storage.ts`. opencode keeps every session in one SQLite
file, `<XDG_DATA_HOME or ~/.local/share>/opencode/opencode.db`, with
`auto_vacuum` off, so space freed by deleted or migrated sessions is never
returned to the filesystem: the file can be many times larger than the data
in it. Aggressive cleanup compacts it with `VACUUM`, which rewrites the same
rows into a smaller file and loses nothing. The figure shown beforehand is
exact (`freelist_count × page_size`), not an estimate.

This is the one place Mullion opens a SQLite file it doesn't own for writing,
so it is deliberately narrow:

- **Only while opencode isn't running.** `VACUUM` holds the write lock for the
  whole rebuild (a minute or so for a large file), which would make opencode's
  own writes fail. Mullion looks for any process (of the server's user) with the
  database, its `-wal` or its `-shm` open (by resolved path, so a symlinked data
  dir is seen too), and skips, without error, if it finds one. It never starts
  or stops opencode. The last look is taken just before the lock: the child
  process is started first and only told to go once that check is clear, so
  nothing but a pipe write separates the two. A holder that is found is
  definitive, and the page names it (pid, binary and its bare flags: never an
  argument value, which could be a credential), so you know what to stop. If no
  holder is found but the scan couldn't look at everything (no readable
  `/proc`, or one of the user's own processes can't be listed), that counts as
  "running", never as "nobody": the Settings page says it couldn't tell and
  what it couldn't look into (for example `cannot list /proc/1234/fd
(EACCES)`), so a host where one process is unreadable (`hidepid`, a sandbox)
  can be diagnosed. systemd's `(sd-pam)` helper, whose descriptors are never
  listable and which can't be opencode, is the one exemption. Stop
  opencode (or its background service, or the container running it) and run the
  cleanup again.
- **Room to work.** A `VACUUM` builds the compacted copy in a temporary file
  and, in WAL mode, then writes it through the WAL, so the volume needs about
  twice the live size free (with 20% slack). The temporary file is kept on the
  database's own volume (`SQLITE_TMPDIR`) so that check is the right one;
  otherwise it refuses and says how much it needed.
- **The server keeps serving.** The `VACUUM` runs in a child `node` process,
  not in the server's own: `better-sqlite3` is synchronous, so doing it in
  process would freeze every terminal and request for the minutes it takes. It
  is killed if it runs past 30 minutes, which is safe since a `VACUUM` that
  doesn't commit changes nothing. The child gets only `PATH`, `HOME`,
  `LD_LIBRARY_PATH` and its temp dir, not the server's whole environment (a
  `NODE_OPTIONS` loader meant for the server shouldn't follow it).
- **Not a long request.** The compaction runs as part of the cleanup job, so
  no HTTP request waits on the `VACUUM`, which can take minutes on a large
  database: a reverse proxy's read timeout (nginx's `proxy_read_timeout`
  defaults to 60 s) cannot cut it off, and a reload just finds the job still
  running. While it runs, the database card shows "being compacted right now"
  (the compaction's own child process is not mistaken for opencode).
- **Nothing else is changed.** No schema, pragma or row is touched: the
  database stays in WAL mode with `auto_vacuum` off, and the WAL is
  checkpointed and truncated afterwards so the file actually shrinks (if a
  reader still holds the WAL the result says so, and it shrinks at its next
  checkpoint). A failed
  `VACUUM` is atomic and leaves the database as it was.
- **Not retention.** This reclaims free pages only. Deleting old sessions is
  opencode's to do (it has no bulk or age-based command yet); see #1664.

## Where the space is

`services/space-report.ts`, `GET /api/storage/space`. A read-only report of the
biggest entries under the home directory (three levels deep, the eight biggest
children of each, the top 25 at the top), with the space outside the home
directory (and in unreadable folders) as its own line. It exists to answer
"what is using my disk?" for the space no cleanup tier handles: nothing in it
can be deleted. Entries a cleanup source owns carry a `coveredBy` label (the
opt-in caches, `~/.npm/_cacache`, opencode's data directory, developer
worktree roots), which the page shows as "cleanable: …". The walk stays on the
home directory's filesystem, never follows symlinks, shares the temp walks'
syscall limiter, and stops at 3 million entries (`truncated`, every figure then
a lower bound). It takes tens of seconds on a large home directory.

## Developer worktrees

`services/dev-worktrees.ts`. Every project on this host keeps its own
developer worktrees: `.wt/<slug>` (this repo's convention, see `AGENTS.md`),
`.worktrees/<slug>` (what agents pick in projects whose conventions name no
directory), and `.claude/worktrees/agent-*`, which Claude Code's isolated
sub-agents leave behind. When a session's conventions say `.wt/`, Mullion's
Claude Code adapter registers a `WorktreeCreate`/`WorktreeRemove` hook
(`src/hooks/worktree-hook.mjs`) so those sub-agent worktrees are created under
`.wt/<name>` on a `worktree-<name>` branch instead.

Each is a full checkout, usually with its own `node_modules`, a few
hundred MB apiece, and nothing removes one once its PR is merged. Aggressive
cleanup removes the ones whose work is already elsewhere. `.mullion-worktrees/`
is not touched here: Task Master owns its own, and an isolated session's are
reclaimed on their own (see [Isolated session worktrees](#isolated-session-worktrees)).

A worktree is only offered when **all** of these hold:

- Its tree is clean (no staged, unstaged or untracked changes, no conflicts).
- No session or resumable task is using it. Sessions of every project count, not
  just the repo's own: a worktree is often registered as a project of its own.
- Its `HEAD` hasn't moved for a day (its reflog), so one just created, or one
  someone pulled into this morning, is left alone.
- And one of these shows its work is elsewhere:
  - **`gone`**: its branch's upstream was deleted on the remote, which is what a
    merged PR's auto-deleted branch looks like. This is read from the last
    fetch, so the preview can only undercount; cleanup fetches each project
    first.
  - **`merged`**: for repos that don't delete branches on merge (and for
    branches pushed without tracking), GitHub reports a PR that merged exactly
    this commit into the repo's default branch. Commits added after the merge
    don't count, and neither does a merge into some other feature branch.
    Needs a GitHub remote and a token; without them this rule is skipped.
    Answers are cached for ten minutes, except a lookup that failed (rate
    limit, offline), which is simply asked again next time.
  - **`detached-merged`**: a detached `HEAD` whose commit is already in the
    default branch, so nothing names those commits that would be lost.
  - **`in-default`**: a `worktree-*` branch (the name the Claude Code worktree
    hook gives its branches) whose tip is already in the default branch, so
    nothing was committed on it. Ordinary branches never get this rule.

Removal goes through the same path as the Git panel's "remove worktree": a
clean-status check, repeated right before each removal (still clean, same
commit, same reason, still unused), then `git worktree remove`. That helper
passes `--force` to git itself once its own check has passed, so the check is
the guard, not git. **The branch is always kept**, so a commit that was never
pushed is still reachable from it. What is not kept is anything git ignores,
because it goes with the directory: `node_modules` is the point, but also a
local `.env` or editor settings in the worktree. Only local projects are
considered; a remote host's worktrees are on another machine.

The Settings preview is read from the last fetch and loads on its own, so it
never holds up the rest of the page. Aggressive cleanup asks the server to
clean up whenever it can, even when the preview is empty, because the first
thing it does is fetch each project that has developer worktrees.

**Orphaned directories** (issue #1979). A directory under one of those roots
that `git worktree list` doesn't know is listed too, as **`orphaned`**, with its
size: a worktree whose registration was pruned (`git worktree prune` after its
`gitdir` went missing), or a directory that was never a worktree. A directory
that only holds registered worktrees deeper down (`.wt/feat/` around a
registered `.wt/feat/x`) is walked into, not reported. Orphans are
**report-only**: nothing can tell whether one holds work, so cleanup never
removes them and they are not counted in what it frees. Settings → Storage lists
them under their own heading; delete one by hand once you've checked it.

Known limits: a worktree outside `.wt/`, `.worktrees/` and `.claude/worktrees/` is never
considered, orphaned or not (a sibling directory such as `../repo-wt-x` stays
invisible here; agents are nudged away from making those, see "Worktree
placement" in `docs/agent-hooks.md`), and a repo whose default branch can't be
determined (no `origin`) gets neither `merged` nor `detached-merged`.

## Isolated session worktrees

`services/session-worktree-reclaim.ts`. A session that runs in a worktree
Mullion cut for it — the launcher's **isolate** toggle, a child spawned with
`--isolate`, and **promote to worktree** — owns that worktree
(`.mullion-worktrees/…`, on a `mullion/…` branch). It used to be left behind
when the session ended. Mullion now removes it itself, on the host the session
ran on (a remote host included), when the session ends and again from a
periodic sweep (the first pass two minutes after boot, then every 30 minutes).
Task Master's worktrees are not these: the task reclaims its own.

It is removed only when **all** of these hold:

- No other session is working inside it — an active one, or an ended one whose
  process has not been confirmed gone (a cascade kill marks children killed
  while their agents may still be exiting there) — and the session's own
  process is confirmed gone too (a kill whose `terminate` failed still marks it
  ended; that is recorded as `still-running`).
- Its branch is **pushed** (it has an upstream it is not ahead of), its
  upstream was **deleted** (a merged PR's auto-deleted branch), or it is
  **merged** into the default branch. A session branch is created without
  tracking, so a branch pushed with a bare `git push origin <branch>` has no
  upstream and counts as unpushed: push with **`git push -u origin <branch>`**.
- Its tree is **clean**: no uncommitted or untracked changes, no merge
  conflicts. Nothing is ever forced.

**The branch is always kept**; only the directory goes, so a commit is never
lost. What git ignores (`node_modules`, a local `.env`) goes with the directory.

A worktree that fails a check is left in place, and the reason is recorded on
the session row as `worktreeKeptReason` (`in-use`, `still-running`, `unpushed`,
`dirty`, `conflicts`, `branch-missing` or `remove-failed`), next to
`worktreeBranch`, `worktreeRepoCwd`, `worktreeLastAttemptAt` and, once removed,
`worktreeReclaimedAt`.

**Settings → Storage → Kept session worktrees** lists every one of them: the
project, the host, the path, the branch, why it was kept and when it was last
tried. Each row says what to do about it:

- `unpushed`: push with an upstream — the row has the
  `git push -u origin <branch>` to copy.
- `dirty`, `conflicts`: commit the work (and push it with `-u`) or discard it.
- `in-use`, `still-running`: nothing; it goes once nothing runs in it.
- Any row: **Remove worktree**, for one you have decided to drop. It goes
  through the Git panel's removal route
  (`POST /api/projects/:id/git-worktree-remove`, given the session's
  `sessionId`), so it runs on the session's own host against the repository
  the worktree was cut from. It refuses while a session is active inside the
  worktree, while the session's own process is not confirmed gone, and on
  uncommitted changes or conflicts — each of which a second, separately
  confirmed **Force remove** overrides. The branch is kept either way, and the
  row drops off once the directory is gone.

The same fields ride on `GET /api/sessions` (`mullion session list --json`) for
scripting. The sweep retries every kept worktree, so pushing the branch or
committing the work is enough: the next pass reclaims it. A host that is
unreachable is simply tried again later; only the attempt is stamped
(`worktreeLastAttemptAt`). Each pass takes at most 100 sessions — ones never
tried first, then the least recently tried — so leftovers that cannot be
resolved (a decommissioned host, an abandoned dirty tree) rotate to the back
instead of crowding out the rest. The server log says what each pass did.

A worktree that is already gone — removed by hand, or its project moved or
deleted so that neither path is a repository any more — is counted as reclaimed;
`branch-missing` is only for a worktree that still exists but has lost its branch.

Known limits: a worktree whose session row was deleted is no longer known to
Mullion; one created before this existed is not tracked (they carry no
`worktreeBranch`); and "pushed" is judged from the branch's upstream, not from
whether some remote branch happens to contain its tip.
