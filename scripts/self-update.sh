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

# Issue #1718 (roadmap 8.4) — this script runs on macOS too, where a stock
# Mac has neither GNU coreutils (sha256sum, timeout, stat -c, find -printf,
# sort -V, readlink -f) nor bash 4 (mapfile). The portable spellings live in
# scripts/portable.sh, which ships inside every release tarball alongside
# this script (see the build-tarball job in
# .github/workflows/release-please.yml), so it is always right here.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/portable.sh
. "$SCRIPT_DIR/portable.sh"

VERSION="${1:?version required}"
ASSET_URL="${2:?asset URL required}"
CHECKSUM_URL="${3:?checksum URL required}"
MULLION_HOME="${4:?MULLION_HOME required}"
NODE_EXEC_PATH="${5:?node exec path required}"

# Resolved by the caller (src/routes/updates.ts, via
# src/services/service-unit.ts) from this host's actual running unit, so a
# renamed unit still restarts correctly without editing this constant.
# Falls back to deploy/mullion.service's name for a manual invocation with
# no 6th arg.
#
# On macOS this is the LAUNCHD LABEL, not a systemd unit name (issue #1718):
# the same argument slot carries whichever the host's platform uses, and the
# restart step below branches on the platform.
UNIT_NAME="${6:-mullion.service}"

# A lock older than this is treated as abandoned rather than "an update is
# genuinely running" — see acquire_lock below. Generous relative to a real
# update's actual runtime (well under 10 minutes end to end), but bounded so
# a SIGKILL/OOM/host reboot mid-update doesn't permanently brick every future
# "Update now" (Hermes review, PR #54).
#
# INVARIANT: this must stay larger than every timeout that can keep a live
# updater running, or clearing a "stale" lock could race a genuinely-alive
# one. Current worst case (issue #647 correction — the enumeration below
# used to omit two of these and left only a ~900s margin): curl's
# --max-time 300 for the tarball download, plus --max-time 60 for the
# checksum download, plus NPM_CI_TIMEOUT_SECONDS for `npm ci`, plus
# NPM_CI_TIMEOUT_SECONDS again for the Playwright Chromium install below —
# 300 + 60 + 600 + 600 = 1560s — plus whatever untimed time `tar`,
# `sha256sum`, the two `node -e` smoke checks, `systemctl --user restart`,
# and the release prune actually take. If a future change raises
# NPM_CI_TIMEOUT_SECONDS (or adds a new slow step) without re-deriving this
# sum and raising STALE_LOCK_SECONDS to stay comfortably above it, this
# guarantee breaks and two updaters could run concurrently.
STALE_LOCK_SECONDS=2400
NPM_CI_TIMEOUT_SECONDS=600

# Declared and assigned separately (shellcheck SC2155) so a failure inside
# the command substitution can't be masked by `export`'s own exit status.
NODE_EXEC_DIR="$(dirname "$NODE_EXEC_PATH")"
export PATH="$NODE_EXEC_DIR:$PATH"

RELEASES_DIR="$MULLION_HOME/releases"
RELEASE_DIR="$RELEASES_DIR/$VERSION"
CURRENT_LINK="$MULLION_HOME/current"
STATUS_FILE="$MULLION_HOME/.update-status.json"
LOCK_DIR="$MULLION_HOME/.update.lock"
TMP_DIR="$(mktemp -d)"

