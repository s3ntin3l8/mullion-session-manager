// Plain-JS twin of src/services/git-env.ts for node scripts, which can't
// import the TypeScript source. src/services/git-env.ts is the source of
// truth for the key list; test/scripts/git-env.test.ts fails if the two drift.
// See that file for why each key is stripped (a hook-leaked GIT_DIR/GIT_CONFIG
// would otherwise redirect `git -C <cwd>` onto another repo's config — #1602,
// #1649).
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
];

// The carrier of the env form of `-c <key>=<value>` — see
// src/services/git-env.ts's comment. It is removed explicitly rather than
// through GIT_ENV_KEYS_TO_STRIP, because the session env deliberately SETS it.
export const GIT_CONFIG_COUNT_KEY = "GIT_CONFIG_COUNT";

// Plain-JS twin of src/services/git-env.ts's GIT_NO_AUTO_GC — the same
// override, the same reason. See that file's comment for why a fetch's
// background gc can eat a concurrent write (issue #1851, #1836).
//
// test/scripts/git-env.test.ts fails if the two drift.
export const GIT_NO_AUTO_GC = ["-c", "gc.auto=0"];

export function gitEnv() {
  const env = { ...process.env };
  for (const key of GIT_ENV_KEYS_TO_STRIP) {
    delete env[key];
  }
  delete env[GIT_CONFIG_COUNT_KEY];
  env.LC_ALL = "C";
  return env;
}
