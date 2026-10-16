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
if overridden, must stay inside the project directory or be another registered
git worktree of the project's repo (`git worktree list`, e.g. a sibling
`repo-pr408` checkout); any other outside path is rejected.

Once spawned, you can supervise your children without full scope:
`mullion session children` / `list_child_sessions` shows each child's derived
status (`working`, `finished`, `awaiting_permission`, `exited`, ...);
`mullion session logs <childId>` / `get_scrollback` (with `sessionId`) reads
its output; `mullion session kill <childId>` / `kill_child_session` stops it.

To block until a child needs you — instead of polling — use
`mullion session wait <childId>` / `wait_for_session`: it returns when the
child finishes its turn, asks for permission/a plan decision/an answer, errors,
or exits (or on timeout, `timedOut: true` — just call it again). Pass the
previous result's `eventSeq` as `--after-seq`/`afterSeq` to ignore a status
you've already seen.

To give a running child a follow-up, use `mullion session prompt <childId>
"<text>" --wait` / `prompt_session` (`wait: true`): it types the prompt into the
child's terminal, submits it, and waits for the turn to end. It works for
Claude Code, Codex and opencode children. It is refused with `409
agent_blocked` while the child is stuck on a permission/plan/question dialog
(typing would answer it — resolve that first, e.g. by telling the human), `409
agent_busy` if you ask to `wait` while the child is mid-turn (prompt without
`wait` to queue the message, or `wait_for_session` with `until: ["done",
"dormant"]` first — a child with background tasks stays busy), and `501` for a
shell child. A prompt you send does
not clear the child's attention badge for the human.

Only your own children are reachable — a sibling or unrelated session is `403`.

This is a genuine child session — it survives if you're later killed, not a
`Task`-tool subagent (no session, no PTY). A spawned child always starts as
an ordinary, visible `terminal` session with permission prompts on; `kind`
and `skipPermissions` are silently ignored from inside a session even if
you pass them (only a full-scope operator can set either — unless this host
has auth disabled entirely, in which case you already are one; see the
Mullion host skill's scope caveat). If a child needs to act unattended
(edit files, run tests, commit) rather than wait on a human, it needs
`skipPermissions: true` to actually take effect. Its panel doesn't
auto-open unless a human turned that on separately — either way it shows
in the sidebar.

**Don't bake prompt text into `command`.** Use `initialPrompt` (MCP) /
`--initial-prompt` (CLI) instead — it's delivered via the target CLI's own
first-turn flag (Claude Code/Codex: `-- <prompt>`; agy: `-i=<prompt>`;
opencode: `--prompt <prompt>`), which actually submits a turn instead of
sitting unread. This matters most for **opencode**: its bare positional is
`[project]`, a start directory, not a prompt — `opencode "do the thing"`
silently tries to `cd` into a directory named that and exits immediately.
Keep `command` a bare invocation; only takes effect when it matches a known
agent CLI — check the result's `initialPromptApplied` field (or a
`warnings` entry) rather than assuming delivery.

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
- `mullion review` (or the `request_review` MCP tool) — ask the Mullion
  server to relay an automated Hermes review of your PR. It posts to the PR
  within a few minutes; wait for it instead of requesting again. Only works
  once an operator has configured the review relay in Mullion's Settings.
- Drive the browser (see the Mullion browser skill) against whatever's
  already listening, dock-managed or started in your own shell.
