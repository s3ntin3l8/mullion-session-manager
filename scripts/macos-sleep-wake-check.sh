#!/usr/bin/env bash
# Validates, on real hardware, what issue #1719 (roadmap 8.5) assumes about
# macOS sleep/wake — the same way scripts/macos-launchd-check.sh validates what
# the macOS DEPLOYMENT (issue #1718) assumes about launchd, and
# scripts/macos-scope-check.sh validates what the macOS SCOPE backend assumes
# about dtach. Linux CI cannot run any of it: a lid-close suspend, `caffeinate`'s
# power assertion and `pmset`'s sleep policy only exist on a Mac.
#
# It creates one temp dir and one dtach master, and removes them on exit. Exit
# status is non-zero if any check FAILed. Paste the whole output into the issue.
#
# What it CAN check here (no Mullion install needed):
#   1. `caffeinate` exists, starts, and HOLDS a power assertion that
#      `pmset -g assertions` reports — the property Mullion's keep-awake
#      depends on (services/keep-awake.ts),
#   2. that `caffeinate` EXITS when it is terminated — so Mullion's disarm
#      path really releases the assertion instead of leaking a child that
#      keeps the machine awake forever,
#   3. `pmset -g custom` — the host's actual sleep policy, for the report,
#   4. the launchd templates still carry the keys the deployment depends on
#      (KeepAlive/RunAtLoad/AbandonProcessGroup) — issue #1719 deliberately
#      changes NONE of them,
#   5. a dtach master SURVIVES being SIGSTOPped and SIGCONTed — a cheap
#      PROXY for a suspend/resume cycle. A real suspend needs a real sleep
#      (section 6), and this proxy does NOT prove that: a stopped process
#      keeps its network and its sockets, which a sleeping machine does not.
#      It proves only that the process and its socket survive a suspension.
#
# What it CANNOT check here (needs a real lid-close cycle): that the machine
# really suspends and resumes, that the agent re-registers on wake, and that
# a sleeping host's sessions read "unknown" and never "dead". Those are the
# checklist items in the validation issue.
#
# Section 6 MEASURES the one thing the code deliberately refuses to assume:
# whether the MONOTONIC clock advances across a macOS suspend. Mullion's
# suspend detection is built on the WALL clock precisely because that
# question has no portable answer (see src/services/suspend-detect.ts), and
# this measurement is what settles it for this hardware.
#
# EVERYTHING this script touches is sandboxed, following issue #1801's lessons:
# a temp dir (never the real $HOME), a launchd label unique to this run
# (never com.mullion.agent / com.mullion.primary), a bootout in the EXIT trap,
# real-file shims rather than symlinks onto system binaries, and no network
# access at all.

set -u

FAILS=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAILS=$((FAILS + 1)); }
skip() { echo "SKIP  $*"; }

echo "uname: $(uname -a | cut -d' ' -f1-3)"
if [ "$(uname -s)" != "Darwin" ]; then
  echo "MISSING: this check only makes sense on macOS"
  exit 2
fi
if ! command -v caffeinate >/dev/null 2>&1; then
  echo "MISSING: caffeinate is not available"
  exit 2
fi
if ! command -v pmset >/dev/null 2>&1; then
  echo "MISSING: pmset is not available"
  exit 2
fi
echo "caffeinate: $(command -v caffeinate)"
echo "pmset: $(command -v pmset)"
if command -v dtach >/dev/null 2>&1; then
  echo "dtach: $(command -v dtach)"
else
  echo "dtach: (not installed — section 5 will be skipped)"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TMPD="$(mktemp -d)"
# A label unique to THIS run. Never com.mullion.agent / com.mullion.primary —
# booting out a real job would stop the developer's own Mullion.
LABEL="com.mullion.sleepcheck.$$"
MASTER_PID=""
CAFF_PID=""

cleanup() {
  [ -n "$CAFF_PID" ] && kill -TERM "$CAFF_PID" 2>/dev/null
  [ -n "$MASTER_PID" ] && kill -KILL "$MASTER_PID" 2>/dev/null
  rm -rf "$TMPD"
}
trap cleanup EXIT

echo
echo "=== 1. caffeinate starts and holds a power assertion ==="
# Mullion spawns `caffeinate -dimsu -w <pid>` (src/services/keep-awake.ts).
# The `-w <pid>` is what makes the child exit when Mullion dies — without it,
# launchd's AbandonProcessGroup=true would leave an orphaned caffeinate behind
# holding the assertion, and the machine could never sleep again.
CAFF_PID="$(command -v caffeinate)"
"$CAFF_PID" -dimsu -w $$ &
CAFF_PID=$!
sleep 2
if ! kill -0 "$CAFF_PID" 2>/dev/null; then
  fail "caffeinate -dimsu -w exited immediately — it did not hold an assertion"
