// The per-session environment a Mullion-hosted session injects that is NOT an
// env-schema key (the schema keys are scrubbed by test/setup.ts from
// `schema.properties`). A suite run from inside a hosted session inherits all
// of these, so test/setup.ts deletes them before any test file runs (issue
// #2112).
//
// No src/ imports on purpose: test/setup.ts imports this, and a setup file that
// pulls in src/ loads node:child_process before a test's own vi.mock applies.
// test/helpers/session-runtime-env.test.ts keeps this list in step with
// src/services/session-env.ts.
export const SESSION_RUNTIME_ENV_KEYS: readonly string[] = [
  "MULLION_HOOK_SOCKET",
  "MULLION_HOOK_TOKEN",
  "MULLION_SESSION_ID",
  "MULLION_CONTROL_UNAVAILABLE",
  "MULLION_FORWARDER_PATH",
  "MULLION_FORWARDER_NODE",
  "MULLION_WORKTREES_IN_DOT_WT",
  "MULLION_OPENCODE_INSTRUCTIONS",
  "OPENCODE_CONFIG_CONTENT",
];
