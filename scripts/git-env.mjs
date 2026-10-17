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

export function gitEnv() {
  const env = { ...process.env };
  for (const key of GIT_ENV_KEYS_TO_STRIP) {
    delete env[key];
  }
  env.LC_ALL = "C";
  return env;
}
