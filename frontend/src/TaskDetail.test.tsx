// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskDetail } from "./TaskDetail.js";
import type { NotificationEvent, Session, Task } from "./api.js";

let tasks: Task[];
let sessions: Session[];
let events: Record<number, NotificationEvent[]>;
let taskMasterEnabled: boolean;

const claimTask = vi.fn(async () => makeSession({ id: 99 }));
const approveTask = vi.fn(async () => makeTask({}));
const rejectTask = vi.fn(async () => makeTask({}));
const refreshTasks = vi.fn(async () => {});
const deleteTask = vi.fn(async () => {});

function storeState() {
  return {
    tasks,
    sessions,
    events,
    taskMasterEnabled,
    claimTask,
    approveTask,
    rejectTask,
    refreshTasks,
    deleteTask,
  };
}

vi.mock("./store.js", () => ({
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
    reviewSessionId: null,
    reviewSeedDelivered: null,
    worktreePath: null,
    branchName: null,
    agentCommand: null,
    prUrl: null,
    assignee: null,
    failureReason: null,
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
  claimTask.mockClear();
  approveTask.mockClear();
  rejectTask.mockClear();
  refreshTasks.mockClear();
  deleteTask.mockClear();
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

  it("shows the review (advisory) section only when reviewSessionId is set", () => {
    tasks = [makeTask({ id: 1, status: "reviewing", reviewSessionId: 5 })];
    sessions = [makeSession({ id: 5 })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.getByText("Review (advisory)")).toBeInTheDocument();
    expect(
      screen.getByText(/cannot approve, reject, or otherwise transition this task/),
    ).toBeInTheDocument();
  });

  it("does not show the review section for a task with no review agent configured", () => {
    tasks = [makeTask({ id: 1, status: "reviewing", reviewSessionId: null })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.queryByText("Review (advisory)")).toBeNull();
  });

  // #487 — the review agent used to spawn silently with no prompt when its
  // adapter couldn't receive a seed; this warning is what makes that visible.
  it("warns in the review section when reviewSeedDelivered is false", () => {
    tasks = [
      makeTask({ id: 1, status: "reviewing", reviewSessionId: 5, reviewSeedDelivered: false }),
    ];
    sessions = [makeSession({ id: 5 })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.getByText(/started with no instructions/)).toBeInTheDocument();
  });

  it("does not warn in the review section when reviewSeedDelivered is true", () => {
    tasks = [
      makeTask({ id: 1, status: "reviewing", reviewSessionId: 5, reviewSeedDelivered: true }),
    ];
    sessions = [makeSession({ id: 5 })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.queryByText(/started with no instructions/)).toBeNull();
  });
});

describe("TaskDetail claim action", () => {
  it("shows an enabled Claim button for a ready task and opens the spawned session", async () => {
    tasks = [makeTask({ id: 1, status: "ready" })];
    const onOpenSession = vi.fn();
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={onOpenSession} />);

    const claimBtn = screen.getByRole("button", { name: "Claim" });
    expect(claimBtn).not.toBeDisabled();
    await user.click(claimBtn);

    expect(claimTask).toHaveBeenCalledWith(1);
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 99 }));
  });

  it("disables Claim with a hint when taskMasterEnabled is off", () => {
    taskMasterEnabled = false;
    tasks = [makeTask({ id: 1, status: "ready" })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Claim" })).toBeDisabled();
    expect(screen.getByText(/Task Master is disabled/)).toBeInTheDocument();
  });

  it("renders no actions for a task past the ready/reviewing gate (e.g. claimed)", () => {
    tasks = [makeTask({ id: 1, status: "claimed" })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Claim" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
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
