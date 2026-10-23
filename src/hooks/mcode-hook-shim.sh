#!/bin/sh
# mcode hook shim — resolves Mullion's hook socket + token for an mcode
# Plugin hook, then execs the shared forwarder.
#
# WHY THIS EXISTS (mcode-specific, unlike forwarder-shim.sh):
# mcode runs a Plugin hook as a CHILD PROCESS whose environment is a strict
# WHITELIST — PATH, HOME, LANG, TERM, SHELL, USER, TMPDIR, TEMP, TMP,
# PATHEXT, SystemRoot, ComSpec, USERPROFILE, HOMEDRIVE, HOMEPATH, APPDATA,
# LOCALAPPDATA, plus MINIMAX_/CLAUDE_/CODEX_PLUGIN_ROOT and *_PROJECT_DIR.
# MULLION_HOOK_SOCKET, MULLION_HOOK_TOKEN and MULLION_FORWARDER_PATH are all
# DROPPED, so the forwarder cannot find Mullion's hook socket the way it does
# for Claude Code / Codex / agy.
#
# The contract this shim implements:
#   argv:  <shim> <mcode> <event>
#          e.g. /path/to/mcode-hook-shim.sh mcode PostToolUse
#   stdin: the hook payload JSON on stdin, passed through untouched.
#   env:   TMPDIR — the session's effective temp dir, where the per-session
#          handoff JSON file (socket path, handshake token, forwarder path)
#          is written. TMPDIR is the ONLY one of these vars mcode's hook
#          child env preserves — see the note below.
#   stdout: whatever the forwarder prints (a hook decision JSON).
#
# FAIL-OPEN BY CONTRACT: if the handoff file is missing/unreadable, or the
# forwarder is missing, this script prints an empty JSON object and exits 0.
# A missing hook must NEVER block a tool call and must never fail the agent.
#
# Host-stable path: this file is installed at a FIXED location (~/.mullion/…)
# so a `git worktree remove` can never dangle it — the same discipline
# forwarder-shim.ts documents for its own script.

set -u

# The handoff file: Mullion's mcode adapter writes it per session, at
# exactly the path this session's TMPDIR points at.
#
# TMPDIR is the ONLY channel available: mcode runs a plugin hook as a child
# process whose environment is a strict whitelist (PATH, HOME, LANG, TERM,
# SHELL, USER, TMPDIR, TEMP, TMP, ...) — every MULLION_* var, including
# MULLION_HOOK_SOCKET/MULLION_HOOK_TOKEN/MULLION_FORWARDER_PATH, is DROPPED.
# TMPDIR survives it, so the handoff file travels under $TMPDIR and the
# socket+token never reach the plugin or any host-global file.
if [ -z "${TMPDIR:-}" ]; then
  # No TMPDIR at all — nothing can point us at the handoff file. Fail open.
  printf '{}'
  exit 0
fi

HANDOFF_FILE="${TMPDIR}/mullion-hook.json"

if [ ! -r "$HANDOFF_FILE" ]; then
  # No handoff for this session (e.g. the hook fired outside a Mullion
  # session, or the session's data was cleaned up). Fail open.
  printf '{}'
  exit 0
fi

# Minimal JSON field extraction — no jq dependency (mcode's hook child has a
# minimal PATH). The handoff file is written by Mullion itself with a fixed
# shape, one field per line, so a line-oriented read is sufficient and safe.
read_field() {
  # $1 = json key
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "$HANDOFF_FILE" | head -n 1
}

SOCKET_PATH="$(read_field socket)"
TOKEN="$(read_field token)"
FORWARDER_PATH="$(read_field forwarderPath)"

if [ -z "$SOCKET_PATH" ] || [ -z "$TOKEN" ] || [ -z "$FORWARDER_PATH" ]; then
  printf '{}'
  exit 0
fi

if [ ! -r "$FORWARDER_PATH" ]; then
  # The forwarder is gone (e.g. an in-progress deploy swapped the checkout).
  # Fail open rather than wedging the agent.
  printf '{}'
  exit 0
fi

# Resolve node: prefer the recorded node path from the handoff, else whatever
# is on PATH. The handoff's nodePath is preferred because a Mullion-managed
# session may run a node that is not the one first on the hook child's PATH.
NODE_PATH="$(read_field nodePath)"
if [ -z "$NODE_PATH" ] || [ ! -x "$NODE_PATH" ]; then
  NODE_PATH="$(command -v node 2>/dev/null || true)"
fi

if [ -z "$NODE_PATH" ]; then
  printf '{}'
  exit 0
fi

# Re-export the socket/token/forwarder the way the forwarder expects them, so
# the forwarder itself needs no mcode-specific branch for the CONNECTION. Only
# the EVENT MAPPING differs, and that lives in forwarder-core.mjs.
MULLION_HOOK_SOCKET="$SOCKET_PATH" \
MULLION_HOOK_TOKEN="$TOKEN" \
MULLION_FORWARDER_PATH="$FORWARDER_PATH" \
exec "$NODE_PATH" "$FORWARDER_PATH" "$@"
