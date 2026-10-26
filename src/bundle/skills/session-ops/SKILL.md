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
To run the child on a **different machine** — e.g. a Mac for Xcode/iOS work or a
macOS-only spike — pass `host: "<hostId>"` or `platform: "darwin"` (CLI
`--host`/`--platform`) and usually `isolate: true` (`--isolate`): the child
gets its own fresh worktree on that host and should commit and push its
branch for you to fetch. A target is a hard requirement — if no eligible host
has the project you get a 409, not a silent fallback. `session wait`, `children`,
`logs`, `kill`, `prompt_session` (CLI `session prompt`) and `wait_for_output` (CLI
`session wait-output`) work on a remote child, including `prompt_session` with
`wait: true` (the wait polls the child's host about once a second). You can also
send the prompt without `wait`, then `wait_for_output` with its `outputOffset` as
`afterOffset`.
Pass `open: "right"|"below"` (CLI `--open right|below`) to have the dashboard
open the child's panel beside yours, so the human sees it without hunting —
only a hint: dropped if your panel isn't open in their current workspace within about a minute of the spawn.

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

To block until a child _prints_ something (a test summary, a marker you asked
it to emit) use `mullion session wait-output <childId> "<text>"` /
`wait_for_output`. It matches ANSI-stripped output and only counts output
printed from now on — so to catch what a prompt just provoked, pass the
`outputOffset` that `session prompt` / `prompt_session` returned as
`--after-offset` / `afterOffset`. `--regex` / `regex: true` is available but
guarded (no backreferences, lookarounds or nested quantifiers).

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
an ordinary, visible `terminal` session; `kind` is silently ignored from
inside a session even if you pass it (only a full-scope operator can set it
— unless this host has auth disabled entirely, in which case you already
are one; see the Mullion host skill's scope caveat).

`skipPermissions` IS honoured from inside a session, but only as far as your
own session's posture allows: **a child can never be more permissive than
the session that spawned it.** Leave it out and the child inherits your
posture exactly; pass `true` and the child gets it only if you already run
with permissions skipped; pass `false` and the child is narrowed to
prompts-on. So a child of an unattended session is unattended too. If a
child needs to act unattended (edit files, run tests, commit) rather than
wait on a human, pass `skipPermissions: true`. Its panel doesn't auto-open
unless a human turned that on separately — either way it shows in the
sidebar.

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

## Reporting your own status

If your CLI has no Mullion hook adapter (a plain shell script, an unsupported
agent), tell Mullion what you are doing so a parent's `wait_for_session` /
`session wait` and the dashboard can tell:

```bash
mullion status working                         # starting a task (clears a previous "done")
mullion status done --message "tests pass"     # finished (a waiting parent wakes up)
mullion status needs_input --message "approve the deploy?"
```

`--message` is ignored for `working` and cut at 200 chars. `needs_input` also clears an earlier `done`. The MCP equivalent is `report_status {state, message?}`. It writes the same
hook messages a real adapter would (`turn_start`, `progress: done`,
`notification`) to your own hook socket, so it only works from inside a
session. Agents with a hook adapter (Claude Code, Codex, opencode, agy) don't
need this.

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
  A re-review of a **new** commit (after pushing fixes) goes through right
  away — only a repeat request for the same commit is refused by the
  cooldown. If a requested review never appears, `mullion review status` (or
  `review_status`) shows the run's state, the bot's reply, whether its
  review landed and the review's own text; `mullion review stop <runId>` (or
  `stop_review`) cancels a run you started. If the PR is in a **different
  repository** than the session's project (you are also changing a sibling
  repo such as `.github`), run `mullion review` from that checkout — the CLI
  reads the repo and branch from its working directory — or pass `--repo
owner/name` with `--pr` (MCP: `repo` + `pr_number`). The repository must be
  registered as a Mullion project; without it the request is about the
  session's own project's repository.
- `mullion triage --issue <n>` (or the `request_triage` MCP tool) — the same
  relay, pointed at an issue instead of a PR: Hermes triages it and posts
  its findings as a comment on the issue. The issue number is required —
  there is no "current issue" to infer. `mullion triage status --issue <n>`
  (or `triage_status`) shows the run's state and whether the comment
  landed.
- Drive the browser (see the Mullion browser skill) against whatever's
  already listening, dock-managed or started in your own shell.
