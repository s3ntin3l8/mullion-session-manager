// Shared by every git-invoking call site (git-status.ts, git-refs.ts, and
// the git-fixture test helpers) rather than duplicated per file — a single
// source of truth for which GIT_* vars must never reach a `git` subprocess.
//
// git honors GIT_DIR/GIT_WORK_TREE/GIT_CONFIG_GLOBAL/etc. *before* it ever
// looks at `-C <cwd>` — if a process inherits one of these (e.g. from a git
// hook that spawned it without clearing its own hook-scoped environment;
// observed happening to `npm test` under pre-commit's pre-push stage), every
// call below would silently target whatever repo/config those vars point at
// instead of the caller's actual `cwd`, regardless of the explicit `-C`
// flag. Stripping them here is what makes `-C cwd` actually authoritative.
//
// GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / GIT_OBJECT_DIRECTORY /
// GIT_COMMON_DIR / GIT_PREFIX / GIT_CONFIG / GIT_CONFIG_GLOBAL /
// GIT_CONFIG_SYSTEM can all redirect a git invocation onto a different repo or
// config file than `cwd` implies. GIT_CONFIG is the legacy one: git 2.43 still
// honors it, so `GIT_CONFIG=<a>/.git/config git -C <b> config user.email x`
// writes into repo a, not b (issue #1649). GIT_CEILING_DIRECTORIES doesn't redirect anything — it only
// bounds parent-directory discovery — but is stripped too as harmless
// belt-and-suspenders against the same class of leaked-hook-env surprise.
//
// LC_ALL=C (Hermes review on PR #505): the same "ambient environment must
// not silently change git's output" concern as the GIT_* stripping above,
// for locale rather than repo targeting. `%(upstream:track)`'s "ahead N" /
// "behind N" / "gone" text (git-refs.ts's listBranches) is gettext-
// localized by git's own ref-filter.c — on a non-C-locale host those
// English-pattern regexes would silently stop matching, and separately
// git-branch-delete.ts's `/not fully merged/i` stderr classification has
// the identical latent exposure. CI's C locale never surfaces this, so pin
// it explicitly here rather than relying on the environment already
// happening to be C.
//
// Exported as a standalone list (not just baked into gitEnv() below) so
// session-env.ts's SERVER_ENV_KEYS can reuse it verbatim (see finding A7):
// the backend's own git subprocesses were always protected via gitEnv(),
// but a terminal session's shell — spawned by buildSessionEnv() — had no
// equivalent stripping, so a leaked GIT_DIR on the *server* process would
// still redirect every `git` command an agent runs inside a session. One
// shared source of truth closes that gap without duplicating the literal
// key list.
export const GIT_ENV_KEYS_TO_STRIP = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_OBJECT_DIRECTORY",
  "GIT_COMMON_DIR",
  "GIT_PREFIX",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
] as const;

/**
 * The carrier of the env form of `-c <key>=<value>`: `GIT_CONFIG_COUNT` plus
 * numbered `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` pairs. git reads only
 * indices 0..COUNT-1, so removing COUNT disables the whole mechanism — which is
 * what we want for the same reason GIT_CONFIG is stripped: an ambient pair
 * could otherwise add config to every git command Mullion runs (`core.bare=true`
 * would be the #1602 hazard all over again).
 *
 * Deliberately NOT in {@link GIT_ENV_KEYS_TO_STRIP}: that list's contract is
 * "these keys must be ABSENT", and the session env deliberately SETS this one
 * (see session-env.ts's GIT_CONFIG_NO_AUTO_GC_ENV). It is removed explicitly
 * instead, and test/scripts/git-env.test.ts checks the two copies agree.
 */
export const GIT_CONFIG_COUNT_KEY = "GIT_CONFIG_COUNT";

/**
 * `-c gc.auto=0` — issue #1851.
 *
 * git asks "while I'm here, should I tidy up this repo?" after some
 * porcelain commands, and sometimes the answer is yes: a background
 * `git gc --auto` starts and can delete a loose object that a CONCURRENT
 * write is creating. The damage surfaces far from the cause — a commit
 * that cannot complete, naming a *missing* object rather than a corrupt
 * one (see #1836 for the full story).
 *
 * This answers "no" for that one command. It writes NOTHING: not the
 * repo's config, not the global config, not the user's. Their own git
 * still tidies up exactly as it does today.
 *
 * Applied to EVERY git invocation Mullion makes, so the invariant is
 * "Mullion never triggers an auto-gc in any repo it touches" holds by
 * construction — including call sites added later. test/git-env-guard.test.ts
 * enforces it the same way it enforces the gitEnv() rule.
 *
 * `-c` is a git GLOBAL option, so it goes before the subcommand and
 * composes with `-C <cwd>` in either order.
 */
export const GIT_NO_AUTO_GC = ["-c", "gc.auto=0"] as const;

/**
 * The git identity Mullion stamps on commits it or its sessions make
 * (`settings.sessions.gitIdentity`, overridable per project). Both fields
 * are always set together: git refuses to guess half an identity.
 */
export interface GitIdentity {
  name: string;
  email: string;
}

/**
 * `-c user.name=… -c user.email=…` for a git commit Mullion makes itself
 * (git-worktree.ts's salvage commit). Command scope, like GIT_NO_AUTO_GC: it
 * overrides system/global/repo config for that one invocation and writes
 * nothing. `[]` when no identity is configured — today's behavior.
 */
export function gitIdentityArgs(identity: GitIdentity | undefined): string[] {
  if (!identity) return [];
  return ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`];
}

/** The same identity as environment overrides, for a commit Mullion makes itself. */
export function gitIdentityEnv(identity: GitIdentity): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}

export function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of GIT_ENV_KEYS_TO_STRIP) {
    delete env[key];
  }
  delete env[GIT_CONFIG_COUNT_KEY];
  env.LC_ALL = "C";
  return env;
}
