# Cross-cutting patterns: pinning tests and enumerated rules

Read this when a diff claims to fix a bug with a regression test, or changes
which agents, hosts, keys or settings a rule applies to.
Verified against `origin/main` 2731ea21; code is cited by symbol, not line.

## 1. A test that pins a fix must redden when the fix is removed

**Invariant.** Frontend guard tests are often vacuous in three ways. A negated
assertion right after resolving a deferred mock passes before the component's
`.then` runs; it needs the resolve wrapped in an awaited `act`. A mock keyed on
the project id records the new id on a reused instance, so a key or remount
test needs mount-only dependencies or a counter. Escape on a `disabled` button
never reaches the modal's key handler. A refactor from a `Set` of subscribers
to a refcounted `Map` needs connected assertions: N-1 unsubscribes send
nothing, the last one sends, reconnect resubscribes, StrictMode's 1 to 0 to 1
cycle holds. Module-level state needs a reset hook such as
`__resetRefreshSessionsInFlightForTests` in `frontend/src/store/slices/sessions.ts`.

**Breaks.** A green suite that never exercised the fix, so the bug returns
unnoticed; multi-subscriber UIs drop updates on remount or reconnect.

**Check.** Revert only the production change (`git checkout origin/main --
<src file>`), keep the new tests, and run them: they must fail.

## 2. A change to an enumerated rule updates every enumeration

**Invariant.** When a diff changes which agents, hosts, keys or labels a rule
covers (the fail-closed set behind `isSandboxCapable` in
`src/services/scaffold-generate.ts`, the key set in `MobileKeyBar`, a settings
label), every other place that lists the old set changes in the same PR: docs,
JSDoc, test `describe` titles, and the description strings in
`src/plugins/env.ts`.

**Breaks.** Documentation, help text and test names contradict behavior, and
the next change trusts the stale list.

**Check.** `git grep -n` the added or removed member, plus words that mark a
closed list ("only", "the other three", "all of"), across `src`, `frontend/src`
and `docs`.
