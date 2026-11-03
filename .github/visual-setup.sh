#!/usr/bin/env bash
# Prepares a hosted runner for `make demo`, which the shared visual-check workflow
# runs (through visual-kit) before and after the pull request. Run by that workflow
# as its setup hook.
#
# `make demo` starts real sessions: each one is a dtach PTY inside a transient
# `systemd --user` scope (AGENTS.md, "The non-obvious session model"). The rest of
# CI mocks that out, so a stock runner has neither dtach nor a user manager.
set -euo pipefail

npm ci
npm --prefix frontend ci

sudo apt-get update -qq
sudo apt-get install -y -qq dtach

# A user manager for the runner account, and the two variables the demo passes on
# to its processes (scripts/demo/env.mjs) so they can reach it.
uid=$(id -u)
sudo loginctl enable-linger "$(id -un)"
sudo systemctl start "user@${uid}.service"
for _ in $(seq 1 30); do
  [ -S "/run/user/${uid}/bus" ] && break
  sleep 1
done
[ -S "/run/user/${uid}/bus" ] || { echo "no user bus at /run/user/${uid}/bus" >&2; exit 1; }
{
  echo "XDG_RUNTIME_DIR=/run/user/${uid}"
  echo "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus"
} >>"$GITHUB_ENV"

# Prove it before the demo depends on it: a scope that runs and exits cleanly.
XDG_RUNTIME_DIR="/run/user/${uid}" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${uid}/bus" \
  systemd-run --user --scope --quiet true
