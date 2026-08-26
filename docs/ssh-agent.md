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

**Approval cadence.** If your agent (e.g. 1Password) prompts for approval on
every signature, a single `ansible-playbook` run across many hosts can mean
many prompts in a row. Check this on a small run before assuming a large one
is usable — loosening the approval cadence is a real security trade-off, not
a default to drift into.

## Multi-host

Since this is host-level config, it composes with Mullion's multi-host
feature with no extra code: each host (primary or agent) that needs SSH
access sets its own `MULLION_SSH_AUTH_SOCK`, and you point one `ssh -R` at
each such host independently. Nothing is proxied through the primary.

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
