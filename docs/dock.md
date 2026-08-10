# Dock

The Dock is a persistent bottom panel showing per-project monitors — dev
servers, logs, status watchers — one column per project currently tiled in
the active workspace (plus any manually pinned). Each column can have
multiple toggleable monitors, each running as a `kind: "dock"` session
that stays out of the normal per-project session inventory.

A monitor is just a shell command that runs on the host (the same
`dtach` + `systemd --user` lifecycle as regular terminal sessions), so
it survives service restarts and tab closures. The Dock never **auto-starts**
a monitor — every one, whether configured in `dock.json` or auto-discovered
(see [Docker Compose services](#docker-compose-services-issue-73) below),
stays off until you click it.

A project's column can also show:

- **GitHub status** — open issue/PR counts and a CI status dot, if a
  GitHub account is connected and the project has a `github.com` origin
  remote. Clicking opens the GitHub panel. See
  [`docs/github-integration.md`](github-integration.md).
- **Browser preview** — a shortcut to open the project's dev server URL
  in a dockview panel, if one is configured. Clicking opens the browser
  preview panel. See [`docs/browser-previews.md`](browser-previews.md).
- **Docker Compose services** — running containers belonging to a Compose
  stack rooted in (or under) the project's directory, each shown as its
  own log-streaming monitor with a status dot, image tag, and update
  actions. See the dedicated section below.

## Quick start

Create `.crs/dock.json` in your project's repo (the path must be exactly `.crs/dock.json` relative to the project root) — or, from the dashboard itself, open the Command Palette → **Dock: \<project\>** and use the built-in editor (see [Editing from the UI](#editing-from-the-ui) below); either way produces the same file:

```json
{
  "controls": [
    {
      "id": "dev-server",
      "title": "Dev server",
      "command": "make dev"
    },
    {
      "id": "logs",
      "title": "Logs",
      "command": "tail -f data/app.log"
    }
  ]
}
```

Refresh the dashboard — the Dock appears at the bottom with a column for
your project, each monitor showing a toggle switch. Click a monitor to
start it; its terminal output appears inline.

## dock.json schema

The file lives at `.crs/dock.json` inside a project's repo (tracked,
team-shareable). A global fallback lives at `~/.config/crs/dock.json`
(controlled by `CRS_CONFIG_DIR`).

### Fields (`DockControl`)

| Field             | Type                    | Required | Description                                                                                                     |
| ----------------- | ----------------------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `id`              | `string`                | yes      | Unique identifier for this monitor                                                                              |
| `title`           | `string`                | yes      | Display name shown in the column header                                                                         |
| `command`         | `string`                | yes      | Shell command to run (`npm run dev`, `tail -f log`, ...)                                                        |
| `cwd`             | `string`                | no       | Working directory override (defaults to project root)                                                           |
| `height`          | `number`                | no       | Initial terminal height in pixels for the monitor body                                                          |
| `env`             | `Record<string,string>` | no       | Environment variables to set for the session                                                                    |
| `worktreeRefresh` | `boolean`               | no       | Periodically `git reset --hard` a preview worktree to the branch's local tip to live-sync it (default: `false`) |

### Branch selection

When the project has multiple branches (or worktrees), the monitor header
shows a branch selector the first time you start the monitor. You can:

- Pick an **existing worktree** on this project — the session runs inside
  that worktree's checkout directly.
- Pick a **branch** without a worktree — a transient preview worktree is
  auto-created under `.mullion-worktrees/dock-preview-<sanitized-branch>-<hash>`,
  checked out with a **detached HEAD** rather than a real branch checkout.
  Preview worktrees are cleaned up when you switch branches or toggle the
  monitor off.

If you want the preview worktree to stay in sync with commits an agent makes
in the main checkout, set `"worktreeRefresh": true` on the control (or enable
"Refresh worktree on agent commits" in Settings → Dock). The backend polls
`git reset --hard` against the branch's local tip every 5 seconds — no fetch,
no network — so HMR dev servers pick up local commits live. The detached HEAD
is what makes this safe to run even while that same branch is checked out
elsewhere (e.g. the primary checkout, or another worktree): the reset only
ever moves the preview worktree's own HEAD, never the branch ref itself, so
nothing else that has the branch checked out is affected. This is safe only
for HMR-capable servers — disable it for non-HMR servers (e.g., production
builds, static generators).

Preview worktrees work the same way on multi-host (remote-hosted) projects
(issue #345) — creation, live sync, and cleanup all run on whichever host
actually owns the project's filesystem, proxied through the same
`SessionBackend`/`/internal/*` pattern GitPanel uses (see
[`git-panel.md`](git-panel.md)). There's no user-visible difference between
a local and a remote preview worktree.

For managing branches and worktrees directly — deleting a branch, removing
a worktree, pruning stale worktree metadata — see the GitPanel, documented
separately in [`git-panel.md`](git-panel.md).

### Full example

```json
{
  "controls": [
    {
      "id": "dev-server",
      "title": "Dev server",
      "command": "npm run dev",
      "cwd": "packages/frontend",
      "height": 300,
      "env": { "NODE_ENV": "development" }
    },
    {
      "id": "typecheck-watch",
      "title": "TypeScript",
      "command": "tsc --noEmit --watch"
    }
  ]
}
```

### Validation

- `id`, `title`, and `command` must be non-empty strings.
- `height` must be a positive integer (pixel value for the monitor body).
- `env` entries must be string-to-string.
- A malformed file is silently treated as empty — the backend logs a
  warning but never throws.

This is the read-side contract (`resolveProjectDock`'s merge, described
above). The UI editor's own write path (below) is intentionally stricter: it
rejects a malformed save outright with a specific error, rather than
persisting something the merge would later have to shrug off as empty.

### Editing from the UI

Open the Command Palette (project scope) and choose **Dock: \<project\>** to
edit a project's own `.crs/dock.json` from the dashboard — a structured
form (add/remove a monitor, edit its fields) rather than a raw-JSON editor,
since `dock.json` is small, fixed-shape data. A few things to know:

- **Only the project-scope file.** The global `<configDir>/dock.json`
  default (see [Global vs. per-project config](#global-vs-per-project-config)
  below) isn't editable from this panel yet — hand-edit it on the host, same
  as today.
- **Whole-file replace, not a per-control patch.** Saving writes the
  editor's full monitor list back to `.crs/dock.json`; it never merges in
  the global default or a Docker-discovered monitor (those stay
  read-only/synthesized, exactly as `dock.json schema`'s Validation section
  above says a project's own file can never carry them).
- **An already-broken file is called out, not hidden.** If `.crs/dock.json`
  on disk doesn't parse or validate, the editor opens with an inline notice
  saying so instead of silently showing an empty (and therefore
  overwrite-on-save-able) form — you still get a blank slate to build a
  fresh, valid config from, and saving replaces the broken file.
- **Takes effect immediately**, not just on the next poll or a page reload
  (see the Troubleshooting note below) — a save is picked up by every
  tiled/pinned Dock column right away.

## Global vs. per-project config

The Dock merges two config layers by monitor `id`:

1. **Global defaults** — `<configDir>/dock.json`
   (`~/.config/crs/dock.json` by default).
2. **Per-project overrides** — `<project>/.crs/dock.json`.

Per-project wins on `id` conflict. Unlike the action launcher
(`actions.json`), there is no `override` flag — dock monitors are
commonly additive across a team's shared config and a developer's
personal ones, so only `id`-based merge is supported.

## Docker Compose services (issue #73)

For a local-host project, the Dock also discovers any Docker Compose
service already running on the host whose stack directory (the
`working_dir` compose recorded at `up` time) is the project's own directory
or a descendant of it, and merges one monitor per service in — under
whatever `.crs/dock.json` already configures. A manually-configured control
with the same `id` wins (see the id format below), same "manual overrides
win" precedence as the global/per-project merge above.

Each discovered monitor:

- **Streams the service's logs** (`docker compose logs -f --tail=200
<service>`, or a plain `docker logs -f` fallback when compose can't
  resolve its own config from the working directory alone) — an ordinary
  `kind: "dock"` session, identical in every other respect to a configured
  one.
- Shows a **status dot** for the container's own state (running/exited/
  restarting/…) — independent of whether the log stream itself is
  currently toggled on, which the existing "on"/"off" tag next to it still
  tracks.
- Shows an **image tag** pill (hover for the full image reference).
- Has a **⋯ menu** with:
  - **Check for update** — runs a quiet `docker compose pull` for that one
    service and compares the resulting local image id against the running
    container's own image, without pulling or restarting it. Disabled for
    a `build:`-only service (no registry image to compare).
  - **Pull & restart stack** — pulls and restarts the **whole** Compose
    stack (`docker compose pull && docker compose up -d`), not just the
    one service, so the stack isn't left internally inconsistent. Requires
    two clicks (arms for 3 seconds after the first), and itself runs as
    another `kind: "dock"` session so its output streams live and a slow
    pull/restart can't time out the request — it appears as its own
    temporary monitor in the same column until it exits.

Discovered monitor ids are `docker:<compose-project>:<service>` — put a
`.crs/dock.json` control at that same id to replace one (e.g. to point its
log command at extra flags), or `docker-update:<compose-project>` if you
ever need to collide with the ephemeral "Pull & restart" monitor (unlikely;
that id is never emitted by this discovery pass, only by a live update run).

Turn this off entirely in **Settings → Dock → "Docker Compose services"**;
discovered monitors are still just monitors, so switching it off/on never
starts or stops anything already running.

### Known limitations

- **Local-host only** — a remote-hosted project's Docker services aren't
  discovered (same scoping as dev-server port detection below).
- **Only stacks already linked to a registered project.** A Compose stack
  whose directory isn't inside any registered project's directory doesn't
  show up anywhere in the Dock — register a project pointing at that
  directory first. There's no "pseudo-project" auto-created for it.
- **One-off `docker compose run` containers are excluded**, and replicas/
  stale containers for the same service are deduped down to one
  (preferring the running one).

## Dev server port detection

When a dock monitor's session output contains a dev server startup banner
matching `Local: http(s)://localhost:<port>`, the backend extracts the
port and surfaces it as a suggestion when editing the project's
`devServerUrl` setting. The detected port is never auto-applied.

Detection covers Vite, Next.js, Create React App, and Astro startup
banners. It strips ANSI escape sequences before matching (real PTY
output includes color/bold formatting). Only the _last_ matching port
is returned, so a dev server that restarts on a different port produces
the right result.

Only works for local-host projects (the same process's PtyManager).
A remote-hosted project's dock sessions live on a different machine and
are not scanned.

## Dev server auto-detect in plain sessions (issue #404)

The detection above only ever runs against a project's `kind: "dock"`
sessions, and only ever offers a suggestion for the manual `devServerUrl`
field. If you start a dev server by hand in an ordinary "+ Session"
terminal instead of a dock control, Mullion separately watches that
session's output for the same startup banner and, once it appears, raises
a **"Dev server detected"** notification (bell icon, in the toolbar's
notification panel) offering **"Use this port"** / **"Ignore port"**.

Accepting the offer does **not** spawn a second session or a dock
control — the dev server is already running live in your plain terminal,
and starting a second copy of it (e.g. a `kind: "dock"` session running
the project's dock-control command) would just collide on the port.
Instead, accepting:

1. Patches the project's `devServerUrl` to the detected port.
2. Creates (or reuses) the project's preview, if `PREVIEW_BASE_HOST` is
   configured (see `docs/browser-previews.md`) — a no-op, not an error,
   when it isn't.
3. Opens (or focuses) the project's preview pane.

The plain session itself is left completely alone.

This background scan is throttled (a fixed ~10s sweep, independent of
`sessions.reconcileIntervalSeconds`) and only considers sessions that are
NOT dock sessions and whose project has no `devServerUrl` set yet. For the
life of this Mullion process, each distinct (session, port) pair is only
ever offered once: dismissing an offer, or a dev server restart that
reprints its banner on the SAME port, never re-notifies — only a restart
that lands on a genuinely different port raises a new offer. This dedup
state is in-memory only, though — since sessions themselves survive a
Mullion restart/redeploy (dtach/systemd), a _dismissed_ offer (unlike an
_accepted_ one, which the `devServerUrl` write itself protects) can
reappear after the next restart if the banner is still in scrollback.

The detection regex itself is reused unchanged from the dock-only
detector above, applied here to an otherwise-unconstrained plain session —
so anything that merely prints or pastes a `Local: http://localhost:PORT/`
-shaped line (a README, test output, a chat transcript) can trigger a
dismissible notification. This is bounded: nothing is ever auto-applied,
and worst case is one extra notification to dismiss.

Controlled by **Settings -> Dock -> "Detect dev servers in plain
sessions"** (`dock.autoDetectDevServer`, default `"ask"`). Set it to
`"off"` to disable the background scan entirely. There is deliberately no
`"always"` option that would silently rewrite `devServerUrl` from PTY
output without asking — the inline one-time suggestion in
`CreateProjectModal.tsx` is the only place this repo pre-fills a value
without a human clicking something, and even that never auto-applies it.

## UI reference

| Operation                       | How                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| **Toggle a monitor on/off**     | Click the monitor's header row                                                      |
| **Resize the Dock height**      | Drag the top border handle (`ns-resize` cursor)                                     |
| **Collapse/expand the Dock**    | Click the chevron button (collapsed header shows live monitor count)                |
| **Resize column widths**        | Drag the vertical dividers between columns                                          |
| **Pin a project column**        | Use the "+ Add project column" dropdown in the Dock header                          |
| **Remove a pinned column**      | Click the "x" on a manually pinned column (not shown for workspace-derived columns) |
| **Open GitHub panel**           | Click the GitHub status row in a project's column                                   |
| **Open browser preview**        | Click the browser URL row in a project's column                                     |
| **Check/pull a Docker service** | Click the ⋯ menu on a discovered Docker monitor                                     |

Dock state persists to `localStorage` (collapsed state, region height,
manually pinned project IDs). Column widths from divider drags are
ephemeral and reset on reload.

## Troubleshooting

- **Monitors don't appear.** Check that `.crs/dock.json` is valid JSON
  with a `controls` array. A parse failure is silently reduced to an
  empty list — check the backend logs for a warning.
- **Config changes don't take effect.** A save from the UI editor (see
  [Editing from the UI](#editing-from-the-ui) above) takes effect
  immediately — no wait. A **hand** edit to either `.crs/dock.json` or the
  global `<configDir>/dock.json` doesn't go through that same immediate
  path, so it shows up once every tiled/pinned column's own poll catches up:
  `GET .../dock` every ~15s (issue #73's own Docker-discovery poll, which
  re-fetches the FULL merged list — configured controls included, not just
  discovered ones). Re-navigating to the project still works too, for an
  immediate refresh rather than waiting out the poll.
- **A Docker service doesn't appear.** Confirm its stack's `working_dir`
  (`docker inspect <container> --format
'{{index .Config.Labels "com.docker.compose.project.working_dir"}}'`) is
  the project's own directory or a subdirectory of it, that `dockerServices`
  is on in Settings → Dock, and that `docker` itself is reachable from the
  Mullion process (its own user must be in the `docker` group, or
  equivalent). Discovery is best-effort: `docker` missing or unreachable
  degrades to no Docker monitors at all, never an error.
- **No dev server port detected.** Only local-host projects are scanned.
  The banner must contain `Local:` followed by an `http(s)://localhost`
  URL — some frameworks use different labels or non-standard ports
  without the word "Local".
