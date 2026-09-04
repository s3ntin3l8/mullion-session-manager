// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskDetail } from "./TaskDetail.js";
import type * as ApiModule from "./api/index.js";
import { ApiError } from "./api/index.js";
import type { GitHubPRsStatus, NotificationEvent, ServerInfo, Session, Task } from "./api/index.js";

let tasks: Task[];
let sessions: Session[];
let events: Record<number, NotificationEvent[]>;
let taskMasterEnabled: boolean;
let prsByProject: Record<number, GitHubPRsStatus | undefined>;
// #1014 (Abandon), review fix — null in most tests, so DeleteTaskAction
// falls back to the literal "mullion-task" (matching every existing test's
// assertions); set per-test to exercise a custom MULLION_TASK_LABEL.
let taskMasterEnv: ServerInfo["taskMasterEnv"] | null = null;

const claimTask = vi.fn(async () => makeSession({ id: 99 }));
const approveTask = vi.fn(async () => makeTask({}));
const mergeTask = vi.fn(async () => makeTask({}));
const rejectTask = vi.fn(async () => makeTask({}));
const retryTask = vi.fn(async () => makeSession({ id: 100 }));
const giveUpTask = vi.fn(async () => makeTask({}));
const refreshTasks = vi.fn(async () => {});
const deleteTask = vi.fn(async () => {});
const updateTask = vi.fn(async () => makeTask({}));

function storeState() {
  return {
    tasks,
    sessions,
    events,
    taskMasterEnabled,
    taskMasterEnv,
    claimTask,
    approveTask,
    mergeTask,
    rejectTask,
    retryTask,
    giveUpTask,
    refreshTasks,
    deleteTask,
    updateTask,
    prsByProject,
  };
}

vi.mock("./store/index.js", () => ({
  useDashboardStore: (selector?: (s: unknown) => unknown) => {
    const state = storeState();
    return selector ? selector(state) : state;
  },
  eventKey: (sessionId: number, seq: number) => `${sessionId}:${seq}`,
}));

vi.mock("./api/index.js", async () => {
  const actual = await vi.importActual<typeof ApiModule>("./api/index.js");
  return {
    ...actual,
    api: {
      ...actual.api,
      listProjectActions: vi.fn(async () => [
        { id: "agent:claude", title: "Claude Code", kind: "agent" },
        { id: "agent:codex", title: "Codex", kind: "agent" },
      ]),
    },
  };
});

function makeTask(overrides: Partial<Task>): Task {
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
    autoReturnCapAnnouncedAt: null,
    worktreePath: null,
    branchName: null,
    agent: null,
    reviewAgent: null,
    agentCommand: null,
    prUrl: null,
    prNumber: null,
    prTitle: null,
    prTitleFallback: false,
    mergeRequestedAt: null,
    mergeError: null,
    releaseRequestedAt: null,
    releaseError: null,
    lastReviewVerdict: null,
    assignee: null,
    failureReason: null,
    githubSyncError: null,
    baseSha: null,
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
    mergedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: 1,
    projectId: 1,
    parentSessionId: null,
    name: null,
    nameLocked: false,
    command: "claude code",
    cwd: null,
    env: null,
    liveCwd: null,
    previewBranch: null,
    kind: "terminal",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastAttachedAt: null,
    alive: true,
    subscriberCount: 0,
    activity: "working",
    lastActivityAt: Date.now(),
    attention: false,
    attentionAt: null,
    lastTitle: null,
    gateState: "idle",
    gates: [],
    gatePrompt: null,
    promoteState: "idle",
    promoteSummary: null,
    promoteSuggestedBaseRef: null,
    permissionState: "idle",
    planState: "idle",
    errorState: "idle",
    endedReason: null,
    liveBranch: null,
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
    stateRestored: true,
    staleHooks: false,
    restoredVersion: null,
    sessionStatus: "working",
    sessionStatusSeverity: "busy",
    sessionStatusDetail: null,
    sessionStatusAttentionRequired: false,
    hookEmits: [],
    pendingDevServerPort: null,
    outstandingBackgroundTasks: [],
    ...overrides,
  };
}

beforeEach(() => {
  sessions = [];
  events = {};
  taskMasterEnabled = true;
  taskMasterEnv = null;
  prsByProject = {};
  claimTask.mockClear();
  approveTask.mockClear();
  mergeTask.mockClear();
  rejectTask.mockClear();
  retryTask.mockClear();
  giveUpTask.mockClear();
  refreshTasks.mockClear();
  deleteTask.mockClear();
  updateTask.mockClear();
});

