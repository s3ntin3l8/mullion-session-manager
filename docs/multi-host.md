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
static token, added by hand in Settings → Hosts & SSH bridges) is also
supported, for a one-off host or anyone who'd rather not hand a shared
enrollment secret to automation — see below.

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
The same `trustProxy`-off consequence also flattens every IP-keyed rate
limiter (including the login limiter) into one shared bucket behind a
proxy — see `docs/auth.md`'s "Current limitations" for why that's an
accepted trade-off rather than a bug (B5, audit remediation plan).

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
is issued and stored alongside it — the HMAC signing key that every
request covered by "Request signing" below is signed with; unlike
`session_id`, it's never re-sent after issuance or presented as a request
credential itself.
The agent renews its session at ~50% of its TTL, and re-runs the full
enrollment call (with retry/backoff, so a briefly-down primary never blocks
the agent's own boot) if a renewal ever comes back `401`.

Newly-enrolled hosts are distinguishable from manually-registered ones via
the API's `origin: "enrolled" | "manual"` field on `GET /api/hosts` —
a Settings → Hosts & SSH bridges UI badge surfacing this (so an unexpected
enrolled host is easy to spot at a glance, not just via the API) hasn't
shipped yet; the data is there for a follow-up to render it.

Advertised URLs must be unique per agent, the same requirement manual
registration already has implicitly. `MULLION_AGENT_ADVERTISE_URL`'s
`http://<hostname>:<PORT>` fallback only produces a unique URL if hostnames
are actually unique across your fleet (true for most cloud/container
provisioning, not guaranteed for a hand-cloned VM image) — two agents
sharing a baseUrl will repeatedly "steal" the same host row from each other
on their independent renewal cycles. Set `MULLION_AGENT_ADVERTISE_URL`
explicitly if you can't guarantee that.

Rotating a manually-registered host's token (Settings → Hosts & SSH
bridges → Edit, or
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
   **Settings → Hosts & SSH bridges → Add a host**, and fill in:
   - **Name** — any label (e.g. `home-server`).
   - **Base URL** — where the agent is reachable, e.g.
     `http://192.168.1.20:4000`.
   - **Token** — must exactly match that agent's `MULLION_AGENT_TOKEN`.

   Once saved, use **Test** in the Hosts list to confirm connectivity.

5. **Create (or move) a project onto that host.** The project-creation modal
   gets a host picker once at least one remote host is registered; every
   session under that project spawns and runs on the agent, and terminal
   attach streams through the primary's own `/ws/terminal` — the browser
   only ever talks to the primary.

## Automatic placement

A project's host is picked **by hand, once**, when the project is created or
moved. Automatic placement ([#1723](https://github.com/s3ntin3l8/mullion-session-manager/issues/1723)
/ roadmap 8.9) lets the primary choose per session instead — but it is
**opt-in, per project**, and it never changes a project's own host.

- **`pinned` (the default).** Every session under the project runs on the
  project's host, exactly as before. Nothing changes until you ask for it.
- **`auto`.** Each session is placed on an eligible host of its own, and the
  choice is recorded on the session row (`sessions.hostId`), so where a
  session ended up is visible afterwards rather than being re-derived.

  **This mode is in effect** (roadmap 8.10,
  [#1724](https://github.com/s3ntin3l8/mullion-session-manager/issues/1724)):
  every session created for an `auto` project is placed when it is created,
  and the decision and its reason are recorded on the session row
  (`sessions.hostId`, `sessions.placementReason`), so where a session ended
  up — and why — can be read back afterwards.

Set it with the project API — `placement: "auto"` on `POST /api/projects`, or
on `PATCH /api/projects/:id` to switch a project in or out.

**What makes a host eligible.** It has to be _online_ per the heartbeat, not
_drained_, it has to have _reported a capacity_ (the load, cores and
memory the fleet reads in `GET /api/hosts`), and it has to have **the
project** — see below. A host that has never reported a capacity is not a
failure — it is simply not a candidate.

**A host has to have the project.** A session runs in a directory, so a host
that does not have the project cannot host a session for it: the checkout
would have to be materialized there first, which is a different feature. So
each project records where it lives on the hosts it may be placed on:

```json
{ "mgmt": "/srv/checkouts/my-project" }
```

That map is `hostCwds` on the project (`POST`/`PATCH /api/projects`). The
project's **own** host is not in it — `projects.cwd` _is_ its path there, and
`projects.hostId` is its host. A host with no entry in the map does not have
the project, so it is never a candidate and the session stays where it
would have been.

The worktree follows the session: it is cut from the project root **on the
host the session runs on**, so the agent's working directory always exists
where the agent is. The repo-level git operations — the base ref the branch
is cut from — still happen on the project's own host, because that is where
the repository lives.

A task's sessions share one host. The worker decides it (the placement
decides), and the reviewer and the rebase worker join it, because they read
the worker's worktree.

**How the choice is made.**

- _Unattended_ sessions (a Task Master worker or reviewer) get **no local
  bonus**: the goal is to move that work off the primary onto the least
  loaded eligible machine.
- _Interactive_ sessions are **local-preferred** — terminal latency matters
  to a human at a keyboard — and spill to another host only when the local
  one is not eligible. The preference applies when the project's own host is
  the local one, i.e. when the checkout is already here; a project that
  lives on a remote host follows the same least-loaded rule as an unattended
  one, because "local" is not where its code is.
- Hosts are compared by **load per core**, not by raw load: load 4 on a
  16-core machine is a quarter of its capacity, load 4 on a 4-core machine
  is all of it.

**Placement never fails a spawn.** If no host is eligible, the project's own
host is used and the session starts anyway — a placement is an optimization,
never a gate. Every decision records why it was made (_"least loaded:
mac-mini at 1.2 load on 12 cores (0.10 per core)"_), on the session row
and in the server log, so it can be explained rather than guessed at.

**Parking a host.** A host can be _parked_: it takes no new work, so the
placement policy stops choosing it. Parking is a **flag, not an action** —
no session is killed, no worktree removed, no agent contacted, and a parked
host stays perfectly usable for **manual** placement (a project still pinned
to it, or a session you start there yourself). It is a column, so the
decision survives a primary restart.

Park one from **Settings → Hosts** (the row's kebab menu), or over the
API: `PATCH /api/hosts/:id` with `{"drained": true}`.

### Dispatching a child session to another host

Automatic placement chooses a host for you. A coordinating session can also
**name** one: `spawn_child_session` (MCP) / `mullion session spawn-child`
(CLI) take `host` (a host id) or `platform` (`darwin`, `linux`, `win32`) —
for example, a Linux session handing Xcode or iOS-Simulator work to a Mac
agent:

```bash
mullion session spawn-child --command claude --platform darwin --isolate \
  --initial-prompt "run the iOS build and fix what breaks"
```

Unlike automatic placement, **a target is a hard requirement**: if no host
matches, the spawn is refused with a **409** (`no eligible host matches
platform darwin`) instead of falling back to the project's host, because a
Mac-only job on the Linux fallback would just fail later. The message names
only the target you asked for, never other hosts. A host is eligible when it
is online, not parked, has reported capacity, and **has the project**:
register its checkout in the project's `hostCwds` map (`PATCH /api/projects/:id`)
first. A target works for a `pinned` project too — it
does not depend on the placement mode — and the usual load-per-core rule
chooses among the hosts that match.

`--isolate` (`isolate: true`) gives the child its own fresh worktree on the
host it runs on: a new `mullion/child-…` branch cut from the default base
ref, **resolved on that host**. The remote child commits and pushes that
branch; the coordinator fetches and reviews it. `--isolate` cannot be
combined with `--cwd`. The worktree is **kept** after the child ends — it
holds the child's commits and any unpushed work, exactly like the launcher's
"isolate" toggle — so remove it yourself with `git worktree remove` once the
branch is merged; automatic reclamation is tracked in #1964.

Supervising a remote child from the coordinator works with `session wait`,
`session children` (each row carries its `hostId` and `placementReason`),
`session logs` and `session kill`. `session prompt` (without `--wait`) and
`session wait-output` work too and run on the child's host: send the prompt,
then wait on its output with the reply's `outputOffset` as `--after-offset`
(`prompt --wait` is not supported for a remote child yet, #1962). See [Current
limitations](#current-limitations) for what is still missing.

### Seeing it in the UI

**The fleet's capacity — Settings → Hosts.** Every host row carries its
platform, how many things it can do at once, its 1-minute load average and
how much memory is free. Two rules the display keeps:

- **A host that reports no capacity shows _unknown_, never zero.** An older
  agent build (or one that has not been polled yet) simply has no reading —
  and a zero load would read as "this machine is idle", which is the one
  thing a missing reading must never say.
- **A reading is a reading, not a fact.** Capacity is cached on the
  heartbeat sweep, so a host that stopped reporting keeps its last numbers
  — shown, but marked with their age (_"reading from 3 min ago"_).

**The placement control — Add/Edit project.** A project's mode is chosen in
the same dialog as its name and path: _On a chosen host_ (today's
behaviour, the default) or _Automatic_. Choosing _Automatic_ shows a **live
preview** of where a new session would land and why:

> Right now a new session would land on **mac-mini** — least loaded: 1.20
> load on 12 cores (0.10 per core).

The preview is the server's own decision, run by the same function the spawn
path uses — so it cannot promise something the placement would not do. It
is a **now** reading (load moves between the preview and the spawn), and it
is answered without placing anything: a preview announces no decision and
writes nothing. Two shapes, one decision: an existing project is asked
about by its id (with the mode it is being asked _about_, not the mode it
is stored as — turning the mode on is the point of the control), and the
create-project dialog asks with the host and mode it would save, before
the project exists.

The reason for a session that was _already_ placed is a different thing —
that decision is made at spawn time, so it is recorded with the row
(`sessions.placementReason`, issue
[#1724](https://github.com/s3ntin3l8/mullion-session-manager/issues/1724)).
**The session's host badge carries it in its tooltip** — the same place that
answers _which_ host, so _why_ is one hover away rather than a log file:

> least loaded: mac-mini at 1.20 load on 12 cores (0.10 per core)

A session with no recorded reason — a row written before placement existed —
keeps the older tooltip, _"Runs on host: mac-mini"_. A **pinned** session
does have one: the pinned path short-circuits the policy but does not skip
the record, so its reason reads _"pinned to the project's host mac-mini"_.

The reason is the placement decision's own words, so it says what was
actually decided rather than a summary of it. It names the host by its
**id** — the policy knows ids, not names, and a remote host's id is a
UUID — so the badge's friendly name replaces it in the tooltip: the
operator knows _"mac-mini"_, not _"3f2a9c1e-…"_.

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

Task Master's promotion path (`#484`) sends a **GitHub credential** (the
shared PAT/OAuth token, or a short-lived App installation token when one is
configured) to a task's own host, once per push, over this same signed,
IP-pinned channel — `POST /internal/git-push`, never logged. This is not a
new trust boundary: an agent host already runs the task's own CLI/coding
agent inside that checkout with full filesystem access, so it already has
the means to read `.git/config` or exfiltrate any credential it's handed by
other means. It is, however, a widening of _what_ actually crosses the
wire to that host on a routine push, not just at claim/worktree time —
worth knowing if you're reasoning about what a compromised agent host could
observe.

## What this does and doesn't protect against

Registering a host (`POST`/`PATCH /api/hosts`) is an admin-only, authenticated
config action — the same trust level as editing `PROJECTS_ROOTS` — not user
input crossing a privilege boundary. The base URL is checked against obvious
credential-leak targets (link-local addresses, cloud instance metadata
endpoints like `169.254.169.254`, RFC 6598 shared-NAT space, and their
IPv6/IPv4-mapped equivalents) both when it is registered **and** every time a
connection to it is opened.

The connection-time half matters because the two checks answer different
questions. Registration validates a _string_; by the time a request is sent,
what matters is the _address_ it resolves to, and those can differ — a
hostname that resolves somewhere harmless when you register it can be rebound
afterwards. So every outbound call to an agent (HTTP and WebSocket alike)
resolves the name, validates every address the resolver returned, and pins
the connection to a validated one. Because the socket connects to exactly the
address that was checked, there is no window in between for the name to move.

What this deliberately does **not** block: a host on `10.x`, `192.168.x`, or
loopback. Those are the normal deployment shape for a private fleet, so the
policy for agent connections permits them — pinning here only ever refuses
link-local, cloud-metadata, and shared-NAT addresses. That narrow set is the
one that matters, because every request carries this host's bearer token and
request signature: a base URL pointed at a metadata endpoint would hand those
credentials straight to it. Beyond that, treat host registration as
trusted-admin-only (it already effectively is) rather than exposing it to
anyone you wouldn't also hand a bearer token with shell access.

When the guard does fire it is logged as a distinct reason rather than a
generic connection failure — a host that goes unreachable because it was
_blocked_ says so, instead of looking like a host that is merely down.

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
heartbeat sweep below ("Health monitoring") is still the fallback for an
ungraceful exit (a crash, `kill -9`, or a network partition). The effect is
purely a faster status update — a clean shutdown reflects as offline in
Settings within the
request's own round-trip, instead of waiting on the heartbeat's 3-missed-ping
window.

This is deliberately **status-only**: unlike `DELETE /api/hosts/:id
?cascade=true` above, it never terminates the host's live sessions. Every
dtach session an agent hosts is bootstrapped into its own detached scope
specifically so it survives an agent process restart — a `systemd-run` scope
on Linux, a detached `dtach` master on macOS (see `deploy/mullion-agent.service`
and the macOS scope backend) — and this shutdown hook fires on _every_
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

### macOS agents: sleep and wake

macOS **suspends** a laptop's processes when it sleeps; it does not kill
them. A Mullion agent on a sleeping Mac therefore comes back with its
processes intact — the live sessions are still there, in their detached
`dtach` scopes — but with its network severed and every timer it had pending
overdue. Three consequences follow, and they are worth separating because
they are often confused.

**1. A sleeping agent makes no progress.** Its sessions are alive but
_stalled_: the agent's process is not running, so nothing it drives is
either. So "offload work to an idle machine" realistically means "offload to
a machine that is **open**". A sleeping host is not spare capacity, and the
fleet UI will show it as such.

**2. The primary notices, and reconnects.** The heartbeat ("Health
monitoring" above) misses three pings — about 90 seconds at the 30s default —
and the host reads **offline**. That is health only: it is in-memory state,
and it never touches a session row. A sleeping host's sessions read
**unknown**, never `dead` and never `exited` — the same rule as any other
unreachable agent, and the reason a network blip never looks like every
session on that host died.

Because a sleep severs the network **without a FIN**, the primary's sockets
to that host are _half-open_: they report as open and never emit `close`,
which is the only event the reconnect loops re-arm on. So when the heartbeat
sees the host come back, it forces those connections closed and reopened
(the same `forceReconnect` path a rotated credential uses). Without that, the
host would show as online while the primary's connection to it stayed wedged
on a dead socket.

**3. The agent revalidates its credential.** An agent's session credential
can be revoked or rotated while it sleeps. On waking, it revalidates
immediately rather than waiting for its next renewal tick — a credential TTL
is measured in hours, and a host that slept for a night would otherwise come
back holding a credential that had already expired.

If the credential was rotated on the primary, the agent re-reads its own
`.env` (the file `scripts/run-with-env.sh` sources) and picks up the new
value, so it recovers **without a redeploy**. Rotate the secret on the
primary and update the agent's `.env`; the agent notices on its next wake.
An agent whose `.env` still holds the old value simply keeps retrying with
it, exactly as it would have before.

#### Keeping an open Mac awake

macOS idles an idle laptop into sleep, and a sleeping machine runs nothing.
While it has live sessions, Mullion holds a `caffeinate` power assertion so
an **open** Mac does not idle-sleep mid-work:

```
caffeinate -dimsu -w <pid>
```

The assertion is held **only while there are live sessions** — an idle but
installed agent still lets the laptop sleep. Set `MULLION_KEEP_AWAKE=false` in
the agent's `.env` to turn it off entirely (useful on a battery-powered
laptop on a long train ride).

Note what this does **not** do: `caffeinate` cannot keep a machine awake
with its **lid closed**. macOS suspends a closed lid regardless of any power
assertion (unless the machine is in clamshell mode — closed, plugged in, and
running an external display). For a closed-lid host, configure the machine
itself:

```
sudo pmset -a sleep 0     # never sleep on idle
sudo pmset -a womp 1      # wake on network access
```

Both change the _user's_ power settings and need `sudo`, so Mullion
documents them rather than running them. `pmset -a sleep 0` is the one that
matters for an unattended agent: it stops the idle-sleep that would
otherwise suspend the host between tasks.

#### What to check on real hardware

None of the above can be established on Linux CI — a lid-close suspend, a
`caffeinate` power assertion and `pmset`'s sleep policy only exist on a Mac.
`scripts/macos-sleep-wake-check.sh` checks what it can without an install
(does `caffeinate` hold an assertion, does it release it when terminated,
what is the host's sleep policy, do the launchd templates still carry the
keys the deployment depends on, does a `dtach` master survive a
suspend/resume proxy), and measures whether the monotonic clock advances
across a real suspend — the one question the code deliberately refuses to
assume. The rest is the checklist in the validation issue.

### macOS as a primary

A Mac can be the **primary** of a mixed fleet, not just an agent — issue
[#1720](https://github.com/s3ntin3l8/mullion-session-manager/issues/1720),
roadmap 8.6.

**What is the same as on Linux.** The primary's extra surface is small:
SQLite, `@fastify/static`, the product routes (which shell out to `git` or go
through the `SessionBackend` seam), the GitHub integration, Playwright, and
Docker detection are all cross-platform. The macOS **launchd** deployment —
`deploy/launchd/com.mullion.primary.plist` — is the counterpart of the
systemd unit, and `deploy/install.sh` picks it from `uname -s` and skips the
systemd prerequisite checks on darwin.

**Installing a Mac needs no clone.** The release tarball ships `deploy/`, so
a Mac (like any host) can be installed straight from a published release:

```sh
curl -fsSL -o mullion-install.sh \
  https://github.com/s3ntin3l8/mullion-session-manager/releases/latest/download/mullion-install.sh
sh mullion-install.sh --role primary ~/opt/mullion
```

The bootstrap fetches the release, verifies its checksum, and runs the
`deploy/install.sh` inside it — the same installer the clone path runs. See
[`deploy/README.md`](../deploy/README.md)'s "Installing without a clone".

**What is different.** A macOS primary's **local** sessions run under the
darwin scope backend — the same detached `dtach` backend an agent's sessions
use — so every local session on a Mac dogfoods the macOS scope path. The
backend is chosen from the **host's own** platform, never negotiated between
hosts, so a primary and its agents never have to agree on anything.

**The topology is OS-agnostic.** The enrollment protocol is
agent-dials-primary (`MULLION_PRIMARY_URL` / `MULLION_ENROLLMENT_TOKEN`) and
carries no OS assumption. So **macOS-primary + Linux-agents** is a valid
topology: the `hosts` table's `local` row simply becomes the Mac, and
`resolveSessionHostId` keeps working unchanged. A session an agent runs shows
up in the primary's list under the **agent's** host id, and the terminal
attach proxies to whichever host the session actually lives on.

#### The Android device panel is Linux-only

The device panel ([`device-panel.md`](device-panel.md)) is **off on macOS**,
even with `DEVICE_ENABLED=true`: the emulator runs in a `systemd --user`
scope (`systemd-run` starts it, `systemctl` reads its liveness and tears it
down), and macOS has no equivalent — the darwin scope backend is keyed to a
_session's_ dtach socket, which an emulator has no analogue of.

So on macOS every route that **adds, starts or changes** a device answers
**400 "The device panel is not supported on darwin — it is Linux-only."** — a
legible reason rather than a raw `spawn systemctl ENOENT` — and the panel's
mDNS scanner never binds a multicast socket. The `/api/devices` reads and
the teardown routes stay open on purpose: they were never gated on
`DEVICE_ENABLED` either, and an operator must be able to stop a device even
where the panel cannot create one. The app boots either way: the gate is a narrowing of an
existing flag, so it can only ever turn the panel _off_ on a platform it was
already off by default on.

A macOS device scope is real work and is tracked separately — see
[#1854](https://github.com/s3ntin3l8/mullion-session-manager/issues/1854).
One lead worth knowing before that issue is picked up: the panel's
**physical** half — an Android phone over adb wireless debugging — needs no
scope at all (the manager branches it off before the scope pre-check), and
`adb` and `scrcpy` both exist on macOS. So that half could be enabled on
macOS separately, without waiting for a macOS device scope for the emulator
half.

## Request signing

Every request the primary sends to a **self-registered** host also carries
an HMAC-SHA256 signature, keyed on the `session_secret` issued at
registration alongside `session_id` (see "Self-registration" above) —
`X-Request-Signature`, `X-Request-Timestamp`, and `X-Request-Nonce`
headers, covering the method, the exact request path and query string, the
timestamp, the nonce, and (for most requests) a hash of the body. The agent
recomputes the same signature on receipt and rejects the request if it
doesn't match, if the timestamp is more than 30 seconds old or in the
future (clock drift between hosts, or a stale/replayed request), or if the
nonce has already been used (a replayed request).

This is **additive**, the same dual-mode-auth invariant every self-
registration feature in this doc follows: a manually-registered,
static-token host never signs anything and is completely unaffected —
signing only ever applies once a session credential (`session_id`) is the
credential actually presented. A request bearing a session id with no
signature at all, or a wrong one, is rejected outright; there's no
"downgrade" path back to unsigned for a session-authenticated request.

A handful of large/streaming request bodies (a remote-hosted preview
request/response, a file upload) aren't hashed — hashing would mean
buffering the whole body before auth is decided — but the request's method,
path, and query string are still covered. The agent independently decides
which routes fall into this category from the request path alone; nothing
about that decision is transmitted by the caller, so there's nothing for a
forged request to tamper with to get a body exempted that shouldn't be.

An agent restart clears its replay-protection state (nonces are in-memory
only), which re-opens the ±30s window a restart-adjacent request could in
principle be replayed within — bounded by the same drift check either way,
and no worse than the fact that a freshly-booted process has no memory of
anything that happened before it.

## Health monitoring

The primary polls every registered remote host's `/health` route (the same
unauthenticated liveness check `ping()`/**Test** already used) on a
background timer — `HOST_HEARTBEAT_INTERVAL_SECONDS` (default `30`, `0`
disables it; also UI-configurable at runtime as "Health check interval" in
Settings → Hosts & SSH bridges, no restart needed). Settings → Hosts & SSH
bridges shows a continuously-updated status dot: green (online), amber
(degraded — up to 2 consecutive missed pings), or a
hollow dim ring with a red text label (offline — 3 or more). This is live,
in-memory state only, never written to the `hosts` table — an unreachable
primary restart resets every host back to "pending" until the next sweep,
same as a fresh boot.

## Capacity reporting

Issue [#1721](https://github.com/s3ntin3l8/mullion-session-manager/issues/1721)
/ roadmap 8.7 — the fleet has a _health_ signal, but no _capacity_ signal, so
"put the work on the idle machine" is still a manual decision. An agent now
reports its capacity, and the primary keeps it next to the health signal.

**The route.** `GET /internal/capacity` on the agent, behind the same gate as
every other `/internal/*` route (bearer token plus HMAC signature, or the
static-Bearer path for a manually-registered host):

```json
{
  "platform": "darwin",
  "logicalCores": 16,
  "loadAverage1m": 2.1,
  "memory": { "totalBytes": 34359738368, "freeBytes": 21474836480 },
  "sessions": { "tracked": 3, "alive": 3 },
  "sampledAt": "2026-10-24T10:00:00.000Z"
}
```

`logicalCores` is `os.availableParallelism()` — how much the box can actually
run in parallel, which accounts for a cgroup CPU limit. It is deliberately
**not** the System Resources page's `logicalCores` (that one counts
`os.cpus().length`, what the box advertises). The session counts are this
host's own in-memory session tracking: how many it knows about, and how many
are alive.

**One measurement, two callers.** The agent measures itself with
`measureHostCapacity()` (`src/services/host-capacity.ts`) and so does the
primary — so a local host's numbers and an agent's numbers are comparable by
construction, not by two implementations that happen to agree today.

**No second timer.** The capacity poll rides the health sweep above: one
`/health` ping and one `/internal/capacity` call per tick, on the same
interval, in the same fan-out. The capacity call has its **own, shorter
budget** (2 s, against the ping's 5 s): capacity is advisory input to a
placement policy, while the ping decides a verdict, so a hung capacity
route must not add its timeout to the sweep and push the next tick — and
with it every host's health update — out of schedule.

**Capacity never decides health.** The health verdict comes from the `/health`
ping alone. An agent build that predates the capacity route answers `404`,
which means _"this build does not report capacity"_ — never _"this host is
broken"_, and the health dot does not flap. Any other failure (timeout,
unreachable, 5xx) leaves the last known numbers in place, stale, and is
logged.

**In memory only.** Like the health state, capacity is never written to the
`hosts` table: it is a live reading, not an intent, and a persisted number
would look durable long after the machine filled up. A primary restart starts
with no capacity knowledge; the first sweep repopulates it. A host that stops
reporting keeps its last known numbers together with their `sampledAt`, so
the UI can show them as stale (that UI is issue
[#1726](https://github.com/s3ntin3l8/mullion-session-manager/issues/1726)).

**What a host is.** The agent also self-reports its platform
(`process.platform`) at enrollment and at every renewal, and the primary
records it in `hosts.platform` — free-form and informational, exactly like
`bridges.platform`. An agent build that predates the field leaves it null,
which is a legitimate state, not a defect. Nothing branches on it.

`GET /api/hosts` carries both: `platform` per host, and `capacity` per host
(`null` when the host does not report any). The local host's capacity is
measured on demand on every request — it has no remote poll to ride, and the
primitives are cheap — and its `platform` is this process's own, so the
response never contradicts itself (`platform: "linux"` beside
`capacity.platform: "linux"`, never `null` beside `"linux"`).

**One caveat, stated so the placement policy inherits it:**
`loadAverage1m` is `os.loadavg()[0]`, which is **permanently 0 on win32** —
the platform reports no load average. A policy that reads `0` as "idle"
would read every Windows host as idle. Windows is out of Phase 8
([#1728](https://github.com/s3ntin3l8/mullion-session-manager/issues/1728)),
and the placement half targets Linux and macOS, but the rule for the future
policy ([#1723](https://github.com/s3ntin3l8/mullion-session-manager/issues/1723))
is: treat `platform: "win32"` as _this host reports no load_, never as _this
host is idle_.

## Where a session lives

A session records the host it was spawned on — `sessions.hostId`, written
**once** at creation and never changed (issue
[#1722](https://github.com/s3ntin3l8/mullion-session-manager/issues/1722)
/ roadmap 8.8). Every **session-scoped** operation follows that row: its
terminal attach, its live status, its scrollback, its process list, its file
uploads, its scope's liveness, the review gate, promote or attention
acknowledgement waiting on it, the worktree it owns, and the events it
reports.

The one operation that stays with the **project** is the browser: the
BrowserManager pools one Chromium **per project** (`browser-manager.ts`), so
a session's browser is reached through its project's browser, whichever host
that browser runs on.

The column is **nullable, and `NULL` means "inherit the project's host"** —
which is every session created before this change, and every session created
before the placement policy lands. Those rows behave exactly as they always
did: a project's host is where its sessions live.

**Project-scoped work still follows the project.** A project's git
operations, its files, its worktree and its webhooks run on the project's own
host, whatever host any one of its sessions happens to sit on. A session
placed on a remote machine does not drag the project's git operations there.
A _task's_ worktree and branch belong to the task's project, and follow it
too — until the placement policy (#1724) decides otherwise for the task's
session as well.

The reason the distinction matters is destructive, not cosmetic: the
reconciler asks a host for the liveness of the sessions it owns, and "dead"
is the one verdict it is allowed to act on (it terminates the scope and
flips the session's row to `"exited"`). Deriving that host from the project
would ask the wrong machine about a session that lives elsewhere — and the
wrong machine's honest answer ("I have no such session") would read as
"dead".

A session's host is fixed at creation; moving a running session between
hosts is not attempted.

### Seeing where a session lives

A session's **effective** host travels with it: the API answers with
`resolvedHostId` — the session's own host, or its project's when the column
is `NULL` — resolved on the server, where the rule already lives. The raw
column stays as it is, so both facts are visible and neither is ambiguous.

In the UI, a session on a **remote** host carries a small, quiet host badge
next to its status (its sidebar row and its pane tab): a dim host icon and
the host's name. A **local** session carries nothing — the sidebar already
shows a per-_project_ host badge, and the per-session badge is for the case
that matters once automatic placement lands: one project's sessions on
_different_ hosts.

### A sleeping host is not a dead session

When a host does not answer, the sessions on it are reported as
**suspended** — not _exited_, and not _idle_:

- **Not exited.** The work may still be running on that machine. The backend
  cannot tell a sleeping host from an unreachable one, so it says what it
  knows: the host did not answer.
- **Not idle.** The idle fallback would be indistinguishable from a session
  that is genuinely idle and alive — the silence of a sleeping laptop and
  the silence of a finished turn look the same otherwise.
- **Not an alert.** A suspended session is `dormant`, so it does not ring
  the tab, badge the favicon, or fire a desktop notification. A laptop that
  fell asleep is not an event.

The state is honest about its own limits: the host's health dot says
**unreachable** rather than _offline_, and a sleeping machine should not
look like a broken one. It returns to the live state on its own — the
session list is refreshed every few seconds, so the first refresh after the
host wakes brings the real status back.

## Agent updates

Issue [#647](https://github.com/s3ntin3l8/mullion-session-manager/issues/647)
/ roadmap 7.8 — an agent updates the same way the primary does
(`scripts/self-update.sh`, unchanged), just triggered remotely instead of
from its own dashboard. Settings → Hosts & SSH bridges shows each
registered agent's running version next to the primary's own, and — when
they differ — an "Update" button. There is deliberately no "update all
hosts": applying is
always a per-host, manually-triggered action, since a concurrent fleet-wide
apply is how every host goes down at once.

An agent is always updated **to the primary's own currently running
version**, never to "whatever is newest on GitHub" — the goal is keeping the
fleet in sync with the primary's release, not each host chasing its own
latest. If the primary's own release has no downloadable tarball yet (a dev
build with no matching tag, or a release whose `build-tarball` CI job hasn't
finished), the Update button is disabled with that reason shown instead of
attempting an update to nothing.

The request path is the same authenticated, signed internal channel every
other primary→agent call in this doc already uses:
`POST /internal/updates/apply` and `GET /internal/updates/status` sit behind
this file's own bearer + (for a registered session) HMAC-signature gate —
**not** the primary's unauthenticated-by-default `/api/updates/*` path,
which relies entirely on `MULLION_AUTH_TOKEN`/OIDC or a reverse-proxy
gateway being configured. Mounting the literal `/api/updates/*` routes on an
agent would mean anyone who could reach the agent's port at all could
trigger a `systemd-run`'d download-and-`npm ci` with no credential
whatsoever — the one thing this feature does differently from a naive read
of the routes it reuses.

During an apply, the agent's own `systemctl --user restart` step (the same
last step `self-update.sh` always takes) briefly makes the agent
unreachable — the update-status proxy call fails at the transport layer for
that window, and the heartbeat sweep above will flap the host's dot to
degraded/offline. Both are expected parts of a normal update, not a failure;
the Settings row keeps showing its last known update phase rather than an
error, and the dot recovers on its own once the process comes back up.
`.update-status.json` lives outside the versioned release directory the
restart flips, so the final phase (`done`/`failed`) is still readable
immediately after the restart completes.

**Bootstrapping:** an agent host running a build older than #647 has no
`/internal/updates/*` routes at all, so the first update attempt against it
404s. That one update has to happen by hand (re-run `deploy/install.sh
--role agent`, or your own config-management run) — every update after that
can go through the button.

## SSH agent access across hosts

If a session on an agent host needs to authenticate with a key that lives on
your laptop (1Password, `ssh-agent`, ...), pair the SSH agent bridge once
from the primary's Settings → Hosts & SSH bridges → SSH agent bridges — that
single pairing serves every enrolled agent host, with no per-host tunnel or
laptop-side change needed when you enroll another one later. See
[`ssh-agent.md`](ssh-agent.md) for setup, the manual per-host `ssh -R`
alternative, and how the two compose.

## Current limitations

- Self-registration has no admin-approval queue — any holder of
  `MULLION_ENROLLMENT_SECRET` can enroll a new host (optionally narrowed with
  `MULLION_ENROLLMENT_ALLOWED_CIDRS`). This is deliberate (see the design
  notes in `.claude/plans/`), not an oversight — it's what makes zero-touch
  deploys possible; treat the enrollment secret as fleet-wide-admin-grade.
- No in-app auth on the agent's internal API beyond the bearer token/session
  credential (plus, for a session credential, the signature described above
  in "Request signing"); put it behind the same network/VPN boundary you'd
  use for anything else with shell access.
- **Parent→child control from a session on an agent host isn't available (#1627).** The control
  socket (`mullion session …`, the MCP control tools) lives only on the
  primary. A session running on an agent host gets
  `MULLION_CONTROL_UNAVAILABLE=remote-host` in its env, and the `mullion` CLI /
  MCP tools fail immediately with an explanation instead of a connect error.
  From the primary, a local caller can drive a remote child: `wait`, `get`,
  scrollback, `kill`, and — since issue #1951 — `prompt` and `wait_for_output`
  (both run on the child's own host).
  `prompt` with `wait` is not supported for a remote child yet (use
  `wait_for_output` with the prompt's `outputOffset`). The child calling _back_
  into the primary is the agent→primary relay, tracked separately (#1656).
- Task Master now works end-to-end against a remote-hosted project (`#484`)
  — issue ingest, claim, work, review with a real diff-stat, promotion to a
  PR, and Retry — given an agent build new enough to serve the routes it
  needs; an older build degrades per-path rather than breaking (see
  [`tasks.md`](tasks.md)'s Known limitations).
- **SSH agent bridge**: the Mullion Helper tray app owns and supervises the
  laptop-side worker; Mullion owns the primary and agent-host relay.
  An inherited ambient `SSH_AUTH_SOCK` on an agent host or the primary
  deliberately outranks the bridge in precedence (upgrade-safety
  trade-off, see [`ssh-agent.md`](ssh-agent.md#precedence)) — this applies
  regardless of whether a laptop has ever actually paired, since the
  bridge socket is materialized on every host. The host
  logs a shadow warning at boot whenever this shadowing happens, so it's
  visible in logs even though Settings' own `connected` status doesn't
  distinguish it from a session actually using the bridge.
- **A sleeping macOS agent is not spare capacity.** macOS suspends a
  closed-lid laptop regardless of Mullion's `caffeinate` assertion, and the
  suspended agent makes no progress at all — its sessions are alive but
  stalled. Mullion holds the assertion only while there are live sessions
  (so an _open_ Mac does not idle-sleep mid-work) and reconnects the
  primary's connections when the host wakes, but only the operator's own
  `pmset` settings can keep a **closed-lid** host running. See "macOS agents:
  sleep and wake" above.
