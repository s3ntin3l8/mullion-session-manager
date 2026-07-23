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
| `review_gate`  | `state: "waiting" \| "approved" \| "denied"`, `prompt: string` | A pending decision (issue #178's review gate — not built yet).   |
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
   protocol above and writes it to `$MULLION_HOOK_SOCKET`.
2. Appends `--settings <that file>` to the command actually spawned.

Only these three hooks are registered. `PreToolUse` — which would gate a
tool call on a human decision — is deliberately **not** wired up yet: there
is no endpoint to ever answer it (that's issue #178's review gate), and a
blocking hook with nothing to resolve it would hang every real tool call
instead of just not being there. `Notification`/`Stop`/`PostToolUse` are all
fire-and-forget, so this is safe to ship ahead of the gate itself.

Codex and agy (Antigravity CLI) get their own adapters reusing this same
socket/forwarder in follow-up PRs (issues #252/#253); OpenCode has no
shell-command hooks at all, so it gets a small plugin instead (issue #175).

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
