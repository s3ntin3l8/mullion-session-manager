#!/usr/bin/env bash
# Serialize the heavy pre-push test hooks across every worktree of this repo.
#
# Several agent sessions routinely push from different `.wt/` worktrees at the
# same time, and each push runs the full vitest suite with coverage (~10 min,
# all cores, heavy IO). Run concurrently they oversubscribe the host, the 20s
# test/hook timeouts start firing, and the failed gate then costs another
# full run. Queueing them behind one lock in the shared git dir makes
# concurrent pushes wait their turn instead of colliding.
#
# The wrapper deliberately does NOT `exec` the command: it stays alive to hold
# the lock, and runs the command with fd 9 closed (`9>&-`). Otherwise every
# process the suite spawns would inherit the lock fd, and a single orphaned
# fixture (e.g. the leaked dtach/sleep processes of #1798) would keep the lock
# held after the hook exits and stall every push in every worktree.
#
# Usage: scripts/with-gate-lock.sh <command> [args...]
# Env:   MULLION_NO_GATE_LOCK=1       skip the lock entirely
#        MULLION_GATE_LOCK_TIMEOUT=N  seconds to wait for the lock (default 3600)
set -euo pipefail

# Opt-out for callers that already serialize (or a host without flock).
if [ "${MULLION_NO_GATE_LOCK:-}" = "1" ] || ! command -v flock >/dev/null 2>&1; then
  exec "$@"
fi

lock="$(git rev-parse --git-common-dir)/prepush-tests.lock"
holder="$lock.holder"
timeout="${MULLION_GATE_LOCK_TIMEOUT:-3600}"

exec 9>>"$lock"
if ! flock -n 9; then
  echo "pre-push: another worktree's test gate is running ($(cat "$holder" 2>/dev/null || echo "holder unknown")); waiting up to ${timeout}s for $lock ..." >&2
  if ! flock -w "$timeout" 9; then
    echo "pre-push: gave up waiting for $lock after ${timeout}s (set MULLION_NO_GATE_LOCK=1 to bypass)" >&2
    exit 1
  fi
fi
echo "pid $$ in $PWD since $(date -Is)" >"$holder"

# Not `exec`, and fd 9 closed for the child (see header).
#
# `set -m` gives the child its own process group with default signal handling.
# Without it bash starts a background child with SIGINT/SIGQUIT ignored, so
# Ctrl-C would stop the wrapper but not the suite. Since the child is then
# outside the terminal's foreground group, forward the terminating signals to
# it explicitly; otherwise a TERM sent only to the wrapper would drop the lock
# while the suite kept running.
set -m
"$@" 9>&- &
child=$!
trap 'kill -s TERM -- "-$child" 2>/dev/null || true' TERM
trap 'kill -s INT -- "-$child" 2>/dev/null || true' INT
trap 'kill -s HUP -- "-$child" 2>/dev/null || true' HUP

# `wait` returns early (status > 128) when a trapped signal arrives; keep
# waiting until the child has really exited.
status=0
while :; do
  wait "$child" && status=0 || status=$?
  kill -0 "$child" 2>/dev/null || break
done
exit "$status"
