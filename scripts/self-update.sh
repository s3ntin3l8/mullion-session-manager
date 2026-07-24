#!/usr/bin/env bash
# Detached updater for the versioned-release prod layout (see deploy/README.md
# and .claude/plans/i-want-to-work-giggly-quail.md). Ships INSIDE every
# release tarball — src/routes/updates.ts always invokes the copy in its own
# release dir ($MULLION_HOME/current/scripts/self-update.sh), so update logic
# is versioned right along with the app it updates.
#
# Launched detached, the same way pty-manager.ts bootstraps a dtach master:
#   systemd-run --user --scope --collect -- scripts/self-update.sh ...
# This has to outlive the process that launches it (npm ci alone can take
# minutes, and the last step restarts that launching process's own systemd
# unit) — a plain child would die the moment its parent's request handler
# returns or the unit restarts.
#
# Usage: self-update.sh <version> <asset-url> <checksum-url> <mullion-home> <node-exec-path> [service-unit]
#   version         e.g. "0.1.5" (no leading "v")
#   asset-url       browser_download_url of the release's .tgz asset
#   checksum-url    browser_download_url of the release's sha256sum-format
#                   checksum file (see release-please.yml's build-tarball
#                   job) — verified against the downloaded tarball below
#                   before it's ever extracted (Hermes review, PR #54).
#   mullion-home    absolute path to the install root (parent of releases/,
#                   current, data/) — see deploy/install.sh
#   node-exec-path  absolute path to the node binary running the caller
#                   (process.execPath) — systemd --user units run with a
#                   minimal PATH (see deploy/mullion.service's ExecStart
#                   comment on nvm), so `npm`/`node` are not reliably on PATH
#                   here; we derive PATH from this instead of assuming
#                   either is found.
#   service-unit    optional: the systemd --user unit to restart in the last
#                   step. src/routes/updates.ts resolves this from its own
#                   /proc/self/cgroup (or MULLION_SERVICE_UNIT) before
#                   spawning this script — see src/services/systemd-unit.ts.
#                   Defaults below if omitted (e.g. a manual invocation), but
#                   the caller passing it is what lets this survive a host
#                   renaming its unit without editing this script.

set -euo pipefail

VERSION="${1:?version required}"
ASSET_URL="${2:?asset URL required}"
CHECKSUM_URL="${3:?checksum URL required}"
MULLION_HOME="${4:?MULLION_HOME required}"
NODE_EXEC_PATH="${5:?node exec path required}"

# Resolved by the caller (src/routes/updates.ts, via
# src/services/systemd-unit.ts) from this host's actual running unit, so a
# renamed unit still restarts correctly without editing this constant.
# Falls back to deploy/mullion.service's name for a manual invocation with
# no 6th arg.
UNIT_NAME="${6:-mullion.service}"

# A lock older than this is treated as abandoned rather than "an update is
# genuinely running" — see acquire_lock below. Generous relative to a real
# update's actual runtime (download + npm ci + restart is normally well
# under 5 minutes), but bounded so a SIGKILL/OOM/host reboot mid-update
# doesn't permanently brick every future "Update now" (Hermes review, PR #54).
#
# INVARIANT: this must stay larger than every timeout that can keep a live
# updater running (currently: curl's --max-time 300 for the download below,
# plus NPM_CI_TIMEOUT_SECONDS for npm ci) — that ordering is *why* clearing
# a stale lock can't race a genuinely-alive updater: anything still holding
# the lock past STALE_LOCK_SECONDS must already have been SIGKILLed by one
# of those timeouts. If a future change raises NPM_CI_TIMEOUT_SECONDS (or
# adds a new slow step) without raising this too, that guarantee breaks and
# two updaters could run concurrently.
STALE_LOCK_SECONDS=1800
NPM_CI_TIMEOUT_SECONDS=600

export PATH="$(dirname "$NODE_EXEC_PATH"):$PATH"

RELEASES_DIR="$MULLION_HOME/releases"
RELEASE_DIR="$RELEASES_DIR/$VERSION"
CURRENT_LINK="$MULLION_HOME/current"
STATUS_FILE="$MULLION_HOME/.update-status.json"
LOCK_DIR="$MULLION_HOME/.update.lock"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# Atomic, portable cross-process lock — `mkdir` either succeeds once or
# fails, no flock/lockfile dependency needed. src/routes/updates.ts also
# checks the status file's phase/age before ever launching this script, but
# that check-then-spawn isn't atomic across two concurrent POST
# /api/updates/apply requests; this is the real guard against two updates
# racing each other. A lock that fails to acquire because it's simply stale
# (left behind by a process that never reached cleanup's rmdir) is cleared
# and retried once, rather than treated the same as a live, in-progress
# update.
acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    return 0
  fi
  local lock_age
  lock_age=$(($(date +%s) - $(stat -c %Y "$LOCK_DIR" 2>/dev/null || echo 0)))
  if [ "$lock_age" -gt "$STALE_LOCK_SECONDS" ]; then
    echo "clearing stale update lock (${lock_age}s old, threshold ${STALE_LOCK_SECONDS}s)" >&2
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR" 2>/dev/null && return 0
  fi
  return 1
}

if ! acquire_lock; then
  echo "update already in progress ($LOCK_DIR exists)" >&2
  exit 1
fi

