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
// SHELL, TERM, LOG_LEVEL, and friends.
// MULLION_HOOK_SOCKET/MULLION_HOOK_TOKEN (Phase 2, issue #172) are injected
// into a session's env deliberately, per-session, *after* buildSessionEnv()
// returns — see pty-manager.ts's bootstrapMaster(). They're listed here too
// so a *nested* Mullion (a `make dev` run from inside a session that itself
// has hooks enabled) doesn't inherit the outer session's socket path/token
// and mistake it for its own: the same env-leak class buildSessionEnv()
// exists to prevent for every other Mullion-owned config key.
// ZDOTDIR/MULLION_USER_ZDOTDIR (issue: sidebar worktree display,
// shell-integration.ts's applyShellIntegrationEnv) are deliberately absent
// from this list even though they're Mullion-owned: unlike every key below,
// a nested Mullion's own sessions don't need them stripped, because
// applyShellIntegrationEnv unconditionally OVERWRITES both for every
// session it instruments, regardless of whatever value it inherited — so a
// leaked value here is immediately clobbered, never actually used.
export const SERVER_ENV_KEYS = [
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
  "NODE_ENV",
] as const;

/**
 * Returns a copy of `base` (defaults to `process.env`) with every
 * Mullion-owned config key in {@link SERVER_ENV_KEYS} removed, and
 * `COLORTERM` forced to `truecolor`. Use this instead of passing
 * `process.env` directly whenever spawning a terminal session's shell — see
 * pty-manager.ts.
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
  return env;
}
