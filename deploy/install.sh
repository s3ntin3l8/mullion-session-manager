#!/usr/bin/env bash
# First-time bootstrap for the versioned-release deploy layout (see
# deploy/README.md). NOT run by this repo's CI, and not idempotent in every
# regard — this is a one-shot "set up a fresh prod install" script, run by
# hand once per host (or by an Ansible role — see deploy/README.md's
# "Automating agent deploys" section). Applying an update afterwards is the
# in-app Settings -> Server info "Update now" button
# (POST /api/updates/apply), which uses scripts/self-update.sh instead.
#
# Run from within a checkout of this repo (it reads deploy/mullion.service /
# deploy/mullion-agent.service as templates, relative to this script's own
# location) — a fresh prod host does NOT need a full build toolchain-driven
# checkout beyond that; the app itself is installed from the CI-built
# release tarball, not built from this checkout.
#
# Usage: deploy/install.sh [--role primary|agent] <mullion-home> [owner/repo]
#   --role        primary (default) or agent — see deploy/README.md's env
#                 contract table for what each role's .env needs. Installs
#                 mullion.service for primary, mullion-agent.service for
#                 agent (issue #245 / roadmap 7.1 and 7.7).
#   mullion-home  absolute (or relative, resolved to absolute) path to the
#                 install root — parent of releases/, current, data/, .env.
#                 e.g. ~/opt/mullion
#   owner/repo    defaults to MULLION_UPDATE_REPO's own default
#                 (s3ntin3l8/mullion-session-manager) — override only for a
#                 fork publishing releases elsewhere.

set -euo pipefail

usage() {
  echo "usage: deploy/install.sh [--role primary|agent] <mullion-home> [owner/repo]" >&2
}

ROLE="primary"
POSITIONAL=()
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      # Hermes review, PR #529: -h (single dash) doesn't match the --*
      # unknown-flag case below, so without this it fell into the
      # positional bucket and became the install-root path instead of
      # printing usage — a confusing failure far from what was asked for.
      usage
      exit 0
      ;;
    --role)
      # Hermes review, PR #529: ${2:?...} when --role is the LAST argument
      # surfaces as a raw "bash: 2: --role requires a value..." unbound-
      # variable message instead of a clean error — ${2:-} leaves ROLE
      # empty in that case instead, which the existing "must be 'primary'
      # or 'agent'" validation below already reports cleanly. `shift`
      # (not `shift 2`) when $2 was never actually there avoids a shift
      # count out of range error too.
      ROLE="${2:-}"
      shift
      [ $# -gt 0 ] && shift
      ;;
    --role=*)
      ROLE="${1#--role=}"
      shift
      ;;
    --*)
      # Hermes review, PR #529: an unrecognized --flag (e.g. a typo'd
      # --roll) previously fell into the positional bucket below and got
      # silently treated as the install-root path — a confusing failure
      # mode far from the actual typo. Fail fast instead.
      echo "Unknown flag: $1" >&2
      exit 1
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done
set -- "${POSITIONAL[@]+"${POSITIONAL[@]}"}"

if [ "$ROLE" != "primary" ] && [ "$ROLE" != "agent" ]; then
  echo "--role must be 'primary' or 'agent' (got: $ROLE)" >&2
  exit 1
fi

MULLION_HOME_INPUT="${1:?usage: deploy/install.sh [--role primary|agent] <mullion-home> [owner/repo]}"
REPO="${2:-s3ntin3l8/mullion-session-manager}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "==> Role: $ROLE"

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

# `bwrap` (bubblewrap) is OPTIONAL, not required — issue #1081. When
# present (and actually usable; scaffold-generate.ts's own runtime probe is
# what decides that, not this check) it lets `/setup/generate`'s agent turn
# run inside a real process-level sandbox instead of relying solely on the
# structural PR-pipeline guarantee. Absent, generation degrades gracefully
# to that structural-only guarantee, with a warning logged at generation
# time — so this is a heads-up, not a hard prerequisite failure.
if ! command -v bwrap >/dev/null 2>&1; then
  echo "NOTE: 'bwrap' (bubblewrap) not found — optional; see deploy/README.md's" >&2
  echo "Host prerequisites section. Without it, scaffold-generate's agent turn" >&2
  echo "runs without process-level sandboxing (structural guarantee only)." >&2
