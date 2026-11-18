// Detected shell/agent CLI shapes, split out of types.ts (re-exported from there).

export type CodexHookTrust = "trusted" | "pending" | "not-installed";

export interface Agent {
  id: string;
  title: string;
  command: string;
  kind: "shell" | "agent";
  available: boolean;
  path: string | null;
  /** Set when "not found" cannot be trusted (the probe timed out or failed, or
   * ran on an unverified PATH): `available: false` then means "could not be
   * checked", not "not installed". Mirrors DetectedAgent.probeError. */
  probeError?: "timeout" | "error";
  /** Codex's `/hooks` trust status for Mullion's merged hooks (issue #259).
   * Only present on the "codex" agent. */
  hookTrust?: CodexHookTrust;
  /** opencode only (issue #1593): its reported x.y.z, and a warning when too old for Mullion. */
  version?: string;
  versionWarning?: string;
  /** Rich statuses (issue: extend surfaced session statuses) — the
   * hook-protocol `kind`s this agent's launch can ever produce (mirrors
   * src/services/agent-detect.ts's DetectedAgent.emits 1:1). Empty for
   * shells and for any agent with no hook adapter at all — those reach only
   * the byte-heuristic working/idle/needs_input/exited states. Drives
   * sessionStatus.ts's capability filtering so the UI never offers a status
   * legend entry/filter a given agent can never reach. */
  emits: string[];
}
