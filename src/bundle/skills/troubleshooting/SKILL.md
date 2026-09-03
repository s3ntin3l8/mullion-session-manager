---
name: troubleshooting
description: "Common failures when reaching back into Mullion from a hosted session: 403s, a stale hook forwarder path, and how to read mullion config's output. Read this if something that should work against the Mullion control socket or hook channel isn't, from inside a Mullion-hosted session."
---

# Mullion troubleshooting

Check for `$MULLION_SESSION_ID` before following anything below — if it's
unset, you're not inside a Mullion-hosted session; none of this applies.

## "If something 403s"

You named a full-scope-only op, or a session id you're not pinned to. This
is expected, not a bug — see the Mullion host skill's scope model table
for exactly which ops are session-reachable. Run `mullion config` (below)
to confirm which scope your connection actually resolved to. If you're
certain this should have worked, check whether authentication is disabled
on this host — the scope model doesn't apply at all in that mode, so a 403
there means something else is wrong.

## Reading `mullion config`

```bash
mullion config
```

Prints the resolved socket path, which env var supplied the token, your own
session id, and the **resolved scope** (`full`/`session`) — determined by
actually probing a full-scope-only op, not just inspecting which token you
were handed. Run this first whenever behavior doesn't match what the
the Mullion host skill's scope table says it should.

## A hook that silently stopped firing

If a hook-driven feature (a SessionStart nudge, a notification) that used
to work has gone quiet, and you're on Codex or agy: their hook registration
lives in a global, host-wide file (`~/.codex/hooks.json`,
`~/.gemini/config/hooks.json`) that only gets rewritten when a session of
that agent type is spawned. If the forwarder path it points at was deleted
(a `make dev` worktree that's since been removed, for example), every hook
for that agent silently no-ops until the next spawn self-heals it. Not
something you can fix mid-session — flag it to a human rather than assuming
a code regression.

## Codex specifically: hooks need a one-time trust grant

Codex hook delivery (including the SessionStart nudge) additionally depends
on a one-time, interactive `/hooks` trust grant for Mullion's own hook
group. Until that's granted, Codex silently skips the hook entirely and
behaves exactly as if the feature didn't exist — not a bug you can fix from
inside a session either.