write_status() {
  local phase="$1"
  local error_msg="${2:-}"
  # Minimal hand-built JSON (no jq dependency) — fields are either
  # controlled inputs (version is a validated semver-ish string from
  # GitHub's tag) or need only basic escaping (error messages). Newlines/
  # tabs are collapsed to spaces *before* backslash/quote escaping — every
  # fail() call site today passes a single-line literal, but a future one
  # that interpolates multi-line command output would otherwise emit
  # invalid JSON (Hermes review, PR #54).
  local escaped_error
  escaped_error=$(printf '%s' "$error_msg" | tr '\n\r\t' '   ' | sed 's/\\/\\\\/g; s/"/\\"/g')
  cat > "$STATUS_FILE" <<EOF
{
  "phase": "$phase",
  "version": "$VERSION",
  "updatedAt": $(date +%s),
  "error": "$escaped_error"
}
EOF
}

fail() {
  local msg="$1"
  echo "self-update failed: $msg" >&2
  write_status "failed" "$msg"
  # Leave any partial release dir behind for `installing`/`verifying`
  # failures removed explicitly below — current is never touched on any
  # failure path, so the running app keeps serving regardless.
  exit 1
}

# --- downloading ---
write_status "downloading"
TARBALL_NAME="mullion-$VERSION.tgz"
TARBALL="$TMP_DIR/$TARBALL_NAME"
CHECKSUM_FILE="$TMP_DIR/$TARBALL_NAME.sha256"
curl -fsSL --max-time 300 -o "$TARBALL" "$ASSET_URL" || fail "download failed from $ASSET_URL"
curl -fsSL --max-time 60 -o "$CHECKSUM_FILE" "$CHECKSUM_URL" ||
  fail "checksum download failed from $CHECKSUM_URL"
# sha256sum -c matches by the filename recorded *inside* the checksum file
# (written by release-please.yml's build-tarball job as
# "<hex>  mullion-<version>.tgz"), so both files must sit in the same
# directory under that exact name — hence cd into $TMP_DIR rather than
# passing absolute paths. A mismatch here means either a corrupted
# download or a tampered/substituted asset; either way, don't extract it.
(cd "$TMP_DIR" && sha256sum -c "$TARBALL_NAME.sha256") ||
  fail "checksum verification failed for $TARBALL_NAME"

# --- installing ---
write_status "installing"
mkdir -p "$RELEASE_DIR" || fail "could not create $RELEASE_DIR"
tar -xzf "$TARBALL" -C "$RELEASE_DIR" || {
  rm -rf "$RELEASE_DIR"
  fail "could not extract release tarball"
}
(cd "$RELEASE_DIR" && timeout "$NPM_CI_TIMEOUT_SECONDS" npm ci --omit=dev) || {
  rm -rf "$RELEASE_DIR"
  fail "npm ci --omit=dev failed or timed out after ${NPM_CI_TIMEOUT_SECONDS}s in $RELEASE_DIR"
}

# --- verifying ---
write_status "verifying"
if [ ! -f "$RELEASE_DIR/dist/server.js" ]; then
  rm -rf "$RELEASE_DIR"
  fail "dist/server.js missing from installed release"
fi
# Native modules (better-sqlite3, node-pty) are compiled by npm ci above
# against *this host's* Node ABI — confirm they actually load before this
# release is ever pointed at by `current`. Run with cwd=$RELEASE_DIR so
# require() resolves this release's own node_modules, not $MULLION_HOME's.
(cd "$RELEASE_DIR" && "$NODE_EXEC_PATH" -e "require('better-sqlite3'); require('node-pty');") || {
  rm -rf "$RELEASE_DIR"
  fail "native module smoke check failed (better-sqlite3/node-pty didn't load)"
}

# --- restarting ---
write_status "restarting"
# Atomic symlink flip: build the new link next to the old one, then rename
# over it — readers (including a systemd unit mid-restart) never observe a
# missing/half-written `current`.
ln -sfn "$RELEASE_DIR" "$MULLION_HOME/current.tmp"
mv -T "$MULLION_HOME/current.tmp" "$CURRENT_LINK"
# Sessions survive: dtach masters run in their own transient systemd --user
# scopes (pty-manager.ts's bootstrapMaster), outside this unit's cgroup, so
# KillMode=control-group only stops the app process itself. The DB migrates
# forward automatically on the new process's startup (ensureDb()).
systemctl --user restart "$UNIT_NAME" || fail "systemctl --user restart $UNIT_NAME failed"

# --- prune old releases, keep the 3 most recent (by version) ---
# Protect whatever `current` resolves to regardless of sort position, on
# top of the newest-3 rule, so an out-of-order manual rollback never gets
# pruned out from under itself.
KEEP_DIR="$(readlink -f "$CURRENT_LINK")"
mapfile -t ALL_RELEASES < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -V)
KEEP_COUNT=3
TOTAL=${#ALL_RELEASES[@]}
if [ "$TOTAL" -gt "$KEEP_COUNT" ]; then
  PRUNE_UPTO=$((TOTAL - KEEP_COUNT))
  for ((i = 0; i < PRUNE_UPTO; i++)); do
    candidate="$RELEASES_DIR/${ALL_RELEASES[$i]}"
    if [ "$candidate" != "$KEEP_DIR" ]; then
      rm -rf "$candidate"
    fi
  done
fi

write_status "done"
