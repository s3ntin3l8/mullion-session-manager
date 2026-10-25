#!/usr/bin/env bash
# Portable helpers shared by deploy/install.sh and scripts/self-update.sh.
#
# Issue #1718 (roadmap 8.4) — the installer and the detached updater run on
# macOS as well as Linux, and a stock Mac ships neither GNU coreutils nor
# bash 4. Everything here is the portable spelling of something that used to
# be a GNU binary or a bash-4 builtin, so both scripts work on a Mac without
# asking the operator to install coreutils.
#
# Sourced, never executed: `set -euo pipefail` and the callers' own settings
# stay in force.

# --- platform ---------------------------------------------------------------

# True on macOS. `uname -s` is the portable spelling; the installer's tests
# shim `uname` to exercise the darwin branch on Linux.
is_darwin() {
  [ "$(uname -s)" = "Darwin" ]
}

# The launchd domain a per-user agent lives in (`gui/$UID`). launchd's own
# tooling wants the numeric uid, not the user name.
launchd_gui_domain() {
  echo "gui/$(id -u)"
}

# --- launchd label unloading --------------------------------------------------

# launchd_wait_label_gone DOMAIN/LABEL [TIMEOUT_TENTHS]
#
# `launchctl bootout` returns BEFORE launchd has finished unloading the label,
# and `launchctl bootstrap` refuses a label that is still registered ("Bootstrap
# failed: 5: Input/output error"). So a caller that boots a label out and
# immediately bootstraps it back is racing launchd's own teardown: sometimes
# the bootstrap is refused, and the host is left with the job NOT loaded at all
# (issue #1924).
#
# Poll until the label is really gone. The probe is `launchctl print
# DOMAIN/LABEL`, whose exit status is the answer: 0 while the label is
# registered, non-zero once it is not ("Could not find service"). Only the exit
# STATUS is used, never the output — launchd's own documentation says `print`'s
# output "is NOT API in any sense at all" and may change between releases.
#
# A probe that FAILS counts as "gone", not "still loaded": on a host without
# launchctl the probe can never succeed, and treating that as "still loaded"
# would burn the whole budget on every run. It does not need to tell the two
# apart — both mean "not loaded" — and the bootstrap that follows surfaces any
# real problem.
#
# TIMEOUT_TENTHS bounds the wait in tenths of a second (the default, 50, is
# five seconds — far above the sub-second unload this was measured against,
# and far below anything an operator would notice). The budget is the CALLER's
# to pass, so a caller that shares a deadline with a following command can
# pass a smaller one.
#
# Returns 0 once the label is gone, non-zero if it is still registered when
# the budget runs out: the caller must NOT bootstrap in that case, because the
# bootstrap would fail with exactly the error this wait exists to prevent.
launchd_wait_label_gone() {
  local target="$1"
  local tenths="${2:-50}"
  local waited=0
  while [ "$waited" -lt "$tenths" ]; do
    if ! launchctl print "$target" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  return 1
}

# --- timeout ----------------------------------------------------------------

# run_with_timeout SECONDS COMMAND...
#
# The portable `timeout`: GNU coreutils' is not on macOS. The command runs in
# the background and is SIGTERMed once the budget is up; its own exit status
# is what this returns (a command that outlives the budget is killed, so its
# status is the signal's, not the command's — exactly like `timeout`).
#
# The watchdog is a background subshell, so it must NOT be waited on: a
# subshell blocked in `sleep` does not act on a SIGTERM until that sleep
# ends, so waiting for it would block for the whole budget. It is killed
# instead, and the marker file keeps a late watchdog from signalling a pid
# that has since been recycled by an unrelated process.
#
# Its output goes to /dev/null: the watchdog outlives the command, and a
# lingering `sleep` holding the caller's stdout pipe would keep that pipe
# open long after the command finished — which reads as a hung process to
# whoever spawned this.
run_with_timeout() {
  local seconds="$1"
  shift
  local marker
  marker="$(mktemp "${TMPDIR:-/tmp}/mullion-timeout.XXXXXX")" || return 1
  "$@" &
  local pid=$!
  (
    sleep "$seconds"
    if [ -e "$marker" ] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  ) >/dev/null 2>&1 &
  local watchdog=$!
  local status=0
  wait "$pid" || status=$?
  # The marker's removal must not be able to fail the caller's command: it
  # runs under `set -e` in both callers, and a failure here (a read-only
  # TMPDIR, a trash-style rm that refuses the path) would abort the whole
  # update for no good reason. A leftover marker only means the watchdog's
  # kill check stays armed — it also checks that the pid is still alive.
  rm -f "$marker" 2>/dev/null || true
  kill "$watchdog" 2>/dev/null || true
  return "$status"
}

