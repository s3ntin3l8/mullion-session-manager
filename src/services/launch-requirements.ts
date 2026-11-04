import type { AgentLaunchOption } from "../shared/agent-protocol.js";

/**
 * The launch options a spawn REQUIRES of its host (issue #2569): every field
 * that would change the session's behaviour if the agent ignored it. An
 * agent's spawn schema strips a field it does not list, so each name here must
 * be one the target host negotiated (`requireLaunchOptions`) before the launch
 * has any side effect.
 *
 * A field at its default is not required: an unset `model` or `false`
 * `skipPermissions` behaves the same on a host that ignores the field. An
 * injection flag is required only when `false`, because an old agent's own
 * fallback is `true` (the same reasoning as the echo check in
 * session-lifecycle.ts).
 */
export interface LaunchFields {
  skipPermissions?: boolean;
  initialPrompt?: string;
  seedPrompt?: string;
  env?: Record<string, string>;
  briefingOverride?: string;
  workflowConventionsText?: string;
  projectSkill?: string;
  projectReviewerAgent?: string;
  injectAgentGuide?: boolean;
  injectProjectBriefing?: boolean;
  injectMullionBundle?: boolean;
  model?: string;
  smallModel?: string;
  taskId?: number | string;
  githubAuth?: unknown;
  gitIdentity?: unknown;
}

export function requiredLaunchOptions(fields: LaunchFields): AgentLaunchOption[] {
  const out: AgentLaunchOption[] = [];
  const add = (set: boolean, option: AgentLaunchOption) => {
    if (set) out.push(option);
  };
  add(fields.skipPermissions === true, "skipPermissions");
  add(fields.initialPrompt !== undefined, "initialPrompt");
  add(fields.seedPrompt !== undefined, "seedPrompt");
  add(fields.env !== undefined && Object.keys(fields.env).length > 0, "env");
  add(fields.briefingOverride !== undefined, "briefingOverride");
  add(fields.workflowConventionsText !== undefined, "workflowConventionsText");
  add(fields.projectSkill !== undefined, "projectSkill");
  add(fields.projectReviewerAgent !== undefined, "projectReviewerAgent");
  add(fields.injectAgentGuide === false, "injectAgentGuide");
  add(fields.injectProjectBriefing === false, "injectProjectBriefing");
  add(fields.injectMullionBundle === false, "injectMullionBundle");
  add(fields.model !== undefined, "model");
  add(fields.smallModel !== undefined, "smallModel");
  add(fields.taskId !== undefined, "taskId");
  add(fields.githubAuth !== undefined, "githubAuth");
  add(fields.gitIdentity !== undefined, "gitIdentity");
  return out;
}
