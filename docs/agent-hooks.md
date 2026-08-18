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

Every session's shell gets two extra environment variables at spawn time,
alongside whatever its launcher command already sets:

| Variable              | Meaning                                                                        |
| --------------------- | ------------------------------------------------------------------------------ |
| `MULLION_HOOK_SOCKET` | Absolute path to a Unix domain socket, shared by every session on this host.   |
| `MULLION_HOOK_TOKEN`  | A per-session secret, unique to this one session, used in the handshake below. |

Both are stripped from a session's env if that session itself starts a
nested Mullion (e.g. running `make dev` from inside a Mullion-managed
terminal) — the same env-leak protection `session-env.ts`'s
`SERVER_ENV_KEYS` already applies to every other Mullion-owned config value
(issue #70).

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

| `kind`                  | Fields                                                                                                | Meaning                                                                                                                                                                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `notification`          | `title: string`, `body: string`                                                                       | Surfaces in the notification bell/desktop-notify, same as a BEL.                                                                                                                                                                                                                           |
| `progress`              | `phase: "thinking" \| "generating" \| "done"`, `lastAssistantMessage?`, `backgroundTasks?`, `detail?` | Drives the sidebar status line; `done` is the authoritative "turn over" signal — see `backgroundTasks` below for why it doesn't unconditionally mean "idle now."                                                                                                                           |
| `file_change`           | `path: string`, `action: "modify" \| "create" \| "delete"`, `agentId?`, `agentType?`                  | A file the agent touched (issue #177's sidebar strip). `agentId`/`agentType` (Phase 5, Track A) are present when the change happened inside a subagent.                                                                                                                                    |
| `review_gate`           | `state: "waiting" \| "approved" \| "denied"`, `prompt: string`                                        | A pending decision (issue #178's review gate — see below).                                                                                                                                                                                                                                 |
| `promote_request`       | `summary: string`, `suggestedBaseRef?`                                                                | Issue #271 — a model-invoked "start work in a worktree" request.                                                                                                                                                                                                                           |
| `session_start`         | `source?: string`                                                                                     | Issue #271 — answered inline with a stashed seed prompt, if any.                                                                                                                                                                                                                           |
| `notification_resolved` | —                                                                                                     | Follow-up to #275 — a confirmed `notification` was resolved with no keystroke (an auto-approved permission).                                                                                                                                                                               |
| `git_branch`            | `branch: string`, `worktree?: string`                                                                 | Sidebar worktree detection — a `git worktree add`/checkout the agent ran.                                                                                                                                                                                                                  |
| `cwd_changed`           | `cwd: string`                                                                                         | Sidebar worktree detection — the agent's shell changed directory.                                                                                                                                                                                                                          |
| `permission_request`    | `tool: string`, `summary: string`                                                                     | PR #300 — a tool-permission dialog is blocking the agent.                                                                                                                                                                                                                                  |
| `stop_failure`          | `error: string`, `errorDetails?`, `errorType?`                                                        | PR #300 — the turn ended on an API error (rate_limit, overloaded, ...).                                                                                                                                                                                                                    |
| `tool_failure`          | `tool: string`, `error: string`, `summary?`, `agentId?`, `agentType?`                                 | PR #300 — a tool call itself failed. `agentId`/`agentType` (Phase 5, Track A) are present when the failure happened inside a subagent.                                                                                                                                                     |
| `session_end`           | `reason: string`, `exitCode?: number`                                                                 | PR #300 — the session terminated, with why (and, when available, its exit code).                                                                                                                                                                                                           |
| `plan_ready`            | `plan: string`, `filePath?`, `summary?`                                                               | PR #300 — Claude Code's `ExitPlanMode` produced a plan awaiting review.                                                                                                                                                                                                                    |
| `turn_start`            | —                                                                                                     | Issue: extend surfaced session statuses — a deterministic "a new turn just started" signal (Claude Code/Codex `UserPromptSubmit`); releases every pending `awaiting_*` status.                                                                                                             |
| `compact`               | `state: "started" \| "finished"`, `trigger?: "manual" \| "auto"`                                      | Claude Code's `PreCompact`/`PostCompact` — context compaction in progress.                                                                                                                                                                                                                 |
| `subagent`              | `state: "started" \| "finished"`, `agentType?`, `agentId?`, `summary?`, `backgroundTasks?`            | Claude Code's `SubagentStart`/`SubagentStop` — tracked as a running count, not a boolean. `agentId` (Phase 5, Track A) correlates a started/finished pair; `summary` is `SubagentStop`'s `last_assistant_message`. `backgroundTasks` (issue #428) rides on `SubagentStop` too — see below. |
| `elicitation`           | `state: "started" \| "finished"`, `server?`                                                           | Claude Code's `Elicitation`/`ElicitationResult` — an MCP server is asking the human a question.                                                                                                                                                                                            |
| `permission_resolved`   | —                                                                                                     | Claude Code's `PermissionDenied` — a possible extra release for a pending `permission_request`, never the only one.                                                                                                                                                                        |
| `plan_resolved`         | —                                                                                                     | Reserved for an agent with a direct "plan decision made" signal; no current adapter sends it (Claude Code's `progress: done`/`turn_start` already release a pending plan).                                                                                                                 |
| `agent_session`         | `sessionId: string`                                                                                   | PR #696 — opencode only: the live opencode internal session id, re-reported on every `session.idle`, so a later promote can export/import the full conversation history into the new worktree session.                                                                                     |

A `kind` this list hasn't been taught yet is accepted and stored verbatim
rather than rejected — this is what lets a newer hook author add a message
kind an older Mullion doesn't recognize without breaking the connection. A
malformed message (missing/wrong-typed fields for a _recognized_ kind, or
invalid JSON) gets a `{"error": "..."}` reply on the same connection, which
stays open — only a failed handshake or an oversized/unterminated line
closes it. See `src/services/hook-protocol.ts` for the authoritative parser.

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
hook never carries them. The forwarder (`src/hooks/forwarder-core.mjs`)
stamps these onto every attributable message from the payload's common
fields in one place (`applyAgentEnvelope`, called from `mapClaudeCodeEvent`),
rather than in each individual mapper. This is what lets Mullion attribute a
file change or tool failure to the subagent that actually caused it, instead
of just the parent session — see the subagent registry design in
`docs/roadmap.md`'s Phase 5 section.

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
   `$MULLION_HOOK_SOCKET`. `PreToolUse` on `Bash` (the blocking review gate,
   see below) is added to the same file only when
   `MULLION_REVIEW_GATE_ENABLED=true`; every other hook below is always
   registered.
2. Appends `--settings <that file>` to the command actually spawned.

As of this writing (issue: extend surfaced session statuses — rewritten
here since the previous revision listed only three of these), the
unconditional set is: `Notification`, `Stop`, `SessionStart`, `CwdChanged`,
`PostToolUse` (matchers `Write|Edit|MultiEdit|NotebookEdit` and `Bash`),
`PermissionRequest`, `StopFailure`, `PostToolUseFailure`, `SessionEnd`,
`PreToolUse` on `ExitPlanMode` (observational — maps to `plan_ready`, not the
blocking gate below), `UserPromptSubmit`, `PreCompact`/`PostCompact`,
`SubagentStart`/`SubagentStop`, `PermissionDenied`, and
`Elicitation`/`ElicitationResult`. See `hook-adapters/claude-code.ts`'s
`buildClaudeHookSettings` for the authoritative, always-current list, and
its exported `CLAUDE_CODE_EMITS` for exactly which wire-protocol `kind`s this
adapter can produce (also surfaced to the frontend via `GET /api/agents`, so
the UI never offers a status legend entry an agent can't reach).

All of the above are fire-and-forget observational hooks (never block the
tool call). `PreToolUse` on `Bash` is the one **blocking** hook — the review gate
(see below) — and defaults **off** (`MULLION_REVIEW_GATE_ENABLED=false`): an
unattended/autonomous session has nobody to click Approve/Deny, so
registering it unconditionally stalls every single Bash call until the
server-side timeout (`hooks.ts`'s `GATE_TIMEOUT_MS`) fails it closed
(denied) — the opposite of the point of an autonomous-agent dashboard. When
enabled, it's deliberately gated to `matcher: "Bash"` only, not every tool
call — Bash's blast radius (arbitrary shell execution) is the one case
judged worth a human-in-the-loop pause; file edits stay fire-and-forget via
the existing `PostToolUse` hook. Making the gated tool set configurable
beyond Bash is a natural follow-up, not built here.

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
"unverified — would need a paid model turn" caveat here unlike Codex's
`apply_patch` extractor or agy's `SessionStart`) that OpenCode's
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
`warnings[]` entry. **Local host only:** `SessionBackend.RemoteBackend.spawn()`
deliberately drops `resumeAgentSessionId` rather than forwarding it;
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
way). The plugin forwards eight non-blocking event-bus types (rewritten
here — a previous revision of this doc said only two, `session.idle` and
`file.edited`): those two, plus `permission.updated` (→
`permission_request`), `permission.replied` (→ `notification_resolved`),
`session.error` (→ `tool_failure`, skipping the user's own `Ctrl-C`),
`tui.toast.show` (→ `notification`, warning/error variants only),
`session.status` (→ `progress` or `notification`, including a `retry`
backoff), and `vcs.branch.updated` (→ `git_branch`). It also exposes its own
`promote_to_worktree` tool (→ `promote_request`, the same blocking flow
issue #271 gives Claude Code via the `mullion` MCP server). See
`opencode-plugin.js`'s `mapOpenCodeEvent` for the authoritative mapping and
`hook-adapters/opencode.ts`'s `OPENCODE_EMITS` for the capability list this
adapter reports. OpenCode's real gating hook is `permission.ask` (mutating
an `output.status` of `ask`/`deny`/`allow`), confirmed against the installed
`@opencode-ai/plugin` package's own types — **not** `tool.execute.before`
throwing, as originally assumed during planning. Unlike Claude Code's
`PreToolUse`, it's still deliberately not wired up: the review-gate endpoint
now exists (issue #178), but OpenCode's own `permission.ask` gating dialect
was never implemented or verified against a live plugin execution — tracked
in issue #264 alongside Codex's and agy's own deferred gate dialects.

**Codex** reuses the same shared forwarder as Claude Code (`src/hooks/
forwarder.mjs`, `codex` as its agent argv). As of this writing (rewritten
here — a previous revision of this doc listed only two of these six),
`mergeCodexHooks` registers `Stop` (→ `progress: done`), `SessionStart` (→
`session_start`), `SessionEnd` (→ `session_end`), `PermissionRequest` (→
`permission_request`, no matcher — every tool that can trigger a permission
dialog), `UserPromptSubmit` (→ `turn_start`), and `PostToolUse` (matchers
`apply_patch` → `file_change`, and `Bash` → `git_branch`/`cwd_changed` for
worktree/branch detection) — Codex has no `Notification` event at all. See
`hook-adapters/codex.ts`'s `CODEX_EMITS` for the capability list this
adapter reports; no compaction/subagent/elicitation equivalents are
registered — Codex's hook surface hasn't been verified to have them (see
`CODEX_EMITS`'s own doc comment). Unlike every other adapter, this is **not
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
install" assumption for Codex. The merge is keyed off the forwarder's own
install path, so re-running it on every launch only ever replaces
Mullion's own hook group; any hooks the user configured themselves are left
untouched, and a file Mullion can't safely parse is left untouched too
(never blindly overwritten). Because trust is recorded against the real,
stable `~/.codex` rather than a fresh-per-session directory, **a one-time
`/hooks` trust grant persists across every future Mullion-launched Codex
session** — it just isn't automatic. Until granted, these hooks are
silently skipped and Codex works exactly as it does today.

Also unverified in this PR: the exact `apply_patch` patch-header format
(`*** Update File: <path>` etc.) the file-change extractor parses — Codex's
hook-trust gate means no CI or local run here could safely trigger a real
hook firing without a live, paid model turn. The extractor is defensive
(an unrecognized format yields no messages, never throws), and this is
called out as a known gap for whoever verifies it against a live session.

**SessionStart's reply** (issue #437a) uses the identical
`hookSpecificOutput.additionalContext` shape Claude Code's does — verified
against Codex's own embedded hook I/O schema
(`formatSessionStartOutput("codex", ...)` in `forwarder-core.mjs`). This is
what carries the agent-guide pointer described in `docs/agent-guide.md`'s
[Auto-injection](agent-guide.md#auto-injection)
section — subject to the same `/hooks` trust gate as every other Codex hook
above.

**agy** (Antigravity CLI) also reuses the shared forwarder (`agy` as its
agent argv), registering `Stop` (→ `progress: done`, plus `stop_failure` when
`terminationReason === "error"`), `PreToolUse` on `run_command` (→
`git_branch`/`cwd_changed` for worktree/branch detection, plus the blocking
`review_gate` below), and `PostToolUse` on `write_to_file` /
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
required. The hook always fires for every `run_command`, but the
blocking `review_gate` — unlike git_branch/cwd_changed observational
messages — is **stripped at the forwarder level** when
`MULLION_REVIEW_GATE_ENABLED` is not `"true"` (issue #264): same
default-off posture as Claude Code's hook-registration-level gate, but
handled at the forwarder rather than hook-registration level because
agy's PreToolUse serves dual observational+gate duty.

**Correction to an earlier revision of this doc:** `PostToolUse` was
originally left unwired for agy because its documented payload example
showed only `{stepIdx, error, ...common fields}` — no tool name or arguments
field to extract a file path from. It's since been wired up (see the
registration list above) against `write_to_file`/`replace_file_content`/
`multi_replace_file_content`'s actual `toolCall.args.TargetFile` (falling
back to `.FilePath`) — verified against those three tools' real payload
shape, not the earlier generic example.

**`SessionStart`'s reply** (issue #437b) is **unverified against a live
firing**, in a narrower sense than "might never fire": `hook-adapters/agy.ts`
registers `SessionStart` unconditionally, and `hooks.ts`'s reply is non-empty
by default on any ordinary session, so this dispatches on Mullion's side on
every agy `SessionStart` — not hypothetically. agy's own bundled `hooks.md`
"Supported Event Types" table omits `SessionStart` entirely, but the
hook-name set embedded in the installed `agy` binary itself does recognize
it, and the binary carries real call-site symbols for it
(`hookcaller.CallSessionStartHook`, `prehooks.NewSessionStartProviderHook` —
not just a recognized name with no wiring behind it). The actual open
question is whether agy's own decoder
(`hookcaller.maybeParseProtoBytes`, proto-based) accepts the shape
`formatSessionStartOutput("agy", ...)` in `forwarder-core.mjs` sends —
`{ injectSteps: [{ ephemeralMessage: additionalContext }] }`, extracted from
the same embedded protobuf descriptor (`third_party/jetski/hooks_pb/
hooks.proto`) as the rest of this section, not guessed. Shipped
optimistically since a decode mismatch's worst case is a silent no-op (same
as any agent without a dialect at all), not a crash. If it turns out the
shape doesn't decode, the fallback is the documented `PreInvocation` event
(same `inject_steps` field), which needs a server-side once-per-session
latch since it fires before every model invocation rather than once per
session — see the `agy` case's own doc comment in `forwarder-core.mjs` for
the full reasoning. This is what carries the agent-guide pointer described
in `docs/agent-guide.md`'s
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

## The review gate (issue #178)

**Off by default** (`MULLION_REVIEW_GATE_ENABLED=false`, see `.env.example`
and `src/plugins/env.ts`) — set it to `true` only when a human is actually
present and watching for the pending-review indicator; an unattended session
has nobody to answer it, so leaving it enabled stalls every Bash call until
the timeout below denies it.

A minimal human-in-the-loop control on top of the same socket: an agent's
`PreToolUse`-equivalent hook sends `review_gate {state: "waiting", prompt}`
and — unlike every other hook message — **keeps its connection open**
instead of fire-and-forget, blocking until a real decision arrives. A human
clicks Approve or (optionally with a reason) Deny in the notification bell
panel (`NotificationBell.tsx`), which calls
`POST /api/sessions/:id/review-gate {decision, reason?}`; the backend
(`src/plugins/hooks.ts`) writes `{"decision": "approved" | "denied",
"reason"?}` back on that still-open connection, the forwarder relays it in
the agent's own decision dialect (`formatGateDecision` in
`forwarder-core.mjs`) on stdout, and exits.

**Claude Code's `PreToolUse` (Bash only)** and **agy's `PreToolUse`
(run_command only, default off — see `MULLION_REVIEW_GATE_ENABLED`)** both
have gate dialects wired up today. Codex and OpenCode still don't — see issue
#264 for why.

**Fail-closed, always.** Every error path resolves to a denial, never a
silent allow:

- No pending gate for a session (already resolved, or nothing was ever
  waiting) → the REST endpoint reports 409/`{ok: false}`, no decision is
  fabricated.
- A second `review_gate: waiting` arriving for a session that already has
  one pending is denied **immediately, on that connection only** — the
  first gate's pending state is left completely undisturbed. (Two gates for
  one session can't share this minimal slice's single-pending-per-session
  bookkeeping without a wire-protocol correlation id; queuing silently would
  risk the human's decision reaching the wrong tool call.)
- A server-side timeout (`hooks.ts`'s `GATE_TIMEOUT_MS`, 290s) auto-denies
  if nobody ever answers, comfortably under Claude Code's own 300s
  `PreToolUse` hook timeout (itself confirmed to fail closed on expiry) —
  Mullion controls the denial and its reason, rather than leaving it to the
  agent's own less-informative timeout behavior.
- The forwarder has its own, shorter internal timeout too (280s) and treats
  a dropped connection or a malformed reply the same way: deny.
- If the socket itself is unavailable when a `PreToolUse` hook fires at all
  (hooks disabled, or the agent invoked outside a Mullion session), the
  forwarder never enters the gate branch in the first place — that's the
  ordinary "hooks disabled" no-op, not a gate to fail closed on.

**Persistence note:** gate state (`SessionInfo.gateState`/`gatePrompt`) is
in-memory only, same as every other live PtyManager field — resets to
`"idle"` across a restart. Persisting an open gate across a restart is an
explicit, tracked gap (ahead of Phase 4's own persistence work), not built
in this minimal slice.

### Removing managed hooks

- **Codex** — open `~/.codex/hooks.json` (or `$CODEX_HOME/hooks.json`) and
  delete every hook group whose `command` references a `forwarder.mjs`
  path (`Stop`/`SessionStart`/`SessionEnd`/`PermissionRequest`/
  `UserPromptSubmit`/`PostToolUse` — see the registration list above) —
  each entry also carries a `"statusMessage"` of `"Mullion agent-hook
forwarder — safe to remove, see docs/agent-hooks.md"` so it's
  identifiable without cross-referencing this file.
- **agy** — open `~/.gemini/config/hooks.json` and delete the top-level
  `"mullion-hook-forwarder"` key.

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
