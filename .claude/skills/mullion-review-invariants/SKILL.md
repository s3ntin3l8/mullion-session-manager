---
name: mullion-review-invariants
description: "Repo-specific correctness invariants for this codebase (Mullion) — read this before reviewing or writing a diff here. Covers the sessions.command/workspaces.layout opaque-blob rule, the three NODE_ENV=test guards that must not be simplified, ESM .js import specifiers, config-via-app.config, DB migration generation, and the two distinct worktree concepts, plus per-area references (the task review loop and verdict contract, and more) that `node scripts/review-references.mjs` picks by the diff's changed files. Companion to the generic autonomous-pr-review skill, which deliberately carries no repo-specific invariants of its own."
---

# Mullion review invariants

`AGENTS.md` states the rules below in brief; this
skill exists so a review pass (or `/code-review`, or a `mullion-reviewer`
sub-agent) checks them mechanically instead of relying on having read and
remembered that file. If a diff violates one of these, it's very likely
wrong even if it's internally consistent and well-tested.

## Per-area references

Beyond the checklist below, `references/` holds one note per area where a
plausible-looking change breaks something the diff does not show. Which ones
apply to a diff is decided by path, not by judgement: run

    node scripts/review-references.mjs

from the checkout under review (it diffs `origin/main...HEAD`; `--base <ref>
--head <ref>` overrides, `--files -` reads changed paths from stdin) and read
every reference it lists before judging the diff. `references.json` is the
index; the same areas are:

| Reference                                                                             | Read it when a diff touches                                                |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [`task-verdict-contract.md`](references/task-verdict-contract.md)                     | review verdict parsing, storing, posting, the reviewer App identity        |
| [`task-review-ingest-and-handle.md`](references/task-review-ingest-and-handle.md)     | review ingestion, the review handle columns, `TASK_ROW_COLUMNS`            |
| [`task-reconcile-loop.md`](references/task-reconcile-loop.md)                         | `reconcileTasks` sweeps, auto-return and rounds, approval carry            |
| [`task-rebase-and-worktrees.md`](references/task-rebase-and-worktrees.md)             | auto-rebase, the review-spawn pass, `mergeable`, worktree reclaim          |
| [`task-merge-and-cleanup.md`](references/task-merge-and-cleanup.md)                   | the merge sweep, retry-state maps, task session cleanup, the workflow gate |
| [`review-relay.md`](references/review-relay.md)                                       | the Hermes review relay and external-reviewer runs                         |
| [`boot-auth-and-limits.md`](references/boot-auth-and-limits.md)                       | boot-time auth checks, the credential reader, the origin gate, rate limits |
| [`session-lifecycle.md`](references/session-lifecycle.md)                             | session liveness, kill, spawn rollback, per-session files, session env     |
| [`pty-host-scope-and-remote-hosts.md`](references/pty-host-scope-and-remote-hosts.md) | the PTY-host protocol, scope ownership, remote hosts, git over a host      |
| [`events-hooks-and-control.md`](references/events-hooks-and-control.md)               | event history, the hook protocol, adapter launch flags, the control socket |
| [`settings-and-schema-threading.md`](references/settings-and-schema-threading.md)     | a new per-project field or setting, default copies, env keys               |
| [`api-route-contracts.md`](references/api-route-contracts.md)                         | batch GET routes, PATCH bodies, destructive endpoints gated on settings    |
| [`scaffold-and-bundle.md`](references/scaffold-and-bundle.md)                         | the project scaffold, bundled skill sources                                |
| [`dockview-layout.md`](references/dockview-layout.md)                                 | dockview groups, layout mutations, floating clamps, breakpoints            |
| [`dock-docker-lifecycle.md`](references/dock-docker-lifecycle.md)                     | the Dock, compose recreate, docker-logs auto-attach, Dock availability     |
| [`frontend-state-and-effects.md`](references/frontend-state-and-effects.md)           | render-phase state, effects, per-project state, busy dialogs, store errors |
| [`cross-cutting-patterns.md`](references/cross-cutting-patterns.md)                   | tests that pin a fix, enumerated rules                                     |

Each reference states the invariant, what breaks, and how to check it, and was
verified against the code when it was written; if one contradicts the code you
are reading, the code wins: say so in the review.

## The opaque-blob invariant

