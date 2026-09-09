# SSH agent access from a session

A Mullion session runs on a host, so it cannot directly reach an SSH agent
that remains on your laptop. Mullion supports two ways to bridge that gap:

- **Mullion Helper** (recommended) pairs once with the primary and serves every
  enrolled host.
- **A manual `ssh -R` tunnel** forwards one socket to one host.

The private key never leaves your laptop in either setup. Approval prompts
from 1Password, Touch ID, `ssh-agent`, or `gpg-agent` still happen there.

## Mullion Helper

[Mullion Helper](https://github.com/s3ntin3l8/mullion-helper) is the
laptop-side tray application. While its tray icon is present, it owns and
supervises the bundled bridge worker. Closing the settings window only hides
the window; choosing **Quit** from the tray stops the worker and the app.

One helper connection supplies `SSH_AUTH_SOCK` to sessions on the primary
and every enrolled agent host. Adding another host does not require another
laptop-side installation or tunnel.

### Install

- **macOS 13.5 or newer on Apple silicon:** download the DMG from the
  [latest Mullion Helper release](https://github.com/s3ntin3l8/mullion-helper/releases/latest),
  drag Mullion Helper to Applications, and open it.
- **Windows 10 or 11 on x64:** download and run the NSIS `setup.exe` from
  the same release page.

Preview builds are ad-hoc signed on macOS and unsigned on Windows. The
operating system may therefore require the normal explicit override for an
app from an unidentified publisher. Platform identity signing is tracked in
[mullion-helper#6](https://github.com/s3ntin3l8/mullion-helper/issues/6).

Linux and Intel macOS packages are not currently shipped. Their rollout is
tracked in [mullion-helper#11](https://github.com/s3ntin3l8/mullion-helper/issues/11)
and [mullion-helper#12](https://github.com/s3ntin3l8/mullion-helper/issues/12).
Use the [manual tunnel](#manual-tunnel-ssh--r) on those platforms for now.

### Pair

1. In Mullion, open **Settings → Hosts → SSH agent bridges** and choose
   **Pair a new bridge**.
2. Copy the one-time payload. It expires after 10 minutes.
3. Open Mullion Helper, paste the payload into its pairing screen, and pair.
4. Confirm that the helper shows **Connected** and Mullion shows the bridge
   as connected.

The helper starts at login after onboarding. Its settings let you select the
SSH-agent socket, pause or resume the bridge, control autostart, inspect local
status, and check for updates. Update checks run at startup, daily while the
app remains open, and on demand; installation is always prompted.

### Existing helper migration

On first launch, Mullion Helper detects credentials from the former
`mullion helper` command-line installation. It imports and validates the
credential, starts its bundled worker, and only disables the old launchd or
Windows autostart entry after the new worker has connected successfully. If
validation or connection fails, the imported copy is rolled back and the old
installation remains active. The retired binary is left on disk, inactive,
so recovery remains possible.

### Status and revocation

The tray app reports the state of the bridge on the current laptop. Mullion's
Settings screen remains the source of truth for the list of paired laptops:

| Mullion status    | Meaning                                                 |
| ----------------- | ------------------------------------------------------- |
| `connected`       | The helper is connected and sessions can use the agent. |
| `pairing pending` | A payload exists but has not been redeemed, or expired. |
| `session expired` | The credential can no longer reconnect; pair again.     |
| `last seen … ago` | Paired but currently disconnected.                      |

Choose **Revoke** beside a bridge in Mullion to delete its server-side
credential and close its live connection immediately. Re-pairing afterward
requires a new payload.

### Security model

For sessions on an agent host, Mullion permits only identity listing
(`SSH_AGENTC_REQUEST_IDENTITIES`) and signing
(`SSH_AGENTC_SIGN_REQUEST`). Requests that add, remove, or lock keys are
rejected independently by both the helper worker and the primary. The shared
conformance vectors for this policy are maintained in both repositories.

A compromised primary can see public identities and request signatures, just
as SSH agent forwarding can, but it cannot extract private keys through the
agent protocol. Primary-local sessions are not filtered at this trust
boundary; restricting those is tracked in
[mullion-session-manager#873](https://github.com/s3ntin3l8/mullion-session-manager/issues/873).

Treat the helper credential as a long-lived bearer token. It renews while the
helper can reach the primary. Revoke the bridge in Mullion if the laptop or
credential may be compromised.

If pairing is redirected to an SSO login page, a forward-auth proxy is
intercepting `/ws/agent-bridge` before it reaches Mullion. See the
[deployment guide](../deploy/README.md) for the required route exemption.

## Manual tunnel (`ssh -R`)

Set `MULLION_SSH_AUTH_SOCK` on a host to a Unix socket forwarded from your
laptop. This remains fully supported and takes precedence over the bridge.

On the receiving host, enable stale-socket replacement in `sshd`:

```text
# /etc/ssh/sshd_config.d/mullion-ssh-agent.conf
StreamLocalBindUnlink yes
```

Reload `sshd`, then create a private socket directory:

```sh
mkdir -p -m 0700 ~/.local/state/mullion-ssh-agent
```

From the laptop, start the reverse forward:

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -R /home/you/.local/state/mullion-ssh-agent/agent.sock:"$SSH_AUTH_SOCK" \
  your-mullion-host
```

Configure the host:

```dotenv
MULLION_SSH_AUTH_SOCK=/home/you/.local/state/mullion-ssh-agent/agent.sock
```

Restart Mullion after changing the environment. New sessions inherit
`SSH_AUTH_SOCK`; existing sessions keep the environment they started with.
Use one tunnel per host and supervise the command with your normal launchd or
systemd user service if it should survive sleep, network changes, and login.

## Precedence

For each host, Mullion resolves the session socket in this order:

1. `MULLION_SSH_AUTH_SOCK`, when explicitly configured.
2. The local socket materialized by a connected Mullion Helper bridge.
3. No `SSH_AUTH_SOCK`.

This lets a host keep an intentional manual tunnel while other hosts use the
same paired helper.

## Troubleshooting

- `ssh-add -l` reports no agent: start a new session after connecting the
  helper or changing host configuration.
- Helper is paired but disconnected: open it from the tray and verify the
  configured socket and primary URL.
- A manual tunnel will not bind after reconnecting: verify
  `StreamLocalBindUnlink yes` is active and remove any stale socket.
- Signatures time out: unlock the laptop's SSH agent and check for a local
  approval prompt.
