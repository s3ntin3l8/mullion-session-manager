#!/usr/bin/env bash
# Installs what `make demo` needs before visual-kit renders it (run by the shared
# visual-check workflow). The check also renders the merge base in a worktree and
# symlinks node_modules and frontend/node_modules into it (visual/scenes.json baseDeps).
set -euo pipefail
npm ci
npm --prefix frontend ci