See `AGENTS.md`. The deliberate exception is `src/services/hook-adapters/`:
each adapter's own `commandTransform` (Claude Code's appends `--settings`/
`--mcp-config`/`--plugin-dir`; Codex's and agy's append their own MCP/model
flags the same way) inspects and rewrites the launch command at spawn time.
Alongside that, the pure lookups exported by `hook-adapters/index.ts` and
`hook-adapters/shared.ts` are the sanctioned way for code elsewhere to ask about
a command's shape: the `commandIs*` predicates (`commandIsOpencode`,
`commandIsMcode`), `commandModelCli`, `commandAgentBin`, `buildModelFlag`,
`getAdapterPromptFraming` (what `sessions.prompt` in
`plugins/control-socket.ts` uses to frame input for the child's agent family),
`getAdapterEmits`, `getAdapterTranscriptFormat`,
`getAdapterInitialPromptArgs`/`adapterHasInitialPromptArgs`,
`getAdapterResumeSessionArgs`/`adapterHasResumeSessionArgs` and
`getAdapterDelegationHint`, plus `validateModel`/`validateCliModel`
(`services/task-model-resolve.ts`) and `commandSupportsSeed`
(`services/task-agent-resolve.ts`). This list is examples, not a closed
whitelist: any helper in it, or any command-shape lookup exported from
`hook-adapters/`, is sanctioned. Callers elsewhere (`task-claim.ts`, `task-reconciler.ts`,
`routes/sessions.ts`, `session-transcript.ts`, `pty-manager.ts`) use them to
branch on a command's agent family, inject a model flag, or decide whether a
real first-turn prompt can be delivered.

**Red flag:** any new code that calls `.split()`, a regex, or a shell
parser on `session.command` or `workspace.layout` **outside** a hook
adapter's own `commandTransform` or one of those sanctioned helpers. A
caller reaching for `commandIsOpencode`/`commandModelCli`/
`commandSupportsSeed`/`buildModelFlag` is fine — that's the invariant's
whole point, a single place the shape lives, not everyone re-deriving it.
If a change needs to know something new about a command's shape that none
of those helpers already expose, that's a sign the data belongs in a typed
field, not squeezed out of the opaque string.

## The three `NODE_ENV=test` guards — do not simplify or combine

See `AGENTS.md`. These look redundant at a glance — they are not. Each
guards a different failure mode in a different tool. **Red flag:** a diff
that merges these into one shared check, or removes one because "the others
already cover it."

## ESM conventions

See `AGENTS.md`. **Red flag:** a diff that mixes value and type imports
from the same module without `import type`, or an import specifier missing
`.js`.

## Configuration

See `AGENTS.md`. **Red flag:** a new `process.env.SOMETHING` read outside
`env.ts` itself or a script under `scripts/`.

## DB migrations

See `AGENTS.md`. **Red flag:** a schema change with no corresponding new
file under `drizzle/`.

## The two worktree concepts — don't conflate them

See `AGENTS.md` for the base rule. Reconciliation detail beyond its
one-line summary: `.mullion-worktrees/` reconciliation is scoped to the
`mullion-task-` prefix plus manual Source Control removal — an interactive
"promote to worktree" session's own worktree has no reconciler at all and
needs manual cleanup.

**Red flag:** code or docs that treat these as the same thing, or that
assume `.wt/` worktrees get automatic cleanup the way `mullion-task-`
worktrees do.

## Test conventions

See `AGENTS.md`. Tests use `app.inject()` — not a real HTTP server — for
route tests.

## Clean mergeability onto `origin/main`

A PR branch must cleanly rebase or merge onto the latest `origin/main`
without conflicts. A review pass must check mergeability against `origin/main`.
If there are merge conflicts, a reviewer must NEVER issue a `clean` verdict;
it must return `changes-requested` so the worker rebases before approval.

## Patch test coverage ($\ge 75\%$)

New or modified executable lines in `src/` and `frontend/src/` must meet
at least $75\%$ patch coverage (`make test-patch-coverage`). Dropped patch
coverage is reported on the PR as the advisory `codecov/patch` status.

## Security anti-patterns & CORS credentials

Never set `Access-Control-Allow-Credentials: true` alongside wildcard or
dynamically reflected origins (CodeQL `js/cors-misconfiguration-for-credentials`).
Run `npm run check:security-antipatterns` (part of `make lint`).
