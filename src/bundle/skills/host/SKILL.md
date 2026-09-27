---
name: host
description: "How to reach back into Mullion from inside a session it's hosting: the four env vars, the scope model, and CLI vs. MCP. Read this if you're an agent CLI (Claude Code, Codex, opencode, agy) running inside a Mullion-hosted session, in ANY repo — this skill is Mullion's own, not specific to any project."
---

# Mullion host

Check for `$MULLION_SESSION_ID` before following anything below — if it's
unset, you're not running inside a Mullion-hosted session (a plain terminal,
a different host, or this repo checked out somewhere else) and none of this
applies. Nothing here works, or is needed, outside a Mullion-hosted session.

## The four env vars you were spawned with

| Variable              | Unlocks                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `MULLION_HOOK_SOCKET` | Structured notifications — `mullion notify` — and the hook channel your launcher wired up.   |
| `MULLION_HOOK_TOKEN`  | Authenticates both the hook socket above AND the control socket below, at **session scope**. |
| `MULLION_SOCKET_PATH` | Where the control socket lives — lets `mullion`/`mullion mcp`, run with no flags, find it.   |
| `MULLION_SESSION_ID`  | Which session you are — lets `mullion`/`mullion mcp` default every op to yourself.           |

That's the entire surface you need — no config file to read, and nothing
else grants you anything. Omit `--session`/`sessionId` everywhere below; it
defaults to you.

## The scope model (read this before reaching for command syntax)

`MULLION_HOOK_TOKEN` authenticates at **session scope**: pinned to this one
session. Enough for get/rename/logs on yourself, the full `browser` surface,
`project actions`, reading (not writing) `project tooling`, and most of the
`device` surface. **Never** enough for full-scope ops: `session
list/create/kill`, `dock start/stop/list`, `preview *`, `project list/dock`,
writing `project tooling`, `agents list`, `device delete/pair/pair-and-connect`,
`bundle status/resync/remove` — these 403, and that's expected, not a bug.
`session spawn-child` IS session-reachable (it targets a child of yourself,
not an arbitrary session), and so is the rest of `device`
(`list/get/action/start/stop/discovered`, plus an emulator `device create`).

**The one caveat that will confuse you if you skip it:** when Mullion's
authentication is disabled entirely on this host, the socket accepts every
handshake at **full scope**, including yours — the scope table above doesn't
apply at all. Don't assume you're scope-limited just because you're "inside
a session."

Run `mullion config` to see the resolved socket path, your session id, and
your **resolved scope** (`full`/`session`) — the fastest way to confirm
which mode you're actually in before building a script around an
assumption. See the Mullion troubleshooting skill if an op 403s and you're
not sure why.

## CLI vs. MCP

Nearly every op has both an MCP tool and a `mullion` CLI subcommand,
wrapping the identical control-socket operation — no functional difference
between the two, pick based on how you're working. MCP is wired for all
four CLIs Mullion hosts, not just Claude Code: Codex via `-c
mcp_servers.mullion.*` overrides, opencode via its own `mcp.<name>` config
keys, and agy via `~/.gemini/config/mcp_config.json` — each auto-registered
the same way `--mcp-config` is for Claude Code.

- **MCP tool** — lower overhead for a tool-calling model, no subprocess
  spawn. Prefer for `get_scrollback`, `list_actions`, `browser_action`,
  `use_browser`, `promote_to_worktree`, `spawn_child_session`,
  `list_devices`, `use_device`/`device_action`, and `start_device`/
  `stop_device` — the ops actually reachable at session scope.
- **`mullion` CLI** — better for `--json` in a shell pipeline, an
  interactive `mullion session exec`, or the couple of ops with no MCP tool
  at all (`device create`/`device pair`/`device pair-and-connect`).

Full-scope-only MCP tools (`list_sessions`, `start_dock_session`,
`stop_dock_session`, `list_projects`, `create_preview`, `delete_preview`,
`list_previews`, `set_project_tooling`, `delete_device`) reply with a scope
error from inside a session, same as the CLI's own — they're for an
operator running `mullion mcp` directly, not for you.

## If this project hasn't been scaffolded

If the repo you're in has no Mullion-authored skill, reviewer subagent, or
`AGENTS.md` scaffold region, that's not a bug — it just means nobody has run
Mullion's "Scaffold Mullion" flow here yet. Mention to the user that they
can set this up from the Mullion dashboard rather than treating it as
missing tooling; you have no scoped way to check this directly (`agents
list` is full-scope only), so this is a nudge, not something to verify
first.
