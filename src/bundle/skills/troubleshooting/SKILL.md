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
Mullion host skill's scope table says it should.

## A hook that silently stopped firing

If a hook-driven feature (a SessionStart nudge, a notification) that used
to work has gone quiet, and you're on Codex or agy: their hook registration
lives in a global, host-wide file (`~/.codex/hooks.json`,
`~/.gemini/config/hooks.json`) that points at a fixed, host-stable shim
(`~/.mullion/hooks/mullion-forwarder-shim.sh`), never at a live forwarder
path directly. Each session resolves its own real forwarder at run time
from the per-session `MULLION_FORWARDER_PATH` env var Mullion injects at
launch. If that path (or `node` itself) is ever unavailable, the shim fails
open — it prints a safe fallback decision and exits 0 instead of blocking
the tool call outright — so a hook-driven feature just silently no-ops
instead of breaking anything. Not something you can fix mid-session either
way — flag it to a human rather than assuming a code regression.

## Codex specifically: hooks need a one-time trust grant

Codex hook delivery (including the SessionStart nudge) additionally depends
on a one-time, interactive `/hooks` trust grant for Mullion's own hook
group. Until that's granted, Codex silently skips the hook entirely and
behaves exactly as if the feature didn't exist — not a bug you can fix from
inside a session either.
