/**
 * The `LaunchPlanSession` fixture shared by the launch-plan tests and by any
 * other test that needs to assert on what `buildLaunchPlan` puts in a
 * session's env.
 *
 * It is a separate module (not a helper inside one test file) so that a test
 * in ANOTHER file can build a session the same way — and so that the fixture
 * stays in step with the `LaunchPlanSession` interface: `baseSession` is
 * typed as `LaunchPlanSession`, so a field the interface gains later breaks
 * the COMPILER here rather than silently turning into `undefined` at runtime.
 *
 * (The test tree is not covered by the repo's `tsconfig.json` — it covers
 * `src/` alone — so this file is not type-checked by `npm run typecheck`.
 * It is still the single place the shape is written down.)
 */

import type { LaunchPlanSession } from "../../src/services/launch-plan.js";

/** A complete `LaunchPlanSession`, with the given overrides applied. */
export function baseSession(overrides: Partial<LaunchPlanSession> = {}): LaunchPlanSession {
  return {
    id: "42",
    cwd: "/tmp/project",
    command: "bash",
    socketPath: "/tmp/sessions/42.sock",
    hookToken: "test-hook-token",
    hookSocketPath: "/tmp/sessions/hooks.sock",
    controlSocketPath: "/tmp/sessions/mullion.sock",
    sessionsDir: "/tmp/sessions",
    sshAuthSock: "",
    authEnabled: false,
    env: {},
    injectAgentGuide: true,
    injectProjectBriefing: true,
    injectMullionBundle: true,
    skipPermissions: false,
    initialPrompt: undefined,
    seedPrompt: undefined,
    resumeAgentSessionId: undefined,
    briefingOverride: undefined,
    workflowConventionsText: undefined,
    projectSkill: undefined,
    projectReviewerAgent: undefined,
    model: undefined,
    smallModel: undefined,
    taskId: undefined,
    ...overrides,
  };
}
