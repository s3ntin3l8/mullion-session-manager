import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// Injects an OSC 7 ("here is my current working directory") announcement
// into a session's interactive shell — issue: sidebar worktree display.
// Without this, PtyManager's Session.liveCwd (see attention-detect.ts's
// detectCwdChange) never updates: a shell never emits OSC 7 on its own, only
// when a shell-integration hook tells it to, the same mechanism VS Code's
// own terminal shell integration and tools like starship/direnv rely on.
//
// Only zsh (this host's default $SHELL, and the shell every launcher config
// in this repo assumes — see agent-detect.ts's KNOWN_SHELLS) is properly
// instrumented, via the ZDOTDIR shim below. bash gets a best-effort
// PROMPT_COMMAND injection with a known limitation (see
// applyShellIntegrationEnv's doc comment). Any other $SHELL (fish, sh,
// tcsh, ...) gets no injection at all — Session.liveCwd simply stays null
// for it, the same "nothing to show" fallback as a session whose shell
// suppresses/never draws a prompt.

const OSC7_ZSH_HOOK = `
# Mullion shell integration (issue: sidebar worktree display) — announces
# this shell's cwd on every prompt draw so the sidebar can show which git
# worktree (if any) this session is actually in. Appended after the user's
# own .zshrc is sourced above, not prepended, so a "precmd_functions" array
# the user's own config already populated isn't clobbered by an assignment
# ahead of it.
_mullion_osc7_precmd() { printf '\\033]7;file://%s%s\\033\\\\' "$HOST" "$PWD"; }
autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook precmd _mullion_osc7_precmd || precmd_functions+=(_mullion_osc7_precmd)
`;

// `.zshrc`'s content is special, unlike the other three shim files below:
// it restores `ZDOTDIR` to the user's real dotfiles directory BEFORE
// sourcing their real `.zshrc`, rather than just sourcing it in place. This
// is the ONE shim file safe to do that in — it's only ever read by the
// interactive shell, and only AFTER zsh has already committed (at file-open
// time) to reading `.zshrc` from the CURRENT `$ZDOTDIR` (this shim
// directory); restoring afterward only changes the shell's OWN `$ZDOTDIR`
// value from that point on, which is exactly what a user's real `.zshrc`
// (or anything it sources, e.g. `source "$ZDOTDIR/plugin.zsh"`) expects to
// see — leaving it pointed at the shim dir for the shell's whole lifetime
// would be a real, silent regression to any config that reads `$ZDOTDIR`.
// Restoring this early, in `.zshenv`/`.zprofile`/`.zlogin` instead, would be
// wrong: those run BEFORE zsh decides where to look for `.zshrc`, so an
// early restore there would point that lookup at the user's real
// directory — which knows nothing about this shim's OSC7 hook below,
// silently dropping it.
function zshrcContent(): string {
  return (
    'export ZDOTDIR="$MULLION_USER_ZDOTDIR"\n' +
    '[ -f "$ZDOTDIR/.zshrc" ] && source "$ZDOTDIR/.zshrc"\n' +
    OSC7_ZSH_HOOK
  );
}

// Bash has no ZDOTDIR equivalent (no single env var that relocates which
// rcfile an interactive shell reads), so this is injected via PROMPT_COMMAND
// instead — appended to, not overwriting, whatever this session's env
// already carries. Known limitation, not attempted to work around: a
// bashrc that itself does `PROMPT_COMMAND="..."` (a plain assignment,
// common in prompt frameworks like starship's `bash` init) overwrites this
// rather than appending to it, silently losing the announcement — same
// "some configurations just won't report a live cwd" posture as this file's
// other gaps.
const OSC7_BASH_SNIPPET = 'printf \'\\033]7;file://%s%s\\033\\\\\' "$HOSTNAME" "$PWD"';

/** Sources `$MULLION_USER_ZDOTDIR/<file>` if present, guarded so a user with
 * no such dotfile at all doesn't get a "no such file" error on shell start. */
function sourceUserDotfile(file: string): string {
  return `[ -f "$MULLION_USER_ZDOTDIR/${file}" ] && source "$MULLION_USER_ZDOTDIR/${file}"\n`;
}

/**
 * Writes the four zsh ZDOTDIR shim files under `<sessionsDir>/shell-
 * integration/zsh/`. Idempotent and cheap (a handful of small text files) —
 * called once per PtyManager construction, not per session, and simply
 * overwrites on every call so an upgraded Mullion's shim content is always
 * current rather than stuck on whatever version first wrote the directory.
 *
 * All FOUR startup files are shimmed, not just `.zshrc` — this is required,
 * not a stylistic choice. `ZDOTDIR` points at this shim directory from spawn
 * (see applyShellIntegrationEnv below) until `.zshrc` restores it (see
 * `zshrcContent`'s doc comment for why only there), so EVERY zsh startup-file
 * lookup up to that point — the outer login/non-interactive wrapper
 * (`zsh -lc "..."`, which reads `.zshenv`/`.zprofile`/`.zlogin`) and the
 * inner interactive shell it execs (which reads `.zshenv` then `.zshrc`) —
 * resolves here. A shim covering only `.zshrc` would leave the outer shell's
 * `.zshenv`/`.zprofile`/`.zlogin` lookup pointed at an empty directory,
 * silently dropping whatever PATH/env setup the user keeps in those files.
 */
export function ensureShellIntegrationFiles(sessionsDir: string): string {
  const zdotdir = path.join(sessionsDir, "shell-integration", "zsh");
  mkdirSync(zdotdir, { recursive: true });
  writeFileSync(path.join(zdotdir, ".zshenv"), sourceUserDotfile(".zshenv"));
  writeFileSync(path.join(zdotdir, ".zprofile"), sourceUserDotfile(".zprofile"));
  writeFileSync(path.join(zdotdir, ".zlogin"), sourceUserDotfile(".zlogin"));
  writeFileSync(path.join(zdotdir, ".zshrc"), zshrcContent());
  return zdotdir;
}

/**
 * Mutates `env` in place to inject the OSC 7 shell-integration hook for
 * `shell` (the session's `$SHELL`, e.g. "/bin/zsh" or "zsh") — a no-op for
 * any shell this doesn't know how to instrument (see this file's own doc
 * comment). Must be called AFTER `env.HOME` is already set to the real
 * value (buildSessionEnv/session-env.ts doesn't strip it) — `MULLION_USER_
 * ZDOTDIR` captures whatever `env.ZDOTDIR` already pointed at (or falls
 * back to `env.HOME`) BEFORE this overwrites `env.ZDOTDIR` with the shim
 * directory, since that capture is what every shim file (ensureShellIntegrationFiles
 * above) uses to still reach the user's own real dotfiles.
 */
export function applyShellIntegrationEnv(
  shell: string,
  env: NodeJS.ProcessEnv,
  sessionsDir: string,
): void {
  const shellName = path.basename(shell);
  if (shellName === "zsh") {
    env.MULLION_USER_ZDOTDIR = env.ZDOTDIR || env.HOME || "";
    env.ZDOTDIR = ensureShellIntegrationFiles(sessionsDir);
  } else if (shellName === "bash") {
    env.PROMPT_COMMAND = env.PROMPT_COMMAND
      ? `${env.PROMPT_COMMAND}; ${OSC7_BASH_SNIPPET}`
      : OSC7_BASH_SNIPPET;
  }
}
