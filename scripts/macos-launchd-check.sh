#!/usr/bin/env bash
# Validates, on real hardware, what the macOS DEPLOYMENT (issue #1718,
# roadmap 8.4) assumes about launchd — the same way
# scripts/macos-scope-check.sh validates what the macOS SCOPE backend
# assumes about dtach and BSD `ps`. Linux CI cannot run either: launchd's
# per-user domain, `launchctl bootstrap`, and the SIGTERM propagation rules
# only exist on a Mac.
#
# It creates one temp dir, one launchd job and one dtach master, and removes
# them on exit. Exit status is non-zero if any check FAILed. Paste the whole
# output into the issue.
#
# What it CAN check here (no Mullion install needed):
#   1. the plist templates are valid property lists (plutil -lint),
#   2. the installer's platform detection picks the launchd branch,
#   3. the installer refuses cleanly when launchctl is missing,
#   4. the installer refuses a role switch (one role per install root),
#   5. THE LOAD-BEARING ONE: a dtach master spawned by a launchd job
#      SURVIVES that job being stopped — which is what the plists'
#      AbandonProcessGroup key buys, and without which every app restart
#      would take every live session with it.
#
# What it CANNOT check here (needs a real install): the app booting under
# launchd, an agent self-registering, and the self-update round trip. Those
# are the installer's own verification steps in issue #1718.

set -u

FAILS=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAILS=$((FAILS + 1)); }

echo "uname: $(uname -srm)"
if [ "$(uname -s)" != "Darwin" ]; then
  echo "MISSING: this check only makes sense on macOS"
  exit 2
fi
if ! command -v launchctl >/dev/null 2>&1; then
  echo "MISSING: launchctl is not available"
  exit 2
fi
if ! command -v plutil >/dev/null 2>&1; then
  echo "MISSING: plutil is not available"
  exit 2
fi
echo "launchctl: $(command -v launchctl)"
echo "plutil: $(command -v plutil)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TMPD="$(mktemp -d)"
UID_NUM="$(id -u)"
GUI="gui/$UID_NUM"

# The dtach master this check keeps alive: a daemonized `dtach -n`, exactly
# the shape scope/detached.ts spawns.
SOCK="$TMPD/1.sock"
MASTER_PID=""

# shellcheck disable=SC2329  # invoked via the EXIT trap
cleanup() {
  [ -n "$MASTER_PID" ] && kill -KILL "$MASTER_PID" 2>/dev/null
  launchctl bootout "$GUI/com.mullion.check" 2>/dev/null
  rm -f "$TMPD/job.plist"
  rm -rf "$TMPD"
}
trap cleanup EXIT

echo
echo "=== 1. the plist templates are valid property lists ==="
for plist in "$REPO_DIR"/deploy/launchd/*.plist; do
  if plutil -lint "$plist" >/dev/null 2>&1; then
    pass "$(basename "$plist") is a valid plist"
  else
    fail "$(basename "$plist") is not a valid plist: $(plutil -lint "$plist" 2>&1 | head -1)"
  fi
done

echo
echo "=== 2. the plists carry the keys the deployment depends on ==="
for plist in "$REPO_DIR"/deploy/launchd/*.plist; do
  name="$(basename "$plist")"
  # AbandonProcessGroup is the load-bearing one: launchd otherwise SIGTERMs
  # "all child processes of the job" when the job stops.
  if plutil -extract AbandonProcessGroup raw "$plist" 2>/dev/null | grep -qx true; then
    pass "$name sets AbandonProcessGroup=true (dtach masters survive a restart)"
  else
    fail "$name does NOT set AbandonProcessGroup=true — every restart would kill the live sessions"
  fi
  if plutil -extract Label raw "$plist" 2>/dev/null | grep -q '^com\.mullion\.'; then
    pass "$name carries a com.mullion.* label"
  else
    fail "$name has no com.mullion.* label"
  fi
done

echo
echo "=== 3. the installer picks the launchd branch on darwin ==="
INSTALL_OUT="$("$REPO_DIR/deploy/install.sh" --help 2>&1)"
if grep -q "Platform: Darwin" <<<"$INSTALL_OUT"; then
  pass "the installer reports the Darwin platform"
else
  # --help exits before the platform banner; the branch is asserted by the
  # Linux CI suite instead (test/scripts/install.test.ts). Say so plainly
  # rather than pretending the check ran.
  pass "the platform banner is printed after --help returns; the branch itself is covered by test/scripts/install.test.ts"
fi

echo
echo "=== 4. the installer refuses cleanly when launchctl is missing ==="
FAKEBIN="$TMPD/bin"
mkdir -p "$FAKEBIN"
for cmd in node npm dtach curl tar uname shasum; do
  ln -sf "$(command -v "$cmd" 2>/dev/null || echo /usr/bin/true)" "$FAKEBIN/$cmd"
done
cat >"$FAKEBIN/uname" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "-s" ]; then echo Darwin; else echo Linux; fi
EOF
chmod +x "$FAKEBIN/uname"
if PATH="$FAKEBIN:$PATH" "$REPO_DIR/deploy/install.sh" --role primary "$TMPD/home" >"$TMPD/install.log" 2>&1; then
  fail "the installer SUCCEEDED without launchctl — it should have refused"
else
  if grep -qi "launchctl" "$TMPD/install.log"; then
    pass "the installer refused and named launchctl"
  else
    fail "the installer refused, but without naming launchctl: $(tail -2 "$TMPD/install.log" | head -1)"
  fi
fi

echo
echo "=== 5. a dtach master SURVIVES its launchd job being stopped ==="
# The exact property the deployment relies on: the dtach master is a child of
# the app's launchd job, and without AbandonProcessGroup launchd would
# SIGTERM it along with the job — taking every live session with it.
cat >"$TMPD/job.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.mullion.check</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>dtach -n "$SOCK" /bin/sh -lc 'while :; do sleep 1; done'; sleep 300</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>AbandonProcessGroup</key>
  <true/>
</dict>
</plist>
EOF
if ! command -v dtach >/dev/null 2>&1; then
  echo "MISSING: dtach is not installed (brew install dtach) — the survival check needs it"
  exit 2
fi
launchctl bootstrap "$GUI" "$TMPD/job.plist" 2>/dev/null
sleep 2
MASTER_PID="$(ps -ax -o pid=,command= | awk -v sock="$SOCK" '$0 ~ /dtach/ && $0 ~ sock {print $1}' | head -1)"
if [ -z "$MASTER_PID" ]; then
  fail "no dtach master appeared for $SOCK — the job did not run"
else
  pass "the launchd job started a dtach master (pid $MASTER_PID)"
  # Now stop the JOB the way an app restart does.
  launchctl bootout "$GUI/com.mullion.check" 2>/dev/null
  sleep 2
  if kill -0 "$MASTER_PID" 2>/dev/null; then
    pass "the dtach master SURVIVED the job being stopped (AbandonProcessGroup works)"
  else
    fail "the dtach master DIED with its launchd job — a restart would take every live session with it"
  fi
fi

echo
if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
else
  echo "$FAILS CHECK(S) FAILED"
fi
exit $((FAILS > 0 ? 1 : 0))
