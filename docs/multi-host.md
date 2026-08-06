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
  sessions on that host) and a token/session-gated internal API
  (`src/routes/internal.ts`) that the primary calls to control it. An agent
  refuses to boot at all unless it has a path to a shared credential —
  either `MULLION_AGENT_TOKEN` (manual) or both `MULLION_PRIMARY_URL` and
  `MULLION_ENROLLMENT_TOKEN` (self-registration, see below) — see
  `src/app.ts`'s fail-closed check.

The primary never parses or trusts anything about a remote host beyond that
internal API; from the primary's point of view, a session either runs on its
own `app.pty` (the `local` host) or gets proxied to a `RemoteHostClient`
talking to an agent's `/internal/*` routes over HTTP + WebSocket
(`src/services/session-backend.ts`, `src/services/remote-host-client.ts`).

## Setting up an agent host

The recommended way to bring an agent online is **self-registration** — no
manual step on the primary at all, the path a scripted/automated deploy
(e.g. an Ansible playbook) should use. See
[`deploy/README.md`](../deploy/README.md)'s "Automating agent deploys"
section for the full deploy-tooling contract (`install.sh --role agent`,
the systemd unit, an example Ansible role); the protocol itself is
documented here. **Manual registration** (a pre-provisioned, per-agent
static token, added by hand in Settings → Hosts) is also supported, for a
one-off host or anyone who'd rather not hand a shared enrollment secret to
automation — see below.

### Self-registration (zero manual steps)

The agent registers itself against the primary's
`POST /api/internal/register` endpoint on boot, with **no
`MULLION_AGENT_TOKEN` at all**. Set, on the agent:

```bash
MULLION_ROLE=agent
MULLION_PRIMARY_URL=https://primary.example.com
MULLION_ENROLLMENT_TOKEN=<fleet-wide-secret, matches the primary's MULLION_ENROLLMENT_SECRET>
MULLION_AGENT_ADVERTISE_URL=http://192.168.1.20:4000   # optional; defaults to http://<hostname>:<PORT>
MULLION_AGENT_NAME=home-server                          # optional; defaults to the hostname
```

...and, on the primary:

```bash
MULLION_ENROLLMENT_SECRET=<the same fleet-wide secret>
MULLION_ENROLLMENT_ALLOWED_CIDRS=10.0.0.0/8              # optional — restricts which peer IPs may enroll
```

`MULLION_ENROLLMENT_ALLOWED_CIDRS` checks the raw TCP peer address
(`request.ip`) — `trustProxy` is off app-wide (see `docs/auth.md`), so if
your primary sits behind a reverse proxy (Traefik, per `deploy/README.md`),
every enroll attempt arrives from the proxy's own address, not the agent's.
List the proxy's address in the range (or leave the setting unset and rely
on `MULLION_ENROLLMENT_SECRET` alone) rather than debugging unexpected 403s.

On boot the agent presents `MULLION_ENROLLMENT_TOKEN` to the primary's
register endpoint; the primary either **claims** an existing host row whose
own `MULLION_AGENT_TOKEN` matches (letting you pre-provision a per-agent
secret the same way as manual registration, just delivered automatically),
or, if the token instead matches `MULLION_ENROLLMENT_SECRET`, **enrolls** a
brand-new host row from the agent's self-reported name/URL. Either way the
primary issues a short-lived session (`session_id`, 24 h TTL, expiry
enforced on renewal too — not just advisory) that becomes the agent's
_inbound_ credential from then on — the enrollment token is used exactly
once per boot, never accepted as a bearer token itself. A `session_secret`
is issued and stored alongside it, but isn't used for authentication yet;
it's provisioned now as the future HMAC signing key for roadmap 7.5. The
agent renews its session at ~50% of its TTL, and re-runs the full
enrollment call (with retry/backoff, so a briefly-down primary never blocks
the agent's own boot) if a renewal ever comes back `401`.

Newly-enrolled hosts are distinguishable from manually-registered ones via
the API's `origin: "enrolled" | "manual"` field on `GET /api/hosts` — a
Settings → Hosts UI badge surfacing this (so an unexpected enrolled host is
easy to spot at a glance, not just via the API) hasn't shipped yet; the data
is there for a follow-up to render it.

Advertised URLs must be unique per agent, the same requirement manual
registration already has implicitly. `MULLION_AGENT_ADVERTISE_URL`'s
`http://<hostname>:<PORT>` fallback only produces a unique URL if hostnames
are actually unique across your fleet (true for most cloud/container
provisioning, not guaranteed for a hand-cloned VM image) — two agents
sharing a baseUrl will repeatedly "steal" the same host row from each other
on their independent renewal cycles. Set `MULLION_AGENT_ADVERTISE_URL`
explicitly if you can't guarantee that.

Rotating a manually-registered host's token (Settings → Hosts → Edit, or
`PATCH /api/hosts/:id`) also revokes any session that host had established
via self-registration, immediately — this is what makes token rotation a
real response to a suspected leak rather than a no-op once a host has
switched to session-based auth.

