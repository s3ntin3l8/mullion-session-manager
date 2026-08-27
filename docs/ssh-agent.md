# SSH agent access from a session

A Mullion session runs on the host, not on your laptop, so it can't reach a
laptop-local SSH agent (1Password's SSH agent, `ssh-agent`, `gpg-agent`
in SSH mode, ...) the way a local terminal or an `ssh -A` connection can. If a
tool run from a session — `ansible`, `git`, plain `ssh` — needs to
authenticate with a key that deliberately never leaves your laptop, that key
has to be reachable some other way.

`MULLION_SSH_AUTH_SOCK` closes that gap on the Mullion side: point it at any
unix socket that speaks the SSH agent protocol, and every session gets
`SSH_AUTH_SOCK` set to that path. **Mullion does not create, manage, or care
what's on the other end of that socket** — getting a real agent-protocol
socket onto the host is a separate, host-level step. The rest of this doc
covers the transport this is designed against: OpenSSH's own remote
unix-socket forwarding, which already does this without any bridge code.

## Why plain OpenSSH is enough

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
etc.). Approval prompts (Touch ID, 1Password's biometric unlock, ...) still
happen on your laptop, per signature — nothing about the key's trust model
changes.

## Host setup (once per host)

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

## Laptop setup (once per host you want to serve)

Run the `ssh -N -R ...` command above under something that keeps it alive —
a `launchd` `KeepAlive` job on macOS, a user systemd unit on Linux. One job
per host. `ExitOnForwardFailure=yes` matters: without it, `ssh` can stay
"connected" with a silently-dead forward.

### macOS (launchd)

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

### Linux (systemd --user)

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
a default to drift into.

## Troubleshooting

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
reattach — reattaching alone does not re-run this) to take effect.

**A session has `SSH_AUTH_SOCK` set but `ssh-add -l` fails.** Settings ->
Hosts -> that host's config panel reports the configured
`MULLION_SSH_AUTH_SOCK` path and whether the socket currently exists on
disk. `present: false` almost always means no `ssh -R` tunnel is currently
up for that host — check the laptop-side tunnel for that specific host, not
Mullion's own config, since a dangling socket is the expected state whenever
the tunnel is down (by design, so a session doesn't need respawning when it
comes back). An older agent build (pre-dating this diagnostic) reports this
field as absent rather than `false`; that reads as "unknown," not as a
missing socket.

## Multi-host

Since this is host-level config, it composes with Mullion's multi-host
feature with no extra code: each host (primary or agent) that needs SSH
access sets its own `MULLION_SSH_AUTH_SOCK`, and you point one `ssh -R` at
each such host independently. Nothing is proxied through the primary — the
path is always resolved host-locally, by whichever host's `PtyManager`
actually spawns the session. A tunnel to one host says nothing about any
other host's socket state; check each host's own Settings panel separately.

## Security notes

- The forwarded socket is a **remote signing oracle** for as long as it's
  connected: anything that can open it can authenticate as you to every host
  your key trusts. The socket itself is created mode `0600` by `sshd`
  (`StreamLocalBindMask`'s default), owner-only — but every process on the
  Mullion host running as that same user, including every session, can use
  it. That's the same exposure `ssh -A` already gives you; this doesn't add a
  new trust boundary, but it also doesn't reduce the existing one, and it's
  reachable for as long as the forward is up rather than only for the
  lifetime of one interactive connection.
- Add `-o ForwardAgent=no` to any onward SSH hop made _from_ the Mullion host
  (e.g. `ansible_ssh_common_args` in your inventory) so a host you deploy to
  can't reach back through to your laptop's agent.
- If this host has in-app auth disabled, that doesn't change anything here —
  the agent socket is gated by filesystem permissions, not by Mullion's own
  auth — but it's still worth fixing independently before relying on this on
  a host anyone else can reach.

## A note on the future

The setup above keeps your laptop as the key holder: if it's offline or
asleep, sessions correctly fail rather than silently using the wrong
identity (or none). A stable, always-available credential — an SSH CA issuing
short-lived certificates, or a boot-unlocked `ssh-agent` on the host itself —
would let this work with the laptop fully out of the loop, at the cost of a
different (host-anchored, not laptop-anchored) trust model. That's a larger,
separate piece of work; `MULLION_SSH_AUTH_SOCK` is designed to point at
whichever kind of socket you choose without any further Mullion-side change.
