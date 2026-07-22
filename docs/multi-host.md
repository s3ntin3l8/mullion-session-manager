# Multi-host sessions

Mullion can run AI CLI sessions on more than one machine from a single
dashboard. One instance is the **primary** (the one you open in your
browser); every other machine runs the **same Mullion codebase**, just
started in a different role, as an **agent**.

## Is an agent different software?

No — it's the identical `mullion` build, just booted with `MULLION_ROLE=agent`
instead of the default `primary`. There's no separate agent package or
binary to install. The role flag changes what the process does at startup
(`src/app.ts`):

- **`primary`** (default) — today's full app: owns the SQLite DB, serves the
  frontend, and runs every product route (`projects`, `sessions`,
  `workspaces`, ...).
- **`agent`** — a stripped-down, DB-less process. No `dbPlugin`, no
  `staticPlugin` (there's no frontend to serve), none of the DB-backed
  routes. It registers only `PtyManager` (so it can spawn/attach terminal
  sessions on that host) and a token-gated internal API
  (`src/routes/internal.ts`) that the primary calls to control it. An agent
  refuses to boot at all if `MULLION_AGENT_TOKEN` is unset — see
  `src/app.ts`'s fail-closed check.

The primary never parses or trusts anything about a remote host beyond that
internal API; from the primary's point of view, a session either runs on its
own `app.pty` (the `local` host) or gets proxied to a `RemoteHostClient`
talking to an agent's `/internal/*` routes over HTTP + WebSocket
(`src/services/session-backend.ts`, `src/services/remote-host-client.ts`).

## Setting up an agent host

1. **Install and configure Mullion on the remote machine** exactly like a
   normal deploy (see the main [README](../README.md) Quick Start /
   [`deploy/`](../deploy/) for a native `systemd --user` install) — same
   `dtach` dependency, same build.
2. **Set two environment variables** on that machine (`.env` or the
   `systemd` unit's environment):

   ```bash
   MULLION_ROLE=agent
   MULLION_AGENT_TOKEN=$(openssl rand -hex 32)
   ```

   Leave `DATABASE_URL`, `DB_ENCRYPTION_KEY`, `FRONTEND_DIST`, etc. unset —
   an agent ignores them, since it never touches the DB or serves the
   frontend.

3. **Start it.** It boots to `/health`/`/ready` plus the internal API; there
   is no UI to open on the agent itself — you never point a browser at it.
4. **Register it on the primary**: open the primary's dashboard →
   **Settings → Hosts → Add host**, and fill in:
   - **Name** — any label (e.g. `home-server`).
   - **Base URL** — where the agent is reachable, e.g.
     `http://192.168.1.20:4000`.
   - **Token** — must exactly match that agent's `MULLION_AGENT_TOKEN`.

   Once saved, use **Ping** in the Hosts list to confirm connectivity.

5. **Create (or move) a project onto that host.** The project-creation modal
   gets a host picker once at least one remote host is registered; every
   session under that project spawns and runs on the agent, and terminal
   attach streams through the primary's own `/ws/terminal` — the browser
   only ever talks to the primary.

## Treat the agent token like a credential

`MULLION_AGENT_TOKEN` gates `/internal/ws/attach`, which runs
`${SHELL} -lc "<command>"` for any request bearing a valid token — a leaked
token is arbitrary command execution on that host. Generate it with real
entropy (`openssl rand -hex 32`), use a different token per agent, and
rotate it the same way you'd rotate an SSH key with shell access to that
box.

## What this does and doesn't protect against

Registering a host (`POST`/`PATCH /api/hosts`) is an admin-only, authenticated
config action — the same trust level as editing `PROJECTS_ROOTS` — not user
input crossing a privilege boundary. The base URL is still checked against
obvious credential-leak targets (link-local addresses, cloud instance
metadata endpoints like `169.254.169.254`, RFC 6598 shared-NAT space, and
their IPv6/IPv4-mapped equivalents), but this is a registration-time check,
not connection-time IP pinning — it doesn't defend against a hostname that
resolves safely at registration and is rebound afterward. If you need to
harden against that, treat host registration as trusted-admin-only (it
already effectively is) rather than exposing it to anyone you wouldn't also
hand a bearer token with shell access.

## Failure behavior

An unreachable agent's sessions are reported as unknown, never treated as
exited — a network blip must never look like every session on that host
died. Deleting a host with existing projects requires either moving/deleting
those projects first, or `?cascade=true`, which best-effort terminates that
host's live sessions before removing the rows (best-effort because an
already-unreachable agent can't be told to terminate anything, and that
can't block removing an otherwise-useless host row).

## Current limitations

- No auto-discovery — hosts are registered manually with a URL and shared
  token.
- No in-app auth on the agent's internal API beyond the bearer token; put it
  behind the same network/VPN boundary you'd use for anything else with
  shell access.
- Connection-time IP pinning (full DNS-rebinding protection) is not yet
  implemented — see "What this does and doesn't protect against" above.