### Manual registration (also supported)

A pre-provisioned, per-agent static token, added by hand — the original
flow, still fully supported for a one-off host or anyone who'd rather not
hand a shared enrollment secret to automation:

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

## Treat agent credentials like credentials

Whichever path an agent uses, its inbound credential — `MULLION_AGENT_TOKEN`
for a manually-registered host, or the primary-issued session for a
self-registered one — gates `/internal/ws/attach`, which runs
`${SHELL} -lc "<command>"` for any request bearing a valid one: a leaked
credential is arbitrary command execution on that host. For manual tokens,
generate them with real entropy (`openssl rand -hex 32`) and use a different
one per agent. `MULLION_ENROLLMENT_TOKEN`/`MULLION_ENROLLMENT_SECRET` are a
different kind of secret — bootstrap-only, never an inbound credential — but
still worth the same handling (real entropy, restrict who can read the env
file, rotate like you would an SSH key with shell access to the fleet).

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

### Graceful deregistration on shutdown

A self-registered agent traps `SIGTERM`/`SIGINT` (the same signals a
`systemctl --user stop`/`restart` sends) and, before exiting, calls
`POST /api/internal/deregister` on the primary with its current session
credential — a request bounded to ~2 seconds and entirely best-effort: an
unreachable primary never blocks or delays the agent's own shutdown, and the
heartbeat sweep above is still the fallback for an ungraceful exit (a crash,
`kill -9`, or a network partition). The effect is purely a faster status
update — a clean shutdown reflects as offline in Settings within the
request's own round-trip, instead of waiting on the heartbeat's 3-missed-ping
window.

This is deliberately **status-only**: unlike `DELETE /api/hosts/:id
?cascade=true` above, it never terminates the host's live sessions. Every
dtach session an agent hosts is bootstrapped into its own `systemd-run`
scope specifically so it survives an agent process restart (see
`deploy/mullion-agent.service`) — and this shutdown hook fires on _every_
graceful `SIGTERM`, including a routine restart during a redeploy, not only
a permanent decommission. Cascade-terminating sessions there would kill
them on every routine restart, defeating that guarantee; an admin who
actually wants a host's sessions terminated already has the cascade-delete
path.

The session credential itself is revoked, though — the primary clears it
outright rather than just marking the host offline in the live tracker, so
a session that just said "I'm going away" doesn't remain a valid inbound
credential until its 24h TTL naturally expires. This costs nothing: a
self-registered agent is stateless and always re-establishes a brand-new
session from its bootstrap credential on its very next boot, so nothing
depends on the outgoing one staying valid.

A manually-registered, static-token-only host has no session credential and
therefore no deregistration call to make at all — it degrades silently to
heartbeat-only detection, exactly as it did before self-registration
existed.

## Health monitoring

The primary polls every registered remote host's `/health` route (the same
unauthenticated liveness check `ping()`/**Ping** already used) on a
background timer — `HOST_HEARTBEAT_INTERVAL_SECONDS` (default `30`, `0`
disables it). Settings → Hosts shows a continuously-updated status dot:
green (online), amber (degraded — up to 2 consecutive missed pings), or red
(offline — 3 or more). This is live, in-memory state only, never written to
the `hosts` table — an unreachable primary restart resets every host back
to "pending" until the next sweep, same as a fresh boot.

## Current limitations

- Self-registration has no admin-approval queue — any holder of
  `MULLION_ENROLLMENT_SECRET` can enroll a new host (optionally narrowed with
  `MULLION_ENROLLMENT_ALLOWED_CIDRS`). This is deliberate (see the design
  notes in `.claude/plans/`), not an oversight — it's what makes zero-touch
  deploys possible; treat the enrollment secret as fleet-wide-admin-grade.
- No in-app auth on the agent's internal API beyond the bearer token/session
  credential; put it behind the same network/VPN boundary you'd use for
  anything else with shell access.
- Requests aren't yet signed (HMAC) — the credential alone authenticates a
  request today; see roadmap 7.5.
- Connection-time IP pinning (full DNS-rebinding protection) is not yet
  implemented — see "What this does and doesn't protect against" above.
