#!/usr/bin/env bash
# visual-kit host hooks (https://github.com/s3ntin3l8/visual-kit, CONTRACT.md "Host hooks").
#
# hooks.mjs runs in a container and reaches the demo only over HTTP, but the
# demo holds its scripted agent transcripts until a release file appears in its
# scratch directory, which only the host can write. visual-kit runs this as
#
#   bash visual/host-hooks.sh <name> <demo-dir> <args...>
#
# with <demo-dir> (the checkout, or the base worktree during a check) as the
# working directory. `make demo` records the scratch scripts dir in
# visual/.out/demo-state while it is up (MULLION_DEMO_STATE in scenes.json).
set -euo pipefail

name=${1:?missing hook name}
demo_dir=${2:?missing demo dir}
shift 2

state="$demo_dir/visual/.out/demo-state"
[ -r "$state" ] || { echo "no demo state at $state" >&2; exit 1; }
scripts=$(<"$state")

# Only the held demo scripts: lowercase words, so nothing can step out of $scripts.
script=${1:-}
[[ $script =~ ^[a-z0-9-]+$ ]] || { echo "bad script name: $script" >&2; exit 2; }

case $name in
  # Let a held transcript start printing.
  release) : >"$scripts/$script.release" ;;
  # The PTY size the released script printed at (`stty size`), for the geometry check.
  size) cat "$scripts/$script.release.size" 2>/dev/null || true ;;
  *) echo "unknown host hook: $name" >&2; exit 2 ;;
esac
