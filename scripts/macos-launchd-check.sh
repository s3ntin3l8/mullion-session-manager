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
#   2. the plists carry the keys the deployment depends on — AbandonProcessGroup
#      above all, since launchd otherwise SIGTERMs every child of the job and
#      the dtach masters would die with the app,
#   3. the installer's platform branch (covered by the Linux CI suite, so it
#      is reported as a SKIP here rather than a PASS that cannot fail),
#   4. the installer refuses cleanly when launchctl is missing,
#   5. the installer refuses a ROLE SWITCH (one role per install root),
#   6. THE LOAD-BEARING ONE: a dtach master spawned by a launchd job
#      SURVIVES that job being stopped — which is what the plists'
#      AbandonProcessGroup key buys, and without which every app restart
#      would take every live session with it.
#
# What it CANNOT check here (needs a real install): the app booting under
# launchd, an agent self-registering, and the self-update round trip. Those
# are the installer's own verification steps in issue #1718.
#
# EVERYTHING this script runs the installer against is sandboxed: a temp HOME
# and a temp PATH (issue #1801). The earlier version of this script ran the
# installer with the REAL $HOME and a PATH that still contained the real
# /bin/launchctl — so its "the installer refuses without launchctl" check
# actually installed a launchd job on the developer's machine, and the
# refusal it asserted could never happen.

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
if ! command -v launchctl >/dev/null 2>&1; then
  echo "MISSING: launchctl is not available"
  exit 2
fi
if ! command -v plutil >/dev/null 2>&1; then
  echo "MISSING: plutil is not available"
  exit 2
fi
if ! command -v dtach >/dev/null 2>&1; then
  echo "MISSING: dtach is not installed (brew install dtach) — the survival check needs it"
  exit 2
fi
echo "launchctl: $(command -v launchctl)"
echo "plutil: $(command -v plutil)"
echo "dtach: $(command -v dtach)"

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
# The installer's platform branch is asserted by the Linux CI suite instead
# (test/scripts/install.test.ts drives it through a shimmed `uname`), so
# there is nothing to check here — say so rather than reporting a PASS that
# cannot fail.
skip "the installer's platform branch (covered by test/scripts/install.test.ts on Linux CI)"

# --- the sandbox the installer runs in ---------------------------------------
#
# A temp HOME (so the installer's writes — ~/Library/LaunchAgents,
# ~/.config/systemd/user — land in the temp dir and never on the developer's
# machine) and a temp PATH holding symlinks to the binaries the installer
# needs BEFORE its prerequisite check. launchctl is deliberately ABSENT from
# that PATH in the first sandbox: /bin is where macOS keeps launchctl, so a
# PATH that still contained it could never prove the refusal.
SBX="$TMPD/sandbox"
SBX_BIN="$SBX/bin"
SBX_HOME="$SBX/home"
mkdir -p "$SBX_BIN" "$SBX_HOME"

for cmd in node npm dtach curl tar shasum stat readlink mv find sort dirname basename \
  mkdir rm ln chmod grep cut sed awk mktemp tr cat wc env bash sh sleep date id; do
  resolved="$(command -v "$cmd" 2>/dev/null || true)"
  [ -n "$resolved" ] && ln -sf "$resolved" "$SBX_BIN/$cmd"
done

# The `uname` shim has to be a REAL FILE: written through a symlink it would
# try to overwrite /usr/bin/uname, which macOS refuses (SIP), and the shim
# would silently never exist (issue #1801).
rm -f "$SBX_BIN/uname"
cat >"$SBX_BIN/uname" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "-s" ]; then echo Darwin; else echo Linux; fi
EOF
chmod +x "$SBX_BIN/uname"

echo
echo "=== 4. the installer refuses cleanly when launchctl is missing ==="
if PATH="$SBX_BIN" command -v launchctl >/dev/null 2>&1; then
  fail "the sandbox PATH still resolves launchctl — the refusal it checks for cannot happen"
