#!/bin/sh
# Mullion bootstrap — install Mullion from a published release, without a
# git clone.
#
# Usage: sh mullion-install.sh [--role primary|agent] [--no-systemd] <mullion-home> [owner/repo]
#
# This is NOT a second installer. It resolves the latest published release,
# downloads it, verifies its checksum, and then hands the whole thing to the
# very same deploy/install.sh that ships INSIDE that release. There is one
# installer, versioned with the code it installs; this script only decides
# WHICH release to install and fetches it.
#
# Why it exists: the published release tarball used to carry the runtime
# scripts (scripts/portable.sh, scripts/run-with-env.sh, scripts/self-update.sh)
# but NOT deploy/ — so install.sh and the launchd plist templates existed only
# in a git checkout. A macOS install therefore needed two artifacts, and the
# clone was not versioned with the release it installed. The release tarball
# now carries deploy/ as well, which makes this bootstrap sufficient on its
# own.
#
# Requirements: bash (the installer is a bash script), curl, tar, and either
# sha256sum or shasum. node is NOT required here — deploy/install.sh checks
# for it itself.
#
# Run it with `sh`, not `./mullion-install.sh`: a GitHub release asset is a
# plain file and loses its executable bit on download.
#
#   curl -fsSL -o mullion-install.sh \
#     https://github.com/s3ntin3l8/mullion-session-manager/releases/latest/download/mullion-install.sh
#   less mullion-install.sh          # it is a shell script — read it first
#   sh mullion-install.sh --role agent ~/opt/mullion-agent
#
# Note: this URL always serves the newest release's copy of the script, and
# the script always installs the newest release AT THE TIME IT RUNS. A copy
# downloaded today and run next month installs next month's release.
set -eu

DEFAULT_REPO="s3ntin3l8/mullion-session-manager"

usage() {
  cat <<'EOF'
usage: mullion-install.sh [--role primary|agent] [--no-systemd] <mullion-home> [owner/repo]

Downloads the latest published Mullion release, verifies its checksum, and
runs the release's own deploy/install.sh with the arguments given here.

  --role primary|agent  which role to install (default: primary)
  --no-systemd          skip the service/job registration entirely
  <mullion-home>        the install root — the parent of releases/, current,
                         data/, logs/ and .env (e.g. ~/opt/mullion)
  owner/repo            install from a fork's releases instead (optional)

The install root, the role and everything else are handled by
deploy/install.sh — this script only fetches the release.
EOF
}

if [ $# -eq 0 ]; then
  usage
  exit 1
fi

# --- read the arguments ------------------------------------------------------
#
# The arguments are forwarded to deploy/install.sh VERBATIM — this loop only
# reads them, to find the install root (for display) and the optional
# owner/repo override (which decides WHICH repository's release is fetched).
# The flag shapes below mirror deploy/install.sh's own parser; an argument
# this loop does not recognize is still forwarded, and install.sh remains the
# authority on whether it is valid.
INSTALL_ROOT=""
REPO_OVERRIDE=""
expect_value=0
for arg in "$@"; do
  if [ "$expect_value" = "1" ]; then
    expect_value=0
    continue
  fi
  case "$arg" in
    -h | --help)
      usage
      exit 0
      ;;
    --role)
      expect_value=1
      ;;
    --role=* | --no-systemd | --*)
      : # a flag with no separate value — nothing positional to collect
      ;;
    *)
      if [ -z "$INSTALL_ROOT" ]; then
        INSTALL_ROOT="$arg"
      elif [ -z "$REPO_OVERRIDE" ]; then
        REPO_OVERRIDE="$arg"
      fi
      ;;
  esac
done

REPO="${REPO_OVERRIDE:-$DEFAULT_REPO}"

# --- prerequisites -----------------------------------------------------------

for bin in bash curl tar; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "mullion-install: '$bin' is required but was not found on PATH." >&2
    exit 1
  fi
done

if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
  echo "mullion-install: neither sha256sum nor shasum found — cannot verify the download." >&2
  exit 1
fi

# --- resolve the latest release ----------------------------------------------
#
# GitHub redirects /releases/latest to /releases/tag/<tag>; following it with
# a HEAD request gives the tag without an API token, a jq dependency, or a
# JSON parser.
TAG_URL="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" 2>/dev/null || true)"
TAG="${TAG_URL##*/tag/}"
if [ -z "$TAG" ] || [ "$TAG" = "$TAG_URL" ]; then
  echo "mullion-install: could not resolve the latest release of $REPO (got: '${TAG_URL:-no response}')." >&2
  echo "mullion-install: check that the repository exists and has a published release." >&2
  exit 1
fi
VERSION="${TAG#v}"

echo "==> Mullion bootstrap"
echo "    repository:      $REPO"
echo "    latest release:  $TAG"
echo "    install root:    ${INSTALL_ROOT:-<not given>}"

# --- download + verify --------------------------------------------------------

TMP_DIR="$(mktemp -d)"
# shellcheck disable=SC2329  # invoked indirectly, by the trap below
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

TARBALL_NAME="mullion-$VERSION.tgz"
BASE_URL="https://github.com/$REPO/releases/download/$TAG"

echo "==> Downloading $TARBALL_NAME"
curl -fsSL -o "$TMP_DIR/$TARBALL_NAME" "$BASE_URL/$TARBALL_NAME"
curl -fsSL -o "$TMP_DIR/$TARBALL_NAME.sha256" "$BASE_URL/$TARBALL_NAME.sha256"

# The checksum is the ONLY thing standing between the user and a tampered
# asset, so this fails CLOSED: a mismatch aborts the install, nothing is
# extracted, and nothing is installed.
echo "==> Verifying the checksum"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$TMP_DIR" && sha256sum -c "$TARBALL_NAME.sha256") || {
    echo "mullion-install: checksum verification FAILED for $TARBALL_NAME — refusing to install." >&2
    exit 1
  }
else
  # macOS ships shasum rather than sha256sum; same output format, same
  # failure semantics.
  (cd "$TMP_DIR" && shasum -a 256 -c "$TARBALL_NAME.sha256") || {
    echo "mullion-install: checksum verification FAILED for $TARBALL_NAME — refusing to install." >&2
    exit 1
  }
fi

# --- extract + hand over to the release's own installer ------------------------

mkdir -p "$TMP_DIR/payload"
tar -xzf "$TMP_DIR/$TARBALL_NAME" -C "$TMP_DIR/payload"

INSTALLER="$TMP_DIR/payload/deploy/install.sh"
if [ ! -f "$INSTALLER" ]; then
  echo "mullion-install: the downloaded release does not contain deploy/install.sh." >&2
  echo "mullion-install: this release cannot be installed from the published artifact." >&2
  exit 1
fi

echo "==> Running the release's installer"
set +e
bash "$INSTALLER" "$@"
STATUS=$?
set -e

if [ "$STATUS" -eq 0 ]; then
  echo "==> Mullion $VERSION installed."
else
  echo "==> The installer exited with status $STATUS — see its output above." >&2
fi
exit "$STATUS"