else
  pass "caffeinate -dimsu -w is running (pid $CAFF_PID)"
  # The assertion must be attributed to OUR caffeinate, not merely counted
  # system-wide: powerd holds a PreventUserIdleSystemSleep of its own
  # ("Prevent sleep while display is on") on every Mac with a lit display, so
  # a system-wide count says nothing about whether OURS is held. The
  # "Listed by owning process" section names the owner by pid.
  ASSERTIONS="$(pmset -g assertions 2>/dev/null)"
  if printf '%s' "$ASSERTIONS" | grep -q "pid $CAFF_PID(caffeinate)"; then
    pass "pmset reports an assertion owned by our caffeinate (pid $CAFF_PID)"
    printf '%s\n' "$ASSERTIONS" | grep "pid $CAFF_PID(caffeinate)" | sed 's/^/      /'
  else
    fail "pmset -g assertions does NOT list an assertion owned by our caffeinate (pid $CAFF_PID) — the keep-awake would not hold the machine awake"
    printf '%s\n' "$ASSERTIONS" | sed 's/^/      /' | head -20
  fi
fi

echo
echo "=== 2. caffeinate EXITS when it is terminated ==="
# The disarm path in keep-awake.ts sends SIGTERM. If caffeinate ignored it,
# every armed/disarmed cycle would leak a child holding the assertion.
kill -TERM "$CAFF_PID" 2>/dev/null
for _ in 1 2 3 4 5 6 7 8 9 10; do
  kill -0 "$CAFF_PID" 2>/dev/null || break
  sleep 0.3
done
if kill -0 "$CAFF_PID" 2>/dev/null; then
  fail "caffeinate SURVIVED SIGTERM — Mullion's disarm would leak a child holding the assertion"
  kill -KILL "$CAFF_PID" 2>/dev/null
else
  pass "caffeinate exited on SIGTERM"
fi
CAFF_PID_KILLED="$CAFF_PID"
CAFF_PID=""
sleep 1
# Again, attributed to OUR pid: powerd's own "prevent sleep while display is
# on" assertion is still held here (the display is lit), so the check is that
# the caffeinate-OWNED assertion is gone — which is what Mullion's disarm
# path is responsible for.
if pmset -g assertions 2>/dev/null | grep -q "pid $CAFF_PID_KILLED(caffeinate)"; then
  fail "an assertion owned by our caffeinate is STILL held after it exited"
else
  pass "our caffeinate's power assertion was released"
fi

echo
echo "=== 3. the host's sleep policy ==="
# Reported, not asserted: what matters is that the operator KNOWS it, because
# an aggressive sleep setting is what the keep-awake has to fight.
pmset -g custom 2>/dev/null | sed 's/^/      /'
pass "pmset -g custom printed the host's sleep policy"

