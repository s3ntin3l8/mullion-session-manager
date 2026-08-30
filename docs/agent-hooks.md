# Agent hook socket

Mullion's Phase 1 notifications are inferred from raw terminal bytes (BEL,
OSC sequences, title changes) — a channel every agent gets automatically,
with zero integration work. Phase 2 adds a second, **structured** channel on
top of that, for agents that want to report richer, machine-readable events
(file changes, review-gate requests, progress) than terminal escape sequences
can carry.

An agent that never uses this channel is completely unaffected: the socket
exists (like the per-session dtach sockets already do) but nothing connects
to it, and every existing PTY-parsed notification keeps working exactly as
before.

## What's injected

Every session's shell gets several extra environment variables at spawn
time, alongside whatever its launcher command already sets. The two this
doc is about:

| Variable              | Meaning                                                                        |
| --------------------- | ------------------------------------------------------------------------------ |
| `MULLION_HOOK_SOCKET` | Absolute path to a Unix domain socket, shared by every session on this host.   |
| `MULLION_HOOK_TOKEN`  | A per-session secret, unique to this one session, used in the handshake below. |

(`MULLION_SOCKET_PATH`/`MULLION_SESSION_ID` — the control-socket path and
this session's id — are injected the same way but belong to the `mullion`
CLI/MCP surface, not this hook channel; see `docs/agent-guide.md`.)

