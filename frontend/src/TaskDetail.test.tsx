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

function storeState() {
  return { tasks, sessions, events, taskMasterEnabled, claimTask, approveTask, rejectTask };
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

  it("disables Approve/Reject with a hint when taskMasterEnabled is off", () => {
    taskMasterEnabled = false;
    tasks = [makeTask({ id: 1, status: "reviewing" })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
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
