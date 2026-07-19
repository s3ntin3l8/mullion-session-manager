#!/usr/bin/env bash
# Detached updater for the versioned-release prod layout (see deploy/README.md
# and .claude/plans/i-want-to-work-giggly-quail.md). Ships INSIDE every
# release tarball — src/routes/updates.ts always invokes the copy in its own
# release dir ($TESSERA_HOME/current/scripts/self-update.sh), so update logic
# is versioned right along with the app it updates.
#
# Launched detached, the same way pty-manager.ts bootstraps a dtach master:
#   systemd-run --user --scope --collect -- scripts/self-update.sh ...
# This has to outlive the process that launches it (npm ci alone can take
# minutes, and the last step restarts that launching process's own systemd
# unit) — a plain child would die the moment its parent's request handler
# returns or the unit restarts.
#
# Usage: self-update.sh <version> <asset-url> <tessera-home> <node-exec-path>
#   version         e.g. "0.1.5" (no leading "v")
#   asset-url       browser_download_url of the release's .tgz asset
#   tessera-home    absolute path to the install root (parent of releases/,
#                   current, data/) — see deploy/install.sh
#   node-exec-path  absolute path to the node binary running the caller
#                   (process.execPath) — systemd --user units run with a
#                   minimal PATH (see deploy/claude-remote-session.service's
#                   ExecStart comment on nvm), so `npm`/`node` are not
#                   reliably on PATH here; we derive PATH from this instead
#                   of assuming either is found.

set -euo pipefail

VERSION="${1:?version required}"
ASSET_URL="${2:?asset URL required}"
TESSERA_HOME="${3:?TESSERA_HOME required}"
NODE_EXEC_PATH="${4:?node exec path required}"

# Must match the [Unit] name in deploy/claude-remote-session.service.
UNIT_NAME="claude-remote-session.service"

export PATH="$(dirname "$NODE_EXEC_PATH"):$PATH"

RELEASES_DIR="$TESSERA_HOME/releases"
RELEASE_DIR="$RELEASES_DIR/$VERSION"
CURRENT_LINK="$TESSERA_HOME/current"
STATUS_FILE="$TESSERA_HOME/.update-status.json"
LOCK_DIR="$TESSERA_HOME/.update.lock"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# Atomic, portable cross-process lock — `mkdir` either succeeds once or
# fails, no flock/lockfile dependency needed. src/routes/updates.ts also
# checks the status file's phase before ever launching this script, but that
# check-then-spawn isn't atomic across two concurrent POST /api/updates/apply
# requests; this is the real guard against two updates racing each other.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "update already in progress ($LOCK_DIR exists)" >&2
  exit 1
fi

write_status() {
  local phase="$1"
  local error_msg="${2:-}"
  # Minimal hand-built JSON (no jq dependency) — fields are either
  # controlled inputs (version is a validated semver-ish string from
  # GitHub's tag) or need only basic escaping (error messages: backslash and
  # double-quote).
  local escaped_error
  escaped_error=$(printf '%s' "$error_msg" | sed 's/\\/\\\\/g; s/"/\\"/g')
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
TARBALL="$TMP_DIR/tessera-$VERSION.tgz"
curl -fsSL --max-time 300 -o "$TARBALL" "$ASSET_URL" || fail "download failed from $ASSET_URL"

# --- installing ---
write_status "installing"
mkdir -p "$RELEASE_DIR" || fail "could not create $RELEASE_DIR"
tar -xzf "$TARBALL" -C "$RELEASE_DIR" || {
  rm -rf "$RELEASE_DIR"
  fail "could not extract release tarball"
}
(cd "$RELEASE_DIR" && npm ci --omit=dev) || {
  rm -rf "$RELEASE_DIR"
  fail "npm ci --omit=dev failed in $RELEASE_DIR"
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
# require() resolves this release's own node_modules, not $TESSERA_HOME's.
(cd "$RELEASE_DIR" && "$NODE_EXEC_PATH" -e "require('better-sqlite3'); require('node-pty');") || {
  rm -rf "$RELEASE_DIR"
  fail "native module smoke check failed (better-sqlite3/node-pty didn't load)"
}

# --- restarting ---
write_status "restarting"
# Atomic symlink flip: build the new link next to the old one, then rename
# over it — readers (including a systemd unit mid-restart) never observe a
# missing/half-written `current`.
ln -sfn "$RELEASE_DIR" "$TESSERA_HOME/current.tmp"
mv -T "$TESSERA_HOME/current.tmp" "$CURRENT_LINK"
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
