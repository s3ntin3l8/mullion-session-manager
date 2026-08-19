# Mullion agent guide

You're reading this from inside a Mullion session — a host PTY, running one
of the AI CLIs Mullion dashboards (Claude Code, Codex, opencode, agy),
attached via `dtach` inside a transient `systemd --user` scope so it survives
a Mullion redeploy. Mullion gives you three ways to reach back into the
system that's hosting you: the [`mullion` CLI](cli.md), an MCP server
(`mullion mcp`, auto-registered for Claude Code sessions), and a hook socket
your launcher already wired up for structured notifications
([`docs/agent-hooks.md`](agent-hooks.md)). This doc is the agent-facing
entry point to all three — read the **scope model** section before you reach
for command syntax, it's the part most likely to surprise you.

<!-- mullion:tier1:start -->

You have four extra environment variables: `MULLION_HOOK_SOCKET` (structured
notifications — `mullion notify`), `MULLION_HOOK_TOKEN` (authenticates both
the hook socket and the control socket, at session scope), `MULLION_SOCKET_PATH`
(control socket location), and `MULLION_SESSION_ID` (which session you are).
That's all of them — no fifth var, no config file.

`MULLION_HOOK_TOKEN` gives you **session scope**: everything you need to act
on yourself (get/rename/logs, the `browser` surface, `project actions`, your
own MCP tools), but full-scope ops (`session list/create/kill`, `dock
start/stop/list`, `preview *`, `project list/dock`, `agents list`) will 403 —
that's expected, not a bug. Run `mullion config` to see your resolved scope.
One exception: if this host has in-app auth disabled entirely, every
connection resolves to full scope regardless.

The rest of this file — the full scope table, CLI vs. MCP, browser
automation, spawning a child session, notifying the human — is below. Read
it before you build anything that assumes more than the above.

<!-- mullion:tier1:end -->

