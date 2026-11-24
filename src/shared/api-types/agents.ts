// Shared API types for agent rules, the skills/agents bundle sync, the Browser pane's quick pick and Codex hook trust (#2412).
//
// The single declaration of each API shape here, used by both workspaces.
// Most were hand-copied into frontend/src/api/ before #2412; the backend
// module that produces one re-exports it, so its importers are unchanged, and
// the frontend imports it through src/shared/types.ts, the one entry point.
// Type-only: no runtime code, and no import from outside src/shared/ (an
// import back from types.ts would be a cycle).

export type CodexHookTrust = "trusted" | "pending" | "not-installed";

export interface BrowserDestination {
  /** Stable id of the entry: `dev-server`, `dock:<sessionId>`,
   * `compose:<stack>:<service>:<port>`, `target:<id>`, `branch:<slug>`. */
  key: string;
  group: "running" | "saved";
  kind: BrowserDestinationKind;
  label: string;
  /** Secondary text: the port, the stack, the destination. */
  detail: string | null;
  /** The address as seen from `hostId` (a bare port is that host's
   * `localhost`), or null when there is none to show. */
  address: string | null;
  /** The host the address is on: where `localhost` in it points. */
  hostId: string;
  /** A branch preview's slug. */
  previewSlug: string | null;
  /** A named target's id. */
  targetId: string | null;
}

export interface BrowserDestinations {
  destinations: BrowserDestination[];
  /** Why the running group is empty or incomplete, or null. */
  runningNote: string | null;
  /** With `?sessionId=`: the host that session's browser runs on, or why it
   * cannot be told; null without the query. The route adds it, so the
   * service's own result (listBrowserDestinations) leaves it out. */
  agentBrowser?: { hostId: string | null; reason: string | null } | null;
}

export type BrowserDestinationKind = "dev-server" | "dock" | "compose" | "target" | "branch";

export type AgentRuleAgent = "claude-code" | "codex" | "opencode" | "agy";

export type AgentRuleScope = "project" | "global";

export type AgentRuleStatus = "active" | "shadowed";

export interface AgentRuleTarget {
  id: string;
  agent: AgentRuleAgent;
  agentLabel: string;
  scope: AgentRuleScope;
  fileName: string;
  absolutePath: string;
  exists: boolean;
  size: number | null;
  mtimeMs: number | null;
  status: AgentRuleStatus | null;
  content: string | null;
  /** Set when `content` was withheld because the file exceeds
   * MAX_RULE_FILE_BYTES — the target still reports exists/size/mtime, just
   * not the body. */
  truncated: boolean;
  /** Set when the resolved path is itself a symlink (issue #431, Hermes
   * review on PR #458) — `content` is still populated (informational), but
   * writeAgentRule refuses to save through it (AgentRuleSymlinkError), so
   * the UI should treat this target as read-only rather than offer an edit
   * whose Save is guaranteed to fail. */
  isSymlink: boolean;
}

export type BundleSyncCli = "claude-code" | "codex" | "agy" | "opencode" | "mcode";

export type BundleSyncStatus = "synced" | "not-synced" | "stale" | "n-a" | "disabled";

export interface BundleSyncCliStatus {
  cli: BundleSyncCli;
  /** From agent-detect.ts's getCachedAgents() — whether this CLI's binary
   * was found on PATH at all, independent of whether Mullion has ever
   * synced content to it. */
  detected: boolean;
  skills: BundleSyncCliFieldStatus;
  agents: BundleSyncCliAgentsStatus;
}

export interface BundleSyncStatusReport {
  enabled: boolean;
  /** The shipped bundle's content hash as of the last successful sync, or
   * `null` when disabled or never synced. */
  bundleHash: string | null;
  manifestPath: string;
  clis: BundleSyncCliStatus[];
}

export interface BundleSyncCliFieldStatus {
  status: BundleSyncStatus;
  root: string;
  count: number;
}

export interface BundleSyncCliAgentsStatus {
  status: BundleSyncStatus;
  // null for codex ("n-a" — no per-agent file format, so there's no root to
  // report either).
  root: string | null;
  count: number;
}
