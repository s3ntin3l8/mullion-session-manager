// #741 — the agent pickers shared by LaunchersSection's "Default agent" and
// TaskMasterSection's Task Master agent defaults. Extracted out of
// LaunchersSection (where it was a module-local const) once a second
// consumer appeared, so the two dropdowns can't drift apart. Values are bare
// KNOWN_AGENTS names (agent-detect.ts), the same shape settings/
// projects.defaultAgent store.
export const AGENT_OPTIONS = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "opencode", label: "opencode" },
  // Rich statuses (issue: extend surfaced session statuses) — was missing
  // entirely, so agy could never be picked as the launcher's default agent
  // even though agent-detect.ts's KNOWN_AGENTS and its own hook adapter have
  // supported it since PR #301.
  { value: "agy", label: "Antigravity" },
  // Issue: mcode support — MiniMax Code's CLI binary is `mcode`, and it has
  // its own hook adapter (hook-adapters/mcode.ts), so it reaches the same
  // hook-confirmed statuses the other instrumented agents do.
  { value: "mcode", label: "MiniMax Code" },
];

// Review-agent pickers additionally offer "none" — the explicit "no review
// agent, human reviews directly" value settings.taskMaster.defaultReviewAgent
// defaults to.
export const REVIEW_AGENT_OPTIONS = [{ value: "none", label: "None" }, ...AGENT_OPTIONS];

// The Hermes reviewer is not a local CLI: it is an HTTP run on the review
// relay's Hermes connection, so it is only offered when Task Master reviews
// are switched on there and the connection has a URL. A stored "hermes" value
// stays readable when this goes false (see withCurrentReviewAgent).
export const HERMES_REVIEW_OPTION = { value: "hermes", label: "Hermes" };

export function hermesReviewerAvailable(
  relay: { provider: string; apiUrl: string; taskMasterReviewer: boolean } | undefined,
): boolean {
  return !!relay && relay.taskMasterReviewer && relay.provider === "hermes" && relay.apiUrl !== "";
}

export function reviewAgentOptions(hermesAvailable: boolean) {
  return hermesAvailable ? [...REVIEW_AGENT_OPTIONS, HERMES_REVIEW_OPTION] : REVIEW_AGENT_OPTIONS;
}

// Keep a stored review-agent value in the list so the control renders it
// instead of falling back to the first option. "hermes" gets its own label
// since it is never "not detected".
export function withCurrentReviewAgent(
  options: { value: string; label: string }[],
  current: string | null | undefined,
): { value: string; label: string }[] {
  if (!current || options.some((o) => o.value === current)) return options;
  return [
    ...options,
    {
      value: current,
      label:
        current === "hermes" ? "Hermes (Task Master reviews off)" : `${current} (not detected)`,
    },
  ];
}
