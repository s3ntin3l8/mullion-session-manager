---
name: mullion-agent-guide
description: "How to reach back into Mullion from inside a session it's hosting: CLI, MCP, hook socket, and their scope limits. Read this if you're an agent CLI (Claude Code, Codex, opencode, agy) running inside a Mullion-managed terminal session."
---

# Mullion agent guide (pointer)

If you're reading this, you're likely running as an agent CLI inside a
Mullion-hosted session in this repository (or a checkout of it). Mullion gives
a hosted session three ways to reach back into the system hosting it — the
`mullion` CLI, an MCP server, and a hook socket — each scoped to the session
itself, not full operator access.

The full guide lives at `docs/agent-guide.md` in this checkout — read it
first, especially its "scope model" section, before reaching for any command
syntax. It covers: the four environment variables every session gets, what's
reachable at session scope vs. full scope, CLI vs. MCP, browser automation,
child-session spawning, and notifying the human.

If you were spawned by Mullion (rather than just working in a checkout of this
repo), a session-specific copy of that same file was very likely already
written for you at
`$(dirname "$MULLION_HOOK_SOCKET")/$MULLION_SESSION_ID.agent-guide.md` — that
copy is identical content, just resolved without needing this repo's working
tree. Either source is authoritative; this file is a pointer to them, not a
third copy — see `docs/agent-guide.md` itself for the mechanism.