A copy of this exact file lives at
`<the directory $MULLION_HOOK_SOCKET is in>/<your $MULLION_SESSION_ID>.agent-guide.md`
(there's no separate env var naming that directory directly — derive it from
`MULLION_HOOK_SOCKET`, e.g. `dirname "$MULLION_HOOK_SOCKET"`) — every agent
Mullion has a hook adapter for (Claude Code, Codex, opencode, agy) gets this
pulled into context automatically at startup, one way or another (see
[Auto-injection](#auto-injection) below).

This repo also exposes itself as a discoverable project skill named
`mullion-agent-guide` (`.claude/skills/mullion-agent-guide/SKILL.md`, with an
`.agents/skills/mullion-agent-guide` symlink alongside it) — a thin pointer
back to this same file, for a session whose agent CLI does its own project
skill discovery rather than (or in addition to) the SessionStart injection
described below.

## The four env vars you were spawned with

Every session gets exactly these four extra environment variables, injected
by `src/services/pty-manager.ts`'s `Session.bootstrapMaster()` (see
`SERVER_ENV_KEYS` in `src/services/session-env.ts` — they're also scrubbed
from any _nested_ Mullion you might start, e.g. `make dev` run from inside
this very session, so a dev instance never mistakes your session's socket/
token for its own):

| Variable              | Unlocks                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `MULLION_HOOK_SOCKET` | Structured notifications — `mullion notify`, and the hook channel your launcher's adapter already wired up (`docs/agent-hooks.md`). |
| `MULLION_HOOK_TOKEN`  | Authenticates both the hook socket above AND the control socket below, at **session scope** (see next section).                     |
| `MULLION_SOCKET_PATH` | Where the control socket lives — lets `mullion`/`mullion mcp`, run with no flags, find it automatically.                            |
| `MULLION_SESSION_ID`  | Which session you are — lets `mullion`/`mullion mcp`, run with no flags, default every op to yourself.                              |

That's the entire surface. There is no fifth var, and no config file you
need to read to use any of this — omit `--session`/`sessionId` everywhere
below and it defaults to you.

## The scope model (read this first)

`MULLION_HOOK_TOKEN` authenticates a control-socket connection at **session
scope**: pinned to this one session for the connection's lifetime. That's
enough for everything a session needs to do to itself — get/rename/logs,
the full `browser` surface, `project actions`, `events tail`, and your own
MCP tools. It is **never** enough for **full-scope** ops:

| Op                                                 | Scope           |
| -------------------------------------------------- | --------------- |
| `session get/rename/logs/scrollback`, `attach`     | full or session |
| `attach` stream frames — `input`/`resize`/`detach` | full or session |
| `session list/create/kill`                         | **full only**   |
| `session spawn-child` / `spawn_child_session`      | full or session |
| `project actions`                                  | full or session |
| `project list`, `project dock`                     | **full only**   |
| `preview create/get/delete/list`                   | **full only**   |
| `dock start/stop/list`                             | **full only**   |
| `agents list`                                      | **full only**   |
| `browser` (any action), `events tail`              | full or session |

(This mirrors `docs/socket-api.md`'s Ops table exactly — that's the
authoritative source if it and this table ever drift; check there for
anything a later PR added.)

The reason you can't just set `MULLION_AUTH_TOKEN` yourself and escalate:
it's **deliberately never present** in a spawned session's environment
(`session-env.ts`'s scrub). This is the actual security boundary — a session
can read/notify/browse for itself, but can't mint itself operator
credentials, list or kill sibling sessions, or control anything
project-level.

**The one caveat that will confuse you if you skip it:** when Mullion's
authentication is disabled entirely (no `MULLION_AUTH_TOKEN`/OIDC
configured on the host), the socket accepts **every** handshake at **full
scope** — including yours. In that mode the scope table above doesn't apply
at all; the socket's `0600` file permission is the only gate left. Don't
assume you're scope-limited just because you're "inside a session" — check
with `mullion config` (below) if it matters to what you're about to do.

## Checking your own scope

```bash
mullion config
```

prints the resolved socket path, which env var supplied the token, your own
session id, and the **resolved scope** (`full`/`session`) determined by
probing a full-scope-only op — the fastest way to confirm which mode you're
actually in before you build a multi-step script around an assumption.

## CLI vs. MCP — when to use which

Every op below has both an MCP tool and a `mullion` CLI subcommand; they
wrap the exact same control-socket operation (`docs/socket-api.md`), so
there's no functional difference in what either can do. Pick based on how
you're working:

- **MCP tool** — lower overhead for a tool-calling model: no subprocess
  spawn, structured input/output, and it's what's already registered for a
  Claude Code session (`mullion mcp`, auto-wired into `--mcp-config`). Prefer
  this for `get_scrollback`, `list_actions`, `browser_action`, `use_browser`,
  `promote_to_worktree`, and `spawn_child_session` — the ops actually
  reachable at session scope.
- **`mullion` CLI** — better when you need to reason about `--json` output
  directly in a shell pipeline, run something interactively (`mullion
session exec`), or you're not running under an agent with MCP wired up at
  all (Codex/OpenCode/agy today — MCP wiring is a separate concern from the
  startup nudge, see [Auto-injection](#auto-injection)).

**From inside a session, the full-scope-only MCP tools
(`list_sessions`/`start_dock_session`/`stop_dock_session`/`list_projects`/
`create_preview`/`delete_preview`) reply with a scope error, same as the
CLI's own** — they're there for an operator running `mullion mcp` directly
with `MULLION_AUTH_TOKEN` set, not for you. `get_scrollback` (defaults to
your own session) and `list_actions` (defaults to your own project) work
normally at session scope.

## Browser automation

If `BROWSER_ENABLED` is on and your session has a browser pane bound to it,
`mullion browser <action>` (or the MCP `browser_action`/`use_browser` tools)
drives it: `navigate`, `snapshot`, `click`, `fill`, `type`, `press`,
`select`, `check`/`uncheck`, `hover`, `scroll`, `wait`, `dialog`, `get`,
`eval`, `screenshot`, `console`, `errors`, `find`, `download` — see
`docs/cli.md`'s browser table for the full argument shape of each.

**Capturing a file download:** `download` retrieves a file the previewed
app triggers a browser download for (a CSV export, a PDF report, ...) — the
download is captured by a listener installed once at browser-launch time,
so it doesn't matter whether the triggering click already happened before
you think to call `download`; it waits up to `timeout_ms` (default 30s,
capped at 120s) if nothing's buffered yet. Pass `contents: true`
(`--contents`, or implicitly via `--out <path>` on the CLI) to get the
file's bytes back as base64, subject to a 1 MiB `max_bytes` cap — see
`docs/browser-automation.md`'s `download` section for the full semantics
and the multi-host caveat (`path` is host-local; `contents` is the portable
field).

**The ref-invalidation footgun:** a `ref` returned by `snapshot`/`find`/
`click`/etc. is invalidated by the very next `navigate` or `snapshot`/`find`
call. Re-snapshot before reusing a ref — a stale ref from three actions ago
will not silently work, and this is the single most common way a scripted
multi-step interaction breaks. Target by `--selector` instead when you don't
need a fresh snapshot anyway.

`eval` runs arbitrary in-page JavaScript with no additional restriction
beyond what an authenticated caller can already do through the browser
pane — same trust tier as shell access through your own terminal, scoped to
whatever the browser can reach.

**Driving content inside an iframe:** most of the actions above (all except
`navigate`, `screenshot`, `dialog`, `console`, `errors`, `download`) accept a `frame`
field/`--frame` flag — a CSS selector for the iframe's host element — that
scopes the action to that iframe's own document (e.g. a Stripe payment
widget or embedded chat). `press`/`type` only accept it alongside a
`ref`/`selector` target. A ref from a `frame`-scoped `snapshot`/`find` only
resolves inside that same frame; pass `frame` again on the follow-up action
or the lookup won't find it. Nested iframes (an iframe inside another
iframe) aren't supported.

## Dev servers and the dock — the honest, scope-limited version

Dock controls (`dock start/stop/list`, `project dock`, and the MCP
`start_dock_session`/`stop_dock_session` tools) are **full scope only** —
`docs/socket-api.md` calls this deliberate: dock control is an
operator-facing concept, not something a session needs to introspect or
drive about itself. **On an install with authentication enabled, you cannot
start or stop a dev server through the dock from inside a session.** Don't
build a workflow that assumes you can.

What you _can_ do for a dev-server-shaped task, at session scope:

- Read your own scrollback (`mullion session logs`, or the `get_scrollback`
  MCP tool) — including a dev server's own startup banner if you started it
  yourself as a plain foreground/background process in your own shell,
  rather than through a dock control.
- `mullion project actions` — whatever the project's own launcher config
  exposes as a one-shot action, distinct from a persistent dock monitor.
- Drive the browser (above) against whatever's already listening, whether
  that's a dock-managed dev server someone else started or one you started
  yourself in this session's own shell.

If auth is disabled (see the scope caveat above), this limitation doesn't
apply — you're at full scope like everything else in that mode.

## Spawning a child session

Unlike a dock control or `session create`, `spawn_child_session` (MCP) /
`mullion session spawn-child --command <cmd>` (CLI) **is** reachable at
session scope — it spawns a real child session (its own PTY, own terminal)
of the session you're running inside, in the same project. You never need to
name a project or your own session id; both are derived automatically. A
hard cap on how many live children you can have open at once applies
(ask a human to raise `settings.sessions.maxChildSessionsPerParent` in
Settings → Sessions if you hit it); `cwd`, if you override it, must stay
inside the project directory. A spawned child's panel does not open on its
own unless a human has separately turned on "Auto-open child session panels"
(`settings.sessions.autoOpenChildPanels`, Settings → Sessions, default off) —
either way, the child always shows in the sidebar.
This is a genuine child session — it survives if you're later killed
(`sessions.parentSessionId`'s FK detaches it rather than taking it down with
you) — not the same thing as a `Task`-tool subagent, which has no session,
no PTY, and nothing this op could target. From inside a session, `kind` and
`skipPermissions` are silently ignored even if you pass them — a child you
spawn always starts as an ordinary, visible `terminal` session with
permission prompts on. Only a full-scope caller (an operator running
`mullion mcp`/CLI directly with `MULLION_AUTH_TOKEN`) can set either.

## Notifying the human

```bash
mullion notify --message "..." [--title "..."]
```

Writes straight to the hook socket (`MULLION_HOOK_SOCKET`/
`MULLION_HOOK_TOKEN`), bypassing the control socket entirely — surfaces in
the notification bell/desktop-notify, same as a terminal BEL. Only works
from inside a session, and deliberately can't target a _different_ session
(the hook token pins you to your own). Use this to surface progress on a
long-running task rather than relying on the human to be watching your
scrollback live.

## Auto-injection

If `sessions.injectAgentGuide` is on (the default), every agent Mullion has
a hook adapter for gets some form of automatic nudge toward this file at
startup — but not the same mechanism, and not the same content, because
each agent's own hook/config surface is genuinely different (issue #437,
landed per-agent). Only for opencode does reading this exact sentence
without having gone looking for this file yourself mean the mechanism
worked (its injection embeds the whole file, this sentence included, not a
short pointer to it — see below); the other three inject a separate,
shorter pointer sentence, so seeing this file at all doesn't by itself
confirm which path got you here.

- **Claude Code, Codex** — a short pointer sentence (built by
  `buildAgentGuidePointer` in `src/plugins/hooks.ts`, composed fresh on
  every `SessionStart`, alongside a promote-flow seed when one is pending)
  is injected as `hookSpecificOutput.additionalContext` — the identical
  reply shape both agents' own hook I/O schemas use. For Codex, delivery
  also depends on a one-time, interactive `/hooks` trust grant for this
  Mullion-owned hook group; until you (or whoever set up this host) grants
  that, Codex silently skips the hook entirely and behaves exactly as if
  this feature didn't exist.
- **agy** — the same short pointer, but via agy's own protobuf-JSON hook
  reply shape: `{ injectSteps: [{ ephemeralMessage: "<pointer text>" }] }`.
  This dialect is **unverified against a live SessionStart firing** — agy's
  own bundled hook docs omit `SessionStart` from their "Supported Event
  Types" table even though the installed binary's recognized hook-name set
  includes it, carries real call-site symbols for it, and Mullion already
  registers a handler for it unconditionally. If you're agy and never saw
  a pointer message at startup at all, the dialect may need to move to the
  documented `PreInvocation` event instead (see `forwarder-core.mjs`'s
  `agy` case in `formatSessionStartOutput` for the full reasoning).
- **opencode** — materially different in kind, not just dialect: opencode
  has no live hook round trip to reply to at all, so there's no per-event
  pointer sentence. Instead, Mullion points opencode's own `instructions`
  config (`OPENCODE_CONFIG_CONTENT`, additive — never replaces your own
  `instructions`) directly at your on-disk guide copy, so its **full
  content** loads into your context at startup, not a pointer to go read
  it yourself. See `hook-adapters/opencode.ts`'s `prepareLaunch` for the
  full reasoning, including why this can only reflect the
  `injectAgentGuide` setting's value at the moment your session was
  spawned, not live like the other three agents. A promote-flow seed no
  longer rides this channel, though: it's delivered as `--prompt <text>`
  argv instead — a real submitted first turn, not more static context —
  since opencode gained `initialPromptArgs`; see that field's own comment.
  For an opencode promote, Mullion goes further: it first attempts to
  carry your **full conversation history** over via `opencode
export`/`import` (local host only), resuming the new session with
  `--session <id>` — in which case no auto-submitted first turn is
  delivered (a resume can't take one), and the resumed session shows the
  whole transcript, waiting for your next message. A caller-supplied seed
  still rides the static `instructions` channel alongside that transcript
  either way (a `--prompt` argv turn is only used when a transfer isn't
  attempted or fails). See `docs/agent-hooks.md`'s opencode section.

If you're on an agent without a hook adapter, or the nudge didn't reach you
for one of the reasons above, you got here some other way (or you're
reading the on-disk copy directly) — you still have the full MCP tool
surface and hook channel described above, there's just no automatic nudge
pointing at this file.

## If something 403s

You named a full-scope-only op, or a session id you're not pinned to. This
is expected, not a bug — see the [scope model](#the-scope-model-read-this-first)
table above for exactly which ops are session-reachable, and `mullion
config` to confirm which scope your connection actually resolved to. If
you're certain this should have worked, check whether authentication is
disabled on this host (the caveat in that same section) — the scope model
doesn't apply there at all.