describe("TaskDetail", () => {
  it("shows a not-found message for an unknown task id", () => {
    tasks = [];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.getByText("Task not found.")).toBeInTheDocument();
  });

  it("renders title, status badge, and project name", () => {
    tasks = [makeTask({ id: 1, title: "Fix the thing", status: "in_progress" })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.getByText("Fix the thing")).toBeInTheDocument();
    expect(screen.getByText("In Progress")).toBeInTheDocument();
    expect(screen.getByText("demo")).toBeInTheDocument();
  });

  it("shows the issue link when issueNumber is set", () => {
    tasks = [makeTask({ id: 1, issueNumber: 42, htmlUrl: "https://github.com/o/r/issues/42" })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    const link = screen.getByRole("link", { name: /Issue #42/ });
    expect(link).toHaveAttribute("href", "https://github.com/o/r/issues/42");
  });

  it("shows the PR link when prUrl is set", () => {
    tasks = [makeTask({ id: 1, status: "done", prUrl: "https://github.com/o/r/pull/7" })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.getByRole("link", { name: /Pull request/ })).toHaveAttribute(
      "href",
      "https://github.com/o/r/pull/7",
    );
  });

  it("shows a CI status dot on the PR link when the branch matches an open PR", () => {
    tasks = [
      makeTask({
        id: 1,
        status: "reviewing",
        prUrl: "https://github.com/o/r/pull/7",
        branchName: "mullion/task-1",
      }),
    ];
    prsByProject = {
      1: {
        prs: [
          {
            number: 7,
            title: "fix: the thing",
            htmlUrl: "https://github.com/o/r/pull/7",
            author: "mullion-bot",
            headSha: "abc123",
            headBranch: "mullion/task-1",
            baseBranch: "main",
            ciStatus: "failure",
            actionsRuns: [],
          },
        ],
        prSummary: { total: 1, pass: 0, fail: 1, pending: 0, unknown: 0 },
      },
    };
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    const link = screen.getByRole("link", { name: /Pull request/ });
    expect(link.querySelector(".github-panel-ci-dot.bad")).toBeInTheDocument();
  });

  it("shows the PR link with no CI dot when nothing matches the task's branch", () => {
    tasks = [
      makeTask({
        id: 1,
        status: "done",
        prUrl: "https://github.com/o/r/pull/7",
        branchName: "mullion/task-1",
      }),
    ];
    prsByProject = {
      1: { prs: [], prSummary: { total: 0, pass: 0, fail: 0, pending: 0, unknown: 0 } },
    };
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    const link = screen.getByRole("link", { name: /Pull request/ });
    expect(link.querySelector(".github-panel-ci-dot")).toBeNull();
  });

  // Hermes review, PR #577/#582 — the CI dot reflects matchedPr (the
  // CURRENT PR on task.branchName), but the link's href previously stayed
  // on task.prUrl regardless. If that branch's PR was closed and a new one
  // opened on the same branch, the dot would describe the new PR while the
  // link opened the old, closed one.
  it("links to the branch-matched PR, not the stale task.prUrl, when they differ", () => {
    tasks = [
      makeTask({
        id: 1,
        status: "reviewing",
        prUrl: "https://github.com/o/r/pull/7",
        branchName: "mullion/task-1",
      }),
    ];
    prsByProject = {
      1: {
        prs: [
          {
            number: 9,
            title: "fix: the thing, round 2",
            htmlUrl: "https://github.com/o/r/pull/9",
            author: "mullion-bot",
            headSha: "def456",
            headBranch: "mullion/task-1",
            baseBranch: "main",
            ciStatus: "success",
            actionsRuns: [],
          },
        ],
        prSummary: { total: 1, pass: 1, fail: 0, pending: 0, unknown: 0 },
      },
    };
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.getByRole("link", { name: /Pull request/ })).toHaveAttribute(
      "href",
      "https://github.com/o/r/pull/9",
    );
  });

  // Item 3 — same "#N" treatment the issue link already gets.
  it("shows the PR number next to the label, same as the issue link", () => {
    tasks = [
      makeTask({ id: 1, status: "done", prUrl: "https://github.com/o/r/pull/7", prNumber: 7 }),
    ];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.getByRole("link", { name: "Pull request #7" })).toBeInTheDocument();
  });

  it("prefers the branch-matched PR's number over the stale task.prNumber", () => {
    tasks = [
      makeTask({
        id: 1,
        status: "reviewing",
        prUrl: "https://github.com/o/r/pull/7",
        prNumber: 7,
        branchName: "mullion/task-1",
      }),
    ];
    prsByProject = {
      1: {
        prs: [
          {
            number: 9,
            title: "fix: the thing, round 2",
            htmlUrl: "https://github.com/o/r/pull/9",
            author: "mullion-bot",
            headSha: "def456",
            headBranch: "mullion/task-1",
            baseBranch: "main",
            ciStatus: "success",
            actionsRuns: [],
          },
        ],
        prSummary: { total: 1, pass: 1, fail: 0, pending: 0, unknown: 0 },
      },
    };
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.getByRole("link", { name: "Pull request #9" })).toBeInTheDocument();
  });

  // Issue #972: retryTask can leave prUrl set with prNumber left null —
  // the label must degrade to plain "Pull request" rather than "#null".
  it("shows the plain label with no trailing number when prNumber is null", () => {
    tasks = [makeTask({ id: 1, status: "done", prUrl: "https://github.com/o/r/pull/7" })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.getByRole("link", { name: "Pull request" })).toBeInTheDocument();
  });

  // #761's second silent layer: a project wants Conventional Commits
  // titles, a PR is open, but the title in use isn't Conventional-Commits-
  // shaped — previously surfaced nowhere but one server-side app.log.warn.
  it("shows the PR title fallback warning when the server flags prTitleFallback", () => {
    tasks = [
      makeTask({
        id: 1,
        status: "reviewing",
        prUrl: "https://github.com/o/r/pull/7",
        prTitleFallback: true,
      }),
    ];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.getByText(/PR title fell back to the raw issue title/)).toBeInTheDocument();
  });

  it("does not show the PR title fallback warning when prTitleFallback is false", () => {
    tasks = [
      makeTask({
        id: 1,
        status: "reviewing",
        prUrl: "https://github.com/o/r/pull/7",
        prTitleFallback: false,
      }),
    ];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.queryByText(/PR title fell back to the raw issue title/)).not.toBeInTheDocument();
  });

  it("shows the resolved agent name from agentCommand", () => {
    tasks = [makeTask({ id: 1, agentCommand: "claude --dangerously-skip-permissions" })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.getByText(/Agent: claude/)).toBeInTheDocument();
  });

  it("shows the failure reason only for a failed task", () => {
    tasks = [makeTask({ id: 1, status: "failed", failureReason: "budget exceeded" })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.getByText("budget exceeded")).toBeInTheDocument();
  });

  // #485 — previously a GitHub sync/scope error was visible only in server
  // logs (or, for promotion, only as transient component state gone on
  // remount). This banner is independent of status, unlike task-detail-failure.
  it("shows a GitHub sync error banner regardless of task status", () => {
    tasks = [
      makeTask({
        id: 1,
        status: "in_progress",
        githubSyncError: "GitHub rejected this write (HTTP 403)",
      }),
    ];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.getByText(/GitHub rejected this write \(HTTP 403\)/)).toBeInTheDocument();
  });

  it("does not show a GitHub sync error banner when githubSyncError is null", () => {
    tasks = [makeTask({ id: 1, status: "in_progress", githubSyncError: null })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.queryByText(/GitHub sync:/)).toBeNull();
  });

  it("#667 — shows a linked blocked-by list for a blocked task", () => {
    tasks = [
      makeTask({
        id: 1,
        blockedState: "blocked",
        blockers: [
          {
            owner: "acme",
            repo: "widgets",
            number: 12,
            title: "The blocker",
            htmlUrl: "https://x/12",
          },
        ],
      }),
    ];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.getByText(/Blocked by/)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "#12" });
    expect(link).toHaveAttribute("href", "https://x/12");
  });

  it("#667 — renders a synthetic not-visible-to-token blocker as plain text, not a link", () => {
    tasks = [
      makeTask({
        id: 1,
        blockedState: "blocked",
        blockers: [
          {
            owner: "acme",
            repo: "widgets",
            number: 0,
            title: "1 blocker(s) not visible to this token",
            htmlUrl: null,
          },
        ],
      }),
    ];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.getByText("1 blocker(s) not visible to this token")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /not visible/ })).toBeNull();
  });

  it("#667 — shows a checking-dependencies message for an unresolved task, not a blocker list", () => {
    tasks = [makeTask({ id: 1, blockedState: "unresolved", blockers: [] })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.getByText("Checking dependencies…")).toBeInTheDocument();
    expect(screen.queryByText(/^Blocked by/)).toBeNull();
  });

  it("#667 — shows nothing for a clear task", () => {
    tasks = [makeTask({ id: 1, blockedState: "clear", blockers: [] })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.queryByText("Checking dependencies…")).toBeNull();
    expect(screen.queryByText(/^Blocked by/)).toBeNull();
  });

  // #701 — sub-issue hierarchy section.
  describe("Hierarchy section (#701)", () => {
    it("renders no Hierarchy section for a task with neither a parent nor children", () => {
      tasks = [makeTask({ id: 1, parentIssueNumber: null, subIssueTotal: null })];
      render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
      expect(
        screen.queryByText("Hierarchy", { selector: ".task-detail-section-title" }),
      ).toBeNull();
    });

    it("links to the parent's title when known", () => {
      tasks = [
        makeTask({
          id: 1,
          parentIssueNumber: 30,
          parentIssueRepo: "s3ntin3l8/branchdam",
          parentIssueTitle: "Phase 5 — Tier-1 project introspection",
        }),
      ];
      render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
      const link = screen.getByRole("link", { name: /Phase 5 — Tier-1 project introspection/ });
      expect(link).toHaveAttribute("href", "https://github.com/s3ntin3l8/branchdam/issues/30");
    });

    it("falls back to a bare #N when the parent's title hasn't been filled yet", () => {
      tasks = [
        makeTask({
          id: 1,
          parentIssueNumber: 30,
          parentIssueRepo: "s3ntin3l8/branchdam",
          parentIssueTitle: null,
        }),
      ];
      render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
      expect(screen.getByRole("link", { name: /#30/ })).toBeInTheDocument();
    });

    it("shows sub-issue completion progress", () => {
      tasks = [makeTask({ id: 1, subIssueTotal: 4, subIssueCompleted: 1 })];
      render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
      expect(screen.getByText("1 of 4 sub-issues complete")).toBeInTheDocument();
    });

    it("lists sibling tasks that are themselves known Task Master tasks", () => {
      tasks = [
        makeTask({
          id: 1,
          issueNumber: 30,
          projectId: 1,
          htmlUrl: "https://github.com/o/r/issues/30",
          subIssueTotal: 2,
          subIssueCompleted: 0,
        }),
        makeTask({
          id: 2,
          issueNumber: 44,
          projectId: 1,
          parentIssueNumber: 30,
          parentIssueRepo: "o/r",
          title: "Child A",
          htmlUrl: "https://github.com/o/r/issues/44",
        }),
        makeTask({
          id: 3,
          issueNumber: 45,
          projectId: 1,
          parentIssueNumber: 30,
          parentIssueRepo: "o/r",
          title: "Child B",
          htmlUrl: null,
        }),
      ];
      render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
      const childLink = screen.getByRole("link", { name: /Child A/ });
      expect(childLink).toHaveAttribute("href", "https://github.com/o/r/issues/44");
      expect(screen.getByText(/Child B/)).toBeInTheDocument();
    });

    it("does not list an unrelated task in a different project as a child", () => {
      tasks = [
        makeTask({
          id: 1,
          issueNumber: 30,
          projectId: 1,
          htmlUrl: "https://github.com/o/r/issues/30",
        }),
        makeTask({
          id: 2,
          issueNumber: 30,
          projectId: 2,
          parentIssueNumber: 30,
          parentIssueRepo: "o/r",
          title: "Other project's task",
        }),
      ];
      render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
      expect(screen.queryByText(/Other project's task/)).toBeNull();
    });

    // Hermes review, PR #702 — issue numbers are per-repo, and cross-repo
    // parents are first-class in this feature: a same-project, same-number
    // sibling whose PARENT is actually in a different repo must not be
    // mistaken for a child just because the numbers coincide.
    it("does not list a same-project, same-number sibling whose parent is actually a different repo", () => {
      tasks = [
        makeTask({
          id: 1,
          issueNumber: 30,
          projectId: 1,
          htmlUrl: "https://github.com/acme/foo/issues/30",
        }),
        makeTask({
          id: 2,
          issueNumber: 99,
          projectId: 1,
          parentIssueNumber: 30,
          parentIssueRepo: "other/repo",
          title: "Coincidental #30 in a different repo",
        }),
      ];
      render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
      expect(screen.queryByText(/Coincidental #30/)).toBeNull();
    });

    it("does not treat every other parentless local task as a child of a local task", () => {
      // issueNumber: null on the "parent" — the guard this pins.
      tasks = [
        makeTask({ id: 1, issueNumber: null, projectId: 1, title: "Local task" }),
        makeTask({
          id: 2,
          issueNumber: null,
          projectId: 1,
          parentIssueNumber: null,
          title: "Unrelated local task",
        }),
      ];
      render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
      expect(
        screen.queryByText("Hierarchy", { selector: ".task-detail-section-title" }),
      ).toBeNull();
    });
  });

  it("shows the review section only when reviewSessionId is set", () => {
    tasks = [makeTask({ id: 1, status: "reviewing", reviewSessionId: 5 })];
    sessions = [makeSession({ id: 5 })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(
      screen.getByText("Review", { selector: ".task-detail-section-title" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/cannot approve, reject, or otherwise transition this task/),
    ).toBeInTheDocument();
  });

  it("does not show the review section for a task with no review agent configured", () => {
    tasks = [makeTask({ id: 1, status: "reviewing", reviewSessionId: null })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.queryByText("Review", { selector: ".task-detail-section-title" })).toBeNull();
  });

  it("renders the review agent's captured findings when present", () => {
    tasks = [
      makeTask({
        id: 1,
        status: "reviewing",
        reviewSessionId: 5,
        reviewFindings: "## Round 1\n\nThe retry loop never backs off.",
      }),
    ];
    sessions = [makeSession({ id: 5 })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.getByText(/The retry loop never backs off\./)).toBeInTheDocument();
  });

  it("does not render a findings block when nothing has been captured yet", () => {
    tasks = [makeTask({ id: 1, status: "reviewing", reviewSessionId: 5, reviewFindings: null })];
    sessions = [makeSession({ id: 5 })];
    const { container } = render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(container.querySelector(".task-detail-review-findings")).toBeNull();
  });

  it("renders findings markdown, including a second stacked auto-return round", () => {
    tasks = [
      makeTask({
        id: 1,
        status: "reviewing",
        reviewSessionId: 5,
        reviewFindings: [
          "## Round 1",
          "",
          "### Critical",
          "- [blocker] **cmd/main.go:10** — missing error check.",
          "",
          "## Round 2",
          "",
          "**Verdict:** clean",
        ].join("\n"),
      }),
    ];
    sessions = [makeSession({ id: 5 })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.getByRole("heading", { level: 2, name: "Round 2" })).toBeInTheDocument();
    expect(screen.getByText("cmd/main.go:10", { selector: "strong" })).toBeInTheDocument();
  });

  it("shows a round indicator once the review has auto-returned to the worker", () => {
    tasks = [makeTask({ id: 1, status: "in_progress", reviewSessionId: 5, autoReturnRounds: 1 })];
    sessions = [makeSession({ id: 5 })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.getByText(/Round 1 sent back to the worker automatically/)).toBeInTheDocument();
  });

  it("shows no round indicator before any auto-return has happened", () => {
    tasks = [makeTask({ id: 1, status: "reviewing", reviewSessionId: 5, autoReturnRounds: 0 })];
    sessions = [makeSession({ id: 5 })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.queryByText(/Round \d+ sent back to the worker automatically/)).toBeNull();
  });

  // Issue #1038 — capped but not yet announced (autoReturnCapAnnouncedAt
  // still null): autoReturnRounds hit the cap at the START of the last
  // permitted round, but the worker/confirming review may still be running.
  // This must NOT say "needs a human" — that's a stronger claim than the
  // machine has actually made yet.
  it("shows a review-in-flight wording, not 'needs a human', once capped but before the cap is announced", () => {
    tasks = [
      makeTask({
        id: 1,
        status: "reviewing",
        reviewSessionId: 5,
        autoReturnRounds: 2,
        autoReturnCapped: true,
        autoReturnCapAnnouncedAt: null,
      }),
    ];
    sessions = [makeSession({ id: 5 })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(
      screen.getByText(/Round 2 — review still in flight; nothing needs you yet/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/needs a human to take it from here/)).toBeNull();
    expect(screen.queryByText(/sent back to the worker automatically/)).toBeNull();
  });

  // Task 258971's investigation, refined by issue #1038: a task parked in
  // "reviewing" with its round budget spent AND the cap notice actually
  // posted looked identical to one mid-round — this asserts the capped
  // wording renders instead once autoReturnCapAnnouncedAt is set.
  it("shows the round-cap wording, not the 'sent back automatically' wording, once the cap has been announced", () => {
    tasks = [
      makeTask({
        id: 1,
        status: "reviewing",
        reviewSessionId: 5,
        autoReturnRounds: 2,
        autoReturnCapped: true,
        autoReturnCapAnnouncedAt: "2026-09-04T09:34:44.000Z",
      }),
    ];
    sessions = [makeSession({ id: 5 })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(
      screen.getByText(/Round 2 — round cap reached, needs a human to take it from here/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/sent back to the worker automatically/)).toBeNull();
    expect(screen.queryByText(/review still in flight/)).toBeNull();
  });

  // #487 — the review agent used to spawn silently with no prompt when its
  // adapter couldn't receive a seed; this warning is what makes that visible.
  it("warns in the review section when reviewSeedDelivered is false", () => {
    tasks = [
      makeTask({ id: 1, status: "reviewing", reviewSessionId: 5, reviewSeedDelivered: false }),
    ];
    sessions = [makeSession({ id: 5 })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.getByText(/no initial instructions/)).toBeInTheDocument();
  });

  it("does not warn in the review section when reviewSeedDelivered is true", () => {
    tasks = [
      makeTask({ id: 1, status: "reviewing", reviewSessionId: 5, reviewSeedDelivered: true }),
    ];
    sessions = [makeSession({ id: 5 })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.queryByText(/no initial instructions/)).toBeNull();
  });

  // Claimed-task-never-starts-a-turn fix — the worker session's own
  // `seedDelivered` now mirrors the review agent's `reviewSeedDelivered`
  // above (previously it was only visible in the claim/retry HTTP response,
  // never on the task row itself — see schema.ts's own doc comment).
  it("warns in the Timeline section when seedDelivered is false", () => {
    tasks = [makeTask({ id: 1, status: "claimed", sessionId: 5, seedDelivered: false })];
    sessions = [makeSession({ id: 5 })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.getByText(/no initial instructions/)).toBeInTheDocument();
  });

  it("does not warn in the Timeline section when seedDelivered is true", () => {
    tasks = [makeTask({ id: 1, status: "claimed", sessionId: 5, seedDelivered: true })];
    sessions = [makeSession({ id: 5 })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.queryByText(/no initial instructions/)).toBeNull();
  });

  it("does not warn in the Timeline section when seedDelivered is null (task never claimed)", () => {
    tasks = [makeTask({ id: 1, status: "ready", sessionId: null, seedDelivered: null })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.queryByText(/no initial instructions/)).toBeNull();
  });
});

describe("TaskDetail claim action", () => {
  it("shows an enabled Claim button for a ready task and does not open its session's panel", async () => {
    tasks = [makeTask({ id: 1, status: "ready" })];
    const onOpenSession = vi.fn();
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={onOpenSession} />);

    const claimBtn = screen.getByRole("button", { name: "Claim" });
    expect(claimBtn).not.toBeDisabled();
    await user.click(claimBtn);

    expect(claimTask).toHaveBeenCalledWith(1);
    // Matches auto-claim, which never opens a panel either — the card's own
    // status dot is enough, and "Open session" in the meta row opens it on
    // demand.
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("disables Claim with a hint when taskMasterEnabled is off", () => {
    taskMasterEnabled = false;
    tasks = [makeTask({ id: 1, status: "ready" })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Claim" })).toBeDisabled();
    expect(screen.getByText(/Task Master is disabled/)).toBeInTheDocument();
  });

  it("renders no actions for a task past the ready/reviewing/failed gate (e.g. claimed)", () => {
    tasks = [makeTask({ id: 1, status: "claimed" })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Claim" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

// A non-drag path between the board's only user-driven, non-terminal status
// change (backlog<->ready) — drag is otherwise the sole way to reach it, and
// HTML5 drag-and-drop never fires on a touch device.
describe("TaskDetail backlog/ready move actions", () => {
  it("shows a Move to Ready button for a backlog task and calls updateTask with status and boardOrder", async () => {
    tasks = [makeTask({ id: 1, status: "backlog" })];
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Move to Ready" }));
    expect(updateTask).toHaveBeenCalledWith(1, { status: "ready", boardOrder: 0 });
  });

  it("shows a Move to Backlog button alongside Claim for a ready task, unaffected by taskMasterEnabled", async () => {
    taskMasterEnabled = false;
    tasks = [makeTask({ id: 1, status: "ready" })];
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    const moveBtn = screen.getByRole("button", { name: "Move to Backlog" });
    expect(moveBtn).not.toBeDisabled();
    await user.click(moveBtn);
    expect(updateTask).toHaveBeenCalledWith(1, { status: "backlog", boardOrder: 0 });
  });

  // Hermes review — an earlier version sent a bare `{ status }` patch and
  // claimed this "always appends," which doesn't hold: routes/tasks.ts's
  // PATCH endpoint never reindexes, so without an explicit boardOrder the
  // task would keep its previous one and land wherever the target column's
  // (boardOrder, id) sort happened to put it — often not the end. This
  // proves the fix: with two existing ready tasks at boardOrder 0 and 1,
  // moving the backlog task there must append it at boardOrder 2, not
  // collide with or precede either of them.
  it("appends to the end of the target column's existing boardOrder sequence, not just a bare status patch", async () => {
    tasks = [
      makeTask({ id: 1, status: "backlog", boardOrder: 0 }),
      makeTask({ id: 2, status: "ready", boardOrder: 0 }),
      makeTask({ id: 3, status: "ready", boardOrder: 1 }),
    ];
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Move to Ready" }));
    expect(updateTask).toHaveBeenCalledWith(1, { status: "ready", boardOrder: 2 });
    expect(updateTask).toHaveBeenCalledTimes(1);
  });

  it("shows an error when updateTask rejects", async () => {
    updateTask.mockRejectedValueOnce(new Error("network down"));
    tasks = [makeTask({ id: 1, status: "backlog" })];
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Move to Ready" }));
    expect(screen.getByText("Failed to move task")).toBeInTheDocument();
  });

  // Independent review — UnifiedBoard.tsx's own applyDrop resyncs the store
  // from the server on a failed patch (its own per-update .catch calls
  // refreshTasks()); an earlier version of this action didn't, so a failed
  // write here left the store's optimistic-free state stale until the next
  // regular poll. Only refreshTasks itself is asserted (not updateTask's
  // call count/args, already covered by "appends to the end..." above) —
  // this test is specifically about the resync-on-failure behavior.
  it("resyncs from the server (refreshTasks) when updateTask rejects, same as the drag path", async () => {
    updateTask.mockRejectedValueOnce(new Error("network down"));
    tasks = [makeTask({ id: 1, status: "backlog" })];
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    refreshTasks.mockClear();
    await user.click(screen.getByRole("button", { name: "Move to Ready" }));
    expect(refreshTasks).toHaveBeenCalled();
  });
});

// #483
describe("TaskDetail retry action", () => {
  it("shows an enabled Retry button for a failed task and does not open its session's panel", async () => {
    tasks = [makeTask({ id: 1, status: "failed", failureReason: "budget exceeded" })];
    const onOpenSession = vi.fn();
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={onOpenSession} />);

    const retryBtn = screen.getByRole("button", { name: "Retry" });
    expect(retryBtn).not.toBeDisabled();
    await user.click(retryBtn);

    expect(retryTask).toHaveBeenCalledWith(1);
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("disables Retry with a hint when taskMasterEnabled is off — like Claim, it spawns a session", () => {
    taskMasterEnabled = false;
    tasks = [makeTask({ id: 1, status: "failed" })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
    expect(screen.getByText(/Task Master is disabled/)).toBeInTheDocument();
  });
});

describe("TaskDetail approve/reject actions", () => {
  it("shows Approve/Reject for a reviewing task; Approve calls approveTask", async () => {
    tasks = [makeTask({ id: 1, status: "reviewing" })];
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(approveTask).toHaveBeenCalledWith(1);
  });

  it("Reject opens a feedback field and submits it to rejectTask", async () => {
    tasks = [makeTask({ id: 1, status: "reviewing" })];
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Reject" }));
    await user.type(screen.getByPlaceholderText("Feedback (optional)"), "please fix X");
    await user.click(screen.getByRole("button", { name: "Reject" }));

    expect(rejectTask).toHaveBeenCalledWith(1, "please fix X");
  });

  it("disables Approve with a hint when taskMasterEnabled is off, but leaves Reject enabled as the escape hatch (Hermes review, PR #480, fourth pass)", () => {
    taskMasterEnabled = false;
    tasks = [makeTask({ id: 1, status: "reviewing" })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).not.toBeDisabled();
  });

  it("still submits a reject through the full feedback flow while taskMasterEnabled is off", async () => {
    taskMasterEnabled = false;
    tasks = [makeTask({ id: 1, status: "reviewing" })];
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(screen.getByRole("button", { name: "Reject" })).not.toBeDisabled();
    await user.type(screen.getByPlaceholderText("Feedback (optional)"), "please fix X");
    await user.click(screen.getByRole("button", { name: "Reject" }));

    expect(rejectTask).toHaveBeenCalledWith(1, "please fix X");
  });

  // #483
  it("Give up opens a reason field and submits it to giveUpTask", async () => {
    tasks = [makeTask({ id: 1, status: "reviewing" })];
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Give up" }));
    await user.type(screen.getByPlaceholderText("Reason (optional)"), "wrong approach");
    await user.click(screen.getByRole("button", { name: "Give up" }));

    expect(giveUpTask).toHaveBeenCalledWith(1, "wrong approach");
  });

  it("Give up stays enabled when taskMasterEnabled is off, same escape hatch as Reject", async () => {
    taskMasterEnabled = false;
    tasks = [makeTask({ id: 1, status: "reviewing" })];
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Give up" })).not.toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Give up" }));
    await user.click(screen.getByRole("button", { name: "Give up" }));

    expect(giveUpTask).toHaveBeenCalledWith(1, undefined);
  });
});

describe("TaskDetail open session", () => {
  it("shows an Open session action when the worker session is known, and calls onOpenSession", async () => {
    tasks = [makeTask({ id: 1, status: "in_progress", sessionId: 7 })];
    sessions = [makeSession({ id: 7, command: "claude code" })];
    const onOpenSession = vi.fn();
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={onOpenSession} />);

    await user.click(screen.getByRole("button", { name: /Open session/ }));
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }));
  });

  it("shows no Open session action for an unclaimed task", () => {
    tasks = [makeTask({ id: 1, status: "backlog", sessionId: null })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Open session/ })).toBeNull();
  });
});

describe("TaskDetail merge-on-approve status", () => {
  it("shows Merge now for a done task with a PR and no merge requested yet", async () => {
    tasks = [makeTask({ id: 1, status: "done", prNumber: 9, prUrl: "https://x/pull/9" })];
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Merge now" }));
    expect(mergeTask).toHaveBeenCalledWith(1);
  });

  it("shows Retry merge and the pending hint once a merge has been requested", () => {
    tasks = [
      makeTask({
        id: 1,
        status: "done",
        prNumber: 9,
        prUrl: "https://x/pull/9",
        mergeRequestedAt: "2026-01-01T00:00:00.000Z",
      }),
    ];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Retry merge" })).toBeInTheDocument();
    expect(screen.getByText(/Merge pending/)).toBeInTheDocument();
  });

  it("shows the recorded merge error instead of the pending hint", () => {
    tasks = [
      makeTask({
        id: 1,
        status: "done",
        prNumber: 9,
        prUrl: "https://x/pull/9",
        mergeRequestedAt: "2026-01-01T00:00:00.000Z",
        mergeError: "Conflicts with main — needs manual resolution",
      }),
    ];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    expect(screen.getByText("Conflicts with main — needs manual resolution")).toBeInTheDocument();
    expect(screen.queryByText(/Merge pending/)).toBeNull();
  });

  it("shows the release-pending hint once a release has been requested (#744)", () => {
    tasks = [
      makeTask({
        id: 1,
        status: "done",
        prNumber: 9,
        prUrl: "https://x/pull/9",
        releaseRequestedAt: "2026-01-01T00:00:00.000Z",
      }),
    ];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    expect(screen.getByText(/Release pending/)).toBeInTheDocument();
  });

  it("shows the recorded release error instead of the pending hint (#744)", () => {
    tasks = [
      makeTask({
        id: 1,
        status: "done",
        prNumber: 9,
        prUrl: "https://x/pull/9",
        releaseRequestedAt: "2026-01-01T00:00:00.000Z",
        releaseError: "No open release-please PR yet — waiting for it to be generated",
      }),
    ];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    expect(
      screen.getByText("No open release-please PR yet — waiting for it to be generated"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Release pending/)).toBeNull();
  });

  it("renders nothing for a done task with no linked PR (a local-only task)", () => {
    tasks = [makeTask({ id: 1, status: "done", prNumber: null })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Merge now" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry merge" })).toBeNull();
  });

  it("shows a generic error when mergeTask rejects with a plain Error", async () => {
    mergeTask.mockRejectedValueOnce(new Error("network down"));
    tasks = [makeTask({ id: 1, status: "done", prNumber: 9, prUrl: "https://x/pull/9" })];
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Merge now" }));

    expect(screen.getByText("Failed to request a merge")).toBeInTheDocument();
  });

  // Hermes review, PR #769 (suggestion) — the real 403 path is an ApiError
  // carrying the backend's own message, not a plain Error; surfaced
  // verbatim the same way DeleteTaskAction/other actions in this file do.
  it("surfaces the ApiError message when mergeTask rejects with one (e.g. the server's 403)", async () => {
    mergeTask.mockRejectedValueOnce(
      new ApiError("Task Master is disabled (deploy-time default or a Settings override)", 403),
    );
    tasks = [makeTask({ id: 1, status: "done", prNumber: 9, prUrl: "https://x/pull/9" })];
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Merge now" }));

    expect(
      screen.getByText("Task Master is disabled (deploy-time default or a Settings override)"),
    ).toBeInTheDocument();
  });

  // Hermes review, PR #769 — the backend route this button calls (POST
  // /api/tasks/:id/merge) is gated on taskMasterEnabled exactly like
  // approve is (routes/tasks.ts), so an enabled button on a disabled
  // install would always 403. This replaces an earlier, incorrect version
  // of this test that asserted the opposite.
  it("gates Merge now on taskMasterEnabled, like Claim/Approve/Retry — the backend route is gated too", () => {
    taskMasterEnabled = false;
    tasks = [makeTask({ id: 1, status: "done", prNumber: 9, prUrl: "https://x/pull/9" })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Merge now" })).toBeDisabled();
    expect(screen.getByText(/Task Master is disabled/)).toBeInTheDocument();
  });
});

// Independent review, PR #477 — the claim/approve/reject failure paths had
// zero coverage; only their success paths were tested.
describe("TaskDetail action failure paths", () => {
  it("shows an error and re-enables Claim when claimTask rejects", async () => {
    claimTask.mockRejectedValueOnce(new Error("network down"));
    tasks = [makeTask({ id: 1, status: "ready" })];
    const onOpenSession = vi.fn();
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={onOpenSession} />);

    await user.click(screen.getByRole("button", { name: "Claim" }));

    expect(screen.getByText("Failed to claim task")).toBeInTheDocument();
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Claim" })).not.toBeDisabled();
  });

  it("shows an error when approveTask rejects", async () => {
    approveTask.mockRejectedValueOnce(new Error("push failed"));
    tasks = [makeTask({ id: 1, status: "reviewing" })];
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Approve" }));

    expect(screen.getByText("Failed to approve task")).toBeInTheDocument();
  });

  it("shows an error and keeps the feedback form open when rejectTask rejects", async () => {
    rejectTask.mockRejectedValueOnce(new Error("network down"));
    tasks = [makeTask({ id: 1, status: "reviewing" })];
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Reject" }));
    await user.click(screen.getByRole("button", { name: "Reject" }));

    expect(screen.getByText("Failed to reject task")).toBeInTheDocument();
    // Still in the feedback-entry state, not silently dropped back to the
    // Approve/Reject pair.
    expect(screen.getByPlaceholderText("Feedback (optional)")).toBeInTheDocument();
  });

  // #483
  it("shows an error and re-enables Retry when retryTask rejects", async () => {
    retryTask.mockRejectedValueOnce(new Error("branch already checked out"));
    tasks = [makeTask({ id: 1, status: "failed" })];
    const onOpenSession = vi.fn();
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={onOpenSession} />);

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(screen.getByText("Failed to retry task")).toBeInTheDocument();
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Retry" })).not.toBeDisabled();
  });

  it("shows an error and keeps the reason form open when giveUpTask rejects", async () => {
    giveUpTask.mockRejectedValueOnce(new Error("network down"));
    tasks = [makeTask({ id: 1, status: "reviewing" })];
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Give up" }));
    await user.click(screen.getByRole("button", { name: "Give up" }));

    expect(screen.getByText("Failed to give up on task")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Reason (optional)")).toBeInTheDocument();
  });
});

// Independent review, PR #477 — the local-only Delete action (mirrors
// routes/tasks.ts's own DELETE restriction: no linked issue, backlog/ready
// only), added because api.getTask/store.deleteTask had no UI call site at
// all — an accidental locally-created task had no way to be removed.
describe("TaskDetail delete action", () => {
  it("shows Delete for a local task in backlog, and calls deleteTask on confirm", async () => {
    tasks = [makeTask({ id: 1, status: "backlog", issueNumber: null })];
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Delete task" }));
    expect(screen.getByText(/can't be undone/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));

    expect(deleteTask).toHaveBeenCalledWith(1);
  });

  it("cancels back to the single Delete button without calling deleteTask", async () => {
    tasks = [makeTask({ id: 1, status: "ready", issueNumber: null })];
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Delete task" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("button", { name: "Delete task" })).toBeInTheDocument();
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it("shows an error when deleteTask rejects", async () => {
    deleteTask.mockRejectedValueOnce(new Error("still claimed"));
    tasks = [makeTask({ id: 1, status: "backlog", issueNumber: null })];
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Delete task" }));
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));

    expect(screen.getByText("Failed to delete task")).toBeInTheDocument();
  });

  it("hides Delete for a GitHub-linked task", () => {
    tasks = [makeTask({ id: 1, status: "backlog", issueNumber: 42 })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Delete task" })).toBeNull();
  });

  it("hides Delete once a task is past backlog/ready", () => {
    tasks = [makeTask({ id: 1, status: "claimed", issueNumber: null })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Delete task" })).toBeNull();
  });

  // #729 — a GitHub-linked task auto-failed by a lost tracking label had no
  // way out of the board at all (Retry needs a preserved branch it never
  // got, and Delete was hidden for any GitHub-linked task). Shown alongside
  // Retry rather than replacing it — the server's own DELETE guard (see
  // routes/tasks.ts) is what actually decides whether the linked issue is
  // safe to remove; the confirm click surfaces a rejection the same way
  // Retry already does above.
  it("shows Delete alongside Retry for a failed GitHub-linked task", async () => {
    tasks = [makeTask({ id: 1, status: "failed", issueNumber: 42 })];
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete task" }));
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));

    expect(deleteTask).toHaveBeenCalledWith(1);
  });

  // The server can refuse a failed GitHub-linked task's delete for several
  // reasons (still-tracked issue, unconfirmable state, a preserved branch —
  // see routes/tasks.ts's DELETE guard) — this only asserts the existing
  // generic-fallback error path (same as the pre-existing "shows an error
  // when deleteTask rejects" test above) fires for this task shape too, not
  // any particular server message; `DeleteTaskAction` only surfaces a
  // rejection's own message for an `ApiError`, never for a plain `Error`.
  it("shows a generic error when the server refuses to delete a failed GitHub-linked task", async () => {
    deleteTask.mockRejectedValueOnce(new Error("still tracked, use Retry"));
    tasks = [makeTask({ id: 1, status: "failed", issueNumber: 42 })];
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Delete task" }));
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));

    expect(screen.getByText("Failed to delete task")).toBeInTheDocument();
  });

  // #1014 (Abandon) — previously hidden entirely (a local failed task had
  // no Delete affordance at all, out of scope for #729). Now shown: a plain
  // delete still 409s (the server's own "past backlog/ready" refusal, since
  // force wasn't asked for), which flips the confirm step into the same
  // force re-prompt a GitHub-linked task's preserved-branch refusal
  // triggers below.
  it("shows Delete for a failed LOCAL task, offering force after a plain delete 409s", async () => {
    deleteTask.mockRejectedValueOnce(
      new ApiError("Cannot delete a task past the backlog/ready stage (status: failed)", 409),
    );
    tasks = [makeTask({ id: 1, status: "failed", issueNumber: null })];
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Delete task" }));
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));

    const abandonButton = await screen.findByRole("button", { name: "Abandon task" });
    expect(screen.getByText(/can't be deleted normally/)).toBeInTheDocument();
    await user.click(abandonButton);

    expect(deleteTask).toHaveBeenLastCalledWith(1, { force: true });
  });

  // #1014 — the preserved-branch refusal (routes/tasks.ts's own #729 guard)
  // is the more common trigger for the force re-prompt. The hint names the
  // GitHub label, the worktree, and the branch specifically, not just a
  // generic "force delete" — so the user knows what Abandon actually does
  // before they click it.
  it("names the label, worktree, and branch in the force re-prompt for a GitHub-linked task", async () => {
    deleteTask.mockRejectedValueOnce(
      new ApiError("Cannot delete: this task has a preserved branch — use Retry to resume it", 409),
    );
    tasks = [
      makeTask({
        id: 1,
        status: "failed",
        issueNumber: 42,
        branchName: "mullion/task-1",
        worktreePath: "/repo/.mullion-worktrees/mullion-task-1",
      }),
    ];
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Delete task" }));
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));

    const abandonButton = await screen.findByRole("button", { name: "Abandon task" });
    expect(screen.getByText(/removes the mullion-task label/)).toBeInTheDocument();
    expect(screen.getByText(/mullion\/task-1/)).toBeInTheDocument();
    expect(screen.getByText(/mullion-worktrees\/mullion-task-1/)).toBeInTheDocument();
    await user.click(abandonButton);

    expect(deleteTask).toHaveBeenLastCalledWith(1, { force: true });
  });

  // Review fix — MULLION_TASK_LABEL is configurable (env.ts), so the force
  // re-prompt must name whatever label is actually configured, not always
  // literally "mullion-task".
  it("names the project's actual configured label, not a hardcoded one", async () => {
    taskMasterEnv = {
      enabled: true,
      maxConcurrent: 1,
      budgetMinutes: 30,
      progressCommentMinutes: 10,
      skipPermissions: false,
      issueLabel: "custom-work-label",
      pollIntervalSeconds: 60,
    };
    deleteTask.mockRejectedValueOnce(
      new ApiError("Cannot delete: this task has a preserved branch — use Retry to resume it", 409),
    );
    tasks = [makeTask({ id: 1, status: "failed", issueNumber: 42 })];
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Delete task" }));
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));

    await screen.findByRole("button", { name: "Abandon task" });
    expect(screen.getByText(/removes the custom-work-label label/)).toBeInTheDocument();
    expect(screen.queryByText(/removes the mullion-task label/)).toBeNull();
  });

  // Review fix — Cancel must drop needsForce too, or reopening the panel
  // skips straight to the Abandon prompt (and force-deletes) even if
  // whatever triggered the earlier 409 no longer applies.
  it("resets the force prompt back to a plain delete after Cancel", async () => {
    deleteTask.mockRejectedValueOnce(
      new ApiError("Cannot delete: this task has a preserved branch — use Retry to resume it", 409),
    );
    tasks = [makeTask({ id: 1, status: "failed", issueNumber: 42 })];
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Delete task" }));
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));
    await screen.findByRole("button", { name: "Abandon task" });

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Delete task" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete task" }));
    expect(screen.getByRole("button", { name: "Confirm delete" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abandon task" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Confirm delete" }));
    expect(deleteTask).toHaveBeenLastCalledWith(1);
  });

  // #746 — done tasks (local and GitHub-linked) get the same Delete
  // affordance, with confirm copy noting the branch is untouched (and, for
  // GitHub-linked, that the closed issue and its PR stay on GitHub — not
  // "merged PR": approveTask only requests a merge when the project has
  // mergeOnApprove on, so a done task's PR is often still open).
  it("shows Delete for a done local task, with branch-untouched confirm copy", async () => {
    tasks = [makeTask({ id: 1, status: "done", issueNumber: null })];
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Delete task" }));
    expect(screen.getByText(/The branch is untouched/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));

    expect(deleteTask).toHaveBeenCalledWith(1);
  });

  it("shows Delete for a done GitHub-linked task, with closed-issue confirm copy", async () => {
    tasks = [makeTask({ id: 1, status: "done", issueNumber: 42 })];
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Delete task" }));
    expect(
      screen.getByText(/closed issue and its PR stay on GitHub, and the branch is untouched/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));

    expect(deleteTask).toHaveBeenCalledWith(1);
  });

  describe("agent selection and display", () => {
    it("renders agent dropdowns for backlog tasks and calls updateTask on change", async () => {
      tasks = [makeTask({ id: 1, status: "backlog", agent: null, reviewAgent: null })];
      const user = userEvent.setup();
      render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

      await screen.findAllByRole("option", { name: "Claude Code" });
      const selects = screen.getAllByRole("combobox");
      expect(selects.length).toBe(2);
      // Hermes review — the resolved "none" default renders capitalized as
      // "None" in the dropdown label, so it reads as "no review agent" rather
      // than a lowercase agent name.
      expect(screen.getByRole("option", { name: "Project default (None)" })).toBeInTheDocument();

      await user.selectOptions(selects[0], "claude");
      expect(updateTask).toHaveBeenCalledWith(1, { agent: "claude" });

      await user.selectOptions(selects[1], "none");
      expect(updateTask).toHaveBeenCalledWith(1, { reviewAgent: "none" });
    });

    it("renders agent dropdowns for failed tasks so user can adjust agent before retrying", async () => {
      tasks = [makeTask({ id: 1, status: "failed", agent: "claude", reviewAgent: null })];
      const user = userEvent.setup();
      render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

      await screen.findAllByRole("option", { name: "Claude Code" });
      const selects = screen.getAllByRole("combobox");
      expect(selects.length).toBe(2);

      await user.selectOptions(selects[0], "codex");
      expect(updateTask).toHaveBeenCalledWith(1, { agent: "codex" });
    });

    it("renders static agent and review agent metadata for in_progress tasks", () => {
      tasks = [
        makeTask({
          id: 1,
          status: "in_progress",
          agent: "codex",
          reviewAgent: "agy",
          agentCommand: "codex",
        }),
      ];
      render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

      expect(screen.queryAllByRole("combobox")).toHaveLength(0);
      expect(screen.getByText("Agent: codex")).toBeInTheDocument();
      expect(screen.getByText("Review agent: agy")).toBeInTheDocument();
    });
  });
});
