// #741 — the agent pickers shared by LaunchersSection's "Default agent" and
// TaskMasterSection's Task Master agent defaults. Extracted out of
// LaunchersSection (where it was a module-local const) once a second
// consumer appeared, so the two dropdowns can't drift apart. Values are bare
// KNOWN_AGENTS names (agent-detect.ts), the same shape settings/
// projects.defaultAgent store.
export const AGENT_OPTIONS = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "codex" },
  { value: "opencode", label: "opencode" },
  // Rich statuses (issue: extend surfaced session statuses) — was missing
  // entirely, so agy could never be picked as the launcher's default agent
  // even though agent-detect.ts's KNOWN_AGENTS and its own hook adapter have
  // supported it since PR #301.
  { value: "agy", label: "agy" },
];

// Review-agent pickers additionally offer "none" — the explicit "no review
// agent, human reviews directly" value settings.taskMaster.defaultReviewAgent
// defaults to.
export const REVIEW_AGENT_OPTIONS = [{ value: "none", label: "None" }, ...AGENT_OPTIONS];
