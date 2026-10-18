# Disk cleanup

Settings → Server → Disk cleanup frees space the host accumulates around
Mullion. It has a **safe** and an **aggressive** button; each tier below says
what it does in which. Every figure shown beforehand is an estimate, and
every removal re-checks the entry right before deleting it, so something that
started being used between the preview and the click is left alone.

The backend lives in `src/routes/system-resources.ts`; each tier is its own
service. Everything here is local to the machine the Mullion server runs on.

## Docker

`services/docker-storage.ts`. Safe prunes dangling images (any age), stopped
containers and unused networks older than 7 days, and build cache older than
24 hours. Aggressive drops the windows and also removes unused tagged images
(`docker system prune --all`). Volumes are never touched.

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

## `~/.cache`

`services/cache-storage.ts`. An opt-in allowlist of re-creatable caches
(Playwright browsers, Hugging Face models, pip, ...), ticked in the settings
page and emptied in aggressive mode only. The server only empties ids that
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
  nothing but a pipe write separates the two. If it can't tell (no readable
  `/proc`, or one of the user's own processes can't be listed), that counts as
  "running", never as "nobody": the Settings page says it couldn't tell and
  what it couldn't look into (for example `cannot list /proc/1234/fd
(EACCES)`), so a host where one process is unreadable (`hidepid`, a sandbox)
  can be diagnosed. Stop
  opencode (or its background service) and run the cleanup again.
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
- **A long request.** The cleanup request stays open until the `VACUUM`
  finishes, which can be minutes on a large database. A reverse proxy with a
  short read timeout (nginx's `proxy_read_timeout` defaults to 60 s) will cut
  the response while the compaction carries on; Settings then says the
  request ended and that it may still be running. Raise that timeout for
  `/api/storage/opencode/prune`, or just reload the page: while it runs, the
  database card shows "being compacted right now" (the compaction's own child
  process is not mistaken for opencode). Running it as a background job that
  the page polls is tracked in #1667.
- **Nothing else is changed.** No schema, pragma or row is touched: the
  database stays in WAL mode with `auto_vacuum` off, and the WAL is
  checkpointed and truncated afterwards so the file actually shrinks (if a
  reader still holds the WAL the result says so, and it shrinks at its next
  checkpoint). A failed
  `VACUUM` is atomic and leaves the database as it was.
- **Not retention.** This reclaims free pages only. Deleting old sessions is
  opencode's to do (it has no bulk or age-based command yet); see #1664.

## Developer worktrees

`services/dev-worktrees.ts`. Every project on this host keeps its own
developer worktrees: `.wt/<slug>` (this repo's convention, see `AGENTS.md`) and
`.claude/worktrees/agent-*`, which Claude Code's isolated sub-agents leave
behind. Each is a full checkout, usually with its own `node_modules`, a few
hundred MB apiece, and nothing removes one once its PR is merged. Aggressive
cleanup removes the ones whose work is already elsewhere. `.mullion-worktrees/`
is not touched: Task Master owns those.

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

Known limits: a worktree outside `.wt/` and `.claude/worktrees/` is never
considered, and a repo whose default branch can't be determined (no `origin`)
gets neither `merged` nor `detached-merged`.
