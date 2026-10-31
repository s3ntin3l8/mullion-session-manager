# Session lifecycle: liveness, kill, rollback, cleanup and env

Read this when a diff touches how a session is declared dead, killed, rolled
back after a failed spawn, cleaned up on disk, or given its environment.
Verified against `origin/main` baf16a1e; code is cited by symbol, not line.

## 1. A dead verdict is destructive only on an affirmative `dead`

**Invariant.** The reconciler (`src/services/session-reconciler.ts`) acts only
on an explicit `liveness === "dead"`; `"unknown"` (version skew, listing
failure, an omitted id) is skipped. A scope backend or liveness consumer must
fill every requested id, or map a missing one to `"unknown"`. The row flips
`active -> exited` as a compare-and-set on `status`, and `terminate()` runs
only when `flipped.changes === 1`. New buckets in `isMasterAliveStateBatch`
keep the confident/uncertain split.

**Breaks.** One transient failure mass-exits live sessions, deleting hook
tokens, state and worktrees while the processes keep running.

**Check.** `git grep -n isMasterAlive -- src`; a `!alive` branch that mutates
state is a red flag.

## 2. Take the row out of the poller's candidate set before the slow op

**Invariant.** `killSession` (`src/services/session-lifecycle.ts`) flips
`active -> killed` with a CAS before awaiting `terminate()`. A "mark handled"
write guarding a concurrent reconciler or attach is synchronous with its check,
with no `await` between. Any flow that awaits a stop or spawn (re-seed, retry)
flips first and CASes back on failure.

**Breaks.** During a slow `systemctl stop` the row still reads `active`: the
reconciler calls it "exited on its own", fails the task and deletes the
worktree, or `/ws/terminal` bootstraps a fresh scope nothing sweeps.

**Check.** Ask which status the poller selects on, and whether the row has
moved off it before the first `await`.

## 3. `Session.kill()` ordering

**Invariant.** In `src/services/pty-manager.ts`, `Session.kill()` sets
`retired = true` first (every `await` checkpoint in `spawnInternal` checks it),
calls `stateFile.disable()` before `stateFile.flush()` and before the pty is
killed. `terminateInner` captures the `Session` before `kill(id)` drops it from
the map, then awaits that object's `spawnOutcome()`. The `exitHandled` latch
lives in the per-spawn closure, not on `this`.

**Breaks.** Reordering resurrects `<id>.state.json` after `terminate()` unlinked
it, leaves an orphan scope (a spawn landing after `stopScope`), or silences the
second incarnation's exit handler.

**Check.** Confirm `Session.kill()` is still called only from `PtyManager.kill`;
reject any class-level `exitHandled`-style field.

## 4. Spawn-failure rollback evicts the in-memory Session and token

**Invariant.** `PtyManager.getOrCreate` inserts the `Session` and its entry in
`hookTokens` before `spawn()` runs. Any create or spawn rollback that deletes
the DB row also calls `app.pty.kill(id)` (safe: nothing is attached yet) and
drops the other per-session maps, via `discardPendingSeed` and
`untrackSessionGithubAuth`.

**Breaks.** A failed spawn leaks a `Session` with its scrollback and a hook
token that still matches, until restart.

**Check.** Open each `catch` around `spawnOutcome()` and session-record
creation in `src/services/session-lifecycle.ts` and `src/routes/sessions.ts`.

## 5. Every per-session file needs a cleanup unlink; the sweep trusts only `dead`

**Invariant.** Any new file or directory under `<sessionsDir>/<id>.*` (token,
state, guide, briefing, adapter config, `<id>.tmp`) is added to
`cleanupSessionFiles` in `src/services/session-files-cleanup.ts`, which runs
from `terminate()`, not from `kill()` (which leaves artifacts for a reattach).
`sweepOrphanedSessionTmpDirs` removes only directories whose id is confirmed
`dead` and older than `MIN_ORPHAN_TMP_AGE_MS`.

**Breaks.** Files accumulate forever, or the sweep deletes a live dtach
session's `TMPDIR` after a restart: presence in the in-memory map means
"tracked", not "alive".

**Check.** Grep a hook-adapter diff for new `sessionsDir` path helpers and find
each in `cleanupSessionFiles`; sweep filters stay directory-only.

## 6. Session env ordering

**Invariant.** In `buildLaunchPlan` (`src/services/launch-plan.ts`),
`buildSessionEnv()` scrubs server identity first, then the caller's
`session.env` applies, then every Mullion-owned write (`MULLION_*`,
`SSH_AUTH_SOCK`, adapter additions). Reserved keys are also rejected at the API
boundary by `isReservedSessionEnvKey`.

**Breaks.** A caller re-injects a scrubbed server secret or overrides
`MULLION_SOCKET_PATH` / `SSH_AUTH_SOCK`, reaching the host's identity.

**Check.** No reorder of those three stages; a new env-carrying field must have
its keys reserved in `src/services/session-env-keys.ts`.