else
  if PATH="$SBX_BIN" HOME="$SBX_HOME" "$REPO_DIR/deploy/install.sh" --role primary \
    "$SBX_HOME/mullion" >"$TMPD/install-nolaunchctl.log" 2>&1; then
    fail "the installer SUCCEEDED without launchctl — it should have refused"
  else
    if grep -qi "launchctl" "$TMPD/install-nolaunchctl.log"; then
      pass "the installer refused and named launchctl"
    else
      fail "the installer refused, but without naming launchctl: $(tail -2 "$TMPD/install-nolaunchctl.log" | head -1)"
    fi
  fi
  # The refusal must not have left anything behind on the real machine.
  if [ -f "$HOME/Library/LaunchAgents/com.mullion.primary.plist" ] &&
    grep -q "$TMPD" "$HOME/Library/LaunchAgents/com.mullion.primary.plist" 2>/dev/null; then
    fail "the installer wrote a plist into the REAL ~/Library/LaunchAgents — the sandbox is not holding"
  else
    pass "the refusal left the real ~/Library/LaunchAgents untouched"
  fi
fi

echo
echo "=== 5. the installer refuses a role switch (one role per install root) ==="
# A launchctl stub, so the installer's prerequisite check passes and the run
# reaches the ROLE check (which happens before any download, and before the
# job is ever installed).
cat >"$SBX_BIN/launchctl" <<'EOF'
#!/usr/bin/env bash
# A stub: the role-switch refusal happens before launchctl is ever called.
exit 0
EOF
chmod +x "$SBX_BIN/launchctl"

ROLE_HOME="$SBX_HOME/role-home"
mkdir -p "$ROLE_HOME"
cat >"$ROLE_HOME/.env" <<'EOF'
MULLION_ROLE=primary
EOF
chmod 600 "$ROLE_HOME/.env"
if PATH="$SBX_BIN" HOME="$SBX_HOME" "$REPO_DIR/deploy/install.sh" --role agent \
  "$ROLE_HOME" >"$TMPD/install-roleswitch.log" 2>&1; then
  fail "the installer accepted a role switch over a primary .env — it should have refused"
else
  if grep -q "MULLION_ROLE" "$TMPD/install-roleswitch.log"; then
    pass "the installer refused the role switch and named the role"
  else
    fail "the installer refused, but without naming the role: $(tail -2 "$TMPD/install-roleswitch.log" | head -1)"
  fi
  if grep -q "MULLION_ROLE=primary" "$ROLE_HOME/.env"; then
    pass "the refused install left the existing .env untouched"
  else
    fail "the refused install modified the existing .env"
  fi
fi

echo
echo "=== 6. a dtach master SURVIVES its launchd job being stopped ==="
# The exact property the deployment relies on: the dtach master is a child of
# the app's launchd job, and without AbandonProcessGroup launchd would
# SIGTERM it along with the job — taking every live session with it.
#
# The probe's PATH has to resolve dtach: a launchd job's default PATH is
# only /usr/bin:/bin:/usr/sbin:/sbin, where a Homebrew dtach
# (/opt/homebrew/bin) is NOT — the very gap the deployment's own plists
# close by writing a resolved PATH into the job. A probe without it never
# starts a dtach at all (issue #1801).
DTACH_DIR="$(dirname "$(command -v dtach)")"
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
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$DTACH_DIR:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>AbandonProcessGroup</key>
  <true/>
</dict>
</plist>
EOF
launchctl bootstrap "$GUI" "$TMPD/job.plist" 2>/dev/null
sleep 3
# The master is the process whose command line IS "dtach -n <socket> …" —
# the `/bin/sh -c dtach -n …` wrapper that started it carries the same
# strings in its own command line and must NOT be mistaken for it. dtach
# forks and the parent exits, so the master is the HIGHEST such pid
# (scripts/macos-scope-check.sh established this on the same hardware).
MASTER_PID="$(ps -ax -o pid=,command= | awk -v sock="$SOCK" '
  $2 == "dtach" && $3 == "-n" && index($0, sock) { print $1 }
' | sort -n | tail -1)"
if [ -z "$MASTER_PID" ]; then
  fail "no dtach master appeared for $SOCK — the job did not run (is dtach on the job's PATH?)"
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
