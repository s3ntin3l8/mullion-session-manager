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
  own writes fail. Before and again right before taking the lock, Mullion looks
  for any process (of the server's user) with the database, its `-wal` or its
  `-shm` open (by resolved path, so a symlinked data dir is seen too), and skips, without error, if it finds one. It never starts or
  stops opencode. Stop opencode (or its background service) and run the cleanup
  again.
- **Room to work.** A `VACUUM` builds the compacted copy in a temporary file
  and, in WAL mode, then writes it through the WAL, so the volume needs about
  twice the live size free (with 20% slack). The temporary file is kept on the
  database's own volume (`SQLITE_TMPDIR`) so that check is the right one;
  otherwise it refuses and says how much it needed.
- **The server keeps serving.** The `VACUUM` runs in a child `node` process,
  not in the server's own: `better-sqlite3` is synchronous, so doing it in
  process would freeze every terminal and request for the minutes it takes. It
  is killed if it runs past 30 minutes, which is safe since a `VACUUM` that
  doesn't commit changes nothing. The request itself stays open until it
  finishes.
- **Nothing else is changed.** No schema, pragma or row is touched: the
  database stays in WAL mode with `auto_vacuum` off, and the WAL is
  checkpointed and truncated afterwards so the file actually shrinks. A failed
  `VACUUM` is atomic and leaves the database as it was.
- **Not retention.** This reclaims free pages only. Deleting old sessions is
  opencode's to do (it has no bulk or age-based command yet); see #1664.
