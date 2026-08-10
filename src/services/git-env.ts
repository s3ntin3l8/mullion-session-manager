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
// GIT_COMMON_DIR / GIT_PREFIX / GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM can all
// redirect a git invocation onto a different repo or config file than `cwd`
// implies. GIT_CEILING_DIRECTORIES doesn't redirect anything — it only
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
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
] as const;

export function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of GIT_ENV_KEYS_TO_STRIP) {
    delete env[key];
  }
  env.LC_ALL = "C";
  return env;
}