# --- checksums --------------------------------------------------------------

# verify_sha256 DIR CHECKSUM_FILE
#
# GNU's `sha256sum -c` is not on macOS; the BSD `shasum -a 256 -c` reads the
# same file format (the release's checksum asset is written in that format —
# see the build-tarball job in .github/workflows/release-please.yml).
verify_sha256() {
  local dir="$1" checksum_file="$2"
  if command -v sha256sum >/dev/null 2>&1; then
    ( cd "$dir" && sha256sum -c "$checksum_file" )
  elif command -v shasum >/dev/null 2>&1; then
    ( cd "$dir" && shasum -a 256 -c "$checksum_file" )
  else
    echo "neither sha256sum nor shasum found — cannot verify the download" >&2
    return 1
  fi
}

# --- file metadata ----------------------------------------------------------

# The modification time of a path, in epoch seconds. GNU stat spells it
# `-c %Y`, BSD stat `-f %m` — and BSD stat errors out on the GNU form, so
# the fallback is what actually runs on a Mac.
file_mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0
}

# --- symlinks ---------------------------------------------------------------

# The target of a symlink (not resolved any further). Plain `readlink` is
# portable; `readlink -f` is not on macOS before 12 and BSD readlink has no
# -f at all. An absolute target is returned as-is; a relative one is
# resolved against the link's own directory.
readlink_target() {
  local link="$1" target
  target="$(readlink "$link" 2>/dev/null || true)"
  [ -n "$target" ] || return 1
  case "$target" in
    /*) printf '%s\n' "$target" ;;
    *) printf '%s/%s\n' "$(cd "$(dirname "$link")" && pwd -P)" "$target" ;;
  esac
}

# Replace a symlink with a new one, atomically enough for an installer:
# GNU's `mv -T` and BSD's `mv -h` both mean "replace the destination ITSELF,
# never the directory it points at" — plain `mv` would move the source INTO
# the destination directory.
#
# The two spellings are mutually exclusive (GNU mv has no -h before coreutils
# 9.4, BSD mv has no -T at all), so the GNU one is tried first and the BSD
# one second. Both fail loudly if neither is understood, rather than
# silently moving the link somewhere else.
replace_symlink() {
  local source="$1" destination="$2"
  if mv -T "$source" "$destination" 2>/dev/null; then
    return 0
  fi
  mv -hf "$source" "$destination"
}

# --- directory listing ------------------------------------------------------

# The names of the subdirectories of DIR, one per line. GNU's
# `find -printf '%f\n'` is not on macOS.
dir_names() {
  local dir="$1" entry name
  [ -d "$dir" ] || return 0
  for entry in "$dir"/*/; do
    [ -d "$entry" ] || continue
    name="$(basename "$entry")"
    printf '%s\n' "$name"
  done
}

# The same names, OLDEST version first — the order GNU's `sort -V` produces
# (which is what the prune step relies on: it prunes the OLDEST ones, and
# protects whatever `current` points at). GNU's `sort -V` is not on macOS, so
# this sorts the dotted numeric fields one by one — the versions here are
# plain MAJOR.MINOR.PATCH, which that spells exactly.
sort_versions() {
  sed 's/^v//' | sort -t. -k1,1n -k2,2n -k3,3n
}
