#!/bin/sh
# mullion-forwarder-shim v1
#
# Installed and owned by Mullion (src/services/hook-adapters/forwarder-shim.ts's
# ensureForwarderShim()) at a fixed, host-stable, per-user location outside
# every checkout and every versioned release directory. Referenced BY VALUE
# from agy's and Codex's own host-global hook config files
# (~/.gemini/config/hooks.json, ~/.codex/hooks.json — see agy.ts/codex.ts),
# so its path must never change and its contract must never grow: those
# config files are shared by every Mullion instance on the host (a
# production install AND any number of `.wt/<slug>` dev worktrees running
# `make dev`), and each one may be running a different Mullion version.
#
# Deliberately POSIX `sh`, not `.mjs`: this must be able to fail open even
# when node itself is missing or broken (an nvm version bump, a removed
# `~/.nvm/versions/node/vX`) — a JS shim can't do that, since it needs a
# working node just to run at all. Deliberately contains NO absolute paths,
# no forwarder path, no node path, no Mullion version: every writer (any
# release, any dev worktree) produces byte-identical content, so a
# concurrent write from a second Mullion instance is a safe no-op, not a
# collision.
#
# Safe to delete: every hook command that invokes this file carries its own
# `|| printf '<fallback-json>'` guard (see
# forwarder-shim.ts's forwarderHookCommand()), so removing this file
# degrades Mullion's hooks to a silent no-op, never to a failed tool call.
# See docs/agent-hooks.md.
#
# Contract (v1, deliberately minimal and frozen so it never needs to
# change — see the version-guard comment in forwarder-shim.ts):
#   argv   <agent> <kind>          forwarded verbatim to the real forwarder
#   env    MULLION_FORWARDER_PATH  absolute path to THIS session's
#                                  forwarder.mjs (injected per-session by
#                                  launch-plan.ts, alongside
#                                  MULLION_HOOK_SOCKET/_TOKEN)
#          MULLION_FORWARDER_NODE  absolute path to the node binary to run
#                                  it with (falls back to `node` on PATH)
#   stdin  passed straight through
#   stdout the real forwarder's own JSON decision on the happy path, or the
#          fallback JSON below on any failure (missing path, missing node,
#          OR the real forwarder producing no output)
#   exit   ALWAYS 0, unconditionally

_mullion_fallback() {
  # Must match forwarder.mjs's own main() fallback exactly (forwarder.mjs:
  # 107-123): agy's PreToolUse hook treats an absent/ambiguous decision as a
  # possible DENIAL (commit 8619182), so it alone gets an explicit allow;
  # every other agent+kind gets a bare {}, which every agent's hook runner
  # treats as "no opinion, never blocks/continues anything".
  if [ "$1" = "agy" ] && [ "$2" = "PreToolUse" ]; then
    printf '%s\n' '{"decision":"allow"}'
  else
    printf '%s\n' '{}'
  fi
  exit 0
}

[ -n "$MULLION_FORWARDER_PATH" ] || _mullion_fallback "$@"
[ -f "$MULLION_FORWARDER_PATH" ] || _mullion_fallback "$@"

_mullion_node="${MULLION_FORWARDER_NODE:-node}"
command -v "$_mullion_node" >/dev/null 2>&1 || _mullion_fallback "$@"

# Deliberately NOT `exec`: the real forwarder's exit status must never
# reach our own. forwarder.mjs's main() is `try { await forward() } finally
# { print }` — a rejection still prints valid JSON in the `finally` and
# THEN exits 1. Propagating that status would make agy hard-block the tool
# call again — the same outage this shim exists to prevent, just triggered
# by a crash instead of a missing file. The decision channel for agy
# PreToolUse and Codex PermissionRequest is stdout, never the exit code, so
# discarding the real forwarder's status costs nothing.
#
# Captured (not streamed) so a forwarder killed before its `finally` runs
# (timeout, SIGKILL) — which yields empty stdout — is distinguishable from
# a real decision and gets the same explicit fallback as a missing
# path/node, rather than an ambiguous empty line reaching agy's PreToolUse
# handler (exactly the ambiguity commit 8619182 exists to prevent).
#
# Accepted tradeoff of not `exec`ing: on a hook timeout, whether the real
# forwarder's own node process gets killed alongside this shell (vs.
# orphaned as a lingering child) depends on whether the caller's timeout
# kills a process GROUP or only the direct child pid — not verified here.
# Bounded impact either way: the forwarder itself has no unbounded work of
# its own (its longest wait is the caller-configured hook timeout via
# runGate()), so a worst-case orphan is a short-lived, harmless process,
# not a leak.
_mullion_output=$("$_mullion_node" "$MULLION_FORWARDER_PATH" "$@")
if [ -n "$_mullion_output" ]; then
  printf '%s\n' "$_mullion_output"
else
  _mullion_fallback "$@"
fi
exit 0