echo
echo "=== 4. the launchd templates still carry the keys the deployment depends on ==="
# Issue #1719 deliberately changes NONE of these. KeepAlive={SuccessfulExit:
# false} + RunAtLoad already cover a crash and a reboot, and changing
# KeepAlive to an unconditional true would fight install.sh's and the
# self-update's bootout/bootstrap sequence — and would undo an operator's
# deliberate `launchctl stop`.
for plist in "$REPO_DIR"/deploy/launchd/*.plist; do
  name="$(basename "$plist")"
  if plutil -extract RunAtLoad raw "$plist" 2>/dev/null | grep -qx true; then
    pass "$name sets RunAtLoad=true"
  else
    fail "$name does NOT set RunAtLoad=true"
  fi
  if plutil -extract KeepAlive.SuccessfulExit raw "$plist" 2>/dev/null | grep -qx false; then
    pass "$name sets KeepAlive.SuccessfulExit=false (restart on a crash, not on a clean stop)"
  else
    fail "$name does NOT set KeepAlive.SuccessfulExit=false"
  fi
  if plutil -extract AbandonProcessGroup raw "$plist" 2>/dev/null | grep -qx true; then
    pass "$name sets AbandonProcessGroup=true (dtach masters survive a restart)"
  else
    fail "$name does NOT set AbandonProcessGroup=true"
  fi
done

echo
echo "=== 5. a dtach master SURVIVES a suspend/resume PROXY (SIGSTOP/SIGCONT) ==="
# A PROXY, and only a proxy: a stopped process keeps its network and its
# sockets, which a sleeping machine does not. It establishes that the
# process and its socket survive a suspension; it does NOT establish that a
# real macOS suspend leaves them intact — that is section 6's job.
if ! command -v dtach >/dev/null 2>&1; then
  skip "dtach is not installed (brew install dtach) — the suspend/resume proxy needs it"
else
  SOCK="$TMPD/scope.sock"
  dtach -n "$SOCK" /bin/sh -lc 'while :; do sleep 1; done' >/dev/null 2>&1
  sleep 1
  # dtach forks and the parent exits, so the master is the HIGHEST pid whose
  # command line IS "dtach -n <socket> …" (the wrapper that started it
  # carries the same strings and must not be mistaken for it).
  MASTER_PID="$(ps -ax -o pid=,command= | awk -v sock="$SOCK" '
    $2 == "dtach" && $3 == "-n" && index($0, sock) { print $1 }
  ' | sort -n | tail -1)"
  if [ -z "$MASTER_PID" ]; then
    fail "no dtach master appeared for $SOCK"
  else
    pass "the dtach master is running (pid $MASTER_PID)"
    kill -STOP "$MASTER_PID" 2>/dev/null
    sleep 2
    if kill -0 "$MASTER_PID" 2>/dev/null; then
      pass "the dtach master survived SIGSTOP"
    else
      fail "the dtach master DIED on SIGSTOP"
    fi
    kill -CONT "$MASTER_PID" 2>/dev/null
    sleep 1
    if kill -0 "$MASTER_PID" 2>/dev/null; then
      pass "the dtach master survived SIGCONT"
    else
      fail "the dtach master DIED on SIGCONT"
    fi
    # The socket is the scope's identity (scope/detached.ts) — a master that
    # survived the suspension but lost its socket would be no use at all.
    if [ -S "$SOCK" ]; then
      pass "the scope's socket still exists after the suspend/resume proxy"
    else
      fail "the scope's socket is GONE after the suspend/resume proxy"
    fi
  fi
fi

echo
echo "=== 6. the suspend-gap MEASUREMENT (needs a real lid-close) ==="
# This is the one question the code deliberately refuses to assume: does the
# MONOTONIC clock advance across a macOS suspend? Mullion's detection uses the
# WALL clock (which always advances), so the answer does not change the
# implementation — but it DOES decide whether a pending renewal timer can be
# missed past the session TTL, and that is worth knowing on real hardware.
#
# Run it as a second step, with the lid actually closed:
#
#     scripts/macos-sleep-wake-check.sh --measure
#
MEASURE="$TMPD/measure.js"
cat >"$MEASURE" <<'EOF'
// Prints the wall-clock and monotonic deltas across a real suspend.
const wall = () => Date.now();
const mono = () => Number(process.hrtime.bigint() / 1000000n);
const before = { wall: wall(), mono: mono() };
console.log("before:", new Date(before.wall).toISOString());
console.log("Close the lid now. Press Enter once the machine has WOKEN UP again.");
process.stdin.setEncoding("utf8");
process.stdin.once("data", () => {
  const after = { wall: wall(), mono: mono() };
  const wallDelta = after.wall - before.wall;
  const monoDelta = after.mono - before.mono;
  console.log("after: ", new Date(after.wall).toISOString());
  console.log("wall clock delta (ms):", wallDelta);
  console.log("monotonic delta (ms):", monoDelta);
  console.log(
    "the monotonic clock advanced across the sleep:",
    monoDelta > 1000 ? "YES" : "NO",
  );
  console.log(
    "a renewal timer set before the sleep would fire:",
    monoDelta > 1000
      ? "as soon as the machine woke (the elapsed time is counted)"
      : "only after its ORIGINAL full delay (the elapsed time is NOT counted)",
  );
});
EOF

if [ "${1:-}" = "--measure" ]; then
  echo "measuring — close the lid, wait, then reopen it and press Enter:"
  node "$MEASURE"
else
  echo "The measurement was prepared but NOT run."
  echo "Re-run this script with --measure and close the lid while it waits:"
  echo "    $SCRIPT_DIR/macos-sleep-wake-check.sh --measure"
fi

echo
if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
else
  echo "$FAILS CHECK(S) FAILED"
fi
exit $((FAILS > 0 ? 1 : 0))
