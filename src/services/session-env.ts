import { GIT_ENV_KEYS_TO_STRIP } from "./git-env.js";

// Mullion-owned config keys (see src/plugins/env.ts's schema) that must
// never bleed from the server process into a spawned terminal session.
//
// Why this exists (issue #70): a terminal session run inside Mullion
// inherits the *entire* server environment through the dtach/systemd-run
// process chain. If a developer starts a second Mullion (e.g. `make dev`)
// from within such a session, it would otherwise silently inherit the
// running server's PORT, and worse, its DATABASE_URL/SESSIONS_DIR — pointing
// a "dev" instance at a production install's live DB and dtach sockets
// instead of its own. Stripping these before spawn means every session
// starts from a clean slate and only ever reads its own .env + schema
// defaults for these keys.
//
// NODE_ENV is included even though it's a generic Node/npm convention, not a
// Mullion-specific key: a session inheriting the server's NODE_ENV=production
// makes `npm install`/`npm ci` run inside that session skip devDependencies
// (vitest, eslint, tsx, ...) — breaking the exact "run a dev checkout from a
// terminal inside prod Mullion" workflow issue #70 is about. Verified
// present on this host (prod's systemd EnvironmentFile sets it).
//
// Deliberately NOT stripped: generic vars a child program may legitimately
// rely on regardless of which Mullion process started it — PATH, HOME,
// SHELL, LOG_LEVEL, and friends. TERM is the one exception: it isn't
// stripped either, but buildSessionEnv() below unconditionally *overwrites*
// it (same treatment as COLORTERM) rather than passing through whatever the
// server process happened to inherit — see the TERM comment below for why.
// MULLION_HOOK_SOCKET/MULLION_HOOK_TOKEN (Phase 2, issue #172) and
// MULLION_SOCKET_PATH/MULLION_SESSION_ID (Phase 4, #134) are injected
// into a session's env deliberately, per-session, *after* buildSessionEnv()
// returns — see pty-manager.ts's bootstrapMaster(). They're listed here too
// so a *nested* Mullion (a `make dev` run from inside a session that itself
// has hooks/the control socket enabled) doesn't inherit the outer session's
// socket path(s)/token/id and mistake them for its own: the same env-leak
// class buildSessionEnv() exists to prevent for every other Mullion-owned
// config key.
// MULLION_SSH_AUTH_SOCK (the config key that names the path launch-plan.ts
// injects as SSH_AUTH_SOCK) is stripped for the same nested-Mullion reason as
// every other key in this list. SSH_AUTH_SOCK itself is deliberately NOT
// stripped here — grouped with the PATH/HOME/SHELL passthrough two
// paragraphs up, NOT with TERM/COLORTERM below (those are the opposite
// treatment: unconditionally overwritten regardless of what's inherited).
// launch-plan.ts overwrites SSH_AUTH_SOCK when MULLION_SSH_AUTH_SOCK is
// configured; when it's not, whatever this host's systemd --user manager (or
// PAM, or a desktop keyring) already exports as SSH_AUTH_SOCK passes straight
// through unexamined — this feature being "off" does not mean a session gets
// no SSH_AUTH_SOCK, only that this feature isn't the one supplying it.
// ZDOTDIR/MULLION_USER_ZDOTDIR (issue: sidebar worktree display,
// shell-integration.ts's applyShellIntegrationEnv) are deliberately absent
// from this list even though they're Mullion-owned: unlike every key below,
// a nested Mullion's own sessions don't need them stripped, because
// applyShellIntegrationEnv unconditionally OVERWRITES both for every
// session it instruments, regardless of whatever value it inherited — so a
// leaked value here is immediately clobbered, never actually used.
//
// GIT_* keys (finding A7): git-env.ts's gitEnv() exists precisely because a
// leaked GIT_DIR/GIT_INDEX_FILE from a git hook made every `git -C <cwd>`
// silently target the wrong repo — a real incident this repo hit. Every
// backend git subprocess routes through gitEnv() and is protected. But a
// terminal session's shell is spawned via buildSessionEnv(), not gitEnv() —
// if the Mullion *server* process itself was ever started with one of these
// leaked (exactly how the original incident happened), every git command an
// AGENT runs inside every session (git commit, git worktree add, git reset
// --hard) would silently target the wrong repo, even though the backend's
// own git calls stayed correct. Reusing GIT_ENV_KEYS_TO_STRIP rather than
// re-listing the same nine keys here keeps the two lists from drifting.
export const SERVER_ENV_KEYS = [
  ...GIT_ENV_KEYS_TO_STRIP,
  "PORT",
  "DATABASE_URL",
  "SESSIONS_DIR",
  "DB_ENCRYPTION_KEY",
  "CORS_ORIGIN",
  "RATE_LIMIT_MAX",
  "RATE_LIMIT_WINDOW",
  "FRONTEND_DIST",
  "PROJECTS_ROOTS",
  "CRS_CONFIG_DIR",
  "GITHUB_OAUTH_CLIENT_ID",
  "PREVIEW_BASE_HOST",
  "MULLION_ROLE",
  "MULLION_AGENT_TOKEN",
  "MULLION_PRIMARY_URL",
  "MULLION_ENROLLMENT_TOKEN",
  "MULLION_AGENT_ADVERTISE_URL",
  "MULLION_AGENT_NAME",
  "MULLION_ENROLLMENT_SECRET",
  "MULLION_ENROLLMENT_ALLOWED_CIDRS",
  "MULLION_AUTH_TOKEN",
  "MULLION_SESSION_SECRET",
  "MULLION_OIDC_ISSUER",
  "MULLION_OIDC_CLIENT_ID",
  "MULLION_OIDC_CLIENT_SECRET",
  "MULLION_OIDC_REDIRECT_URI",
  "MULLION_HOME",
  "MULLION_UPDATE_REPO",
  "MULLION_HOOK_SOCKET",
  "MULLION_HOOK_TOKEN",
  "MULLION_SOCKET_PATH",
  "MULLION_SSH_AUTH_SOCK",
  "MULLION_SESSION_ID",
  "NODE_ENV",
  // OPENCODE_CONFIG_CONTENT is a per-session injection Mullion sets on the
  // env of a spawned opencode session (hook-adapters/opencode.ts's
  // prepareLaunch, applied AFTER buildSessionEnv() returns — so listing it
  // here never clobbers the intended per-session value). It must be stripped
  // from the inherited environment for the same nested-Mullion reason as the
  // MULLION_* keys just above: when Mullion itself runs inside a Mullion-
  // managed session (e.g. `make dev` from a terminal inside prod Mullion, the
  // exact issue #70 scenario), the server process carries the OUTER session's
  // OPENCODE_CONFIG_CONTENT, and every session it spawns would otherwise
  // inherit that stale agent-guide pointer instead of getting its own. The
  // opencode test in test/services/pty-manager.test.ts exercises this gate
  // (omits OPENCODE_CONFIG_CONTENT when getInjectAgentGuide is off) and only
  // fails on a host where a live Mullion has the var in its own env.
  "OPENCODE_CONFIG_CONTENT",
] as const;

