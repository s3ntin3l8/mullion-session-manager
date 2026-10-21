#!/bin/bash
# Validates, on real hardware, what the macOS scope backend
# (src/services/scope/detached.ts, issue #1716) assumes about dtach and BSD
# `ps`. Linux CI cannot run that backend, so this is run once, by hand, on a
# Mac (issue #1741). It needs `dtach` (`brew install dtach`) and nothing else
# beyond the base system (`ps`, `nc`, `awk`). It also runs on Linux, which is
# how the script itself is sanity-checked.
#
# It creates one temp dir and one detached session, and removes both on exit.
# Exit status is non-zero if any check FAILed. Paste the whole output into the
# issue.

set -u

FAILS=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAILS=$((FAILS + 1)); }

echo "uname: $(uname -srm)"
if ! command -v dtach >/dev/null 2>&1; then
  echo "MISSING: dtach is not installed (brew install dtach)"
  exit 2
fi
echo "dtach: $(command -v dtach)"
dtach --help 2>&1 | head -1 || true

TMPD="$(mktemp -d)"
SOCK="$TMPD/1.sock"
MASTER_PID=""
# shellcheck disable=SC2329  # invoked via the EXIT trap
cleanup() {
  [ -n "$MASTER_PID" ] && kill -KILL "$MASTER_PID" 2>/dev/null
  rm -rf "$TMPD"
}
trap cleanup EXIT

# The exact process-table read the backend does (PS_ARGS in detached.ts).
# COLUMNS is widened the same way the backend does.
ps_table() { COLUMNS=10000 ps -ax -o pid=,ppid=,pgid=,command=; }
# Rows whose argv[0] is dtach and which create $SOCK.
master_rows() { ps_table | awk -v sock="$SOCK" '$4 ~ /(^|\/)dtach$/ && $5 == "-n" && $6 == sock'; }

# Same shape as the backend's launch: dtach -n <socket> <shell> -lc <command>
dtach -n "$SOCK" /bin/sh -lc 'while :; do sleep 1; done' || {
  echo "FAIL  dtach -n failed to start"
  exit 1
}
sleep 1

echo
echo "=== 1. BSD ps renders pid=,ppid=,pgid=,command= as four fields, command last ==="
ps_table | head -3
if ps_table | awk 'NF < 4 || $1 !~ /^[0-9]+$/ || $2 !~ /^[0-9]+$/ || $3 !~ /^[0-9]+$/ { bad = 1 } END { exit bad }'; then
  pass "every row is pid ppid pgid <command...> (numeric first three fields)"
else
  fail "some rows do not parse as pid ppid pgid command"
fi

echo
echo "=== 2. dtach's argv, with the socket path, is visible in ps ==="
master_rows
MASTER_PID="$(master_rows | awk '{print $1}' | sort -rn | head -1)"
if [ -n "$MASTER_PID" ]; then
  pass "found a dtach -n row naming the socket; highest pid = $MASTER_PID"
else
  fail "no dtach -n row names the socket: dtach may rewrite its process title, and teardown would silently no-op"
  echo "--- dtach-ish rows, for the report ---"
  ps_table | grep -i dtach | grep -v grep
  exit 1
fi
echo "master: $(master_rows | awk -v p="$MASTER_PID" '$1 == p')"
PGID="$(ps -o pgid= -p "$MASTER_PID" | tr -d ' ')"
echo "master pgid=$PGID pid=$MASTER_PID (backend kills the group only when pgid == pid)"

echo
echo "=== 3. A probe connection is harmless (does not kill the session, does not clog the accept queue) ==="
if [ -S "$SOCK" ]; then pass "socket file is a unix socket"; else fail "socket file missing / not a socket"; fi
# Many short-lived probes, as liveness polling would make over time.
i=0
while [ $i -lt 300 ]; do
  nc -U -w 1 "$SOCK" </dev/null >/dev/null 2>&1 &
  i=$((i + 1))
  # keep the burst bounded
  [ $((i % 50)) -eq 0 ] && wait
done
wait
sleep 1
if kill -0 "$MASTER_PID" 2>/dev/null && [ -n "$(master_rows)" ]; then
  pass "session survived 300 probe connections"
else
  fail "session died after probe connections"
fi
# A further client must still be accepted afterwards (queue not wedged).
if nc -U -w 2 "$SOCK" </dev/null >/dev/null 2>&1; then
  pass "a further connection is still accepted"
else
  fail "a further connection was refused or timed out after the probes"
fi
echo "NOTE  not covered here: a probe against a live interactive attach (needs a tty)."
echo "      Check by hand: 'dtach -a $SOCK' in one terminal, run the nc line above"
echo "      from another, confirm the attached terminal is not displaced."

echo
echo "=== 4. Socket file vs. the master's death ==="
# SIGTERM: dtach has a handler and may unlink its own socket. SIGKILL cannot be
# handled, so the file is always left behind: that stale file is what the
# backend's teardown unlinks itself, and what the probe must read as dead.
kill -TERM "$MASTER_PID" 2>/dev/null
sleep 1
if kill -0 "$MASTER_PID" 2>/dev/null; then fail "master did not exit on SIGTERM (backend escalates to SIGKILL)"; else pass "master exited on SIGTERM"; fi
if [ -e "$SOCK" ]; then
  echo "NOTE  socket file left behind after SIGTERM"
else
  echo "NOTE  dtach unlinked its own socket on SIGTERM (the backend's unlink is then a no-op)"
fi
SOCK2="$TMPD/2.sock"
dtach -n "$SOCK2" /bin/sh -lc 'while :; do sleep 1; done'
sleep 1
PID2="$(COLUMNS=10000 ps -ax -o pid=,command= | awk -v sock="$SOCK2" '$3 == "-n" && $4 == sock { print $1 }' | sort -rn | head -1)"
if [ -z "$PID2" ]; then
  fail "could not find the second master"
else
  kill -KILL "$PID2" 2>/dev/null
  sleep 1
  if [ -e "$SOCK2" ]; then
    pass "socket file left behind after SIGKILL (the backend relies on this and removes it itself)"
    if nc -U -w 2 "$SOCK2" </dev/null >/dev/null 2>&1; then
      fail "stale socket still accepted a connection"
    else
      pass "connecting to the stale socket fails (probe reads it as dead)"
    fi
  else
    echo "NOTE  no stale file even after SIGKILL; the backend's unlink is a no-op"
  fi
fi
MASTER_PID=""

echo
if [ "$FAILS" -eq 0 ]; then
  echo "=== all checks passed ==="
else
  echo "=== $FAILS check(s) FAILED: record them in issue #1741 so the backend can be corrected ==="
fi
exit $((FAILS > 0))