All are stripped from a session's env if that session itself starts a
nested Mullion (e.g. running `make dev` from inside a Mullion-managed
terminal) — the same env-leak protection `session-env.ts`'s
`SERVER_ENV_KEYS` already applies to every other Mullion-owned config value
(issue #70).

### How a hook command finds the forwarder

`forwarder.mjs` is the actual per-agent JSON shim that speaks this socket's
wire protocol (below) — but the command Mullion registers in agy's and
Codex's own hook configs never invokes it directly. Both `~/.gemini/config/
hooks.json` and `~/.codex/hooks.json` are **host-global, persistent** files
shared by every Mullion instance on the host (a production install and any
number of `.wt/<slug>` dev worktrees running `make dev`), so the command
string those files carry can never embed a checkout-specific, possibly
worktree-relative path to `forwarder.mjs` — the moment such a worktree is
removed, that path would dangle, and agy treats a non-zero PreToolUse exit
as a hard tool-call abort, breaking `run_command` for every agy session on
the host, not just this repo's.

Instead, both configs invoke a small, dependency-free POSIX `sh` script —
`src/hooks/forwarder-shim.sh`, installed at a fixed, host-stable, per-user
location (`~/.mullion/hooks/mullion-forwarder-shim.sh`, see
`src/services/hook-adapters/forwarder-shim.ts`) that is identical no matter
which Mullion instance last wrote it. At run time the shim resolves the
REAL, per-session forwarder from two more injected env vars:

| Variable                 | Meaning                                          |
| ------------------------ | ------------------------------------------------ |
| `MULLION_FORWARDER_PATH` | Absolute path to THIS session's `forwarder.mjs`. |
| `MULLION_FORWARDER_NODE` | Absolute path to the node binary to run it with. |

so a dev instance and the production install can run agy/Codex sessions
concurrently without clobbering each other's hook config, and a removed
worktree can never dangle it again.

Three layers of fail-open protect every hook invocation, so a missing
forwarder degrades to a silent no-op rather than a failed tool call:

1. `forwarder.mjs` itself — no `MULLION_HOOK_SOCKET`/`_TOKEN`, an unmapped
   payload, or a gate timeout all fall through to printing the correct JSON
   and exiting 0 (see "Wire protocol" below).
2. The shim — `MULLION_FORWARDER_PATH` unset, pointing at a removed
   worktree, or `MULLION_FORWARDER_NODE` missing all print the same
   fail-open JSON and exit 0.
3. The hook command string itself — a `|| printf '<fallback>'` guard covers
   the shim file being missing/not executable, the one case the shim can't
   cover for itself.

## Wire protocol

Connect to `$MULLION_HOOK_SOCKET` and write newline-delimited JSON, UTF-8
encoded. The **first line** on every connection must be a handshake
identifying which session you're speaking for:

```json
{ "token": "<the value of $MULLION_HOOK_TOKEN>" }
```

An unknown, forged, or malformed token closes the connection immediately —
there is no error reply for a failed handshake, only a closed socket. A
successful handshake attributes every subsequent line on that connection to
this session; you don't need to repeat the token.

Every message after the handshake is validated JSON, one object per line,
against a `kind`-discriminated shape. This table (rewritten against the
current code — issue: extend surfaced session statuses; the previous
revision predated PRs #300/#301 and had drifted to list only 5 of the 22
kinds the parser now recognizes) is grouped by when each kind was added:

| `kind`                  | Fields                                                                                                                                                 | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `notification`          | `title: string`, `body: string`                                                                                                                        | Surfaces in the notification bell/desktop-notify, same as a BEL.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `progress`              | `phase: "thinking" \| "generating" \| "done"`, `lastAssistantMessage?`, `backgroundTasks?`, `detail?`                                                  | Drives the sidebar status line; `done` is the authoritative "turn over" signal — see `backgroundTasks` below for why it doesn't unconditionally mean "idle now," and "Settle window" below for why its `agentIdle` attention ping doesn't fire immediately either.                                                                                                                                                                                                                                                 |
| `file_change`           | `path: string`, `action: "modify" \| "create" \| "delete"`, `agentId?`, `agentType?`                                                                   | A file the agent touched (issue #177's sidebar strip). `agentId`/`agentType` (Phase 5, Track A) are present when the change happened inside a subagent.                                                                                                                                                                                                                                                                                                                                                            |
| `review_gate`           | agent sends `state: "waiting"`, `prompt: string`, `gateId?: string`; Mullion resolves it with `state: "waiting" \| "approved" \| "denied" \| "lapsed"` | A pending decision (issue #178's review gate — see below). `gateId` (issue: correlate concurrent permission gates) is forwarder-generated per blocked hook process, letting more than one gate be held per session at once — optional on the wire; a payload with none gets a server-synthesized fallback id. `"lapsed"` (issue #840/#844) is server-generated only — no agent ever sends it — meaning nobody ever answered, so the agent fell through to its own native prompt; distinct from a human `"denied"`. |
| `promote_request`       | `summary: string`, `suggestedBaseRef?`                                                                                                                 | Issue #271 — a model-invoked "start work in a worktree" request.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `session_start`         | `source?: string`                                                                                                                                      | Issue #271 — answered inline with a stashed seed prompt, if any.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `notification_resolved` | —                                                                                                                                                      | Follow-up to #275 — a confirmed `notification` was resolved with no keystroke (an auto-approved permission).                                                                                                                                                                                                                                                                                                                                                                                                       |
| `git_branch`            | `branch: string`, `worktree?: string`                                                                                                                  | Sidebar worktree detection — a `git worktree add`/checkout the agent ran.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `cwd_changed`           | `cwd: string`                                                                                                                                          | Sidebar worktree detection — the agent's shell changed directory.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `permission_request`    | `tool: string`, `summary: string`                                                                                                                      | PR #300 — a tool-permission dialog is blocking the agent. Both this event and its attention ping now settle before notifying — see below.                                                                                                                                                                                                                                                                                                                                                                          |
| `stop_failure`          | `error: string`, `errorDetails?`, `errorType?`                                                                                                         | PR #300 — the turn ended on an API error (rate_limit, overloaded, ...). This event is still emitted immediately; only its attention ping settles — see below.                                                                                                                                                                                                                                                                                                                                                      |
| `tool_failure`          | `tool: string`, `error: string`, `summary?`, `agentId?`, `agentType?`                                                                                  | PR #300 — a tool call itself failed. `agentId`/`agentType` (Phase 5, Track A) are present when the failure happened inside a subagent. This event is still emitted immediately; only its attention ping settles — see below.                                                                                                                                                                                                                                                                                       |
| `session_end`           | `reason: string`, `exitCode?: number`                                                                                                                  | PR #300 — the session terminated, with why (and, when available, its exit code).                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `plan_ready`            | `plan: string`, `filePath?`, `summary?`                                                                                                                | PR #300 — Claude Code's `ExitPlanMode` produced a plan awaiting review.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `turn_start`            | —                                                                                                                                                      | Issue: extend surfaced session statuses — a deterministic "a new turn just started" signal (Claude Code/Codex `UserPromptSubmit`); releases every pending `awaiting_*` status.                                                                                                                                                                                                                                                                                                                                     |
| `compact`               | `state: "started" \| "finished"`, `trigger?: "manual" \| "auto"`                                                                                       | Claude Code's `PreCompact`/`PostCompact` — context compaction in progress.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `subagent`              | `state: "started" \| "finished"`, `agentType?`, `agentId?`, `summary?`, `backgroundTasks?`                                                             | Claude Code's `SubagentStart`/`SubagentStop` — tracked as a running count, not a boolean. `agentId` (Phase 5, Track A) correlates a started/finished pair; `summary` is `SubagentStop`'s `last_assistant_message`. `backgroundTasks` (issue #428) rides on `SubagentStop` too — see below.                                                                                                                                                                                                                         |
| `elicitation`           | `state: "started" \| "finished"`, `server?`                                                                                                            | Claude Code's `Elicitation`/`ElicitationResult` — an MCP server is asking the human a question.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `permission_resolved`   | —                                                                                                                                                      | Claude Code's `PermissionDenied` — a possible extra release for a pending `permission_request`, never the only one.                                                                                                                                                                                                                                                                                                                                                                                                |
| `plan_resolved`         | —                                                                                                                                                      | Reserved for an agent with a direct "plan decision made" signal; no current adapter sends it (Claude Code's `progress: done`/`turn_start` already release a pending plan).                                                                                                                                                                                                                                                                                                                                         |
| `agent_session`         | `sessionId: string`                                                                                                                                    | PR #696 — opencode only: the live opencode internal session id, re-reported on every `session.idle`, so a later promote can export/import the full conversation history into the new worktree session.                                                                                                                                                                                                                                                                                                             |

A `kind` this list hasn't been taught yet is accepted and stored verbatim
rather than rejected — this is what lets a newer hook author add a message
kind an older Mullion doesn't recognize without breaking the connection. A
malformed message (missing/wrong-typed fields for a _recognized_ kind, or
invalid JSON) gets a `{"error": "..."}` reply on the same connection, which
stays open — only a failed handshake or an oversized/unterminated line
closes it. See `src/services/hook-protocol.ts` for the authoritative parser.

### Settle window before notifying (making notifications relevant/scannable)

Four attention signals no longer notify the instant their triggering hook
message arrives: `permissionRequest` (2s), `toolFailure`/`apiError` (2s
each), and `agentIdle` (3s) — see `src/services/attention-tracker.ts`'s
`ATTENTION_SETTLE_MS`. This is deliberately a separate mechanism from
`attention-detect.ts`'s existing `ATTENTION_CONFIRM_MS` debounce (which
stays at 0 for all four and is otherwise unchanged) — that debounce answers
"is this raw byte noise?", this settle window answers "did a human ever
actually need to see this?" Measured against 7 days of real
`session_events`: 537 of 538 `permission_request`s were auto-approved by the
agent's own trust config in a mean of 26ms (mostly opencode's
`external_directory` glob prompts), 140 of 140 tool/API failures recovered
on the agent's own very next output chunk, and 465 of 517 `agentIdle`
"turn finished" pings were flaps where a background `Agent`/`Task` call
reopened the same turn within a few seconds.

Each of the four is cancelled — meaning nothing is ever emitted at all, not
even to the timeline — by a specific resolution, not a generic timeout:

- `permissionRequest` — a `permission_resolved` message, a `tool_done`
  matching the pending tool, or `progress: done`'s own unconditional latch
  clears (all already release a confirmed `permissionRequest`; they now also
  cancel a merely-pending one).
- `toolFailure`/`apiError` — the agent's own next real PTY output chunk (NOT
  a hook message — the state machine treats byte-level output as the
  resolution for these two specifically, unlike the other three).
- `agentIdle` — a `progress` message reporting any phase other than `"done"`
  (i.e. the agent resumed generating before the turn-complete ping fired).

All four are also cancelled by `turn_start` or a genuine keystroke, same as
an already-confirmed flag would be. If a hook author is testing against
Mullion, expect these four notifications to lag their triggering message by
up to the windows above when nothing intervenes, and to sometimes not appear
at all when something does — that's the fix working as intended, not a
delivery bug.

### `backgroundTasks` and the `background` status (issue #428)

Claude Code's `Stop` and `SubagentStop` hooks both carry an optional
`background_tasks` array (`{id, type, status, description, command?,
agent_type?, server?, tool?, name?}`) — outstanding background Bash jobs,
MCP-backed tasks, or `Agent`/`Task` calls launched with `run_in_background`.
Its presence is what lets Mullion tell "the turn ended, and everything it
started is done" apart from "the turn ended, but a background `Agent` call
from this same turn hasn't returned yet."

`Stop`'s `phase: "done"` still unconditionally latches `lastTurnEndedAt`
(`src/services/pty-manager.ts`'s `emitHookEvent`) — that stays an honest "the
hook fired" signal. What's gated is the `agentIdle` attention ping: it's
suppressed while `backgroundTasks` reports anything non-terminal
(`src/services/background-tasks.ts`'s `isBackgroundTaskOutstanding` — a
missing or unrecognized `status` counts as outstanding, by design), and fires
_late_ once the list drains rather than never. The drain signal in practice
is almost always `SubagentStop`, not a further `progress` message: the
parent's turn has already ended by the time a background subagent finishes,
so `SubagentStop`'s own `backgroundTasks` field (forwarded by
`mapClaudeCodeSubagentStop` in `src/hooks/forwarder-core.mjs`) is the only
place that drain is ever reported.

`session-status.ts`'s `deriveSessionStatus` reads the same filtered list
(`SessionInfo.outstandingBackgroundTasks`, computed once in `toInfo()`) to
gate `finished` and, when something is still outstanding once every
higher-precedence status has been checked, to report the `background` status
instead — outranked by `subagent` (a Task-tool subagent already has a more
specific status of its own), but above plain `working`/`idle`. Sidebar Row 6
renders each outstanding task as a chip, gated the same `hookEmits`-reachable
way Row 5's subagent chips are.

`Stop`/`SubagentStop` also carry a `session_crons` field (scheduled prompts
active in the session) that Mullion does not currently read or forward.

### Agent-attribution envelope (Phase 5, Track A)

`file_change`, `tool_failure`, and `subagent` may additionally carry
`agentId`/`agentType` — present when the underlying hook fired **inside a
subagent** rather than the main agent. Claude Code's own hook payloads carry
`agent_id`/`agent_type` on every hook fired during a `SubagentStart`/
`SubagentStop`-bracketed tool call (verified empirically against a live
subagent invocation, not just Claude Code's own docs); a main-agent-caused
hook never carries them. Codex's own embedded hook I/O schemas confirm the
same pair on `PostToolUse`/`SubagentStart`/`SubagentStop` (required on the
latter two, optional — present only inside a subagent — on `PostToolUse`),
so this applies to Codex too. The forwarder (`src/hooks/forwarder-core.mjs`)
stamps these onto every attributable message from the payload's common
fields in one place (`applyAgentEnvelope`, called from both
`mapClaudeCodeEvent` and `mapCodexEvent`), rather than in each individual
mapper. This is what lets Mullion attribute a file change or tool failure to
the subagent that actually caused it, instead of just the parent session —
see the subagent registry design in `docs/roadmap.md`'s Phase 5 section.

## Auto-injected agents

For a recognized agent, Mullion wires the hook connection up for you — no
manual configuration needed. The spawn seam (`Session.bootstrapMaster()`)
checks the launch command against a small registry of per-agent adapters
(`src/services/hook-adapters/`) and, on a match, augments **this launch
only**: it never edits the agent's own real config, and a session whose
command doesn't match any known agent launches completely unchanged.

**Claude Code** is the first adapter. When the launch command is a simple,
unchained `claude ...` invocation (no `&&`/`|`/`;`/redirection — those are
left untouched, since rewriting one piece of a chained command could attach
a flag to the wrong part of it), Mullion:

1. Writes an ephemeral `<sessionId>.hooks.json` under the sessions directory
   (never `~/.claude` or the repo) registering hooks — each one invokes a
   small shared forwarder script (`src/hooks/forwarder.mjs`) that maps the
   hook's own JSON to the wire protocol above and writes it to
   `$MULLION_HOOK_SOCKET`. Every hook below is always registered
   unconditionally — there is no longer a flag gating any of them (see the
   review-gate section below for why the one that used to be conditional,
   `PreToolUse` on `Bash`, was removed rather than kept opt-in).
2. Appends `--settings <that file>` to the command actually spawned.
3. Writes a second ephemeral file, `<sessionId>.mcp.json`, registering
   Mullion's own MCP server (`src/mcp/server.mjs`) as `mullion`, and appends
   `--mcp-config <that file>` alongside `--settings` above
   (`hook-adapters/claude-code.ts`'s `buildClaudeMcpConfig`). This is what
   makes the `mcp__mullion__*` tools (session/project/preview control, see
   `src/mcp/tools.mjs`) available inside the session — unconditional, not
   gated on any setting, since it's core Mullion functionality rather than an
   optional nudge. The config file carries only the session-scoped hook
   token, never the operator's own credential, so those tools stay
   session-scoped for an in-session agent (full-scope-only ops correctly
   403).

As of this writing (issue #264 rescope — rewritten here since the previous
revision described a conditionally-registered `PreToolUse`/`Bash` gate that
no longer exists), the full set is: `Notification`, `Stop`, `SessionStart`,
`CwdChanged`, `PostToolUse` (matchers `Write|Edit|MultiEdit|NotebookEdit` and
`Bash`), `PermissionRequest`, `StopFailure`, `PostToolUseFailure`,
`SessionEnd`, `PreToolUse` on `ExitPlanMode` (observational — maps to
`plan_ready`), `UserPromptSubmit`, `PreCompact`/`PostCompact`,
`SubagentStart`/`SubagentStop`, `PermissionDenied`, and
`Elicitation`/`ElicitationResult`. See `hook-adapters/claude-code.ts`'s
`buildClaudeHookSettings` for the authoritative, always-current list, and
its exported `CLAUDE_CODE_EMITS` for exactly which wire-protocol `kind`s this
adapter can produce (also surfaced to the frontend via `GET /api/agents`, so
the UI never offers a status legend entry an agent can't reach).

`PermissionRequest` is the one **blocking** hook — see "The review gate"
below for why it replaced the old `PreToolUse`/`Bash` gate, and why that
means it's safe to register unconditionally rather than behind a flag.
Every other hook above is fire-and-forget (never blocks the tool call).

**The `--bare` caveat:** Claude Code's `--bare` flag ("Minimal mode: skip
hooks, LSP, plugin credentials") disables every integration described above.
If a user-authored launcher command includes `--bare` — e.g.
`claude --bare --dangerously-skip-permissions` — Mullion's hooks and
plugin-dir bundle are silently ignored: no notifications, no review gate,
no tooling bundle. MCP config (`--mcp-config`) is also likely dropped
under `--bare`, though this is an external-CLI behavior not yet confirmed
empirically. The `commandTransform` function appends
`--settings`/`--mcp-config`/`--plugin-dir` to the end of the command, but
`--bare` causes Claude to discard them before they take effect. Avoid
`--bare` in launcher commands unless you deliberately want a stripped-down
session with no Mullion integration.

**OpenCode** has no shell-command hooks at all — only a JS/TS plugin API,
auto-discovered from a `plugins/` directory it scans (never referenced by
argv or by its config file's own `plugin` array, which only accepts npm
package names). When the launch command is a simple `opencode ...`
invocation, Mullion:

1. Writes the shared plugin file (`src/hooks/opencode-plugin.js`) into an
   ephemeral, per-session `<sessionId>.opencode-config/plugins/` directory
   under the sessions directory.
2. Sets `OPENCODE_CONFIG_DIR` to that directory — confirmed against the
   installed OpenCode CLI to load **additively** alongside the user's real
   global/project config, not in place of it, so this never disturbs an
   existing `opencode.json` or its other plugins.

**The agent-guide auto-inject nudge** (issue #437c) rides the same
additive-env-var posture, via a second variable: `OPENCODE_CONFIG_CONTENT`,
a runtime override near the top of OpenCode's own documented
config-precedence chain, set to `{"instructions": ["<path to this
session's own copy of docs/agent-guide.md>"]}`. Verified empirically this
PR (`opencode debug config`, no live session or model call needed, so no
"unverified — would need a paid model turn" caveat here unlike agy's
`SessionStart`, or Codex's `apply_patch` extractor before issue #846's live
verification) that OpenCode's
`instructions` array **concatenates** with whatever the user's own
project/global `instructions` already contains, including when combined
with `OPENCODE_CONFIG_DIR` above — never replaces them. Also verified this
merge is per-key, not a whole-layer shadow: unrelated top-level keys
(`model`, `small_model`) in a project's own config survive fully intact
when `OPENCODE_CONFIG_CONTENT` sets only `instructions`. This is a
materially different mechanism from every other agent's SessionStart
pointer, not just a different dialect: OpenCode has no live hook round
trip to reply to at all, so there is no per-event pointer sentence, and
this static `instructions` channel alone still can't compose a live
per-event reply — Mullion can only point OpenCode's static startup config
at the guide file itself, so OpenCode's context gets the guide's **full
content**, loaded once at startup, not a short "here's where to find it"
nudge.

As of the promote-flow first-turn fix, the promote-flow seed (issue
#271/#678) no longer rides this `instructions` channel at all: it's sent
as `--prompt <text>` argv instead, via `initialPromptArgs`, verified
against the installed CLI to actually submit a turn rather than just add
context — see `hook-adapters/opencode.ts`'s own comment.

**MCP** (issue #881): the same `OPENCODE_CONFIG_CONTENT` payload also
carries an `mcp.mullion` entry, registering Mullion's own MCP server
(`src/mcp/server.mjs`) so the `mcp__mullion__*` tools are available inside
an OpenCode session too — unconditional, like Claude Code's `--mcp-config`
above, not gated on any setting. The shape differs from Claude Code's
`mcpServers.<name>` in two ways confirmed empirically against the installed
OpenCode CLI (never against a user's real config): `command` is a single
array **including** the executable (Claude Code splits `command`/`args`),
and the env key is `environment`, not `env`. Verified two ways: config
resolution via `opencode debug config`, and — the stronger check — a real
`opencode mcp list` against a stdio probe server, which reported
`mullion  connected`, confirming the server is actually spawned and
initialized rather than merely present in resolved config. Same
additive-merge and session-scoped-token-only posture as everything else on
this channel — see `hook-adapters/opencode.ts`'s `buildOpenCodeMcpConfig`.

That's only the no-transfer path, though. As of the full-context
carryover (PR #696), an opencode promote goes further when it can: for a
**local** opencode session whose live opencode session id is known (the
`agent_session` hook, above), Mullion first attempts to carry the **full
conversation history** into the new worktree session via `opencode
export`/`import` — the importer re-keys the imported session to the
_current_ instance's project/directory, precisely the thing a `--fork`
resume gets wrong — and then launches the promoted session with
`--session <id>`. **No `--prompt` is sent on a resume**: verified against
the bare-TUI command form Mullion actually spawns, opencode silently
accepts but never auto-submits `--prompt` when combined with
`--session`/`--continue` (the same failure shape as the `--fork`
directory bug below), so a synthesized continuation nudge would just be
dropped. Instead the transfer surfaces a `warnings[]` note: the full
history carried over and the session is picking up where it left off,
waiting for your next message — the imported transcript is already
visible the moment it opens.

**Why not `--fork`:** a `--session <id> --fork` resume was investigated
and dropped — opencode's `--fork` pins the forked session's `directory`
to the _original_ session's stored directory even with an explicit
`--dir` pointing at the worktree, and a live tool call inside the forked
session actually ran with the wrong `cwd` (back in the main checkout,
defeating worktree isolation). `export`/`import` was chosen instead
because the importer re-keys to the current project/directory.

The transfer is a capability probe, never a promote-blocking dependency:
`opencode-session-transfer.ts` resolves `{ transferred: false, reason }`
on every failure mode rather than throwing, and the promote handler falls
through to the ordinary seed path unchanged — an argv `--prompt` first
turn when a seed was supplied, else a cold start — each with its own
`warnings[]` entry. **Local host only:** `session-backend.ts`'s
`RemoteBackend.spawn()` deliberately drops `resumeAgentSessionId` rather than forwarding it;
remote-host carryover is an explicit follow-up, not silently
half-implemented.

The `instructions`-based `seedPrompt` channel survives as a context-only
fallback, for a caller that sets `seedPrompt` without also requesting
`initialPrompt` — and, since a resume can't take an auto-submitted turn,
also carries a caller-supplied seed on the transfer path as static
context alongside the imported transcript.

Gated on the live
`sessions.injectAgentGuide` setting's value _at this session's own spawn
time_ (`HookAdapterContext.injectAgentGuide`, threaded from
`PtyManager`/`Session` in `pty-manager.ts` down to
`hook-adapters/opencode.ts`'s `prepareLaunch`) — necessarily a spawn-time
snapshot, since unlike hooks.ts's per-hook-fire live read for every other
agent, there is no later moment for OpenCode to re-check the setting
against. See
`prepareLaunch`'s own doc comment for the full reasoning.

No write to opencode's resolved global config dir (`$XDG_CONFIG_HOME/opencode`
when set, else `~/.config/opencode` — see
`resolveOpenCodeConfigHome()`, `hook-adapters/opencode-skills.ts`) or a
project's `.opencode/` happens at all — fully ephemeral, same posture as
Claude Code's `--settings` file, and
strictly less persistent than the originally-planned managed-install
fallback (superseded once `OPENCODE_CONFIG_DIR` was confirmed to work this
way). The plugin forwards seventeen non-blocking event-bus types (rewritten
here — a previous revision of this doc said only eight, several under stale
v1 event names): `session.idle` (→ `progress: done`, plus `agent_session`
carrying opencode's own internal session id for a later promote's history
transfer), `file.edited` (→ `file_change`), `permission.asked` (→
`permission_request` — opencode 1.18.7 renamed this from v1's
`permission.updated`), `permission.replied` (→ `permission_resolved`, not
`notification_resolved` as an earlier revision of this doc had it —
`notification_resolved` only clears a confirmed `hookNotification`, not
`permissionState`, so answering an opencode permission used to clear
nothing), `session.error` (→ `tool_failure`, skipping the user's own
`Ctrl-C`), `tui.toast.show` (→ `notification`, warning/error variants only),
`question.asked` (→ `question`, started), `question.replied`/
`question.rejected` (→ `question`, finished), `todo.updated` (→ `todo`),
`session.diff` (→ `session_diff`), `worktree.failed`/`mcp.browser.open.failed`
(→ `notification`, error variants), `session.status` (→ `progress`, or
`turn_start` + `progress` on a `busy` status, including a `retry` backoff —
never `notification`, unlike an earlier revision of this doc), `vcs.branch.updated`/
`worktree.ready` (→ `git_branch`), and `session.compacting`/
`session.subagent` (→ `compact`/`subagent`, started or finished). It also
exposes its own
`promote_to_worktree` tool (→ `promote_request`, the same blocking flow
issue #271 gives Claude Code via the `mullion` MCP server). See
`opencode-plugin.js`'s `mapOpenCodeEvent` for the authoritative mapping and
`hook-adapters/opencode.ts`'s `OPENCODE_EMITS` for the capability list this
adapter reports. OpenCode's real gating hook is `permission.ask` (mutating
an `output.status` of `ask`/`deny`/`allow`), confirmed against the installed
`@opencode-ai/plugin` package's own types — **not** `tool.execute.before`
throwing, as originally assumed during planning. It's still not wired up,
but not by choice: live testing against the installed CLI (1.18.21–1.18.23)
confirmed `permission.ask` never fires at all, in either headless or
interactive mode — a confirmed upstream bug (opencode issues #7006, #19927:
`PermissionNext.ask()`'s own `if (!needsAsk)` guard skips the plugin trigger
entirely for a first-encounter command, exactly the case remote approval
would need). Tracked in issue #264 as blocked upstream, not as a Mullion gap
— Codex's own dialect shipped (see below); agy has no `PermissionRequest`-
equivalent hook to build one on at all.

**Codex** reuses the same shared forwarder as Claude Code (`src/hooks/
forwarder.mjs`, `codex` as its agent argv). As of this writing (rewritten
here — a previous revision of this doc listed only two of these six),
`mergeCodexHooks` registers `Stop` (→ `progress: done`), `SessionStart` (→
`session_start`), `SessionEnd` (→ `session_end`), `PermissionRequest` (→
`review_gate` — issue #264's blocking permission-approval channel, no
matcher — every tool that can trigger a permission dialog, registered with a
300s timeout rather than the fire-and-forget default), `UserPromptSubmit`
(→ `turn_start`), `PostToolUse` (matchers
`apply_patch` → `file_change`, and `Bash` → `git_branch`/`cwd_changed` for
worktree/branch detection), and — confirmed live against installed
codex-cli 0.149.0's own embedded hook I/O schemas, contradicting an earlier
"hasn't been verified to have them" caveat — `PreCompact`/`PostCompact` (→
`compact: {state, trigger}`, both carrying a required `trigger` unlike
Claude Code's own PostCompact, which carries none) and `SubagentStart`/
`SubagentStop` (→ `subagent: {state, agentType, agentId}`). No elicitation
equivalent is registered — Codex's hook surface still hasn't been verified
to have one. Codex has no `Notification` event at all. See
`hook-adapters/codex.ts`'s `CODEX_EMITS` for the capability list this
adapter reports. Unlike every other adapter, this is **not
ephemeral** — two facts verified against the real installed Codex CLI during
the original PR contradict what the plan before that assumed:

1. **`CODEX_HOME` is not a surgical knob.** Unlike OpenCode's
   `OPENCODE_CONFIG_DIR`, it relocates auth, model config, MCP servers,
   trusted-project state, and history — pointing it at a fresh per-session
   scratch directory doesn't add hooks, it breaks Codex outright (its own
   diagnostics tool reports no credentials found against an empty one).
2. **Codex requires an explicit, interactive, one-time trust decision**
   (`/hooks` inside the TUI) before ANY non-managed command hook — including
   one Mullion generates — is allowed to run. The only non-interactive
   bypass, `--dangerously-bypass-hook-trust`, disables that review
   **globally for the whole invocation**, including whatever hooks a
   cloned/opened repo's own `.codex/hooks.json` ships — a real
   unreviewed-code-execution risk for a tool whose job is running agents
   against arbitrary repositories. Not used here.

Given both, Mullion instead does an idempotent, Mullion-owned **merge into
the user's real `~/.codex/hooks.json`** (or `$CODEX_HOME/hooks.json` if the
user has their own override set) — the same "managed, reversible install"
posture as agy below, not the plan's original "no argv edit, no managed
install" assumption for Codex. The merge is keyed off the fixed forwarder
shim's install path (see "How a hook command finds the forwarder" above),
so re-running it on every launch only ever replaces Mullion's own hook
group; any hooks the user configured themselves are left untouched, and a
file Mullion can't safely parse is left untouched too (never blindly
overwritten). Because trust is recorded against the real, stable
`~/.codex` rather than a fresh-per-session directory, **a one-time `/hooks`
trust grant persists across every future Mullion-launched Codex session**
— it just isn't automatic. Until granted, these hooks are silently skipped
and Codex works exactly as it does today.

**Upgrading from a pre-shim release (one-time cost):** Codex's `/hooks`
trust is granted per hook-group command string — `trusted_hash` in
`~/.codex/config.toml` (see `codex-trust.ts`'s own doc comment). Migrating
an already-trusted host to the forwarder-shim command shape changes that
string once, which re-triggers Codex's interactive `/hooks` review exactly
once per host, the same way any prior forwarder-path change already did
before the `current`-symlink stable-path fix (issue #259). Grant that
review **before** running any unattended Codex session on the upgraded
host, or it silently sits with no Mullion hooks (same as any other
not-yet-trusted host) until someone notices and completes it — see
"Removing managed hooks" below for how to confirm what's currently
installed. After this one-time migration, the command string is a
permanent constant across every future release, so this specific cost
never recurs.

**Live-verified (issue #846):** the `apply_patch` patch-header format the
file-change extractor parses was confirmed against two real hook firings
(codex-cli 0.149.0, a throwaway `$CODEX_HOME` + `--dangerously-bypass-hook-trust`,
never shipped). Two things settled: `tool_input.command` is a plain string —
NOT the argv-array shape (`{"command":["apply_patch", "..."]}`) the model's
own tool-call instructions (embedded in the binary) describe; that shape is
how the model _invokes_ the tool, not what `PostToolUse` delivers to the
hook. And a rename is `*** Update File: <old path>` immediately followed by
`*** Move to: <new path>` — not a dedicated verb — which the extractor now
handles by rewriting that entry's path to the rename target, rather than
silently reporting a `modify` on the old path with the new one never
surfacing at all (the pre-fix behavior). The path itself can be either
relative or absolute depending on what the model already knows about its
cwd when it writes the patch — `isPathGitIgnoredCached` (`git-ignore.ts`)
already handled both before this fix; nothing needed to change there. The
extractor stays defensive for anything it doesn't recognize (yields no
messages, never throws).

**SessionStart's reply** (issue #437a) uses the identical
`hookSpecificOutput.additionalContext` shape Claude Code's does — verified
against Codex's own embedded hook I/O schema
(`formatSessionStartOutput("codex", ...)` in `forwarder-core.mjs`). This is
what carries the agent-guide pointer described in `docs/agent-guide.md`'s
[Auto-injection](agent-guide.md#auto-injection)
section — subject to the same `/hooks` trust gate as every other Codex hook
above.

**Sandbox `.git` writability (issue #906):** Codex's `workspace-write` sandbox
marks `.git` as read-only by default, causing every `git worktree add/remove`
and `git stash push` to require an escalated permission. Mullion's Codex
adapter injects `--add-dir .git` via `commandTransform` to grant `.git` write
access inside the sandbox, reducing permission escalations at the source.
Verified against installed `codex-cli 0.151.0`'s own `--help` output. This
flag is appended before the skip-permissions flag, so it's harmless when
`--dangerously-bypass-approvals-and-sandbox` bypasses the sandbox entirely.

**agy** (Antigravity CLI) also reuses the shared forwarder (`agy` as its
agent argv), registering `Stop` (→ `progress: done`, plus `stop_failure` when
`terminationReason === "error"`), `PreToolUse` on `run_command`
(observational only — `git_branch`/`cwd_changed` for worktree/branch
detection; issue #264 removed the `review_gate` it used to also emit, since
agy has no `PermissionRequest`-equivalent hook to build a gate on), and
`PostToolUse` on `write_to_file` /
`replace_file_content` / `multi_replace_file_content` (→ `file_change`) —
rewritten here since a previous revision of this doc said only `Stop` was
registered, and separately claimed `PostToolUse` was "deliberately not wired
up" (see that claim's own correction further down). See
`hook-adapters/agy.ts`'s `AGY_EMITS` for the capability list this adapter
reports; four hook events are registered (issue #321): `Stop`
(→ `progress: done` + optional `stop_failure`), `PreToolUse` on
`run_command` (→ `git_branch`/`cwd_changed` + optional `review_gate`),
`PostToolUse` on `write_to_file`/`replace_file_content`/
`multi_replace_file_content` (→ `file_change`), and `SessionStart` (→
`session_start`). **No `SessionEnd`** (issue #461): a registered SessionEnd
hook never actually fires — `strings` on the installed agy binary lists
`SessionStart` among its recognized hook event keys but not `SessionEnd`,
and a live `agy --print` run confirmed it empirically (SessionStart/
PostToolUse/Stop all fired on a clean exit, SessionEnd never did).
PermissionRequest and compaction/subagent/elicitation were checked and do
not exist in agy's hook surface as of this writing (see
`forwarder-core.mjs`'s `mapAgyEvent` for the authoritative list). Config
location
and schema were both verified against agy's own bundled documentation
(the `agy-customizations` skill's `docs/hooks.md`, shipped with the
installed CLI) rather than guessed — two corrections to the original plan:

- The **global** config location is `~/.gemini/config/hooks.json` (the
  plan guessed `~/.gemini/antigravity-cli/hooks.json`), following the same
  customization-root convention agy's own `plugins.json`/`skills.json`
  use.
- The **schema** is unlike Claude Code/Codex: top-level keys are arbitrary
  hook NAMES (no `"hooks"` wrapper), and `Stop` specifically is a FLAT
  array of handler objects (`PreToolUse`/`PostToolUse` use the familiar
  `{matcher, hooks: [...]}` grouped form, but `Stop` doesn't).

No documented hook-trust gate exists for agy (unlike Codex) — a managed,
idempotent merge into the real `~/.gemini/config/hooks.json` (keyed by a
Mullion-owned hook name, `mullion-hook-forwarder`, never disturbing any
other hook the user configured) auto-fires with no interactive step
required. The hook always fires for every `run_command`, purely
observationally (git_branch/cwd_changed detection) — it never produced
`review_gate` before issue #264 removed that path entirely, since agy has
no `PermissionRequest`-equivalent hook to build a gate dialect on, unlike
Claude Code and (eventually) Codex.

**Correction to an earlier revision of this doc:** `PostToolUse` was
originally left unwired for agy because its documented payload example
showed only `{stepIdx, error, ...common fields}` — no tool name or arguments
field to extract a file path from. It's since been wired up (see the
registration list above) against `write_to_file`/`replace_file_content`/
`multi_replace_file_content`'s actual `toolCall.args.TargetFile` (falling
back to `.FilePath`) — verified against those three tools' real payload
shape, not the earlier generic example.

**`SessionStart`'s reply** (issue #437b) is **confirmed working against a
live firing** (issue #715): `hook-adapters/agy.ts` registers `SessionStart`
unconditionally, and `hooks.ts`'s reply is non-empty by default on any
ordinary session, so this dispatches on Mullion's side on every agy
`SessionStart` — not hypothetically. agy's own bundled `hooks.md`
"Supported Event Types" table still omits `SessionStart` entirely, but the
hook-name set embedded in the installed `agy` binary itself does recognize
it, and the binary carries real call-site symbols for it
(`hookcaller.CallSessionStartHook`, `prehooks.NewSessionStartProviderHook` —
not just a recognized name with no wiring behind it). The open question
this section used to raise — whether agy's own decoder
(`hookcaller.maybeParseProtoBytes`, proto-based) actually accepts the shape
`formatSessionStartOutput("agy", ...)` in `forwarder-core.mjs` sends —
`{ injectSteps: [{ ephemeralMessage: additionalContext }] }` — is resolved:
it decodes and the content reaches the model. Verified with `agy --print
"<probe>"`, `GEMINI.md` removed from the working tree so agy's own native
project-file loading (#711) couldn't be the source, and the answer still
correctly cited "Project Briefing (`AGENTS.md`) — Injected by Mullion" as
where it learned the repo's rules. See `docs/agent-guide.md`'s
[Live end-to-end verification](agent-guide.md#live-end-to-end-verification-issue-715)
section for the full probe transcript summary. This is what carries the
agent-guide pointer described in `docs/agent-guide.md`'s
[Auto-injection](agent-guide.md#auto-injection)
section.

Because agy's hooks run **synchronously**, blocking its own agent loop
until each hook command exits, and its `Stop` contract expects a JSON
decision object on stdout, the shared forwarder now always prints `{}` to
stdout right before exiting (harmless for Claude Code/Codex, which don't
require or forbid any stdout output).

### Skills Manager: agy skills are listed, never toggleable (issue #467)

The Skills Manager (`docs/roadmap.md`'s Phase-adjacent work, `#432`/`#463`)
discovers agy's skills — its builtin bundle, its extensions'
skills, and (since #467) its documented project (`.agents/skills`) and
global (`~/.gemini/antigravity-cli/skills`) roots — but agy skills can never
be individually enabled or disabled through Mullion, by design, not by gap.
Inspecting the installed agy 1.1.9 binary's symbol table found no per-skill
disabled bit anywhere in its data model: `Plugin`/`PluginItem` expose a
`GetDisabled` accessor, but `SkillMetadata` exposes only
`GetName`/`GetDescription`/`GetPublisher`/`GetVersion` — nothing else.
Antigravity's own public docs (https://antigravity.google/docs/cli/plugins)
confirm this independently: no per-individual-skill enable/disable
mechanism is documented; `agy plugin disable <plugin_name>` suspending the
entire package is the only lever. Mullion doesn't wire a "toggle" that
actually disables a skill's whole containing plugin (rules, hooks, and MCP
servers included) — that's a much coarser and more surprising operation
than a single-skill switch — so agy's `enabledByAgent` stays `null`
unconditionally. See `src/services/skills.ts`'s header comment for the full
evidence trail.

**Known limitation, Claude Code side (not fixed by #467):** a `SKILL.md`
whose frontmatter sets `disable-model-invocation` is pinned by Claude Code to
`user-invocable-only` and can never read as fully `"on"` again, regardless of
what `skillOverrides` says. `parseSkillFrontmatter` (`src/services/skills.ts`)
only reads `name`/`description`, so Mullion can't see this frontmatter field
and would show such a skill as toggleable-to-enabled when it isn't. Left as a
follow-up rather than widening the frontmatter parser for one more field
here.

## The review gate (issue #178, rescoped by #264)

**Originally a `PreToolUse`/`Bash` gate, replaced entirely.** The first
version of this feature registered a blocking `PreToolUse` hook matched to
`Bash`, off by default (`MULLION_REVIEW_GATE_ENABLED=false`) because it fired
on _every_ Bash call — including ones already auto-approved by the agent's
own allowlist — stalling each one until a human answered or the timeout
denied it. That flag has been removed; the mechanism it gated no longer
exists.

**Now built on `PermissionRequest` instead**, confirmed live (Claude Code
2.1.220, a real interactive session) to fire deterministically, and _only_,
when the agent is about to show an actual permission dialog — never for an
allowlisted/auto-approved call. That makes it safe to register
unconditionally: an unanswered request now falls through to the agent's own
native prompt (see below), not a denial, so an unattended session degrades to
exactly the behavior it would have with no Mullion involved at all, rather
than stalling every tool call.

The wire mechanics are unchanged from the original design: an agent's
`PermissionRequest`-equivalent hook sends `review_gate {state: "waiting",
prompt}` and — unlike every other hook message — **keeps its connection
open** instead of fire-and-forget, blocking until a real decision arrives. A
human clicks Approve or (optionally with a reason) Deny in the notification
bell panel (`NotificationBell.tsx`), which calls
`POST /api/sessions/:id/review-gate {decision, reason?}`; the backend
(`src/plugins/hooks.ts`) writes `{"decision": "approved" | "denied",
"reason"?}` back on that still-open connection, the forwarder relays it in
the agent's own decision dialect (`formatGateDecision` in
`forwarder-core.mjs`) on stdout, and exits.

**Claude Code's and Codex's `PermissionRequest` both have a gate dialect
wired up today** — confirmed live against installed codex-cli 0.149.0 that
its `PermissionRequest` decision shape
(`hookSpecificOutput.decision.{behavior,message}`) is byte-identical to
Claude Code's (`formatGateDecision` reuses the same formatter for both).
Unlike Claude Code, Codex has no ExitPlanMode-equivalent tool to exempt, so
every Codex `PermissionRequest` becomes a `review_gate` — there's no
observational fallback shape left for this agent at all. agy has no
`PermissionRequest`-equivalent hook at all, so it can't participate;
OpenCode's own equivalent (`permission.ask`) is confirmed not to fire against
the installed CLI at all (a real upstream bug, not a Mullion gap — see issue
#264 for the tracking link).

**Fall-through, not fail-closed, when nobody answers.** This is the load-bearing
difference from the old gate: a real human decision is always "approved" or
"denied", but every OTHER outcome — no reply within the timeout, a dropped
connection, a malformed reply — now degrades to a bare `{}` reply
(confirmed live to make Claude Code show its own native permission dialog
instead), not an explicit denial:

- No pending gate for a session (already resolved, or nothing was ever
  waiting) → the REST endpoint reports 409/`{ok: false}`, no decision is
  fabricated.
- **Concurrent gates are now correlated and independently resolvable**
  (superseding PR #839's fall-through — see the investigation this replaced
  it, below). Codex and Claude Code can both fire more than one
  `PermissionRequest` for the same session at once (parallel tool calls);
  each gets its own `gateId`, generated by the forwarder
  (`forwarder.mjs:forward()`) and threaded through the wire protocol
  (`ReviewGateHookMessage.gateId`, `hooks.ts`'s `pendingGates: Map<sessionId,
Map<gateId, PendingGate>>`, `Session.pendingGates`/`resolveGate(gateId,
...)`). `POST /api/sessions/:id/review-gate` takes an optional `gateId`
  body field — resolving a specific gate when given, or the OLDEST
  still-pending gate when omitted (the pre-correlation contract, still
  valid for any caller that only ever expects one). `SessionInfo.gates` is
  the full live list; `gateState`/`gatePrompt`/`gateAt` stay as a derived
  single-gate summary (`"waiting"` while ANY gate is waiting, representing
  the oldest) for every consumer that only ever needed one representative
  value — the session-status pill, push notifications, and the persisted
  state file. `NotificationBell.tsx`'s `GateActions` renders one Approve/Deny
  pair per entry in `gates`, correlated to its own event row by `gateId`.

  Previously, a second `review_gate: waiting` arriving for a session that
  already had one pending fell through _immediately, on that connection
  only_, leaving the first gate's pending state "completely undisturbed" —
  which sounded safe but meant the first gate had **no affordance in the
  terminal at all** while it sat parked. Live evidence from a stuck Codex
  session (branchDAM, 2026-08-29): the user answered the SECOND,
  fallen-through prompt (the only one Codex actually rendered), had no
  indication a first, unrelated tool call was still waiting on a decision
  reachable only from the Mullion UI, and the turn aborted twice. Gate
  correlation removes the need for that tradeoff.

- A server-side timeout (`hooks.ts`'s `GATE_TIMEOUT_MS`, 290s) falls through
  if nobody ever answers, comfortably under Claude Code's own 600s
  `PermissionRequest` hook timeout — Mullion controls the outcome rather than
  leaving it to the agent's own, less predictable expiry behavior.
- The forwarder has its own, shorter internal timeout too (280s) and treats
  a dropped connection or a malformed reply the same way: fall through.
- If the socket itself is unavailable when a `PermissionRequest` hook fires
  at all (hooks disabled, or the agent invoked outside a Mullion session),
  the forwarder never enters the gate branch in the first place — that's
  the ordinary "hooks disabled" no-op, not a gate to resolve at all.

**Persistence note (issue #844):** the SUMMARY gate state
(`SessionInfo.gateState`/`gatePrompt`/`gateAt`) is NOT in-memory only — it's
in `StoredStateFields` and survives a restart via the per-session state file
(issue #323). The live, per-gate list (`SessionInfo.gates`, `hooks.ts`'s
`pendingGates` sockets/timers) is deliberately in-memory only and does NOT
survive a restart, for either field — there is no live connection left to
correlate a restored gate against regardless of how many were pending, so
persisting the full list would add real complexity for no behavioral gain
(see `Session.pendingGates`'s own doc comment in `pty-manager.ts`). A restart
while the summary shows `"waiting"` therefore surfaces a fourth state,
`"lapsed"`: nobody ever answered, so the agent(s) fell through to their own
native prompt(s) (the same outcome as a live timeout or a dropped connection
— `"lapsed"` covers all of these, not just the restart case). Mullion
resolves this at two points: any gate(s) still pending at a _graceful_
shutdown are resolved to `"lapsed"` before their sockets are destroyed
(`hooksPlugin`'s `onClose`); a `"waiting"` summary restored from a state file
after a hard crash/`kill -9` is resolved to `"lapsed"` directly on reattach
(`Session.spawn()`'s `savedState` handling — there's no per-gate id left to
resolve individually, so this bypasses `resolveGate()` and resets the
summary fields itself). Either way, the UI never shows a live-looking
Approve/Deny for a gate nothing is listening on, and the timeline records
"no answer" distinctly from an actual human "denied".

### Does remote answering generalize beyond permissions? (issue #845)

Three other hook-protocol kinds share the review gate's exact shape — "the
agent is blocked waiting on a human" — and were investigated for the same
remote-answer treatment: `question` (Claude Code's `AskUserQuestion`, arriving
as a `PermissionRequest`), `plan_ready` (`ExitPlanMode`, deliberately exempted
from `review_gate` above), and `elicitation` (an MCP server asking the human
a question). Live-verified against installed Claude Code 2.1.220 (a
throwaway per-project `.claude/settings.json`, real interactive sessions via
`script -qec`, same verification bar as everything else in this file).
**None of the three generalizes as cleanly as the review gate did** — the
review gate's own success turns out to rest on a property specific to
ordinary tool calls (Bash, Edit, Write) that doesn't hold for these three.

**`question` — the hook fires, but its decision doesn't control the
answer.** `PermissionRequest{tool_name: "AskUserQuestion"}` really does carry
`tool_input.questions[0]` with `question`/`header`/`options[].{label,
description}`/`multiSelect` (confirmed live — today's mapper's defensive
`?.` read was correct to be defensive, but the field is real). But
`{"decision":{"behavior":"allow"}}` — the SAME reply that fully resolves a
Bash/Edit permission dialog — does **not** answer the question. It only
permits the `AskUserQuestion` tool call to proceed, which means "render
Claude Code's own interactive picker" (`❯ 1. Red  2. Blue  3. Green` —
arrow keys + Enter). The picker is a separate, keyboard-driven state machine
downstream of the permission decision, not controlled by it — confirmed live
by sending `allow` and watching the pty sit at the picker, unresolved,
waiting for real keystrokes. There is no reply field that injects a chosen
option; the review gate's `updatedInput`/similar was never confirmed to
exist for Claude Code, and this makes the question moot regardless — the
picker doesn't consult the permission decision at all once past the initial
allow.

**A practical, but unofficial and fragile, workaround exists: `deny` +
`message`.** Denying the `AskUserQuestion` call with
`message: "The user has already chosen: Blue. Do not ask again, proceed
treating the answer as Blue."` reliably (live-verified) made the model treat
"Blue" as the answer and print it back, without the interactive picker ever
rendering — the denial reason surfaces to the model as a tool error
("`Denied by PermissionRequest hook`" + the message text), and the model
reads and acts on it like any other tool-call failure message. This is NOT a
documented contract — it works because Claude Code surfaces denial reasons
to the model as ordinary text and the model follows instructions in that
text, the same mechanism any Bash-denial message already relies on to steer
the agent, repurposed here. It has no structural validation (nothing confirms
"Blue" was actually one of the three offered options — a typo or a
hallucinated option string would pass through this path exactly the same
way a real one does), and a future Claude Code version could change how (or
whether) denial reasons reach the model without warning, silently breaking
it. Building product-facing "answer this question from the bell" on it would
mean accepting that fragility, not a documented API.

**`plan_ready` — same structural gap, same workaround, with one more
layer.** `PreToolUse`/`ExitPlanMode` and `PermissionRequest{ExitPlanMode}`
both fire on the same dialog (already known, see the ExitPlanMode exemption
above). Live-verified: `allow`ing either does **not** skip Claude Code's own
"Would you like to proceed? 1. Yes 2. Yes, and use auto mode 3. No, keep
planning" prompt — identical failure mode to `question`. The same `deny` +
`message` workaround (`"The user has already approved this plan... proceed
immediately to implementing step 1"`) DOES skip that prompt and moves the
model straight into execution — but the individual file edits that follow
then hit their own, ordinary `PermissionRequest`-gated confirmations
(`Write`/`Edit`), which is exactly what the review gate above already
handles today. So the practically buildable shape isn't "answer plan_ready
directly" — it's "deny `ExitPlanMode` with an approval message, then let the
existing review gate handle whatever it does next" — genuinely buildable,
but built on the same undocumented, model-following-instructions mechanism
as `question`'s workaround, with the same fragility caveat. The fidelity
gap the original plan already flagged (yes / yes-and-auto-accept / keep
planning collapsed to a bell-side approve/deny) is real regardless of which
path is used.

**`elicitation` — no blocking hook at all, confirmed by code, not by a live
firing.** `Elicitation`/`ElicitationResult` are registered with the default
`hookEntry()` in `claude-code.ts` — the same short, fire-and-forget timeout
as `progress`/`file_change`/every other observational kind, not
`PermissionRequest`'s long override. `mapClaudeCodeElicitation` always
returns `{kind: "elicitation", ...}`, never `review_gate`, and
`forwarder.mjs`'s dispatcher only routes a message through the blocking
`runGate()` when its mapped kind is exactly `"review_gate"`. So there is
structurally nothing to answer here — `elicitation` never blocks Claude Code
at the hook layer, whatever answering mechanism MCP's own elicitation
protocol might offer a client is a separate integration surface entirely,
outside this hook channel and outside this issue's scope.

**Conclusion: nothing new to build from this investigation.** Unlike
`#847`'s "blocked upstream, revisit later" verdict, this isn't a bug to wait
out — it's a real design boundary. The review gate works because a
Bash/Edit/Write permission decision genuinely IS the whole answer ("run it or
don't"); `question`/`plan_ready` don't have that property, because the
"answer" is a choice made by a downstream interactive UI the permission
layer doesn't control. The `deny` + `message` technique is real and works
today, but it's a prompt-engineering trick riding on the model reading
denial text, not a protocol contract — worth knowing about, not worth
shipping a bell-side "answer this question" button on top of without
accepting that it could silently stop working on any future Claude Code
release.

### Removing managed hooks

- **Codex** — open `~/.codex/hooks.json` (or `$CODEX_HOME/hooks.json`) and
  delete every hook group whose `command` references
  `mullion-forwarder-shim.sh` (`Stop`/`SessionStart`/`SessionEnd`/
  `PermissionRequest`/`UserPromptSubmit`/`PostToolUse` — see the
  registration list above) — each entry also carries a `"statusMessage"` of
  `"Mullion agent-hook forwarder — safe to remove, see docs/agent-hooks.md"`
  so it's identifiable without cross-referencing this file. On a host that
  hasn't relaunched a Mullion-owned Codex session since the forwarder-shim
  migration, a group may still reference an older `forwarder.mjs` path
  directly instead — the same rule applies, delete it.
- **agy** — open `~/.gemini/config/hooks.json` and delete the top-level
  `"mullion-hook-forwarder"` key.
- **The shim itself** — `rm -rf ~/.mullion/hooks` removes
  `mullion-forwarder-shim.sh`. Safe at any time: every hook command that
  invokes it carries its own fail-open guard (see "How a hook command finds
  the forwarder" above), so a missing shim degrades hooks to a silent
  no-op, never a failed tool call. It's also self-healing — the next agy/
  Codex session launch reinstalls it automatically.
- **The Mullion tooling bundle's skills** (codex/agy only — Claude Code's
  copy is a per-session `--plugin-dir` flag, never written to disk, and
  opencode's is a per-session config pointer, also never written) —
  delete any `mullion-`-prefixed directory under `~/.agents/skills`
  (codex) or `~/.gemini/config/skills` (agy). Self-healing the other
  direction too: turning `sessions.injectMullionBundle` off in Settings
  removes these automatically on that agent's next launch, no manual step
  needed unless you're removing Mullion itself.

Any other hooks in either file are Mullion's to leave alone, never to
touch.

## Security notes

- The socket file is created with `0600` permissions — only the user
  Mullion runs as can connect at all.
- The per-session token is a defense against a **different** session's hook
  messages being forged on this shared socket, not against that session's
  own child processes (which legitimately inherit `$MULLION_HOOK_TOKEN`, the
  same way any other env var is inherited).
- A session's token is regenerated every time its process is (re)spawned —
  killing a session invalidates its old token immediately, even if the same
  session id is reused later.
