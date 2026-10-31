# PTY-host protocol, scope ownership, remote hosts and git env

Read this when a diff touches `src/pty-host/`, scope listing or stopping in
`src/services/session-process.ts`, a remote-host call (`RemoteHostClient`,
`/internal/*`), or any code that spawns `git`. Verified against `origin/main`
baf16a1e; code is cited by symbol, not line.

## 1. PTY-host HELLO is frozen, the first frame precedes writes, tokens are file-handed

**Invariant.** The `pty-host` handshake is versioned in `src/pty-host/protocol.mjs`
(`FRAME_VERSION`, `PROTOCOL_VERSION`, `MIN_CLIENT_VERSION`). The HELLO payload from
`encodeHello` stays byte-identical, because a running master compares the whole
payload to its token; `test/fixtures/pty-host-protocol-v1.json` pins it. The client
writes HELLO and the initial resize synchronously in the attach body, and the master
accepts nothing before a valid HELLO. The token travels by env or the per-session
token file (`src/services/pty-host-token.ts`), never argv.
`BOOTSTRAP_MASTER_TIMEOUT_MS` stays above `SERVE_READY_TIMEOUT_MS`.

**Breaks.** Sessions outlive backend restarts, so a protocol tweak locks a live
master out of every new backend; a write before auth lets an unauthenticated peer
inject keystrokes.

**Check.** Diff `src/pty-host/` and the fixture. A change to `encodeHello` or the
fixture is a red flag.

## 2. Scope ownership resolves by socket path; destructive fallbacks stay namespaced

**Invariant.** A scope is ours only because its dtach socket directory is in the
owned-dir set (`listOwnedScopes`, `resolveOwningUnit`). `candidateIdForUnit` is a
guess that may only feed the unverifiable bucket. The `stopScope` fallback after a
listing failure targets only the namespaced `crs-session-<instanceId>-<id>` unit.
The listing cache key includes the sorted owned-dir set and the prefix.
`deriveInstanceId` hashes a `path.resolve`d dir, not a `realpath`.

**Breaks.** Two instances (or a test run) stop each other's sessions on a low
`sessions.id`; a realpath-derived id changes per deploy and orphans live scopes.

**Check.** Look for one-argument `scopeUnitName(id)` callers, ids parsed from a unit
name, and listing parameters missing from the cache key.

## 3. A new spawn-time field must reach the internal schema and handler

**Invariant.** A field carried by `SessionTarget`/`RemoteBackend.spawn` to
`POST /internal/sessions` must also be added to `spawnSessionSchema`
(`src/routes/internal-schemas.ts`, closed, with Fastify `removeAdditional`) and to
the handler in `src/routes/internal.ts`. Prefer an echo-back response field in the
`initialPromptApplied`/`taskIdApplied` style so version skew is visible.

**Breaks.** The agent drops the field silently, with no error or log; the feature
works for local sessions only.

**Check.** `git grep -n <newField> -- src/routes/internal-schemas.ts
src/routes/internal.ts`; a miss in either is the bug.

## 4. HMAC body hashing assumes `JSON.stringify` on both ends; the unsigned list is an allowlist

**Invariant.** The agent re-derives the body hash from the parsed body, so every
`RemoteHostClient` call sends `JSON.stringify(plainObject)` with a JSON content
type. Streaming or raw bodies must be listed in `UNSIGNED_BODY_PATH_PREFIXES`
(`src/services/request-signature.ts`), matched on a path boundary and derived from
the path on both ends. Adding a prefix widens the security surface.

**Breaks.** A raw string, non-JSON content type or integer past 2^53 re-serialises
differently and every call 401s with no visible cause; too broad a prefix passes a
tampered body.

**Check.** New `request()` sites send stringified JSON. A new prefix needs a test
and a stated reason.

## 5. Git over a remote host dispatches by `hostId`, maps two error classes, contains paths

**Invariant.** Git features go through `src/services/host-git.ts` or
`SessionBackend` keyed by the `hostId`, never a `git-*.ts` module with a bare cwd.
`HostRequestError` (4xx, including an old agent's 404) means unsupported, update the
host; `HostUnreachableError` means retry later; anything else rethrows. A new
`/internal/*` git route validates every path with `resolveWithinRoots` and sets a
timeout above the default if it makes several git calls.

**Breaks.** A remote project's git op runs on the primary's filesystem, a skewed
agent yields a 500, or a path outside `PROJECTS_ROOTS` is touched.

**Check.** Grep task and route code for direct `git-status`/`git-worktree` imports
that skip `host-git.ts`; confirm each new internal handler calls `resolveWithinRoots`.

## 6. Spawn git with `gitEnv()`; the strip-list is copied in three files

**Invariant.** Every `git` subprocess in `src/`, `test/` and `scripts/` passes
`env: gitEnv()`, which strips `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and
friends and forces `LC_ALL=C`. The list is duplicated on purpose in
`src/services/git-env.ts`, `scripts/git-env.mjs` and `src/hooks/worktree-hook.mjs`;
`test/git-env-guard.test.ts` compares them.

**Breaks.** Code running inside a git hook or worktree writes to the real
checkout's config, index or branches; a key added to one copy leaves the others open.

**Check.** Grep for `execFile`/`spawn` of `"git"` lacking `gitEnv`; diff the three
arrays when a key changes.

## 7. Branch and worktree guards are scoped by checkout, not project row

**Invariant.** A guard on a branch-moving or worktree-removing git route finds
live sessions by effective cwd and host across every project
(`sessionsInProjectCheckout` in `src/routes/projects.ts`), never by
`sessions.projectId`. A project whose cwd is itself a linked worktree is left out
of the "other worktrees" list. Git-level refusals answer `200` with a `reason`;
only an unreachable host, a schema error or an unknown project are error
statuses. The sweeper owns only directories with the `TASK_WORKTREE_PREFIX`
prefix, so a new worktree namespace needs its own cleanup owner.

**Breaks.** Two project rows pointing at one checkout let one check out a branch
under the other's live session; a new worktree prefix leaks a directory and a git
registration on the host forever.

**Check.** Grep new session lookups in the git routes for `projectId`; for a new
worktree creator confirm `TASK_WORKTREE_PREFIX` and `pruneWorktrees` cover it.
