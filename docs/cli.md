# `mullion` CLI

The `mullion` command is the primary consumer of the [control socket
API](socket-api.md) — a local-only CLI for listing/creating/attaching to
sessions, driving a session's bound browser (see
[browser-automation.md](browser-automation.md) for the underlying action
set), and tailing notification events, with no HTTP base URL or bearer
token required. Run from inside a Mullion session, it defaults to targeting
that session with zero flags; run from an operator's own shell, it needs
`MULLION_AUTH_TOKEN` (see [Authentication and scope](#authentication-and-scope)
below).

A versioned install links it at `~/.local/bin/mullion` (see
`deploy/install.sh` — it skips the link if that release predates the CLI, and
`~/.local/bin` needs to be on `PATH`), so on an installed host it's just:

```bash
mullion <command> [args] [flags]
```

Running from a checkout (e.g. during development) instead invokes it directly:

```bash
node src/cli/mullion.mjs <command> [args] [flags]
```

## Global flags

| Flag              | Meaning                                                                                                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--json`          | Print the raw op response instead of the command's default rendering.                                                                                                               |
| `--session <id>`  | Target a session explicitly. Omit it when run from inside the session you want to target — it defaults to that session (see [Authentication and scope](#authentication-and-scope)). |
| `--socket <path>` | Override control-socket discovery (`MULLION_SOCKET_PATH`, then `$SESSIONS_DIR/mullion.sock`, then `~/.local/state/mullion/sessions/mullion.sock`).                                  |
| `--quiet`         | Suppress stdout on success (exit code still reflects success/failure).                                                                                                              |

These may appear anywhere in the command line, before or after the command
itself.

## Commands

```
mullion session list|get|create|spawn-child|kill|rename|logs|exec
mullion browser navigate|click|fill|type|press|select|check|uncheck|hover|
                scroll|wait|dialog|get|eval|snapshot|screenshot|find|console|errors|
                download
mullion project list|actions|dock
mullion preview create|get|delete|list
mullion dock start|stop|list
mullion bundle status|resync|remove
mullion events tail
mullion history [--session <id>] [--kind <k>] [--since <ms>] [--until <ms>]
                [--limit <n>] [--cursor <c>]
mullion notify --message "..." [--title "..."]
mullion mcp
mullion helper pair|run|install|uninstall
mullion config
```

Aliases: `ps` → `session list`, `kill` → `session kill`, `logs` → `session logs`,
`exec` → `session exec`.

### session

- `session list [--project <id>] [--kind terminal|dock]`
- `session get [<id>]` — omit `<id>` to inspect the session you're running
  inside (or pass `--session <id>`).
- `session create --project <id> --command <cmd> [--name <n>] [--cwd <path>] [--kind terminal|dock] [--skip-permissions]`
- `session spawn-child --command <cmd> [--parent <id>] [--name <n>] [--cwd <path>] [--kind terminal|dock] [--skip-permissions]` (Phase 5, issue #193 5.3b) — spawns a real child session (own PTY) of `--parent`, or of the session you're running inside when `--parent` is omitted (falls back to `--session`). No `--project` flag: the project is always derived from the parent. Reachable at session scope (`sessions.spawn_child`), unlike `session create` above — see [`socket-api.md`](socket-api.md) for the full validation rules (same project, one level of nesting, cwd containment, a per-parent live-child cap). `--kind`/`--skip-permissions` only take effect for a full-scope caller (`MULLION_AUTH_TOKEN` set); silently ignored at session scope.
- `session kill <id> [--cascade detach|kill]` — `detach` (default) leaves any live children of `<id>` running as independent top-level sessions; `kill` cascades to them too.
- `session rename <id> <name>` — or `session rename <name>` with `--session <id>` supplying the target.
- `session logs <id>` (alias: `logs <id>`) — dumps the session's scrollback buffer (raw bytes, including ANSI escapes) to stdout. One-shot, not a live tail.
- `session exec <command...> --project <id> [--kill-on-exit]` (alias: `exec`) — creates a session, attaches to it, and forwards your terminal's stdin/resize until the remote program exits or you interrupt (Ctrl-C). **Detaches, never kills, on interrupt** — the session keeps running in the background exactly like any other Mullion session; pass `--kill-on-exit` to kill it instead.

### browser

Every [browser-automation](browser-automation.md) action is its own subcommand
(not a `--action` flag), taking the same fields as the underlying
`AgentAction` schema (`src/routes/browser-automation.ts`). Targeting for
actions that operate on a specific element uses `--ref e17` (from a prior
`snapshot`/`find`'s ref table) or `--selector "button.submit"` —
mutually exclusive.

**`--frame <selector>`** (issue #382) scopes a subcommand to an iframe's own
document — `<selector>` targets the iframe's **host element** (e.g.
`--frame "#payment-iframe"`), not anything inside it. Allowed on `click`,
`fill`, `select`, `check`, `uncheck`, `hover`, `get`, `wait`, `scroll`,
`snapshot`, `find`, and `eval`; allowed on `press`/`type` only alongside
`--ref`/`--selector` (their no-target form falls back to a global keyboard
action, which has no per-frame meaning). Rejected client-side (fails fast,
no round trip) on `navigate`, `screenshot`, `dialog`, `console`, `errors`,
`download`, and on `press`/`type` with no target. Nested iframes (an iframe inside an
iframe) aren't supported — `--frame` resolves one selector against the
top-level page only. A ref returned from a `--frame`-scoped `snapshot`/
`find` only resolves against that same frame — pass `--frame` again on the
follow-up action, or the ref lookup won't find it.

All 20 actions (19 `AgentAction` variants plus `find`) are exercised against
a real Playwright page, not just ajv-validated, in
[`test/e2e/browser-actions.e2e.test.ts`](../test/e2e/browser-actions.e2e.test.ts)
(`make test-e2e`, opt-in — see [`test/e2e/README.md`](../test/e2e/README.md)).

| Subcommand                       | Target   | `--frame`?                                      | Extra args                                                                            |
| -------------------------------- | -------- | ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| `navigate <url>`                 | none     | no                                              | `[--wait-until load\|domcontentloaded\|networkidle\|commit]`                          |
| `snapshot`                       | none     | yes                                             | —                                                                                     |
| `click`                          | required | yes                                             | —                                                                                     |
| `fill <value>`                   | required | yes                                             | —                                                                                     |
| `press <value>` / `type <value>` | optional | yes, only with a target                         | with no target, falls back to a global keyboard action (`page.keyboard.press/type`)   |
| `select <value...>`              | required | yes                                             | one value → bare string; 2+ → array (multi-`<select>`)                                |
| `check` / `uncheck` / `hover`    | required | yes                                             | —                                                                                     |
| `get`                            | optional | yes                                             | with no target, returns the whole page's HTML (`page.content()`)                      |
| `wait [<value>]`                 | optional | yes (ignored for a numeric timeout — see below) | `<value>` is a selector-string-or-numeric-timeout; needs at least one of value/target |
| `dialog [accept\|dismiss]`       | none     | no                                              | `[--text <prompt-value>]` — omitting the value clears any pending dialog handling     |
| `scroll [top\|bottom]`           | optional | yes                                             | `[--x <n>] [--y <n>]`                                                                 |
| `eval <script>`                  | none     | yes                                             | —                                                                                     |
| `screenshot`                     | none     | no                                              | `[--out <path>]` (default: stdout)                                                    |
| `console` / `errors`             | none     | no                                              | —                                                                                     |
| `find <value>`                   | none     | yes                                             | `--by text\|role\|label\|placeholder\|testid [--name <n>] [--limit <1-50>]`           |
| `download`                       | none     | no                                              | `[--timeout <ms>] [--contents] [--max-bytes <n>] [--out <path>]` (issue #381)         |

`download` is the only subcommand with a `--timeout`/`timeout_ms` flag —
every other action's server-side schema has no such field. `--timeout`
(default 30000ms, clamped server-side to a max of 120000ms) waits for a
download to arrive if none is already buffered; `--contents` includes the
file as base64 (implied by `--out`); `--max-bytes` caps how large a file
`--contents` will include (default and hard cap 1 MiB — see
`docs/browser-automation.md`'s `download` section for why); `--out <path>`
writes the decoded file to disk, the same way `screenshot`'s `--out` does.

`wait`'s numeric-timeout branch (`page.waitForTimeout`) always runs against
the top-level page regardless of `--frame` — a frame has no independently
meaningful timer. Only `wait`'s selector/locator branches are frame-scoped.

**Output:** by default, every action except `find`/`console`/`errors`/`get`/
`eval`/`screenshot`/`download` renders the response's aria snapshot tree plus a
`ref  role  name` table so a ref is copy-pasteable straight into your next
command. `find` renders its own match table; `download` renders a
filename/size/path line per buffered download. `--json` prints the raw
response for any action. `screenshot` writes the decoded PNG to `--out
<path>` (stdout by default); `download --out <path>` writes the first
(newest) download's decoded `contents` the same way (implicitly requesting
`--contents` if not given explicitly).

**Refs are invalidated by the next `navigate`/`snapshot`/`find` call** — take
a fresh snapshot before reusing one. This is the single most likely footgun
when scripting a multi-step interaction.

Worked example, driving a session's browser from an operator shell (swap
`M`'s assignment for `M="node src/cli/mullion.mjs"` when running from a
source checkout instead of an installed release):

```bash
M="mullion"
S="--session 3"

$M browser navigate http://localhost:5173 $S --wait-until networkidle
$M browser snapshot $S                        # note a ref from the printed table, e.g. e3
$M browser find "Sign in" --by text $S
$M browser click --ref e3 $S
$M browser type --selector "#email" "a@b.c" $S
$M browser select --selector "#plan" pro $S
$M browser screenshot $S --out /tmp/shot.png
```

### project

- `project list` — full scope only.
- `project actions [<id>]` — omit `<id>` to default to your own session's
  project (session scope); full scope must pass it explicitly.
- `project dock <id>` — full scope only; lists this project's dock controls
  (see `mullion dock start` below).
- `project tooling <id> [--briefing <path|->] [--skill <path|->] [--reviewer <path|->]`
  — full scope only. Without any of the write flags, reads the project's
  `project_tooling` row and prints `{briefing, skill, reviewerAgent}`
  (each a string or `null`). Passing any of `--briefing`/`--skill`/`--reviewer`
  upserts that field; the file content is read from the given path, or
  from stdin if `-` is passed (only one flag may read from stdin per
  invocation). Each field is independent. On a partial-failure upsert
  the CLI prints the full reply, including the per-field `ok`/`status`/
  `error` for any field that rejected — this is the one surface that
  exposes the per-field diagnostics (the MCP `set_project_tooling` tool
  collapses them to a generic error). See
  [`docs/project-briefing.md`](project-briefing.md) for what each field
  does and how the resolved values reach spawned sessions.

### preview

- `preview create (--project <id> | --url <url>)` — the two flags are
  mutually exclusive; `--project` mints a preview for a registered project,
  `--url` for an arbitrary external URL.
- `preview get <slug>`
- `preview delete <slug>`
- `preview list` — lists every registered preview on the host (previews are
  host-global, not scoped to a session or project).

### dock

Sessions spawned from a project's dock controls (persistent monitors — dev
servers, log tails — distinct from one-shot launchers).

- `dock list` — sessions with `kind: "dock"`.
- `dock start <projectId> <dockControlId>` — looks up the control via
  `project dock`, then creates a session from its command/cwd.
- `dock stop <sessionId>`

### bundle

Issue #944/#945 — status/troubleshooting for the host-local, boot-time sync
of Mullion's own shipped skill/agent bundle into every detected CLI's global
config root (see [`architecture.md`](architecture.md) and
`src/services/bundle-sync.ts`). Never a precondition for the integration
working — the boot-time sync already runs automatically with no user action.

- `bundle status` — per-CLI sync status (`synced`/`not-synced`/`stale`/`n-a`/
  `disabled`) for skills and agents, plus whether each CLI's binary was
  detected on this host at all.
- `bundle resync` — re-runs the same sync the boot-time hook performs, for
  troubleshooting ("I deleted something, bring it back") or
  immediately-after-upgrade impatience. Returns `409` if
  `sessions.injectMullionBundle` is off.
- `bundle remove` — removes Mullion's bundle content from this host
  entirely (manifest-tracked paths, a legacy sweep for pre-manifest
  installs, and agy's own `mullion` MCP entry) and turns
  `sessions.injectMullionBundle` off so it stays removed **on this host**.
  On the primary that's durable; a remote agent host registered to this
  primary is unaffected and keeps re-syncing on its own boot cycle
  regardless, since `injectMullionBundle` isn't threaded from primary to
  agent hosts the way `injectAgentGuide`/`injectProjectBriefing` are (see
  issue #1089). No confirmation prompt at the CLI layer, same as
  `session kill`/`preview delete` — a confirming UI is the dashboard
  panel's job, not this command's.

### events

- `events tail` — subscribes to the aggregated notification-event stream and
  prints one JSON line per event until interrupted (Ctrl-C).

### history

Issue #213 (roadmap 4.7) — queries **persisted** session-event history (the
`session_events` table), a one-shot query with filters. Distinct from
`events tail` above, which is a live push feed of the in-memory ring buffer
only, not durable storage. Also distinct from `session logs` (alias `logs`)
above, which is unrelated: raw base64 PTY scrollback bytes, not notification
events at all.

- `history [--session <id>] [--kind <k>] [--since <ms>] [--until <ms>] [--limit <n>] [--cursor <c>]`
  — `--session` is the [global flag](#global-flags), not command-specific:
  omit it to query every session (full scope) or your own session (session
  scope, matching `session get`'s own default); full scope may also name any
  other session's id explicitly. `--since`/`--until` are epoch-millisecond
  bounds on the event's own timestamp. `--limit` caps the page size (server
  clamps it regardless). `--cursor` is the `nextCursor` value from a
  previous response's JSON — pass it back to fetch the next, older page.
  Wraps the `events.query` control-socket op (see
  [`docs/socket-api.md`](socket-api.md)).

History persistence itself is opt-in and off by default (Settings ->
event-persistence toggle, `sessions.eventPersistence`) — when it's off, this
command's response is `{"persistenceEnabled":false,"events":[],"nextCursor":null}`
rather than an error, so you can tell "nothing recorded because persistence
is off" apart from "nothing recorded because nothing happened yet." Turning
it on does **not** backfill: only events emitted after that moment are
captured, so a session's existing in-memory scrollback/`events tail` output
predating the toggle won't retroactively appear in `history`.

**Scope note:** persisted-history coverage is **fleet-wide**, not just
sessions this process itself spawned — the event-persistence writer
subscribes to this process's own `app.pty.onEvent()` for local sessions, and
maintains one long-lived `/internal/ws/events` subscription per enrolled
remote host (`src/services/remote-event-subscriber.ts`) independent of any
browser tab being open. See `src/plugins/event-store.ts`'s own doc comment.

### notify

- `notify --message <text> [--title <t>]` (default title: `"mullion"`) —
  writes a notification directly to the **hook** socket
  (`MULLION_HOOK_SOCKET`/`MULLION_HOOK_TOKEN`), bypassing the control socket
  entirely. Only works from inside a session (errors clearly otherwise).
  Deliberately has no `--session <id>`: hook-socket auth pins the connection
  to whichever session's token was presented, so there is no way to notify a
  _different_ session over this channel.

### mcp

- `mullion mcp` — execs `dist/mcp/server.mjs` (`src/mcp/server.mjs` in dev),
  Mullion's stdio MCP server. Equivalent to invoking that file directly.

Tools exposed, beyond `promote_to_worktree`/`use_browser`/`browser_action`
(both hook-socket, see [`docs/agent-hooks.md`](agent-hooks.md)):
`list_sessions`, `start_dock_session`, `stop_dock_session`, `get_scrollback`,
`list_projects`, `list_actions`, `get_project_tooling`, `set_project_tooling`,
`create_preview`, `delete_preview`,
`list_previews` — each a thin wrapper over the matching control-socket op
(`src/mcp/tools.mjs`). The two `*_project_tooling` tools are full-scope only
— they're operator-side, for automating the same per-project row the
Mullion Briefing panel edits in the UI; see
[`docs/project-briefing.md`](project-briefing.md). Note: the
`set_project_tooling` MCP tool surfaces a partial-failure upsert as a
generic tool error — the CLI is the right surface if a caller needs to
see which field rejected (the per-field `ok`/`status`/`error`).

**Scope applies here too.** Claude Code's auto-injected MCP config
(`buildClaudeMcpConfig`) only ever carries the session-scoped
`MULLION_HOOK_TOKEN` as this server's control-socket credential — deliberately,
per [Authentication and scope](#authentication-and-scope) below: writing the
full-scope `MULLION_AUTH_TOKEN` into a per-session config file would let any
agent read its own operator credential straight off disk. So from inside a
normal agent session **when authentication is enabled**, `list_sessions`/
`start_dock_session`/`stop_dock_session`/`list_projects`/`create_preview`/
`delete_preview`/`list_previews`/`get_project_tooling`/`set_project_tooling`
reply with a scope error (same message as the CLI's own,
above) rather than succeeding — they're for a client that sets
`MULLION_AUTH_TOKEN` itself (e.g. `mullion mcp` run directly by an operator).
`get_scrollback` (defaults to the caller's own session) and `list_actions`
(defaults to the caller's own project) are reachable at session scope and
work normally from inside a session regardless. **When authentication is
disabled** (`isAuthEnabled(app.config)` false — the `0600` socket mode is the
only gate in that mode, same posture plain HTTP already takes), every
handshake resolves to full scope, so all of the above are reachable from
inside a session too — this isn't new to these tools, it's the existing
socket-wide posture from `docs/socket-api.md`.

### helper

- `mullion helper pair <payload> [--name <name>] [--insecure]` — redeems a
  pairing payload (generated from Settings → Hosts → SSH agent bridges on
  the primary) and persists the resulting session credential. `--insecure`
  disables TLS certificate verification on the WebSocket connection to the
  primary — intended for self-signed or internal-CA primaries (Caddy/nginx
  dev, Cloudflare origin-pinned, etc.); leave it off against any primary
  you actually trust to issue its own certificates.
- `mullion helper run [--ssh-auth-sock <path>] [--json-events] [--insecure]` —
  long-running; forwards this machine's SSH agent to every enrolled agent
  host via the primary, using the credential `pair` persisted.
  `--ssh-auth-sock` overrides this process's own `SSH_AUTH_SOCK` env var —
  required under a supervisor that doesn't set one (see below).
  `--json-events` additionally writes newline-delimited JSON connection
  events to stdout; see
  [`ssh-agent.md`](ssh-agent.md#structured-events---json-events) for the
  event shapes. `--insecure` has the same meaning as on `pair` above, and
  must match what `pair` was run with against the same primary.
- `mullion helper install [--ssh-auth-sock <path>]` — generates and
  registers a launchd job (macOS), systemd `--user` unit (Linux), or
  Windows Scheduled Task that supervises `run`, so you don't have to
  hand-write one. Re-running it replaces a previous install (new
  `--ssh-auth-sock`, moved checkout, ...). On Windows, this is what the
  [installer](ssh-agent.md#getting-mullion-helper-onto-your-laptop) runs on
  your behalf — see [`ssh-agent.md`](ssh-agent.md#keeping-it-running) for
  what's verified in CI vs. still tracked as manual ([issue
  #871](https://github.com/s3ntin3l8/mullion-session-manager/issues/871)).
- `mullion helper uninstall` — stops and removes whatever `install` set up,
  on whichever of the three supported platforms this is, and forgets the
  local pairing credential too. A no-op, not an error, if nothing is
  installed (a paired-but-never-installed credential is still removed).

The one subcommand meant to run on a machine with **no local Mullion server
and no control socket at all** — a laptop holding the SSH agent that a
Mullion session elsewhere needs to reach. Dispatched before
`MullionSocketClient` is even constructed (same as `mcp` above), so it works
from a bare extracted release tarball with no `.env`, no database, nothing
but Node itself. Full walkthrough, including how to get this file onto a
laptop with no checkout and how to keep `run` alive across reboots:
[`ssh-agent.md`](ssh-agent.md#ssh-agent-bridge).

### config

- `mullion config` — prints the resolved socket path, which env var supplied
  the token (or none), the session id you're running inside (if any —
  `MULLION_SESSION_ID`, omitted when run outside a session), whether the
  socket is reachable, and the resolved scope (`full`/`session`) determined
  by probing a full-scope-only op. Useful for debugging the [scope
  trap](#authentication-and-scope) below.

## Authentication and scope

See [`docs/agent-guide.md`](agent-guide.md) for the same scope model written
for an in-session agent reading it directly (issue #405) — this section is
the authoritative source it points back to.

Every session's own environment carries `MULLION_HOOK_TOKEN` (injected by
`pty-manager.ts`), which authenticates at **session scope**: pinned to that
one session, sufficient for everything a session-scoped agent needs to do to
itself (`session get/rename/logs`, the full `browser` subcommand,
`project actions`, `events tail`, `history` — restricted to its own
session's events). It is never sufficient for **full-scope**
ops — `session list/create/kill`, `project dock`, `preview *`, and
`mcp`-adjacent listing — because `MULLION_AUTH_TOKEN` is deliberately
stripped from every spawned session's environment
(`src/services/session-env.ts`) so a session can never mint itself operator
credentials.

Running a full-scope-only command from inside a session fails with a message
naming which token was used and what to do about it:

```
not permitted for this connection's scope (connected via MULLION_HOOK_TOKEN).
This command needs full scope — set MULLION_AUTH_TOKEN, or run it from
outside a session (session env only ever carries MULLION_HOOK_TOKEN).
```

`mullion config` reports the resolved scope directly rather than making you
find this out by trial and error.
