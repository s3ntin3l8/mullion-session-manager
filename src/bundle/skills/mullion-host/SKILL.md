---
name: mullion-host
description: "How to reach back into Mullion from inside a session it's hosting: CLI, MCP, hook socket, and their scope limits. Read this if you're an agent CLI (Claude Code, Codex, opencode, agy) running inside a Mullion-hosted session, in ANY repo — this skill is Mullion's own, not specific to any project."
---

# Mullion agent guide (pointer)

If you're reading this, you're running as an agent CLI inside a Mullion-hosted
session — regardless of which repo this session's working directory is in.
Mullion gives a hosted session three ways to reach back into the system
hosting it: the `mullion` CLI, an MCP server, and a hook socket — each scoped
to the session itself, not full operator access.

A session-specific copy of the full guide was written for you at:

```
$(dirname "$MULLION_HOOK_SOCKET")/$MULLION_SESSION_ID.agent-guide.md
```

Both `$MULLION_HOOK_SOCKET` and `$MULLION_SESSION_ID` are environment
variables every Mullion-hosted session has. Read that file — it covers the
four environment variables every session gets, what's reachable at session
scope vs. full scope, CLI vs. MCP, browser automation, child-session
spawning, and notifying the human — before reaching for any command syntax.

This skill deliberately does not point at a path inside any particular
repo's checkout (e.g. `docs/agent-guide.md`): it is delivered into every
session Mullion hosts, in every project, and the per-session copy above is
the only location guaranteed to exist regardless of which repo you're in.
