// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskDetail } from "./TaskDetail.js";
import type { GitHubPRsStatus, NotificationEvent, Session, Task } from "./api/index.js";

let tasks: Task[];
let sessions: Session[];
let events: Record<number, NotificationEvent[]>;
let taskMasterEnabled: boolean;
let prsByProject: Record<number, GitHubPRsStatus | undefined>;

const claimTask = vi.fn(async () => makeSession({ id: 99 }));
const approveTask = vi.fn(async () => makeTask({}));
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
    claimTask,
    approveTask,
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
    reviewFindings: null,
    reviewRounds: 0,
    worktreePath: null,
    branchName: null,
    agentCommand: null,
    prUrl: null,
    prNumber: null,
    assignee: null,
    failureReason: null,
    githubSyncError: null,
    baseSha: null,
    dependencyCount: null,
    blockedState: "clear",
    blockers: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    claimedAt: null,
    startedAt: null,
    reviewingAt: null,
    completedAt: null,
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
  prsByProject = {};
  claimTask.mockClear();
  approveTask.mockClear();
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

  it("shows a round indicator once the review has auto-returned to the worker", () => {
    tasks = [makeTask({ id: 1, status: "in_progress", reviewSessionId: 5, reviewRounds: 1 })];
    sessions = [makeSession({ id: 5 })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.getByText(/Round 1 sent back to the worker automatically/)).toBeInTheDocument();
  });

  it("shows no round indicator before any auto-return has happened", () => {
    tasks = [makeTask({ id: 1, status: "reviewing", reviewSessionId: 5, reviewRounds: 0 })];
    sessions = [makeSession({ id: 5 })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.queryByText(/Round \d+ sent back to the worker automatically/)).toBeNull();
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
});
