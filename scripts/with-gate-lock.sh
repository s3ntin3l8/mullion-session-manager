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
# Usage: scripts/with-gate-lock.sh <command> [args...]
set -euo pipefail

lock="$(git rev-parse --git-common-dir)/prepush-tests.lock"

# Opt-out for callers that already serialize (or a host without flock).
if [ "${MULLION_NO_GATE_LOCK:-}" = "1" ] || ! command -v flock >/dev/null 2>&1; then
  exec "$@"
fi

exec 9>"$lock"
if ! flock -n 9; then
  echo "pre-push: another worktree's test gate is running; waiting for $lock ..." >&2
  flock 9
fi
exec "$@"
