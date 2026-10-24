/**
 * The `LaunchPlanSession` fixture shared by the launch-plan tests and by any
 * other test that needs to assert on what `buildLaunchPlan` puts in a
 * session's env.
 *
 * It is a separate module (not a helper inside one test file) so that a test
 * in ANOTHER file can build a session the same way, and so the shape is
 * written down in exactly one place.
 *
 * `baseSession` is typed as `LaunchPlanSession`, which is what keeps the
 * fixture honest ABOUT ITS INTENT — but it is not a compiler guarantee
 * today: the repo's `tsconfig.json` covers `src/` alone, so the test tree is
 * NOT type-checked by `npm run typecheck`. The annotation documents the
 * required shape (a field the interface gains shows up as a missing key in
 * this file, for whoever next type-checks the test tree) rather than failing
 * the build. Writing the fixture inline in a test file is how the mcode
 * adapter's test ended up omitting ten required fields in the first place.
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
