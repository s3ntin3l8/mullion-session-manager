// The agent protocol registry (issue #2248): the ONE place that names what a
// Mullion agent can be asked to do. The agent's `GET /internal/protocol`
// answers from it and the primary's support checks read it, so neither side
// keeps a list of its own that can drift.
//
// This is independent of the release version: two hosts on different releases
// are compatible while the primary's range includes the agent's
// `protocolVersion`, and what an agent supports is what it advertises, not
// what its version string implies.

/** The protocol revision this build speaks (bump on a breaking wire change). */
export const PROTOCOL_VERSION = 1;

/** The inclusive range of agent `protocolVersion`s this build can drive. */
export const SUPPORTED_PROTOCOL_RANGE = { min: 1, max: 1 } as const;

/**
 * Operations an agent can perform, by route family. Add a name when a family
 * of `/internal/*` routes is introduced; never reuse one for a new meaning.
 */
export const AGENT_OPERATIONS = [
  "sessions",
  "session-control",
  "session-transcript",
  "git",
  "git-worktrees",
  "project-files",
  "project-discovery",
  "skills",
  "agent-rules",
  "dock",
  "previews",
  "browser",
  "uploads",
  "updates",
  "capacity",
  "capabilities",
  "agent-detect",
  "setup",
  "scaffold",
  "bundle-sync",
  "terminal-palette",
  // Issue #2451: the agent serves request/response operations over its OUTBOUND
  // channel (src/shared/agent-channel.ts). A support flag for the transport,
  // not a route family.
  "channel-requests",
] as const;
export type AgentOperation = (typeof AGENT_OPERATIONS)[number];

/**
 * Optional fields of the agent's spawn body (`POST /internal/sessions`). An old
 * agent's `additionalProperties: false` schema silently strips a field it
 * does not know, so the primary must know before sending one.
 */
export const AGENT_LAUNCH_OPTIONS = [
  "skipPermissions",
  "initialPrompt",
  "seedPrompt",
  "projectId",
  "env",
  "briefingOverride",
  "workflowConventionsText",
  "projectSkill",
  "projectReviewerAgent",
  "injectAgentGuide",
  "injectProjectBriefing",
  "injectMullionBundle",
  "model",
  "smallModel",
  "taskId",
  "githubAuth",
  "gitIdentity",
] as const;
export type AgentLaunchOption = (typeof AGENT_LAUNCH_OPTIONS)[number];

export interface AgentProtocolInfo {
  protocolVersion: number;
  operations: string[];
  launchOptions: string[];
}

/** What this build advertises on `GET /internal/protocol`. */
export function localProtocolInfo(): AgentProtocolInfo {
  return {
    protocolVersion: PROTOCOL_VERSION,
    operations: [...AGENT_OPERATIONS],
    launchOptions: [...AGENT_LAUNCH_OPTIONS],
  };
}

const LATE_OPERATIONS: ReadonlySet<string> = new Set([
  "agent-detect",
  "capabilities",
  "updates",
  "channel-requests",
]);

/**
 * What an agent that predates the handshake (404 on `/internal/protocol`) is
 * assumed to support: the operations and launch options that existed before it.
 * Frozen — new registry entries are NOT added here, so a legacy host reads as
 * lacking them.
 */
export const LEGACY_BASELINE: Readonly<AgentProtocolInfo> = Object.freeze({
  protocolVersion: 0,
  // Routes added after the first agent builds, each one already known to 404
  // on an old agent elsewhere in the primary (#2240, #2306, #647).
  operations: Object.freeze(
    AGENT_OPERATIONS.filter((op) => !LATE_OPERATIONS.has(op)),
  ) as unknown as string[],
  launchOptions: Object.freeze([
    "skipPermissions",
    "initialPrompt",
    "seedPrompt",
    "projectId",
    "env",
  ]) as unknown as string[],
});

/** True when `protocolVersion` is inside the range this build can drive. */
export function isProtocolCompatible(protocolVersion: number): boolean {
  return (
    protocolVersion >= SUPPORTED_PROTOCOL_RANGE.min &&
    protocolVersion <= SUPPORTED_PROTOCOL_RANGE.max
  );
}

/** Issue #2248 — what `GET /api/hosts` reports of a host's protocol handshake. */
export interface HostProtocolStatus {
  /** null for a legacy agent (no handshake route). */
  protocolVersion: number | null;
  /** The agent's protocol is outside the primary's supported range. */
  incompatible: boolean;
  /** Registry operations the host does not support (the remedy is Update). */
  missingOperations: string[];
  /** Launch options the host would silently drop; a launch needing one is refused. */
  missingLaunchOptions: string[];
  legacy: boolean;
}
