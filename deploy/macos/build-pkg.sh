#!/usr/bin/env bash
# Round 4 (PR5, issue #820) — the minimal macOS installer for the SSH-agent
# bridge helper: packages scripts/build-helper-sea.mjs's own mullion-helper
# binary (built by CI BEFORE this runs — see this file's own invocation in
# .github/workflows/ci-cd.yml's test-macos job and release-please.yml's
# build-helper-pkg job) into a plain pkgbuild component package. No custom
# pairing-payload wizard page (unlike deploy/windows/mullion-helper.iss) —
# Installer.app has no Inno-Setup-style scripting for that; a real one would
# need a compiled InstallerPlugin or a standalone GUI app, either of which is
# tray-repo work, not this reference installer's job. Pairing stays a
# one-time `mullion-helper helper pair <payload>` in Terminal after install,
# same as the Windows installer's own "leave the pairing field blank, pair
# later" fallback — except here it's the only path, not a fallback.
set -euo pipefail

VERSION="${1:-0.0.0-dev}"
# Hermes review, PR #918 — VERSION becomes part of OUT_PATH below with no
# validation; every actual caller (a developer's own local invocation,
# test-macos's fixed literal, release-please.yml's own tag_name output) is
# already trusted, so this was never exploitable in practice, but a version
# string containing "/" could still escape OUT_DIR into an unintended path
# by accident (a malformed release tag, a copy-paste typo), not just by
# malice — worth rejecting outright rather than silently writing somewhere
# unexpected.
case "$VERSION" in
  */* | *..*)
    echo "invalid VERSION '$VERSION' — must not contain '/' or '..'" >&2
    exit 1
    ;;
esac
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
SEA_BIN="$REPO_ROOT/build/helper-sea/mullion-helper"
STAGE_ROOT="$REPO_ROOT/build/macos-pkg-root"
OUT_DIR="$REPO_ROOT/build/installer"
# Fixed, never regenerate — same reasoning as the Windows installer's own
# AppId comment (deploy/windows/mullion-helper.iss): macOS's package
# receipt database (`pkgutil --pkgs`) uses this to recognize "the same
# product" across versions. Deliberately distinct from LAUNCHD_LABEL
# (de.s3ntin3l8.mullion-helper, src/cli/ssh-agent-helper-install.mjs) — the
# package identifier and the launchd job it happens to install are two
# different things that don't need to share a name.
IDENTIFIER="de.s3ntin3l8.mullion-helper-pkg"

if [ ! -x "$SEA_BIN" ]; then
  echo "expected a built mullion-helper SEA at $SEA_BIN — run 'npm run build:helper-sea' first" >&2
  exit 1
fi

rm -rf "$STAGE_ROOT"
mkdir -p "$STAGE_ROOT/usr/local/bin" "$OUT_DIR"
cp "$SEA_BIN" "$STAGE_ROOT/usr/local/bin/mullion-helper"
chmod 755 "$STAGE_ROOT/usr/local/bin/mullion-helper"

OUT_PATH="$OUT_DIR/mullion-helper-$VERSION.pkg"
pkgbuild \
  --root "$STAGE_ROOT" \
  --identifier "$IDENTIFIER" \
  --version "$VERSION" \
  --scripts "$HERE/scripts" \
  --install-location / \
  "$OUT_PATH"

echo "built $OUT_PATH"
