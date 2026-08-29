# SSH agent access from a session

A Mullion session runs on a host, not on your laptop, so it can't reach a
laptop-local SSH agent (1Password's SSH agent, `ssh-agent`, `gpg-agent`
in SSH mode, ...) the way a local terminal or an `ssh -A` connection can. If a
tool run from a session — `ansible`, `git`, plain `ssh` — needs to
authenticate with a key that deliberately never leaves your laptop, that key
has to be reachable some other way.

There are two ways to close that gap:

- **The SSH agent bridge** (recommended) — pair a small laptop-side helper
  once from Settings, and every enrolled agent host gets a working
  `SSH_AUTH_SOCK` automatically, with no per-host tunnel to maintain. This is
  the rest of this doc's main focus.
- **A manual `ssh -R` tunnel** — point `MULLION_SSH_AUTH_SOCK` at a unix
  socket you forward yourself, one tunnel per host. Still fully supported
  (see [Manual tunnel](#manual-tunnel-ssh--r)) — it predates the bridge, has
  no laptop-side software to install, and if it's already working for you
  there's no need to switch: **a host's `MULLION_SSH_AUTH_SOCK`, if set,
  always wins over the bridge** (see [Precedence](#precedence)).

Either way, **Mullion does not create, manage, or care what's on the other
end of the socket a session ends up with** — the actual agent (1Password,
`ssh-agent`, ...) always keeps running on your laptop; approval prompts
(Touch ID, 1Password's biometric unlock, ...) happen there, per signature,
and nothing about the key's trust model changes.

## SSH agent bridge

A small helper process (`mullion helper`) runs on your laptop, holds a
persistent connection to the primary's `/ws/agent-bridge` endpoint, and for
every enrolled agent host, the primary relays signing requests from that
host's sessions through the bridge to your laptop's real agent and back. One
pairing serves **every** enrolled agent host — there's no per-host tunnel to
set up or keep alive, and enrolling a new agent host later needs no laptop-
side change at all.

For sessions on an **agent host**, only two request types are ever relayed
onward: listing loaded identities (`SSH_AGENTC_REQUEST_IDENTITIES` — what
`ssh-add -l` sends) and signing (`SSH_AGENTC_SIGN_REQUEST`). Everything else
— adding, removing, or locking keys — is dropped before it reaches your
laptop's agent. A compromised or malicious primary can therefore see which
keys are loaded and ask them to sign, exactly like `ssh -A` already permits,
but cannot mutate the agent or extract private key material this way.

**Sessions on the primary itself are not filtered this way** — the sign-only
check happens as traffic crosses from an agent host's different trust domain
onto the primary; a session on the primary already runs as the primary, so
there's no boundary left to enforce there. This is not a new capability: it's
the same access a manual `ssh -R` tunnel already grants a primary-local
session today (every message type, unfiltered). If you want the mutating
request types blocked for primary-local sessions specifically, that's not
built yet — see [issue #873](https://github.com/s3ntin3l8/mullion-session-manager/issues/873).

The bridge supplies `SSH_AUTH_SOCK` to sessions on **both** agent hosts and
the primary itself — each materializes its own local bridge socket.

### Pairing

1. On the primary, open **Settings → Hosts → SSH agent bridges** and click
   **Pair a new bridge**. This generates a one-time pairing payload, valid
   for 10 minutes, and starts polling for the helper to redeem it.
2. On your laptop, get `mullion helper` (see below) and run:

   ```sh
   mullion helper pair '<payload>'
   ```

   Quote the payload — it's an opaque, base64url-ish blob, not something to
   retype. `--name <name>` overrides the default label (your laptop's
   hostname) shown in Settings.

3. Keep it forwarding:

   ```sh
   mullion helper run
   ```

   This is a long-running foreground process — supervise it the same way you
   would the manual tunnel's `ssh -R` (see [Keeping it
   running](#keeping-it-running) below). Once it's up, Settings shows the
   bridge as `connected`, and any session on any enrolled agent host — or on
   the primary itself — has a working `SSH_AUTH_SOCK` from that point on.

### Getting `mullion helper` onto your laptop

**On Windows**, download `mullion-helper-setup-<version>.exe` from the
latest [GitHub release](https://github.com/s3ntin3l8/mullion-session-manager/releases)
and run it — no Node install, no terminal. The installer:

- runs entirely as your own user (no admin prompt — it deliberately never
  asks for elevation; see [Keeping it running](#keeping-it-running) below
  for why that matters);
- asks for your pairing payload on one wizard page (paste it from
  **Settings → Hosts → SSH agent bridges**, or leave it blank and pair
  later — see [Pairing](#pairing) above for where the payload comes from);
- installs to `%LOCALAPPDATA%\Mullion\mullion-helper.exe` and registers the
  Scheduled Task for you, both in the same step — there is no separate
  `install` command to run afterward.

The download is currently **unsigned** — Windows SmartScreen will show
"Windows protected your PC"; click **More info → Run anyway**. A
code-signing certificate is planned as part of the future native tray app,
not this reference installer. If you'd rather run the bare `.exe` yourself
(no installer, no Scheduled Task), or automate an install without the
wizard (`mullion-helper-setup-<version>.exe /VERYSILENT /SUPPRESSMSGBOXES`,
the same invocation CI itself uses to verify every release), see
[`cli.md`](cli.md#helper) for the raw `mullion helper <verb>` commands the
installer runs on your behalf.

**On macOS or Linux**, `mullion helper` is one of the `mullion` CLI's
subcommands (see [`cli.md`](cli.md#helper)), specifically designed to need
no local Mullion install and no npm — it only touches Node builtins and a
handful of small sibling files, nothing from `node_modules`. Two ways to
get it running:

- **From a release tarball** (typical for a laptop with no Mullion checkout).
  Every GitHub release publishes `mullion-<version>.tgz` plus a
  `.sha256` checksum — the same artifact the primary itself downloads for
  self-update (see [`deploy/README.md`](../deploy/README.md)). Download both,
  verify, and extract:

  ```sh
  sha256sum -c mullion-<version>.tgz.sha256
  mkdir mullion-helper && tar -xzf mullion-<version>.tgz -C mullion-helper
  node mullion-helper/dist/cli/mullion.mjs helper pair '<payload>'
  node mullion-helper/dist/cli/mullion.mjs helper run
  ```

  A recent Node is the only dependency — `mullion helper` uses Node's
  built-in `WebSocket` client, unavailable before Node 22, and the tarball's
  own `package.json` (`engines.node`) states the exact floor this release
  was built against. No `npm install` needed — the extracted tarball's
  `dist/cli/` is self-contained.

- **From a checkout**, if you already have one on this machine (e.g. it's
  the same machine you develop Mullion on): `node src/cli/mullion.mjs helper
pair '<payload>'` works identically, no build step required.

### Keeping it running

`mullion helper run` is a plain foreground process — it doesn't daemonize or
install itself as a service on its own. `mullion helper install` does that
for you on **macOS, Linux, and Windows**:

```sh
mullion helper install --ssh-auth-sock "$SSH_AUTH_SOCK"
```

(On Windows, the [installer](#getting-mullion-helper-onto-your-laptop)
already runs this step for you — `--ssh-auth-sock` isn't even needed there,
since it defaults to the real pipe path; this command is for macOS/Linux, or
for running the bare `mullion-helper.exe` yourself without the installer.)

This generates and registers a launchd job (`~/Library/LaunchAgents/de.s3ntin3l8.mullion-helper.plist`),
a systemd `--user` unit (`~/.config/systemd/user/mullion-helper.service`), or
a Windows Scheduled Task (`MullionHelper`, registered from a generated
`mullion-helper-task.xml` alongside the credential file), starts it
immediately, and re-running the command later cleanly replaces the previous
install (new `--ssh-auth-sock`, moved checkout, ...) rather than erroring
over an already-loaded job — `schtasks /Create /F` is unconditionally
idempotent, so Windows doesn't even need the explicit pre-teardown step the
other two platforms do. `mullion helper uninstall` stops and removes it
again, along with the pairing credential — a no-op, not an error, if nothing
is installed (the installer's own uninstaller, from **Settings → Apps** or
`unins000.exe` in the install folder, runs this for you first, before
removing the exe itself). On Linux,
also run `loginctl enable-linger $(whoami)` so the unit survives logout, the
same requirement the manual tunnel's own [systemd
section](#linux-systemd---user) below has.

**Windows verification status:** every release's `install`/`uninstall` path
and the installer itself are exercised for real in CI on a `windows-latest`
runner (`.github/workflows/ci-cd.yml`'s `test-windows` job) — a genuine
`schtasks.exe` round trip, and the installer's own silent install/uninstall
(`/VERYSILENT /SUPPRESSMSGBOXES`), confirming the exe lands, the Scheduled
Task registers, and both remove the exe, the task, and the pairing
credential again on uninstall.
1Password's Windows named pipe accepting the mux's concurrent-channel shape
is confirmed working too
([issue #874](https://github.com/s3ntin3l8/mullion-session-manager/issues/874),
closed): 8 and 16 simultaneous connections each round-tripped correctly.
`--ssh-auth-sock` defaults to `\\.\pipe\openssh-ssh-agent` on Windows if not
given explicitly — pass it only to override. What CI _can't_ cover — a real
interactive logon actually firing the Scheduled Task, and a real signature
flowing end to end through a live 1Password agent — is tracked at [issue
#871](https://github.com/s3ntin3l8/mullion-session-manager/issues/871).

**Pass `--ssh-auth-sock <literal path>` explicitly**, as in the example
above. Neither `launchd`, `systemd --user`, nor a Windows Scheduled Task
inherits your login shell's `SSH_AUTH_SOCK` — the same reasoning as the
manual tunnel's own
[launchd](#macos-launchd)/[systemd](#linux-systemd---user) sections below —
so `install` captures whatever `--ssh-auth-sock` resolves to (the flag, or
your current shell's `$SSH_AUTH_SOCK`) as a literal path baked into the
generated job, once, at install time; it is not re-read from the
environment afterward. `install` refuses outright, rather than generating a
job that would fail at every restart, if neither is available — except on
Windows, where a named pipe path can't be reliably existence-checked the way
a unix socket file can, so that check is skipped there rather than risking a
confident-but-wrong warning.

If you'd rather supervise it yourself instead of using `install` — a
process manager you already run, a platform `install` doesn't cover yet —
the `launchd`/`systemd --user` examples in [Manual
tunnel](#manual-tunnel-ssh--r) below are directly adaptable: swap the
`ssh -N -R ...` command in `ProgramArguments`/`ExecStart` for
`/path/to/node /path/to/mullion.mjs helper run --ssh-auth-sock <path>`.

The helper reconnects on its own if the primary is briefly unreachable
(laptop sleep, network drop, primary restart) — backing off from 1s up to
30s between attempts, and it never gives up outright, so a laptop that wakes
up hours later resumes forwarding without a manual restart. Independently
of that reconnect loop, `run` also **renews its own session automatically**
(see [Credential storage](#credential-storage) below) — the two together
mean a helper left running under `install` normally never needs a human to
re-pair it at all. If the session is ever genuinely dead by the time `run`
next needs it — the bridge was revoked from Settings, or the primary stayed
unreachable long enough for renewal itself to exhaust its own retries —
`run` prints that the session is no longer valid and exits; under a
supervisor that restarts it unconditionally, this becomes a restart loop
until you re-pair with a fresh payload from Settings, not a self-healing
retry.

### Structured events (`--json-events`)

`mullion helper run --json-events` writes one JSON object per line
(newline-delimited JSON) to **stdout** for every state transition below —
useful for a status icon, log shipper, or any other supervisor that needs to
react to connection state without regex-matching prose. The human-readable
messages already documented above keep going to **stderr**, completely
unchanged, whether or not `--json-events` is passed — an existing script
parsing stderr today keeps working exactly as it does now.

Every line is a single object with at least a `type` field:

| `type`             | Extra fields            | Meaning                                                                                                                                                              |
| ------------------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connected`        | `bridge_id`, `base_url` | The auth handshake with the primary succeeded (first connect or a reconnect).                                                                                        |
| `disconnected`     | —                       | The connection dropped and wasn't caused by `run` itself stopping; a reconnect attempt follows.                                                                      |
| `connect_failed`   | `message`               | A connection attempt failed at the network level (DNS, refused, timeout) rather than being rejected by the primary; a reconnect attempt follows.                     |
| `session_renewed`  | `expires_at`            | The session was proactively renewed (see [Credential storage](#credential-storage) below) and the rotated credential was persisted.                                  |
| `renewal_retry`    | `delay_ms`              | A renewal attempt failed at the network level and will be retried after `delay_ms`; the current session stays in use in the meantime.                                |
| `renewal_rejected` | —                       | The primary rejected the renewal outright (the bridge was revoked). Fatal: `run` closes the connection and exits 1.                                                  |
| `dead_credential`  | `message`               | The primary rejected an auth handshake using the current session id, and no concurrent renewal explains it — the credential is genuinely dead. Fatal: `run` exits 1. |

There's no `paired` event on this stream — pairing state is only ever
observable via whether the credential file exists, and `run` never touches
that file at startup beyond reading it once.

```sh
mullion helper run --ssh-auth-sock "$SSH_AUTH_SOCK" --json-events | jq .
```

### Credential storage

`mullion helper pair` persists the session credential it gets back to
`$MULLION_HELPER_STATE_DIR/ssh-agent-bridge.json`, falling back to
`$XDG_STATE_HOME/mullion/ssh-agent-bridge.json`, and finally
`~/.local/state/mullion/ssh-agent-bridge.json` — directory created `0700`,
file `0600`. `mullion helper run` reads it to reconnect without re-pairing;
`mullion helper uninstall` removes it along with whatever `install` set up
(delete it by hand to forget the pairing locally without uninstalling
anything else). Revoking from Settings, see below, is the primary-side
equivalent — it takes effect immediately, where a local delete alone leaves
the session valid server-side until its own TTL or renewal budget runs out.

**A freshly paired session is valid for 24h, but `run` renews it on its own
at roughly half that TTL** (a plain HTTP call to the primary,
`POST /api/bridges/renew`, deliberately independent of the WS connection
actually forwarding traffic — renewing never disrupts a session mid-signing)
— well before the original deadline, and every renewal resets the clock for
another 24h. A helper that's continuously connected, or one that's
disconnected-and-reconnecting, both keep renewing this way as long as `run`
is running and can reach the primary at all; there's no daily chore anymore.
The 24h deadline still matters as a hard backstop: if `run` isn't running,
or the primary is unreachable for longer than renewal's own retry budget, or
the bridge is revoked from Settings, the session eventually (or immediately,
for a revoke) stops being valid, and only a fresh `mullion helper pair`
payload from Settings fixes that — restarting `run` alone won't revive an
actually-dead credential.

**The security boundary this creates**: `session_id` is the sole bearer
credential both to reconnect (`auth`) and to renew (`POST
/api/bridges/renew`) — there's no second factor, and renewal is precisely
what makes automatic re-pairing unnecessary. A leaked `session_id` therefore
stays usable indefinitely as long as _something_ keeps renewing it before
each 24h deadline, not just for the TTL it was issued with. Treat the
credential file the same way you'd treat any other long-lived bearer token
(`~/.ssh/id_*`, an API key) — if you suspect it's been exposed, revoke the
bridge from Settings rather than waiting for it to expire on its own.

### Revoking

Settings → Hosts → SSH agent bridges → **Revoke** on a bridge's row closes
its live connection immediately and deletes the pairing — there's no CLI
verb for this, and no propagation delay to wait out. Re-pairing after a
revoke needs a fresh payload from Settings; the old one won't work even if
it hasn't expired yet.

### Status labels

| Settings shows...      | Meaning                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connected`            | The helper's `run` process is currently connected. Sessions on any enrolled agent host, or on the primary itself, can sign.                                                                                                                                                                                                                                      |
| `pairing pending`      | A pairing code was issued but `mullion helper pair` hasn't redeemed it yet — or it already expired (10 minutes) and needs a fresh one.                                                                                                                                                                                                                           |
| `session expired`      | The credential is genuinely dead — `run` wasn't running (or couldn't reach the primary) for long enough that renewal never had a chance to fire before the 24h deadline, or the bridge was revoked from Settings (see [Credential storage](#credential-storage)). Re-pair with a fresh payload; restarting `run` alone won't fix an actually-expired credential. |
| `last seen <time> ago` | Paired, not currently connected. If `run` is stopped, restart it — a live session renews itself, so no re-pair is needed unless it's actually expired (see the row above).                                                                                                                                                                                       |

A bridge that's genuinely been revoked doesn't appear in this list at all —
revoking deletes the row outright, it never shows up as a lingering
disconnected entry.

## Manual tunnel (`ssh -R`)

`MULLION_SSH_AUTH_SOCK` is the original, still-supported way to close this
gap: point it at any unix socket that speaks the SSH agent protocol on the
host itself, and every session on that host gets `SSH_AUTH_SOCK` set to that
path. Unlike the bridge, this is entirely host-local — no primary
involvement, no laptop-side process beyond the tunnel, and it composes with
multi-host without any bridge code at all (see [Multi-host](#multi-host)
below).

### Why plain OpenSSH is enough

OpenSSH (≥ 6.7) can forward a _unix-domain socket_ over `-R`, and a forwarded
agent socket carries the SSH agent protocol natively — no separate protocol,
no separate code. From your laptop:

```sh
ssh -N -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -R /home/you/.local/state/mullion-ssh-agent/agent.sock:$SSH_AUTH_SOCK \
    your-mullion-host
```

This binds a socket at that path on the host, backed by whatever
`$SSH_AUTH_SOCK` resolves to on your laptop (1Password's agent, `ssh-agent`,
etc.).

### Host setup (once per host)

1. **`StreamLocalBindUnlink yes`.** A `-R` forward to a unix socket is bound
   by **`sshd`**, not the client, so this is an `sshd_config` setting on the
   _receiving_ host:

   ```
   # /etc/ssh/sshd_config.d/mullion-ssh-agent.conf
   StreamLocalBindUnlink yes
   ```

   then `systemctl reload ssh`. Without this, the _first_ time your laptop
   reconnects (sleep, network drop, reboot — anything that doesn't cleanly
   unlink the socket file) the rebind fails and the forward stays dead until
   someone manually removes the stale file. This is not optional.

2. **Create the socket's parent directory.** `sshd` will not create it for
   you; if it's missing, the `-R` bind fails, `ExitOnForwardFailure=yes` makes
   `ssh` exit immediately, and a `KeepAlive`-style supervisor turns that into
   a restart loop:

   ```sh
   mkdir -p -m 0700 ~/.local/state/mullion-ssh-agent
   ```

3. **Set `MULLION_SSH_AUTH_SOCK`** in this host's Mullion `.env` to that path,
   and restart the service.

### Laptop setup (once per host you want to serve)

Run the `ssh -N -R ...` command above under something that keeps it alive —
a `launchd` `KeepAlive` job on macOS, a user systemd unit on Linux. One job
per host. `ExitOnForwardFailure=yes` matters: without it, `ssh` can stay
"connected" with a silently-dead forward.

#### macOS (launchd)

A plain terminal running the `ssh -N -R ...` command works until you close
the terminal, sleep the laptop past its network timeout, or reboot — none
of which restart it for you. `launchd` does. Save this as
`~/Library/LaunchAgents/de.s3ntin3l8.mullion-ssh-agent.<host>.plist`, one
file per host you serve (the label and the socket path must both be
host-specific, or two jobs will fight over the same forward):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>de.s3ntin3l8.mullion-ssh-agent.your-mullion-host</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/ssh</string>
    <string>-N</string>
    <string>-o</string><string>ExitOnForwardFailure=yes</string>
    <string>-o</string><string>ServerAliveInterval=30</string>
    <string>-o</string><string>ServerAliveCountMax=3</string>
    <string>-R</string>
    <string>/home/you/.local/state/mullion-ssh-agent/agent.sock:/Users/you/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock</string>
    <string>your-mullion-host</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>
  <string>/tmp/mullion-ssh-agent-your-mullion-host.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/mullion-ssh-agent-your-mullion-host.log</string>
</dict>
</plist>
```

**`$SSH_AUTH_SOCK` must be a literal path here, not the environment
variable.** `launchd` jobs don't inherit your shell's `$SSH_AUTH_SOCK` — it's
set per-login-session by whatever agent is running (1Password's app,
`ssh-agent`), and `launchd` starts this job outside that session entirely.
1Password's own agent socket is at the fixed path
`~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock`
([1Password docs](https://developer.1password.com/docs/ssh/agent/compatibility/)),
shown above — for any other agent, run `echo $SSH_AUTH_SOCK` in a regular
terminal to get its real path and hardcode that instead.

Load and manage the job with `launchctl`, not by double-clicking the file.
`load`/`unload` are deprecated on modern macOS — use `bootstrap`/`bootout`
against the GUI domain instead:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/de.s3ntin3l8.mullion-ssh-agent.your-mullion-host.plist
launchctl list | grep mullion-ssh-agent   # confirm it's running (PID, not "-")
tail -f /tmp/mullion-ssh-agent-your-mullion-host.log   # confirm no connect errors
launchctl bootout gui/$(id -u)/de.s3ntin3l8.mullion-ssh-agent.your-mullion-host  # stop it
```

`KeepAlive: true` restarts the job whenever it exits for _any_ reason,
without backoff — if the host is unreachable, `launchd` will retry in a tight
loop. That's the right default here (a working tunnel matters more than a
brief noisy retry burst), but if `$SSH_AUTH_SOCK` came from a plain
`ssh-agent` rather than 1Password, its path can change across a reboot or
agent restart, silently turning every future retry into a connection to a
dead socket — with 1Password's agent this isn't a concern since its socket
path is stable.

#### Linux (systemd --user)

**`$SSH_AUTH_SOCK` must be a literal path here too, not the environment
variable** — same reasoning as the `launchd` case above, for a different
reason: a `systemd --user` manager is a separate process from your login
shell and does not source `.bash_profile`/`.zprofile` (where an agent
typically sets this var), so `$SSH_AUTH_SOCK` expands empty in the unit
below unless you explicitly import it. Hardcoding avoids that class of bug
entirely rather than relying on an import step staying done. 1Password's own
agent socket on Linux is at the fixed path `~/.1password/agent.sock`
([1Password docs](https://developer.1password.com/docs/ssh/agent/config/));
for any other agent, run `echo $SSH_AUTH_SOCK` in a regular terminal to get
its real path and hardcode that instead.

The same idea via a user unit,
`~/.config/systemd/user/mullion-ssh-agent@.service`, templated on the
target host so `systemctl --user start mullion-ssh-agent@your-mullion-host`
starts one instance per host:

```ini
[Unit]
Description=Mullion SSH agent forward to %i

[Service]
ExecStart=/usr/bin/ssh -N -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -R /home/you/.local/state/mullion-ssh-agent/agent.sock:/home/you/.1password/agent.sock %i
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

then `systemctl --user enable --now mullion-ssh-agent@your-mullion-host` and
`loginctl enable-linger $(whoami)` so it survives logout. Because the socket
path above is a literal, not an inherited env var, this survives whether the
unit is started interactively or (via the linger) at boot before any login
shell ever runs — the same staleness caveat as the `launchd` case still
applies if the agent itself restarts onto a different socket path later
without the unit restarting too, though that isn't a concern with
1Password's stable path.

If you're using an agent whose socket path genuinely isn't stable and you
need the running shell's actual `$SSH_AUTH_SOCK` instead of a hardcoded
path, import it explicitly before starting the unit —
`systemctl --user import-environment SSH_AUTH_SOCK` — but note this only
captures whatever value is current in the shell you run it from, one time;
it will not track a later change without re-running it and restarting the
unit.

**Approval cadence.** If your agent (e.g. 1Password) prompts for approval on
every signature, a single `ansible-playbook` run across many hosts can mean
many prompts in a row. Check this on a small run before assuming a large one
is usable — loosening the approval cadence is a real security trade-off, not
a default to drift into. This applies equally to the bridge above.

### Troubleshooting (manual tunnel)

**`remote port forwarding failed for listen path <path>`** (client-side,
printed by `ssh` itself). This error doesn't say which of two causes it is —
check both, in order:

1. **The parent directory doesn't exist on the host.** `sshd` will not
   create it — see "Host setup" step 2 above. `ls -ld` the directory; if it's
   missing, `mkdir -p -m 0700` it and reconnect.
2. **A stale socket file is blocking the rebind**, because
   `StreamLocalBindUnlink yes` (Host setup step 1) isn't set, or hasn't taken
   effect yet (`systemctl reload ssh` on the host after adding it). Check
   with `sshd -T | grep streamlocalbindunlink` on the host — if it prints
   `no`, that's the cause. This specific failure mode only shows up on a
   _reconnect_ (sleep, network drop, reboot), not the very first connection,
   since there's no stale file yet the first time.

**Debugging the transport separately from the injection.** These are two
independent things, and conflating them wastes time:

- **Transport** — is the socket actually forwarded and does it work at all?
  Test with an explicit, manual `SSH_AUTH_SOCK`:
  ```sh
  SSH_AUTH_SOCK=/home/you/.local/state/mullion-ssh-agent/agent.sock ssh-add -l
  ```
  If this lists your key, the `ssh -R` tunnel and the host-side sshd config
  are both correct — any remaining problem is entirely on the Mullion side.
- **Injection** — is Mullion actually setting `SSH_AUTH_SOCK` for new
  sessions? Open a **brand-new** session (not one that predates the config
  change or service restart — see below) and run a bare `ssh-add -l`, with
  no manual export. If the transport test above passed but this fails, check
  that `MULLION_SSH_AUTH_SOCK` is actually in the running service's
  environment, not just the `.env` file on disk.

**`MULLION_SSH_AUTH_SOCK` needs a build that actually contains this
feature.** The config key itself is accepted (and silently does nothing) on
any Mullion build — `@fastify/env` validates the key exists in the schema,
but an older binary has no code that reads it. This feature shipped in
`v0.2.46`; if you're on an older release, upgrading is the fix, not
re-checking your config.

**A pre-existing session won't pick up a config change.** `SSH_AUTH_SOCK` is
set once, at a session's own launch — a session that was already running
before you set `MULLION_SSH_AUTH_SOCK` (or before you restarted the service
after setting it) keeps whatever it originally inherited. This is by design
(see the injection's own "set unconditionally, never gated on the socket
being live" behavior above) — it means a running session doesn't need to be
restarted just because the Mac's tunnel dropped and came back, but it also
means a _config_ change needs a fresh session (or a full session
reattach — reattaching alone does not re-run this) to take effect. The same
is true switching to or from the bridge.

**A session has `SSH_AUTH_SOCK` set but `ssh-add -l` fails.** Settings ->
Hosts -> that host's config panel reports the configured
`MULLION_SSH_AUTH_SOCK` path, which of `configured` / `ambient` / `bridge`
tier actually supplied it (see [Precedence](#precedence)), and whether the
socket currently exists on disk. `present: false` almost always means no
`ssh -R` tunnel is currently up for that host — check the laptop-side tunnel
for that specific host, not Mullion's own config, since a dangling socket is
the expected state whenever the tunnel is down (by design, so a session
doesn't need respawning when it comes back). An older agent build
(pre-dating this diagnostic) reports this field as absent rather than
`false`; that reads as "unknown," not as a missing socket. The reported path
is resolved (`path.resolve`), host-locally, the same way the injection
itself resolves it — if you configured a relative path, what's shown here is
the absolute path it resolved to on that host, not the raw string from
`.env`.

## Precedence

A session's `SSH_AUTH_SOCK` is resolved once, at launch, in this order:

1. **`configured`** — this host's `MULLION_SSH_AUTH_SOCK`, if set, always
   wins, whether or not a bridge is ever paired. An operator who already has
   a working manual tunnel keeps it unchanged after the bridge ships or gets
   paired elsewhere in the fleet.
2. **`ambient`** — if this host's own Mullion process inherited a
   `SSH_AUTH_SOCK` from its environment (systemd `--user`, PAM, a desktop
   keyring), that value passes through untouched.
3. **`bridge`** — only if neither of the above applies, and only on an agent
   host: the socket the bridge materializes, live the moment any laptop
   pairs, whether or not one happens to be connected at the instant the
   session launches (a session started before any pairing starts working the
   moment one connects, no respawn needed).
4. **`none`** — nothing supplies it; `SSH_AUTH_SOCK` is left unset.

Settings → Hosts reports which tier actually supplied a given host's socket.

## Multi-host

The bridge and the manual tunnel compose with Mullion's multi-host feature
very differently:

- **Bridge**: one pairing, done once from the primary's Settings, serves
  every enrolled **agent** host automatically — pairing again per host is
  neither needed nor possible (there's one bridge connection, fanned out to
  whichever agent host's session needs it). Enrolling a new agent host later
  needs no laptop-side change.
- **Manual tunnel**: since `MULLION_SSH_AUTH_SOCK` is host-level config, it
  composes with multi-host with no extra code, but per-host: each host
  (primary or agent) that needs SSH access sets its own
  `MULLION_SSH_AUTH_SOCK`, and you point one `ssh -R` at each such host
  independently. Nothing is proxied through the primary — the path is always
  resolved host-locally, by whichever host's `PtyManager` actually spawns
  the session. A tunnel to one host says nothing about any other host's
  socket state; check each host's own Settings panel separately.

## Security notes

- **Bridge**: for traffic relayed from an **agent host**, only listing
  loaded identities and signing cross onto the primary — never add, remove,
  lock, or export. For a session running **on the primary itself**, that
  filter doesn't apply: the primary is already the trust boundary the filter
  exists to protect, so there's nothing left to enforce against its own
  traffic, and it can reach every request type — the same access a manual
  `ssh -R` tunnel already grants a primary-local session today, not a new
  capability. A live bridge is reachable by every enrolled agent host's
  sessions, and the primary's own, for as long as it's connected, same
  exposure shape as the manual tunnel below. **Revoking a bridge from
  Settings takes effect immediately** — the live connection is closed as
  part of the same request, not on next reconnect.
- **Manual tunnel**: the forwarded socket is a **remote signing oracle** for
  as long as it's connected: anything that can open it can authenticate as
  you to every host your key trusts. The socket itself is created mode
  `0600` by `sshd` (`StreamLocalBindMask`'s default), owner-only — but every
  process on the Mullion host running as that same user, including every
  session, can use it. That's the same exposure `ssh -A` already gives you;
  this doesn't add a new trust boundary, but it also doesn't reduce the
  existing one, and it's reachable for as long as the forward is up rather
  than only for the lifetime of one interactive connection.
- Add `-o ForwardAgent=no` to any onward SSH hop made _from_ a Mullion host
  (e.g. `ansible_ssh_common_args` in your inventory) so a host you deploy to
  can't reach back through to your laptop's agent — this applies whether
  that host got its socket from the bridge or a manual tunnel.
- If a host has in-app auth disabled, that doesn't change anything here — the
  agent socket (either kind) is gated by filesystem permissions and, for the
  bridge, the pairing/session credential, not by Mullion's own in-app auth —
  but it's still worth fixing independently before relying on this on a host
  anyone else can reach.

## A note on the future

The bridge above closes the original gap this doc used to describe as future
work: your laptop no longer needs a per-host tunnel to serve every enrolled
agent host. It still keeps your laptop as the key holder, though — if it's
offline or asleep, sessions correctly fail rather than silently using the
wrong identity (or none), for both the bridge and the manual tunnel. A
stable, always-available credential — an SSH CA issuing short-lived
certificates, or a boot-unlocked `ssh-agent` on the host itself — would let
this work with the laptop fully out of the loop, at the cost of a different
(host-anchored, not laptop-anchored) trust model. That's still a larger,
separate piece of work, and the bridge's own `SSH_AUTH_SOCK` precedence
(above) means adopting it later wouldn't require ripping either of today's
approaches out.
