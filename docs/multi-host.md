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

There are two ways to bring an agent online: register it by hand (below), or
let it self-register with no manual step on the primary at all. Self-
registration is the path meant for scripted/automated deploys (e.g. an
Ansible playbook) — see [`deploy/README.md`](../deploy/README.md) for the
full contract once PR 7.7 lands; the mechanics are documented here.

### Manual registration (a pre-provisioned, per-agent token)

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

### Self-registration (zero manual steps)

The agent can instead register itself against the primary's
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

Newly-enrolled hosts show up in Settings → Hosts with an "enrolled" origin
badge, distinct from manually-registered ones, so an unexpected host is easy
to spot.

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