fi

NODE_PATH="$(command -v node)"
echo "    node: $NODE_PATH ($("$NODE_PATH" --version))"

# Matches self-update.sh's own NPM_CI_TIMEOUT_SECONDS.
NPM_CI_TIMEOUT_SECONDS=600

mkdir -p "$MULLION_HOME_INPUT"
MULLION_HOME="$(cd "$MULLION_HOME_INPUT" && pwd)"
echo "==> Installing into $MULLION_HOME"

if [ -f "$MULLION_HOME/.env" ]; then
  # Hermes review, PR #529: an existing .env from a prior run at a
  # different --role must not be silently kept while THIS run installs the
  # other role's systemd unit — that leaves a host booting as primary (per
  # its own .env) with the agent unit enabled, or vice versa, with no error
  # at all. grep, not `source`ing the file: .env may contain values with
  # shell-special characters that aren't safe to eval. Defaults to
  # "primary" when the line is absent entirely (a legacy/hand-written .env
  # that never set MULLION_ROLE at all) — src/plugins/env.ts's own schema
  # default is "primary", so an empty grep result means primary just as
  # much as an explicit line would; skipping the check in that case (as an
  # earlier version of this fix did) would leave the exact gap it exists
  # to close.
  #
  # Independent review, PR #529: strip a trailing \r (a .env templated on
  # or transferred from Windows), surrounding quotes, and whitespace — a
  # hand-authored `MULLION_ROLE="agent"` (this section's own docs invite
  # operators to hand-template .env themselves) would otherwise never
  # string-equal the validated $ROLE and trip a false-positive refusal.
  # NOT handled, deliberately: spaces around the `=` itself
  # (`MULLION_ROLE = agent`) — that's not valid dotenv syntax and the grep
  # below won't match the line at all, so it's treated the same as the
  # line being absent (defaults to "primary" just below).
  #
  # Checked here, immediately after resolving $MULLION_HOME — deliberately
  # BEFORE the release download/npm ci/Playwright install/symlink-flip
  # below, so a mismatch is caught before any of that runs, not after
  # (Hermes review, PR #529: catching it after those steps means a refused
  # run still wasted minutes and already mutated the host).
  EXISTING_ROLE="$(grep -E '^MULLION_ROLE=' "$MULLION_HOME/.env" | tail -1 | cut -d= -f2- || true)"
  EXISTING_ROLE="${EXISTING_ROLE%$'\r'}"
  # Hermes review, PR #529 (fifth round): a sed BRE-anchor escaping bug in
  # an earlier version of this trim made the trailing-quote strip a no-op
  # for some sed dialects. Pure bash parameter expansion instead — no
  # regex, no dialect ambiguity, and it's simpler than the sed pipeline it
  # replaces. Strips at most one layer of whitespace, then at most one
  # matching quote character, from each end.
  while [[ "$EXISTING_ROLE" == [[:space:]]* ]]; do EXISTING_ROLE="${EXISTING_ROLE#[[:space:]]}"; done
  while [[ "$EXISTING_ROLE" == *[[:space:]] ]]; do EXISTING_ROLE="${EXISTING_ROLE%[[:space:]]}"; done
  case "$EXISTING_ROLE" in
    \"*) EXISTING_ROLE="${EXISTING_ROLE#\"}" ;;
    \'*) EXISTING_ROLE="${EXISTING_ROLE#\'}" ;;
  esac
  case "$EXISTING_ROLE" in
    *\") EXISTING_ROLE="${EXISTING_ROLE%\"}" ;;
    *\') EXISTING_ROLE="${EXISTING_ROLE%\'}" ;;
  esac
  EXISTING_ROLE="${EXISTING_ROLE:-primary}"
  if [ "$EXISTING_ROLE" != "$ROLE" ]; then
    echo "$MULLION_HOME/.env already has MULLION_ROLE=$EXISTING_ROLE, but --role $ROLE was requested." >&2
    echo "Refusing to install the $ROLE systemd unit over a $EXISTING_ROLE .env — fix one or the other first." >&2
    exit 1
  fi
fi

mkdir -p "$MULLION_HOME/releases" "$MULLION_HOME/data/sessions" "$MULLION_HOME/data/browsers" "$MULLION_HOME/browsers"

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

  # Phase 3 (#179): `playwright` is a runtime dependency (see package.json),
  # but `npm ci` alone never downloads its Chromium binary — that only
  # happens via this explicit `playwright install` call. Deliberately NOT a
  # package.json postinstall hook: that would re-run (and re-download) on
  # every `npm ci` anywhere, including this repo's own CI. Installed
  # unconditionally at install/update time (matching issue #179's own
  # requirement) regardless of whether BROWSER_ENABLED is ever turned on —
  # the feature itself stays off by default (src/plugins/env.ts), so this is
  # purely a one-time disk/bandwidth cost, not a running-process cost.
  # PLAYWRIGHT_BROWSERS_PATH is set to an absolute path OUTSIDE $RELEASE_DIR
  # (see the data/ layout note above) so the downloaded browser survives the
  # next update's `current` symlink flip instead of being orphaned with this
  # release.
  echo "==> Installing Playwright's Chromium browser"
  PATH="$(dirname "$NODE_PATH"):$PATH" \
    bash -c "cd '$RELEASE_DIR' && PLAYWRIGHT_BROWSERS_PATH='$MULLION_HOME/browsers' timeout $NPM_CI_TIMEOUT_SECONDS npx playwright install chromium"
fi

echo "==> Pointing current -> $VERSION"
ln -sfn "$RELEASE_DIR" "$MULLION_HOME/current.tmp"
mv -T "$MULLION_HOME/current.tmp" "$MULLION_HOME/current"

# Phase 4 (#134, PR7) — points at $MULLION_HOME/current (the symlink just
# flipped above), not its realpath, so a later release flip (including
# every scripts/self-update.sh run — see that script's matching step)
# never needs this symlink itself touched again. Guarded on the target
# actually existing: the release this host is installing might predate
# `make build` copying src/cli into dist/cli at all (e.g. installing
# during the window between this shipping and the next release-please
# tag) — an unconditional `ln -sfn` would happily create a dangling
# symlink in that case (code review, PR #403).
MULLION_CLI_LINKED=false
if [ -f "$MULLION_HOME/current/dist/cli/mullion.mjs" ]; then
  echo "==> Linking mullion CLI to ~/.local/bin/mullion"
  mkdir -p ~/.local/bin
  ln -sfn "$MULLION_HOME/current/dist/cli/mullion.mjs" ~/.local/bin/mullion
  MULLION_CLI_LINKED=true
else
  echo "==> mullion CLI not present in this release (dist/cli/mullion.mjs missing) — skipping ~/.local/bin/mullion link"
fi

if [ -f "$MULLION_HOME/.env" ]; then
  # Role-mismatch already checked and enforced right after $MULLION_HOME
  # was resolved, above — before any expensive/mutating step ran.
  echo "==> $MULLION_HOME/.env already exists, leaving it as-is"
  # Hermes review, PR #529: content untouched, but permissions still
  # tightened — a legacy .env written at the ambient umask (644), or one
  # an operator hand-templated per this section's own docs, can hold
  # MULLION_ENROLLMENT_TOKEN/MULLION_AGENT_TOKEN just as much as a
  # freshly-generated one.
  chmod 600 "$MULLION_HOME/.env"
elif [ "$ROLE" = "primary" ]; then
  echo "==> Writing $MULLION_HOME/.env (primary)"
  # Only the absolute-path overrides the versioned-release layout requires
  # (see deploy/README.md's "cwd-relative path" warning) plus the two
  # role/home settings — everything else keeps its src/plugins/env.ts
  # schema default. Not copied from .env.example: a fresh prod host installs
  # from the release tarball, not a full source checkout, so .env.example
  # may not even be present here.
  # Independent review, PR #529: umask 077 in a subshell (rather than
  # writing first and chmod 600-ing after) closes the brief window where
  # the freshly-created file would otherwise sit at the process's ambient
  # umask (typically 644) before its permissions were tightened.
  ( umask 077 && cat > "$MULLION_HOME/.env" <<EOF
# Generated by deploy/install.sh. See .env.example in the source repo for
# the full list of tunables — only the settings this layout requires are
# set here; everything else uses its schema default.
DATABASE_URL=file:$MULLION_HOME/data/app.db
SESSIONS_DIR=$MULLION_HOME/data/sessions
MULLION_HOME=$MULLION_HOME
MULLION_ROLE=primary
# Phase 3 (#179) — BROWSER_ENABLED stays false (schema default) until you
# opt in; these two paths are pre-configured either way so turning it on
# later needs no reinstall. See deploy/README.md's Playwright prerequisites.
PLAYWRIGHT_BROWSERS_PATH=$MULLION_HOME/browsers
BROWSER_DATA_DIR=$MULLION_HOME/data/browsers
EOF
  )
  chmod 600 "$MULLION_HOME/.env"
else
  echo "==> Writing $MULLION_HOME/.env (agent)"
  # Issue #245 / roadmap 7.1 + 7.7 — deliberately NO DATABASE_URL,
  # DB_ENCRYPTION_KEY, or FRONTEND_DIST: an agent is DB-less and serves no
  # frontend (src/app.ts's agent branch never registers dbPlugin/
  # staticPlugin). The four MULLION_AGENT_*/MULLION_PRIMARY_URL/
  # MULLION_ENROLLMENT_* values below are read from this script's own
  # environment if the caller (e.g. an Ansible task) already exported them,
  # so a fully automated deploy needs no manual edit of this file at all —
  # see deploy/README.md's "Automating agent deploys" section. Left blank
  # (with the schema's own empty-string default) otherwise, for an operator
  # to fill in by hand; src/app.ts refuses to boot with neither auth path
  # configured, so an incomplete file fails loudly on first start rather
  # than silently.
  # Independent review, PR #529: same umask-077-in-a-subshell reasoning as
  # the primary branch above — this file can hold the fleet-wide
  # MULLION_ENROLLMENT_TOKEN, so it must never exist at the ambient umask
  # even momentarily.
  #
  # Hermes review, PR #529 (fifth round): an earlier version of this
  # interpolated every MULLION_AGENT_* value directly inside an unquoted
  # <<EOF heredoc — a caller-supplied value (from Ansible/ansible-vault,
  # not this script's own control) containing `$`, `` ` ``, or `\` would
  # be shell-expanded (or, for `$(...)`/backticks, EXECUTED) at write
  # time, silently corrupting the credential into the exact crash-loop
  # the warnings below try to pre-empt — or worse. Split: static
  # content/paths (safe — never carries arbitrary caller input) still goes
  # through an interpolated heredoc; every value that CAN carry arbitrary
  # caller input is instead appended with `printf '%s'`, which treats it
  # as an inert string with no further shell interpretation at all.
  ( umask 077 && cat > "$MULLION_HOME/.env" <<EOF
# Generated by deploy/install.sh --role agent. See docs/multi-host.md for
# the self-registration vs. manual-token setup this needs, and
# .env.example in the source repo for every tunable.
SESSIONS_DIR=$MULLION_HOME/data/sessions
MULLION_HOME=$MULLION_HOME
MULLION_ROLE=agent
PLAYWRIGHT_BROWSERS_PATH=$MULLION_HOME/browsers
BROWSER_DATA_DIR=$MULLION_HOME/data/browsers

# Comma-separated dirs on THIS host to scan for project discovery —
# required for this agent to be useful at all.
EOF
    printf 'PROJECTS_ROOTS=%s\n' "${MULLION_AGENT_PROJECTS_ROOTS:-}" >>"$MULLION_HOME/.env"
    cat >>"$MULLION_HOME/.env" <<'EOF'

# --- Pick ONE of the two credential paths below; src/app.ts refuses to
# boot an agent with neither configured. See docs/multi-host.md. ---

# Path 1 (recommended for automated fleets): self-registration — no manual
# step on the primary at all. Requires MULLION_ENROLLMENT_SECRET to be set
# on the primary too.
EOF
    printf 'MULLION_PRIMARY_URL=%s\n' "${MULLION_AGENT_PRIMARY_URL:-}" >>"$MULLION_HOME/.env"
    printf 'MULLION_ENROLLMENT_TOKEN=%s\n' "${MULLION_AGENT_ENROLLMENT_TOKEN:-}" >>"$MULLION_HOME/.env"
    printf 'MULLION_AGENT_ADVERTISE_URL=%s\n' "${MULLION_AGENT_ADVERTISE_URL:-}" >>"$MULLION_HOME/.env"
    printf 'MULLION_AGENT_NAME=%s\n' "${MULLION_AGENT_NAME:-}" >>"$MULLION_HOME/.env"
    cat >>"$MULLION_HOME/.env" <<'EOF'

# Path 2: a pre-provisioned static token, registered by hand in the
# primary's Settings -> Hosts -> Add host. Set this INSTEAD of Path 1 above.
EOF
    printf 'MULLION_AGENT_TOKEN=%s\n' "${MULLION_AGENT_TOKEN:-}" >>"$MULLION_HOME/.env"
  )
  if [ -z "${MULLION_AGENT_PROJECTS_ROOTS:-}" ]; then
    # Hermes review, PR #529: nothing in src/app.ts's fail-closed check
    # covers this — an agent with an empty PROJECTS_ROOTS boots fine and
    # just has zero discoverable projects, which is a silent "deployed but
    # useless" outcome for a fleet role, not a boot failure to catch it.
    echo "WARNING: PROJECTS_ROOTS is empty in the generated .env — this agent will boot but have no discoverable projects. Set MULLION_AGENT_PROJECTS_ROOTS before running this script, or edit \$MULLION_HOME/.env by hand." >&2
  fi
  # Hermes review, PR #529 (fourth round): must mirror src/app.ts's ACTUAL
  # condition (hasManualToken OR (hasPrimaryUrl AND hasEnrollmentToken)),
  # not just "both vars empty" — MULLION_AGENT_ENROLLMENT_TOKEN alone,
  # with MULLION_AGENT_PRIMARY_URL forgotten, previously passed this check
  # silently while app.ts's own boot-time check still refuses to start.
  # Hermes review, PR #529 (fifth round): src/app.ts checks
  # `.trim() !== ""`, not just non-empty — a whitespace-only value (e.g.
  # a stray space from a templating bug) would pass a plain `[ -n ]` check
  # here but still fail app.ts's own check at boot. is_blank mirrors
  # .trim() === "" using the same bash-native whitespace strip as
  # EXISTING_ROLE above (no sed, no dialect ambiguity).
  is_blank() {
    local v="$1"
    while [[ "$v" == [[:space:]]* ]]; do v="${v#[[:space:]]}"; done
    while [[ "$v" == *[[:space:]] ]]; do v="${v%[[:space:]]}"; done
    [ -z "$v" ]
  }
  HAS_MANUAL_TOKEN=false
  is_blank "${MULLION_AGENT_TOKEN:-}" || HAS_MANUAL_TOKEN=true
  HAS_ENROLLMENT_PATH=false
  if ! is_blank "${MULLION_AGENT_PRIMARY_URL:-}" && ! is_blank "${MULLION_AGENT_ENROLLMENT_TOKEN:-}"; then
    HAS_ENROLLMENT_PATH=true
  fi
  if [ "$HAS_MANUAL_TOKEN" = false ] && [ "$HAS_ENROLLMENT_PATH" = false ]; then
    # Unlike PROJECTS_ROOTS, this one IS fail-closed — but only at
    # process-boot time (src/app.ts's own check), which under
    # `Restart=on-failure` means `enable --now` below starts a unit that
    # immediately crash-loops (every ~2s) until .env is filled in, rather
    # than install.sh itself catching it up front. Warning here so that
    # noisy journald spam isn't the first sign something's missing. Names
    # the .env KEYS the operator would actually grep for
    # (MULLION_ENROLLMENT_TOKEN/MULLION_AGENT_TOKEN, written via the
    # printf appends above), not the install.sh-side input variable names.
    echo "WARNING: this agent has no complete credential path in the generated .env — neither MULLION_AGENT_TOKEN, nor both MULLION_PRIMARY_URL and MULLION_ENROLLMENT_TOKEN, are set. It will fail to boot at all (src/app.ts's fail-closed check) and crash-loop under systemd until one full path is configured. Set MULLION_AGENT_TOKEN, or both MULLION_AGENT_PRIMARY_URL and MULLION_AGENT_ENROLLMENT_TOKEN, before running this script, or edit \$MULLION_HOME/.env by hand." >&2
  fi
  # Hermes review, PR #529: this file holds the fleet-wide
  # MULLION_ENROLLMENT_TOKEN (or a per-agent MULLION_AGENT_TOKEN) — real
  # secrets, written with whatever the default umask happens to be
  # otherwise. Same restriction as the primary's .env above.
  chmod 600 "$MULLION_HOME/.env"
fi

echo "==> Installing the systemd --user unit"
mkdir -p ~/.config/systemd/user
if [ "$ROLE" = "primary" ]; then
  UNIT_NAME="mullion.service"
  UNIT_TEMPLATE="$SCRIPT_DIR/mullion.service"
  OTHER_UNIT_NAME="mullion-agent.service"
else
  UNIT_NAME="mullion-agent.service"
  UNIT_TEMPLATE="$SCRIPT_DIR/mullion-agent.service"
  OTHER_UNIT_NAME="mullion.service"
fi
sed \
  -e "s#^WorkingDirectory=.*#WorkingDirectory=$MULLION_HOME/current#" \
  -e "s#^ExecStart=.*#ExecStart=$NODE_PATH dist/server.js#" \
  -e "s#^EnvironmentFile=.*#EnvironmentFile=$MULLION_HOME/.env#" \
  "$UNIT_TEMPLATE" \
  > ~/.config/systemd/user/"$UNIT_NAME"

systemctl --user daemon-reload

# Hermes review, PR #529: enabling THIS role's unit never disabled the
# OTHER one on its own — a host that switched roles by hand-flipping .env
# and re-running this script (rather than starting fresh) could end up
# with both units enabled, both loading the same .env, and both binding
# the same PORT — a crash loop, not just a mismatch warning. Best-effort:
# the other unit may simply never have existed on this host, which is not
# an error. Done BEFORE `enable --now` below (Hermes review, PR #529,
# second round): stopping the old unit first means the new one starts
# clean, rather than colliding on PORT and crash-looping (self-healing
# either way under Restart=on-failure, but a clean transition is better).
if systemctl --user --quiet is-enabled "$OTHER_UNIT_NAME" 2>/dev/null ||
  systemctl --user --quiet is-active "$OTHER_UNIT_NAME" 2>/dev/null; then
  # Hermes review, PR #529 (fourth round): is-enabled alone misses a unit
  # started manually without ever being enabled (e.g. `systemctl --user
  # start mullion-agent.service` while testing) — it would still be
  # running and still PORT-collide, just outside what is-enabled reports.
  echo "==> Disabling $OTHER_UNIT_NAME (this host is now role: $ROLE)"
  # Hermes review, PR #529 (third round): `|| true` alone would silently
  # swallow a genuine failure here (the new unit would then start and
  # PORT-collide with the still-running old one) — surface it instead of
  # just continuing quietly. Still non-fatal: self-healing under
  # Restart=on-failure either way, and this is best-effort by design (see
  # above).
  systemctl --user disable --now "$OTHER_UNIT_NAME" ||
    echo "WARNING: failed to disable $OTHER_UNIT_NAME — it may still be running and could collide with $UNIT_NAME on PORT until stopped by hand (systemctl --user disable --now $OTHER_UNIT_NAME)." >&2
fi

systemctl --user enable --now "$UNIT_NAME"

echo "==> Done. Status:"
systemctl --user --no-pager status "$UNIT_NAME" || true

if [ "$ROLE" = "primary" ]; then
  cat <<EOF

Next steps (see deploy/README.md):
  - Point Traefik at this host (deploy/traefik-dynamic.yml).
  - Wire up your forwardAuth middleware (deploy/authentik-middleware-example.yml).
  - Check GET /health and /api/server-info once Traefik is routing.
EOF
else
  cat <<EOF

Next steps (see docs/multi-host.md):
  - If you used self-registration (Path 1 in $MULLION_HOME/.env), this
    agent should already be self-registering with the primary — check
    Settings -> Hosts on the primary for a new "enrolled" host, or watch
    this unit's logs: journalctl --user -u $UNIT_NAME -f
  - If you used a manual token (Path 2), register this host by hand on
    the primary: Settings -> Hosts -> Add host, with this host's reachable
    base URL and the MULLION_AGENT_TOKEN value from $MULLION_HOME/.env.
  - Check GET /health on this host once it's reachable from the primary.
EOF
fi
if [ "$MULLION_CLI_LINKED" = true ]; then
  cat <<EOF
  - The \`mullion\` CLI is linked at ~/.local/bin/mullion (docs/cli.md) —
    add ~/.local/bin to PATH if it isn't already.
EOF
fi