cleanup() {
  # Both removals are best-effort: the temp dir may already be gone, and a
  # rm that refuses the path (a trash-style wrapper) must not turn a
  # successful update into a failed one.
  rm -rf "$TMP_DIR" 2>/dev/null || true
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
  lock_age=$(($(date +%s) - $(file_mtime "$LOCK_DIR")))
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
verify_sha256 "$TMP_DIR" "$TARBALL_NAME.sha256" ||
  fail "checksum verification failed for $TARBALL_NAME"

# --- installing ---
write_status "installing"
mkdir -p "$RELEASE_DIR" || fail "could not create $RELEASE_DIR"
tar -xzf "$TARBALL" -C "$RELEASE_DIR" || {
  rm -rf "$RELEASE_DIR"
  fail "could not extract release tarball"
}
(cd "$RELEASE_DIR" && run_with_timeout "$NPM_CI_TIMEOUT_SECONDS" npm ci --omit=dev) || {
  rm -rf "$RELEASE_DIR"
  fail "npm ci --omit=dev failed or timed out after ${NPM_CI_TIMEOUT_SECONDS}s in $RELEASE_DIR"
}

# Phase 3 (#179) — mirrors deploy/install.sh's own Chromium install step (see
# its comment for why this isn't a package.json postinstall hook instead).
# PLAYWRIGHT_BROWSERS_PATH must match install.sh's — both point outside any
# release dir so the browser survives this exact symlink flip below, and a
# host that already has it cached (unchanged version) makes this a fast
# no-op rather than a re-download.
(cd "$RELEASE_DIR" && PLAYWRIGHT_BROWSERS_PATH="$MULLION_HOME/browsers" \
  run_with_timeout "$NPM_CI_TIMEOUT_SECONDS" npx playwright install chromium) || {
  rm -rf "$RELEASE_DIR"
  fail "playwright install chromium failed or timed out after ${NPM_CI_TIMEOUT_SECONDS}s in $RELEASE_DIR"
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
# Loads the actual app module graph (buildApp's own import chain) under real
# Node ESM, not just the two native addons above — same rationale as that
# check: CI's build:smoke-test (package.json) already runs this against the
# build's own Node, but only this run, against $NODE_EXEC_PATH on the actual
# deploy target, guards a host running a different Node than CI (0.2.23's
# web-push regression — a bad named import from a CJS dependency — is the
# motivating case). dist/app.js is the buildApp factory module, not
# dist/server.js — it has no import-time side effects (no listen, no DB
# open) and resolves cleanly on a healthy release.
(cd "$RELEASE_DIR" && "$NODE_EXEC_PATH" --input-type=module -e "await import('./dist/app.js');") || {
  rm -rf "$RELEASE_DIR"
  fail "app module graph failed to load under Node ESM"
}

# --- restarting ---
write_status "restarting"
# Atomic symlink flip: build the new link next to the old one, then rename
# over it — readers (including a systemd unit mid-restart) never observe a
# missing/half-written `current`.
rm -f "$MULLION_HOME/current.tmp"
ln -s "$RELEASE_DIR" "$MULLION_HOME/current.tmp"
replace_symlink "$MULLION_HOME/current.tmp" "$CURRENT_LINK"
# Phase 4 (#134, PR7) — (re)links ~/.local/bin/mullion here too, not just in
# install.sh: every host already provisioned before this CLI existed ran
# install.sh long before this step existed and only ever updates via THIS
# script (deploy/README.md — routine updates never re-run install.sh), so
# install.sh's own one-time link would otherwise never reach them. Guarded
# on the target actually existing, same reasoning as install.sh's identical
# check: a release built before `make build` started copying src/cli into
# dist/cli would otherwise get a dangling symlink here (code review, PR
# #403). Points at $CURRENT_LINK, not $RELEASE_DIR, so this same check
# never needs to run again on a future update once the target exists.
if [ -f "$CURRENT_LINK/dist/cli/mullion.mjs" ]; then
  mkdir -p ~/.local/bin
  rm -f ~/.local/bin/mullion
  ln -s "$CURRENT_LINK/dist/cli/mullion.mjs" ~/.local/bin/mullion
fi
# Sessions survive: dtach masters run in their own transient systemd --user
# scopes (pty-manager.ts's bootstrapMaster), outside this unit's cgroup, so
# KillMode=control-group only stops the app process itself. The DB migrates
# forward automatically on the new process's startup (ensureDb()).
#
# On macOS the same property comes from the launchd job's AbandonProcessGroup
# key (see deploy/launchd/*.plist): launchd otherwise SIGTERMs every child of
# the job, which would take the dtach masters — and every live session —
# down with it.
if is_darwin; then
  # The launchd plist is NOT rewritten by an update (the `current` symlink is
  # what moves), so there is nothing to reload — kickstart is enough.
  launchctl kickstart -k "$(launchd_gui_domain)/$UNIT_NAME" ||
    fail "launchctl kickstart -k $(launchd_gui_domain)/$UNIT_NAME failed"
  # This job (the one-shot update job src/routes/updates.ts bootstrapped) has
  # done its work: drop its plist and boot itself out so it does not linger
  # loaded. The plist goes first — the bootout kills this very process.
  # `|| true`: the plist may not exist (a manual invocation, or an rm that
  # refuses the path), and neither is a reason to fail an update that has
  # already succeeded.
  rm -f "$MULLION_HOME/logs/com.mullion.update-$VERSION.plist" 2>/dev/null || true
  launchctl bootout "$(launchd_gui_domain)/com.mullion.update-$VERSION" 2>/dev/null || true
else
  # Reload the systemd user manager in case the unit on disk was updated or marked dirty.
  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user restart "$UNIT_NAME" || fail "systemctl --user restart $UNIT_NAME failed"
fi

# --- prune old releases, keep the 3 most recent (by version) ---
# Protect whatever `current` resolves to regardless of sort position, on
# top of the newest-3 rule, so an out-of-order manual rollback never gets
# pruned out from under itself.
KEEP_DIR="$(readlink_target "$CURRENT_LINK" || echo "$CURRENT_LINK")"
# Oldest first (the order the prune below expects). `find -printf` and
# `sort -V` are GNU-only, and `mapfile` is bash 4 — the portable spellings
# are dir_names/sort_versions (GNU-free) and a plain read loop (bash 3.2-safe).
ALL_RELEASES="$(dir_names "$RELEASES_DIR" | sort_versions)"
KEEP_COUNT=3
TOTAL="$(printf '%s\n' "$ALL_RELEASES" | grep -c . || true)"
if [ "$TOTAL" -gt "$KEEP_COUNT" ]; then
  PRUNE_UPTO=$((TOTAL - KEEP_COUNT))
  INDEX=0
  while IFS= read -r release_name; do
    [ -n "$release_name" ] || continue
    if [ "$INDEX" -ge "$PRUNE_UPTO" ]; then
      break
    fi
    candidate="$RELEASES_DIR/$release_name"
    if [ "$candidate" != "$KEEP_DIR" ]; then
      rm -rf "$candidate"
    fi
    INDEX=$((INDEX + 1))
  done <<EOF
$ALL_RELEASES
EOF
fi

write_status "done"
