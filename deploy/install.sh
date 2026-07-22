#!/usr/bin/env bash
# First-time bootstrap for the versioned-release deploy layout (see
# deploy/README.md). NOT run by this repo's CI, and not idempotent in every
# regard — this is a one-shot "set up a fresh prod install" script, run by
# hand once per host. Applying an update afterwards is the in-app
# Settings -> Server info "Update now" button (POST /api/updates/apply),
# which uses scripts/self-update.sh instead.
#
# Run from within a checkout of this repo (it reads
# deploy/claude-remote-session.service as a template, relative to this
# script's own location) — a fresh prod host does NOT need a full build
# toolchain-driven checkout beyond that; the app itself is installed from
# the CI-built release tarball, not built from this checkout.
#
# Usage: deploy/install.sh <mullion-home> [owner/repo]
#   mullion-home  absolute (or relative, resolved to absolute) path to the
#                 install root — parent of releases/, current, data/, .env.
#                 e.g. ~/opt/mullion
#   owner/repo    defaults to MULLION_UPDATE_REPO's own default
#                 (s3ntin3l8/mullion-session-manager) — override only for a
#                 fork publishing releases elsewhere.

set -euo pipefail

MULLION_HOME_INPUT="${1:?usage: deploy/install.sh <mullion-home> [owner/repo]}"
REPO="${2:-s3ntin3l8/mullion-session-manager}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Checking host prerequisites"
missing=()
for bin in node npm dtach systemd-run systemctl curl tar timeout sha256sum; do
  command -v "$bin" >/dev/null 2>&1 || missing+=("$bin")
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "Missing required host binaries: ${missing[*]}" >&2
  echo "See deploy/README.md's prerequisites (Node 26, dtach, a systemd --user" >&2
  echo "session, and — for the native-module compile step below — python3/make/g++)." >&2
  exit 1
fi

NODE_PATH="$(command -v node)"
echo "    node: $NODE_PATH ($("$NODE_PATH" --version))"

# Matches self-update.sh's own NPM_CI_TIMEOUT_SECONDS.
NPM_CI_TIMEOUT_SECONDS=600

mkdir -p "$MULLION_HOME_INPUT"
MULLION_HOME="$(cd "$MULLION_HOME_INPUT" && pwd)"
echo "==> Installing into $MULLION_HOME"

mkdir -p "$MULLION_HOME/releases" "$MULLION_HOME/data/sessions"

echo "==> Looking up the latest release of $REPO"
RELEASE_JSON="$(curl -fsSL -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$REPO/releases/latest")"
VERSION="$(printf '%s' "$RELEASE_JSON" | "$NODE_PATH" -e \
  'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write((d.tag_name||"").replace(/^v/,""))')"
ASSET_URL="$(printf '%s' "$RELEASE_JSON" | "$NODE_PATH" -e \
  'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const a=(d.assets||[]).find(x=>x.name.endsWith(".tgz"));process.stdout.write(a?a.browser_download_url:"")')"
CHECKSUM_URL="$(printf '%s' "$RELEASE_JSON" | "$NODE_PATH" -e \
  'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const a=(d.assets||[]).find(x=>x.name.endsWith(".sha256"));process.stdout.write(a?a.browser_download_url:"")')"
if [ -z "$VERSION" ] || [ -z "$ASSET_URL" ] || [ -z "$CHECKSUM_URL" ]; then
  echo "Could not find a .tgz release asset (and its .sha256 checksum) for $REPO's latest release." >&2
  echo "Has the release-please.yml build-tarball job run yet?" >&2
  exit 1
fi
echo "    latest release: $VERSION"

RELEASE_DIR="$MULLION_HOME/releases/$VERSION"
if [ -d "$RELEASE_DIR" ]; then
  echo "    $RELEASE_DIR already exists, reusing it"
else
  echo "==> Downloading and installing $VERSION"
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  TARBALL_NAME="mullion-$VERSION.tgz"
  curl -fsSL -o "$TMP_DIR/$TARBALL_NAME" "$ASSET_URL"
  curl -fsSL -o "$TMP_DIR/$TARBALL_NAME.sha256" "$CHECKSUM_URL"
  # Same verification self-update.sh performs before every later update —
  # see its own comment on why both files must share $TMP_DIR (Hermes
  # review, PR #54).
  (cd "$TMP_DIR" && sha256sum -c "$TARBALL_NAME.sha256") ||
    { echo "checksum verification failed for $TARBALL_NAME" >&2; exit 1; }
  mkdir -p "$RELEASE_DIR"
  tar -xzf "$TMP_DIR/$TARBALL_NAME" -C "$RELEASE_DIR"
  # Same PATH fix self-update.sh applies — a bare `npm ci` needs `npm`
  # resolvable, which isn't guaranteed by every shell this script might run
  # under (though usually fine interactively, unlike the systemd unit).
  PATH="$(dirname "$NODE_PATH"):$PATH" \
    bash -c "cd '$RELEASE_DIR' && timeout $NPM_CI_TIMEOUT_SECONDS npm ci --omit=dev"
fi

echo "==> Pointing current -> $VERSION"
ln -sfn "$RELEASE_DIR" "$MULLION_HOME/current.tmp"
mv -T "$MULLION_HOME/current.tmp" "$MULLION_HOME/current"

if [ -f "$MULLION_HOME/.env" ]; then
  echo "==> $MULLION_HOME/.env already exists, leaving it as-is"
else
  echo "==> Writing $MULLION_HOME/.env"
  # Only the absolute-path overrides the versioned-release layout requires
  # (see deploy/README.md's "cwd-relative path" warning) plus the two
  # role/home settings — everything else keeps its src/plugins/env.ts
  # schema default. Not copied from .env.example: a fresh prod host installs
  # from the release tarball, not a full source checkout, so .env.example
  # may not even be present here.
  cat > "$MULLION_HOME/.env" <<EOF
# Generated by deploy/install.sh. See .env.example in the source repo for
# the full list of tunables — only the settings this layout requires are
# set here; everything else uses its schema default.
DATABASE_URL=file:$MULLION_HOME/data/app.db
SESSIONS_DIR=$MULLION_HOME/data/sessions
MULLION_HOME=$MULLION_HOME
MULLION_ROLE=primary
EOF
fi

echo "==> Installing the systemd --user unit"
mkdir -p ~/.config/systemd/user
sed \
  -e "s#^WorkingDirectory=.*#WorkingDirectory=$MULLION_HOME/current#" \
  -e "s#^ExecStart=.*#ExecStart=$NODE_PATH dist/server.js#" \
  -e "s#^EnvironmentFile=.*#EnvironmentFile=$MULLION_HOME/.env#" \
  "$SCRIPT_DIR/claude-remote-session.service" \
  > ~/.config/systemd/user/claude-remote-session.service

systemctl --user daemon-reload
systemctl --user enable --now claude-remote-session.service

echo "==> Done. Status:"
systemctl --user --no-pager status claude-remote-session.service || true

cat <<EOF

Next steps (see deploy/README.md):
  - Point Traefik at this host (deploy/traefik-dynamic.yml).
  - Wire up your forwardAuth middleware (deploy/authentik-middleware-example.yml).
  - Check GET /health and /api/server-info once Traefik is routing.
EOF
