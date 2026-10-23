#!/bin/sh
# The launchd launcher — the macOS analogue of the systemd unit's
# EnvironmentFile= + ExecStart= pair (issue #1718, roadmap 8.4).
#
# launchd has no EnvironmentFile, and the systemd unit's EnvironmentFile= is
# exactly what makes the install's .env visible at every start. Inlining the
# .env's values into the plist would freeze them at install time — an
# operator could no longer edit MULLION_ROLE, the auth vars or the frontend
# settings without re-installing. So the plist runs this script instead: it
# reads the .env and execs node, which is what systemd would have done.
#
# The .env is PARSED, not sourced. systemd's EnvironmentFile= parses
# KEY=VALUE literally; `set -a; . "$MULLION_HOME/.env"` would instead EXECUTE
# it — so `MULLION_AGENT_NAME=Studio Mac` would run `Mac` and leave the
# variable unset, and a hand-edited secret holding `$` or a backtick would be
# expanded or executed. Parsing keeps the two paths equivalent.
#
# The paths come from the plist's EnvironmentVariables (MULLION_HOME and
# MULLION_NODE_BIN, plus the PATH that makes `dtach` resolvable — a launchd
# job gets only /usr/bin:/bin:/usr/sbin:/sbin, and a Homebrew dtach lives in
# /opt/homebrew/bin), so nothing here depends on the ambient PATH.

# `export "$key=$value"` assigns the value literally: no word splitting, no
# globbing, no command substitution — the property EnvironmentFile= has.
read_env_file() {
  env_file="$1"
  [ -f "$env_file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "" | \#*) continue ;;
      *=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    # A key is a plain name; anything else is not an assignment.
    case "$key" in
      [A-Za-z_]* ) ;;
      *) continue ;;
    esac
    case "$key" in
      *[!A-Za-z0-9_]*) continue ;;
    esac
    # Strip one layer of matching surrounding quotes, the way a dotenv
    # parser does — and leave the contents of the value alone.
    case "$value" in
      \"*\")
        value="${value#\"}"
        value="${value%\"}"
        ;;
      \'*\')
        value="${value#\'}"
        value="${value%\'}"
        ;;
    esac
    export "$key=$value"
  done < "$env_file"
}

read_env_file "$MULLION_HOME/.env"

# `exec` replaces this shell with node, so launchd's job is node's process
# (and launchd tracks it as such). The relative `dist/server.js` resolves
# against the job's WorkingDirectory — the versioned-release layout's
# `current` symlink — exactly as the systemd unit's relative ExecStart
# resolves against its own WorkingDirectory.
exec "$MULLION_NODE_BIN" dist/server.js
