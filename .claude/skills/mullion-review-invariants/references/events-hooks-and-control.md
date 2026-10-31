# Event history, hook protocol, hook adapters and the control socket

Read this when a diff touches `session_events` persistence, the hook forwarder or
`src/plugins/hooks.ts`, a per-CLI adapter under `src/services/hook-adapters/`, or
`src/plugins/control-socket.ts` and the control relay. Verified against
`origin/main` baf16a1e; code is cited by symbol, not line.

## 1. Persisted event identity is `(session_id, seq, ts, kind)`; remote events fail closed

**Invariant.** `session_events` has the unique index `session_events_dedupe_idx` over
those four columns (`src/db/schema.ts`), and `src/services/event-history.ts` inserts
with `onConflictDoNothing`. Replay is idempotent, and a restart's reset `seq` stays
distinct through `ts`. Remote events pass `filterHostOwnership`
(`src/services/event-store.ts`): session, project and host must match the reporting
host; a failed read drops only unverifiable remote rows.
`src/services/remote-event-subscriber.ts` treats the persistence setting as
tri-state, so an unreadable setting never opens or tears down subscriptions. A new
event kind must be registered in `KIND_LABELS` (`frontend/src/eventDescriptions.ts`)
or its stored rows are dropped as unknown.

**Breaks.** Narrowing the key to `(session_id, seq)` duplicates the timeline on
reconnect or drops real post-restart events.

**Check.** Diff the index in `schema.ts`; for a new kind check `KIND_LABELS` and
`src/services/hook-protocol.ts`.

## 2. Blocking-reply messages go after siblings; the reply set must match `hooks.ts`

**Invariant.** `src/hooks/forwarder.mjs` sends the handshake, then every sibling in
order, then the blocking message (`review_gate`, `session_start`) on one connection.
Gate handling settles on the first reply line, so a sibling that draws a reply is
read as the answer. `REPLY_ELICITING_KINDS` (`src/hooks/forwarder-core.mjs`) must
list exactly the kinds `src/plugins/hooks.ts` answers with a socket write; a new
reply-eliciting kind is added in both. Mappers never emit a sibling that fails
`src/services/hook-protocol.ts` validation (a `git_branch` with an empty branch
draws an error reply).

**Breaks.** A permission gate settles on a stray error line and falls through to the
agent's own prompt, or a stale `cwd_changed` lands after the `git_branch` that
carries the worktree.

**Check.** Compare `socket.write` sites in `hooks.ts` with the Set; confirm
`typeof x === "string" && x.length > 0` guards on constructed siblings.

## 3. Agent payload dialect: `ExitPlanMode` and gate replies

**Invariant.** `PermissionRequest` maps to a `review_gate`, except Claude Code's
`ExitPlanMode`, which stays an observational `permission_request` because
`PreToolUse` already maps it to `plan_ready` and gates are not deduplicated.
`no_response` formats to bare `{}` in `formatGateDecision` so the native prompt takes
over. A Codex reply never sets `interrupt`, `updatedInput` or `updatedPermissions`.

**Breaks.** An unwanted blocking gate on plan exit, a double attention badge, a Codex
reply that fails closed.

**Check.** Run `test/hooks/forwarder-core.test.ts`.

## 4. Per-CLI launch flags: TOML inline table, shell-quoted, realpath, `taskId !== undefined`

**Invariant.** Codex `-c` overrides are built with `tomlString` then `shellQuote`.
The trust override from `buildCodexTrustFlag` is a TOML inline table keyed by the
`realpath` of the cwd, not a dotted path, since cwds contain dots
(`.mullion-worktrees/`). Task Master unattended behaviour (denying human-only
skills) is gated on `ctx.taskId !== undefined`, so task id 0 counts, and the deny
list stays identical across the codex and opencode adapters.

**Breaks.** A hung folder-trust prompt no hook ever sees; an unattended worker
blocking on a human-only skill.

**Check.** Grep for `if (ctx.taskId)`; a truthy test is the bug.

## 5. Control-socket scope enforcement is structural

**Invariant.** A full-scope-only op goes through `injectRoute`, which 403s any other
connection. A session-reachable op uses a `DeclaredResolver` built with `pinned(...)`
or `unscoped(...)`; the `routeOp` overloads make a bare function for such an op a
compile error, so do not loosen them. Session ops forwarding a body into a REST
schema use the closed allowlist `SESSION_SPAWN_CHILD_FIELDS`, with privilege-widening
values such as `skipPermissions` capped by the parent's own. A pinned connection
re-checks that its session row is still active on each privileged op, since the hook
token outlives the process.

**Breaks.** A hook-token holder gains full-scope behaviour, or spawns and messages
after its session died.

**Check.** For a new op read its `scopes` in `OPS`; diff the allowlist against
`createSessionSchema`; add a row to `docs/socket-api.md`.

## 6. A relay refusal is a fatal frame; relayed sessions are re-validated per request

**Invariant.** A refused or closed relay connection is reported through
`relayErrorFrame`, used by both `src/services/control-relay-agent.ts` and the
primary side. Relayed connections skip the handshake, run at session
scope with streaming ops refused, and each request calls `relayedSessionDenied` to
re-check the session row and host binding. The
`MULLION_CONTROL_UNAVAILABLE=remote-host` literal is a contract between
`launch-plan.ts` and `src/cli/client.mjs`.

**Breaks.** Clients mistake a harmless error for a dead connection or never learn it
died; a compromised agent mints requests for sessions it does not host; marker drift
disables the CLI's fast-fail.

**Check.** A hand-built `{id: null, ok: false}` outside the helper is wrong; grep the
marker literal in both files.
