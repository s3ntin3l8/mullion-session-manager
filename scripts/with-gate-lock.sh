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
#        (the command keeps the terminal: it stays in the foreground process
#        group, so it may read stdin and receives Ctrl-C / Ctrl-Z as usual)
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

# Who holds the lock, for the waiting message. The pid is checked so a holder
# file left behind by a SIGKILLed wrapper is reported as unknown, not as fact.
describe_holder() {
  local pid
  pid="$(sed -n 's/^pid \([0-9][0-9]*\) .*/\1/p' "$holder" 2>/dev/null | head -n1)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then cat "$holder"; else echo "holder unknown"; fi
}

exec 9>>"$lock"
if ! flock -n 9; then
  echo "pre-push: another worktree's test gate is running ($(describe_holder)); waiting up to ${timeout}s for $lock ..." >&2
  if ! flock -w "$timeout" 9; then
    echo "pre-push: gave up waiting for $lock after ${timeout}s (set MULLION_NO_GATE_LOCK=1 to bypass)" >&2
    exit 1
  fi
fi
trap 'rm -f "$holder"' EXIT
echo "pid $$ in $PWD since $(date -Is)" >"$holder"

# Not `exec`, and fd 9 closed for the child (see header). The wrapper has to
# outlive the command to keep the lock, so a signal sent only to the wrapper
# must reach the command too, or the lock would drop while the suite keeps
# running. The traps go in BEFORE the spawn (guarded on `child`) so there is no
# window where a TERM kills the wrapper and orphans the command.
child=
# shellcheck disable=SC2317,SC2329  # invoked indirectly, from the traps below
forward() { [ -z "$child" ] || kill -s "$1" "$child" 2>/dev/null || true; }
trap 'forward TERM' TERM
trap 'forward INT' INT
trap 'forward HUP' HUP

# A bash background job has SIGINT/SIGQUIT ignored, so reset them in the
# subshell or Ctrl-C would stop the wrapper but not the suite. Deliberately no
# job control (`set -m`): the command stays in the terminal's foreground
# process group, so it can still read the tty, and `wait` blocks until it
# really exits instead of returning early on a stopped child.
( trap - INT QUIT; exec "$@" ) 9>&- &
child=$!

# `wait` also returns early (status > 128) when a trapped signal arrives; keep
# waiting until the child has really exited.
status=0
while :; do
  wait "$child" && status=0 || status=$?
  kill -0 "$child" 2>/dev/null || break
done
exit "$status"
