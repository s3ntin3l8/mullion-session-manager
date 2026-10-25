#!/usr/bin/env bash
# Assemble the release tarball (and its checksum) from an already-built
# checkout. This is the exact payload the release workflow publishes as
# `mullion-<version>.tgz`, extracted from the workflow's inline shell so it
# can be run locally, reproduced byte-for-byte, and tested on Linux without
# a release (see test/scripts/assemble-release-tarball.test.ts).
#
# Usage: scripts/assemble-release-tarball.sh <version> [output-dir]
#   version     the bare MAJOR.MINOR.PATCH version, WITHOUT a leading "v"
#               (release-please's tag carries the "v"; package.json's own
#               "version" field does not — see src/services/update-checker.ts's
#               parseVersion).
#   output-dir  where the .tgz and the .sha256 are written. Defaults to the
#               current directory.
#
# The tarball's root layout is load-bearing and must not change:
#
#   dist/  frontend/dist/  drizzle/  scripts/  package.json  package-lock.json
#   deploy/   <- NEW in this script's history (see below)
#
# `src/plugins/env.ts`'s cwd-relative defaults (FRONTEND_DIST=./frontend/dist,
# drizzle/ via path.resolve("drizzle")) and `scripts/self-update.sh` both
# resolve against the release directory that `current` points at, so the
# tarball is extracted with `-C <dir> .` — no wrapping directory — and these
# entries keep their positions.
#
# WHY deploy/ ships in the tarball: without it, installing Mullion needs a
# `git clone` in addition to the published tarball, because `install.sh` and
# the launchd plist templates exist only in a checkout. The published
# v0.3.44 tarball carried `scripts/portable.sh` and `scripts/run-with-env.sh`
# but no `deploy/` and no `.plist`, so a macOS install had to fetch two
# artifacts and the clone was not versioned with the release it installed.
# Shipping the installer inside the payload makes one artifact enough, and
# makes every future installer shape (a DMG, a .pkg, an .app) a front-end
# over THIS payload instead of a second copy of the installer that can drift.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"

usage() {
  echo "usage: scripts/assemble-release-tarball.sh <version> [output-dir]" >&2
}

# Files and directories under deploy/ that are deliberately NOT part of the
# payload.
#
#   macos/ — the retired Helper-installers' leftovers (the .pkg builder and
#     its postinstall were removed in #1207 when the Helper moved to its own
#     repo); only an orphaned logo PNG remained, and that is gone too. The
#     exclusion is now defensive rather than load-bearing.
#
# Everything else under deploy/ ships, INCLUDING the two reverse-proxy
# examples (traefik-dynamic.yml, authentik-middleware-example.yml): the
# installer's own "Next steps" block ends by pointing operators at those two
# paths, so on the clone-free path they have to exist on the host — a shipped
# installer that ends by naming two missing files is not a usable one. They
# cost ~14 KB.
DEPLOY_EXCLUDE_FILES=()
DEPLOY_EXCLUDE_DIRS=(
  "macos"
)

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  usage
  exit 1
fi

VERSION="$1"
OUTPUT_DIR="${2:-.}"

case "$VERSION" in
  "" | */* | *..*)
    echo "invalid version '$VERSION' — expected a bare MAJOR.MINOR.PATCH (no leading 'v', no '/', no '..')" >&2
    exit 1
    ;;
esac

# Resolve the output dir to an absolute path before staging, so the tarball
# can be written into it from anywhere.
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"

# The staged tree is built OUTSIDE the checkout (a fresh temp dir), for the
# same reason the workflow used ../staging: a staging tree inside the repo
# would be picked up by the `cp -r scripts` copy below and nest inside
# itself.
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

# --- the payload -------------------------------------------------------------

for required in dist frontend/dist drizzle scripts package.json package-lock.json deploy; do
  if [ ! -e "$REPO_ROOT/$required" ]; then
    echo "missing '$required' in $REPO_ROOT — build the backend and the frontend first (npm run build; cd frontend && npm run build)" >&2
    exit 1
  fi
done

mkdir -p "$STAGING/frontend"
cp -r "$REPO_ROOT/dist" "$STAGING/dist"
cp -r "$REPO_ROOT/frontend/dist" "$STAGING/frontend/dist"
cp -r "$REPO_ROOT/drizzle" "$STAGING/drizzle"
cp -r "$REPO_ROOT/scripts" "$STAGING/scripts"
cp "$REPO_ROOT/package.json" "$REPO_ROOT/package-lock.json" "$STAGING/"

# deploy/ — the installer, its templates, and the bootstrap. Copied whole and
# then pruned of the excluded entries, so a file added under deploy/ ships by
# default (the installer is the only thing that should ever be missing from
# a payload) while the excluded ones stay out.
cp -R "$REPO_ROOT/deploy" "$STAGING/deploy"
# The ${arr[@]+"${arr[@]}"} form is what makes an EMPTY array safe under
# `set -u` in bash 3.2 — macOS's shell, where an empty array reads as unset
# and "${arr[@]}" alone aborts the script. Same idiom install.sh uses for its
# own positional array.
for excluded in ${DEPLOY_EXCLUDE_FILES[@]+"${DEPLOY_EXCLUDE_FILES[@]}"}; do
  rm -f "$STAGING/deploy/$excluded"
done
for excluded in ${DEPLOY_EXCLUDE_DIRS[@]+"${DEPLOY_EXCLUDE_DIRS[@]}"}; do
  rm -rf "$STAGING/deploy/$excluded"
done

# macOS's Finder metadata never belongs in a release payload. .DS_Store is
# gitignored, so it never reaches the repository — but `cp -R` copies the
# WORKING TREE, and a developer who has merely browsed deploy/ in Finder has
# one there. Strip it wherever it landed, at any depth.
find "$STAGING" -name '.DS_Store' -type f -delete

# --- the archive -------------------------------------------------------------

TARBALL_NAME="mullion-${VERSION}.tgz"
# `-C staging .` (no wrapping directory) rather than `tar -czf x.tgz
# staging/`, which would nest everything one level too deep on extraction —
# the layout self-update.sh and install.sh both depend on.
tar -czf "$OUTPUT_DIR/$TARBALL_NAME" -C "$STAGING" .

# The checksum is its own release asset, in the standard sha256sum output
# format ("<hex>  <filename>", two spaces) so `sha256sum -c` / `shasum -a
# 256 -c` can verify it directly — the same format scripts/self-update.sh and
# deploy/install.sh both consume. Computed with the file's BASENAME in the
# output so the checksum file names the archive relative to the directory it
# is verified in.
if command -v sha256sum >/dev/null 2>&1; then
  ( cd "$OUTPUT_DIR" && sha256sum "$TARBALL_NAME" >"$TARBALL_NAME.sha256" )
elif command -v shasum >/dev/null 2>&1; then
  # macOS ships shasum, not sha256sum — and its output format is identical.
  ( cd "$OUTPUT_DIR" && shasum -a 256 "$TARBALL_NAME" >"$TARBALL_NAME.sha256" )
else
  echo "neither sha256sum nor shasum found — cannot produce the checksum" >&2
  exit 1
fi

echo "==> Assembled $OUTPUT_DIR/$TARBALL_NAME"
echo "    checksum: $OUTPUT_DIR/$TARBALL_NAME.sha256"
