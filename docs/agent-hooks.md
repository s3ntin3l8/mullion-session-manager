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
against a `kind`-discriminated shape:

| `kind`         | Fields                                                         | Meaning                                                          |
| -------------- | -------------------------------------------------------------- | ---------------------------------------------------------------- |
| `notification` | `title: string`, `body: string`                                | Surfaces in the notification bell/desktop-notify, same as a BEL. |
| `progress`     | `phase: "thinking" \| "generating" \| "done"`                  | Drives the sidebar status line.                                  |
| `file_change`  | `path: string`, `action: "modify" \| "create" \| "delete"`     | A file the agent touched (issue #177's sidebar strip).           |
| `review_gate`  | `state: "waiting" \| "approved" \| "denied"`, `prompt: string` | A pending decision (issue #178's review gate — see below).       |
| `fork`/`join`  | `childPid: number`                                             | Validated and stored, not yet surfaced in any UI (Phase 5).      |

A `kind` this list hasn't been taught yet is accepted and stored verbatim
rather than rejected — this is what lets a newer hook author add a message
kind an older Mullion doesn't recognize without breaking the connection. A
malformed message (missing/wrong-typed fields for a _recognized_ kind, or
invalid JSON) gets a `{"error": "..."}` reply on the same connection, which
stays open — only a failed handshake or an oversized/unterminated line
closes it. See `src/services/hook-protocol.ts` for the authoritative parser.

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
   (never `~/.claude` or the repo) registering `Notification`, `Stop`, and
   `PostToolUse` hooks — each one invokes a small shared forwarder script
   (`src/hooks/forwarder.mjs`) that maps the hook's own JSON to the wire
   protocol above and writes it to `$MULLION_HOOK_SOCKET`. `PreToolUse` (the
   blocking review gate, see below) is added to the same file only when
   `MULLION_REVIEW_GATE_ENABLED=true`.
2. Appends `--settings <that file>` to the command actually spawned.

`Notification`/`Stop`/`PostToolUse` are always registered and are
fire-and-forget. `PreToolUse` is the one **blocking** hook — the review gate
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

No write to `~/.config/opencode` or a project's `.opencode/` happens at
all — fully ephemeral, same posture as Claude Code's `--settings` file, and
strictly less persistent than the originally-planned managed-install
fallback (superseded once `OPENCODE_CONFIG_DIR` was confirmed to work this
way). The plugin forwards only `session.idle` (→ `progress: done`) and
`file.edited` (→ `file_change`) — both non-blocking. OpenCode's real gating
hook is `permission.ask` (mutating an `output.status` of `ask`/`deny`/
`allow`), confirmed against the installed `@opencode-ai/plugin` package's
own types — **not** `tool.execute.before` throwing, as originally assumed
during planning. Unlike Claude Code's `PreToolUse`, it's still deliberately
not wired up: the review-gate endpoint now exists (issue #178), but
OpenCode's own `permission.ask` gating dialect was never implemented or
verified against a live plugin execution — tracked in issue #264 alongside
Codex's and agy's own deferred gate dialects.

**Codex** reuses the same shared forwarder as Claude Code (`src/hooks/
forwarder.mjs`, `codex` as its agent argv), registering `Stop` (→
`progress: done`) and `PostToolUse` (→ `file_change`, matcher `apply_patch`
— Codex has no `Notification` event at all). Unlike every other adapter,
this is **not ephemeral** — two facts verified against the real installed
Codex CLI during this PR contradict what the original plan assumed:

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

**agy** (Antigravity CLI) also reuses the shared forwarder (`agy` as its
agent argv), registering only `Stop` (→ `progress: done`). Config location
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
required.

`PostToolUse` (→ `file_change`) is **deliberately not wired up for agy**,
unlike every other adapter: agy's own documented `PostToolUse` payload
example shows only `{stepIdx, error, ...common fields}` — no tool name or
arguments field at all, so there's no verified field to extract a file path
from. Unlike Codex's `apply_patch` header format (a well-known public
format this PR could at least ground a parser in), inventing field names
here would be a pure guess with zero evidence. Left for a follow-up once
the real payload shape is confirmed against a live hook firing.

Because agy's hooks run **synchronously**, blocking its own agent loop
until each hook command exits, and its `Stop` contract expects a JSON
decision object on stdout, the shared forwarder now always prints `{}` to
stdout right before exiting (harmless for Claude Code/Codex, which don't
require or forbid any stdout output).

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

Only **Claude Code's `PreToolUse` (Bash only)** has a real gate dialect
wired up today — see issue #264 for why Codex, agy, and OpenCode don't yet.

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
  delete the `Stop`/`PostToolUse` hook group(s) whose `command` references
  a `forwarder.mjs` path — each entry also carries a `"statusMessage"` of
  `"Mullion agent-hook forwarder — safe to remove, see docs/agent-hooks.md"`
  so it's identifiable without cross-referencing this file.
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