/**
 * Returns a copy of `base` (defaults to `process.env`) with every
 * Mullion-owned config key in {@link SERVER_ENV_KEYS} removed, `COLORTERM`
 * forced to `truecolor`, and `TERM` forced to `xterm-256color`. Use this
 * instead of passing `process.env` directly whenever spawning a terminal
 * session's shell — see pty-manager.ts.
 */
export function buildSessionEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of SERVER_ENV_KEYS) {
    delete env[key];
  }
  // Issue #91: pty-manager.ts spawns every session with TERM=xterm-256color
  // (node-pty's `name` option) but nothing ever set COLORTERM, so a session
  // only ever advertised 256-color support even though xterm.js can render
  // full 24-bit truecolor. A real terminal emulator sets this for any shell
  // it spawns; do the same here rather than passing through whatever (if
  // anything) happened to be in the inherited env.
  env.COLORTERM = "truecolor";
  // Issue #305: node-pty's `name: "xterm-256color"` (pty-manager.ts's
  // attachClient()) only sets TERM for the `dtach -a` attach-proxy process —
  // it has no effect on the actual session shell, which is spawned earlier
  // and separately by bootstrapMaster() using this env. That shell therefore
  // inherited whatever TERM (if any) the Mullion server process itself had,
  // which is unset when running as a systemd --user service. The combination
  // of no TERM + COLORTERM=truecolor is non-standard and defeats TERM-based
  // color-capability detection in some CLIs (confirmed: agy/Antigravity CLI's
  // embedded charmbracelet/colorprofile falls back to no color when it sees
  // TERM=""). Every session's terminal is always xterm.js on the other end
  // of the WebSocket regardless of what the server process inherited, so
  // force this the same way COLORTERM is forced above rather than passing
  // through the server's own (possibly absent) TERM.
  env.TERM = "xterm-256color";
  return env;
}
