---
name: session-ops
description: "Spawning a child session, notifying the human, and what you can and can't do with a dev server/dock from inside a Mullion-hosted session. Read this if you're an agent CLI running inside a Mullion-hosted session and need to fan out work, surface progress, or check on a dev server, in ANY repo."
---

# Mullion session ops

Check for `$MULLION_SESSION_ID` before following anything below — if it's
unset, you're not inside a Mullion-hosted session and none of this applies.

## Spawning a child session

`spawn_child_session` (MCP) / `mullion session spawn-child --command <cmd>`
(CLI) is reachable at session scope — it spawns a real child session (its
own PTY, own terminal) of the session you're running inside, in the same
project. You never need to name a project or your own session id; both are
derived automatically. A hard cap on live children applies (ask a human to
raise `settings.sessions.maxChildSessionsPerParent` if you hit it); `cwd`,
if overridden, must stay inside the project directory.

This is a genuine child session — it survives if you're later killed, not a
`Task`-tool subagent (no session, no PTY). A spawned child always starts as
an ordinary, visible `terminal` session with permission prompts on; `kind`
and `skipPermissions` are silently ignored from inside a session even if
you pass them (only a full-scope operator can set either). Its panel
doesn't auto-open unless a human turned that on separately — either way it
shows in the sidebar.

## Notifying the human

```bash
mullion notify --message "..." [--title "..."]
```

Writes straight to the hook socket, bypassing the control socket entirely —
surfaces in the notification bell/desktop-notify, same as a terminal BEL.
Only works from inside a session, and can't target a different one. Use
this to surface progress on a long-running task rather than relying on the
human watching your scrollback live.

## Dev servers and the dock — the honest, scope-limited version

Dock controls (`dock start/stop/list`, `project dock`, and the MCP
`start_dock_session`/`stop_dock_session` tools) are **full scope only**:
dock control is operator-facing, not something a session can drive about
itself. On a host with authentication enabled, you cannot start or stop a
dev server through the dock from inside a session — don't build a workflow
that assumes you can. (If auth is disabled on this host, this limitation
doesn't apply — see the Mullion host skill's scope caveat.)

What you _can_ do for a dev-server-shaped task, at session scope:

- Read your own scrollback (`mullion session logs`, or `get_scrollback`) —
  including a dev server's startup banner, if you started it yourself as a
  plain foreground/background process in your own shell.
- `mullion project actions` — whatever the project's own launcher config
  exposes as a one-shot action, distinct from a persistent dock monitor.
- Drive the browser (see the Mullion browser skill) against whatever's
  already listening, dock-managed or started in your own shell.
