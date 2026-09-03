// Builder functions for the domain shapes hand-rolled repeatedly across
// this suite (Session literals alone: ~49 in SessionRow.test.tsx, ~26 in
// UnifiedBoard.test.tsx, ~23 in Sidebar.test.tsx — plus near-identical
// local `makeSession`/`makeProject`/`makeTask`/`makeHost`/`makeWorkspace`
// helpers already independently reinvented in SessionRow.test.tsx,
// UnifiedBoard.test.tsx, Sidebar.test.tsx, kanban.test.ts,
// unifiedBoard.test.ts, hostStatus.test.ts, and WorkspaceSwitcher.test.tsx).
//
// Deliberately builder FUNCTIONS, not static exported constants: every real
// usage overrides a handful of fields per test case (`makeSession({ status:
// "exited" })`), so a shared constant would just move the duplication from
// "redefine the whole object" to "spread the whole object" at every call
// site. Every field below is typed against the real `Session`/`Project`/
// `Task`/`Workspace`/`Host` interfaces in api.ts (not a hand-typed subset),
// so an api.ts shape change that adds/renames a required field is a
// same-file compile error here, not a silent gap a consuming test's
// `Partial<T>` override would otherwise mask.
import type { Host, Project, Session, Task, Workspace } from "../api/index.js";

export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 1,
    projectId: 1,
    parentSessionId: null,
    name: null,
    nameLocked: false,
    command: "claude code",
    model: null,
    cwd: null,
    env: null,
    kind: "terminal",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastAttachedAt: null,
    alive: true,
    subscriberCount: 0,
    activity: "working",
    lastActivityAt: Date.now(),
    liveCwd: null,
    previewBranch: null,
    attention: false,
    attentionAt: null,
    lastTitle: null,
    gateState: "idle",
    gatePrompt: null,
    gates: [],
    permissionState: "idle",
    planState: "idle",
    errorState: "idle",
    endedReason: null,
    exitCode: null,
    attentionKind: null,
    errorDetail: null,
    lastAssistantMessage: null,
    compactState: "idle",
    subagentCount: 0,
    subagents: [],
    elicitationState: "idle",
    elicitationServer: null,
    lastTurnEndedAt: null,
    outstandingBackgroundTasks: [],
    sessionStatus: "working",
    sessionStatusSeverity: "busy",
    sessionStatusDetail: null,
    sessionStatusAttentionRequired: false,
    promoteState: "idle",
    promoteSummary: null,
    promoteSuggestedBaseRef: null,
    liveBranch: null,
    stateRestored: true,
    staleHooks: false,
    restoredVersion: null,
    hookEmits: [],
    pendingDevServerPort: null,
    ...overrides,
  };
}

export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 1,
    name: "demo",
    cwd: "/home/x/demo",
    hostId: "local",
    devServerUrl: null,
    detectedDevServerPort: null,
    currentBranch: null,
    autoFetch: null,
    ruleFiles: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    defaultAgent: null,
    defaultReviewAgent: null,
    mergeOnApprove: null,
    autoApprove: null,
    maxAutoReturnRounds: null,
    conventionalCommitTitles: null,
    autoTagRelease: null,
    injectAgentGuide: null,
    injectProjectBriefing: null,
    ...overrides,
  };
}

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    projectId: 1,
    projectName: "demo",
    issueNumber: null,
    title: "Fix the thing",
    body: null,
    htmlUrl: null,
    status: "ready",
    boardOrder: 0,
    sessionId: null,
    seedDelivered: null,
    reviewSessionId: null,
    reviewSeedDelivered: null,
    reviewFindingsIngestedSessionId: null,
    reviewFindings: null,
    autoReturnRounds: 0,
    lastAutoReturnReason: null,
    autoReturnCapped: false,
    worktreePath: null,
    branchName: null,
    baseSha: null,
    agent: null,
    reviewAgent: null,
    agentCommand: null,
    prUrl: null,
    prNumber: null,
    mergeRequestedAt: null,
    mergeError: null,
    releaseRequestedAt: null,
    releaseError: null,
    lastReviewVerdict: null,
    externalReviewRequestedAt: null,
    externalReviewNote: null,
    assignee: null,
    failureReason: null,
    githubSyncError: null,
    dependencyCount: null,
    blockedState: "clear",
    blockers: [],
    parentIssueNumber: null,
    parentIssueRepo: null,
    parentIssueTitle: null,
    subIssueTotal: null,
    subIssueCompleted: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    queuedAt: null,
    claimedAt: null,
    startedAt: null,
    reviewingAt: null,
    completedAt: null,
    ...overrides,
  };
}

export function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 1,
    name: "Default",
    groupId: null,
    position: 0,
    layout: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeHost(overrides: Partial<Host> = {}): Host {
  return {
    id: "h1",
    name: "test-host",
    baseUrl: "http://127.0.0.1:4000",
    isLocal: false,
    hasToken: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    health: "pending",
    lastSeenAt: null,
    lastCheckedAt: null,
    ...overrides,
  };
}
