// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UnifiedBoard } from "./UnifiedBoard.js";
import type {
  GitBranchesResult,
  GitDiffStats,
  GitHubPRsStatus,
  GitStatus,
  NotificationEvent,
  Project,
  Session,
  Task,
} from "./api.js";

// Merges KanbanBoard.test.tsx's and TasksPanel.test.tsx's own store mocks —
// UnifiedBoard reads value fields via a useShallow-grouped selector (the P1
// perf fix that replaced its old whole-store destructure) and calls its
// actions via useDashboardStore.getState() at each call site, while the
// SessionRows it mounts in the ad-hoc lane use individual selectors, and
// TaskDetail (stubbed below) would otherwise need its own
// claim/approve/reject/retry/give-up surface. The mock below serves all
// three call shapes the way the real zustand hook does: no selector ->
// whole state, a selector -> selector(state), .getState() -> whole state.
let sessions: Session[];
let projects: Project[];
let tasks: Task[];
let tasksLoaded: boolean;
let taskMasterEnabled: boolean;
let kanbanOrder: Record<string, number[]>;
let events: Record<number, NotificationEvent[]>;
let sessionGitStatuses: Record<number, GitStatus | null>;
let gitDiffStats: Record<number, GitDiffStats | null>;
let gitBranchesByProject: Record<number, GitBranchesResult | undefined>;
let prsByProject: Record<number, GitHubPRsStatus | undefined>;
let hideEndedSessions: boolean;

const setKanbanColumnOrder = vi.fn((columnId: string, order: number[]) => {
  kanbanOrder = { ...kanbanOrder, [columnId]: order };
});
const setViewMode = vi.fn();
const deleteSession = vi.fn(async () => {});
const refreshTasks = vi.fn(async () => {});
const updateTask = vi.fn(async () => makeTask({}));
const createTask = vi.fn(async () => makeTask({}));

function storeState() {
  return {
    sessions,
    projects,
    tasks,
    tasksLoaded,
    taskMasterEnabled,
    kanbanOrder,
    setKanbanColumnOrder,
    deleteSession,
    setViewMode,
    hideEndedSessions,
    refreshTasks,
    updateTask,
    createTask,
    settings: { sessions: { confirmBeforeKill: false } },
    theme: "dark",
    events,
    sessionGitStatuses,
    gitDiffStats,
    gitBranchesByProject,
    prsByProject,
  };
}

vi.mock("./store.js", () => {
  const useDashboardStore = (selector?: (s: unknown) => unknown) => {
    const state = storeState();
    return selector ? selector(state) : state;
  };
  // P1 perf fix moved UnifiedBoard's action call sites off this whole-store
  // subscription and onto useDashboardStore.getState() — the mock needs to
  // serve that call shape too, same as ProjectSection.test.tsx's own fix.
  useDashboardStore.getState = storeState;
  return { useDashboardStore };
});

// TaskDetail.test.tsx (546 lines) already covers TaskDetail comprehensively;
// stubbing it here keeps this file's mock from also having to grow
// claimTask/approveTask/rejectTask/retryTask/giveUpTask plus SessionTimeline's
// own reads. Only the drawer wiring (which taskId, does it open/close, and
// whether the drawer's own onOpenSession is really the board's wrapped
// openSession and not the raw prop) is this file's concern — the stub
// exposes a button that invokes whatever onOpenSession it was actually
// given, so a test can tell the two apart.
vi.mock("./TaskDetail.js", () => ({
  TaskDetail: ({
    params,
    onOpenSession,
  }: {
    params: { taskId: number };
    onOpenSession: (session: Session) => void;
  }) => (
    <div data-testid="task-detail-stub" data-task-id={params.taskId}>
      <button onClick={() => onOpenSession({ id: params.taskId } as Session)}>
        stub open session
      </button>
      {/* Mirrors TaskDetail's real Claim/Approve buttons, which render
          disabled when taskMasterEnabled is off — a disabled button that a
          querySelectorAll focus-trap counts as focusable but that .focus()
          can never actually land on. */}
      <button disabled>disabled stub action</button>
    </div>
  ),
}));

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

function makeProject(overrides: Partial<Project>): Project {
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
    defaultAgent: null,
    defaultReviewAgent: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    claimedAt: null,
    startedAt: null,
    reviewingAt: null,
    completedAt: null,
    ...overrides,
  };
}

// jsdom doesn't implement DataTransfer/DragEvent — mirrors KanbanBoard.test.tsx's
// and TasksPanel.test.tsx's own stub.
function createDataTransfer(data: Record<string, string> = {}): DataTransfer {
  const map = new Map<string, string>(Object.entries(data));
  return {
    setData(type, val) {
      map.set(type, val);
    },
    getData(type) {
      return map.get(type) ?? "";
    },
    get types() {
      return Array.from(map.keys());
    },
    effectAllowed: "none" as DataTransfer["effectAllowed"],
    dropEffect: "none" as DataTransfer["dropEffect"],
    clearData(format) {
      if (format) map.delete(format);
      else map.clear();
    },
    setDragImage() {},
    items: {} as DataTransfer["items"],
    files: {} as FileList,
  } as DataTransfer;
}

function createDragEvent(type: string, dataTransfer: DataTransfer): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as unknown as DragEvent;
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  return event;
}

beforeEach(() => {
  sessions = [];
  projects = [makeProject({ id: 1, name: "demo" }), makeProject({ id: 2, name: "other" })];
  tasks = [];
  // Defaults to "loaded" — this file's own concern is the board's rendered
  // content, not the loading-skeleton transition, which store.tasksLoaded.test.ts
  // covers directly. Individual tests override this to false where the
  // pre-load state matters.
  tasksLoaded = true;
  taskMasterEnabled = true;
  kanbanOrder = {};
  events = {};
  sessionGitStatuses = {};
  gitDiffStats = {};
  gitBranchesByProject = {};
  prsByProject = {};
  hideEndedSessions = false;
  setKanbanColumnOrder.mockClear();
  setViewMode.mockClear();
  deleteSession.mockClear();
  refreshTasks.mockClear();
  updateTask.mockClear();
  createTask.mockClear();
  // The detail drawer's width (UnifiedBoard.tsx) reads/writes
  // crs.taskDrawerWidth — same precedent as Dock.test.tsx's own
  // localStorage.clear(), so a resize left over from one test can't leak
  // its width into the next.
  localStorage.clear();
});

describe("UnifiedBoard task columns", () => {
  it("renders one column per TaskStatus with correct counts", () => {
    tasks = [
      makeTask({ id: 1, status: "backlog" }),
      makeTask({ id: 2, status: "ready" }),
      makeTask({ id: 3, status: "ready" }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const columns = screen.getAllByText(
      /^Backlog$|^Ready$|^Claimed$|^In Progress$|^Reviewing$|^Done$|^Failed$/,
      { selector: ".kanban-column-title" },
    );
    expect(columns).toHaveLength(7);

    const readyColumn = screen
      .getByText("Ready", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!;
    expect(readyColumn.querySelector(".kanban-column-count")?.textContent).toBe("2");
  });

  it("shows the project name, issue number, and agent on a card", () => {
    tasks = [
      makeTask({
        id: 1,
        status: "in_progress",
        issueNumber: 42,
        htmlUrl: "https://github.com/o/r/issues/42",
        agentCommand: "claude code --dangerously-skip-permissions",
      }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    expect(screen.getAllByText("demo").length).toBeGreaterThan(0);
    expect(screen.getByText("#42")).toBeInTheDocument();
    expect(screen.getByText("claude")).toBeInTheDocument();
  });

  it("shows the matched PR's number and CI status on a card, joined by branchName", () => {
    tasks = [makeTask({ id: 7, status: "reviewing", branchName: "mullion/task-7" })];
    prsByProject = {
      1: {
        prs: [
          {
            number: 12,
            title: "fix: the widget",
            htmlUrl: "https://github.com/o/r/pull/12",
            author: "mullion-bot",
            headSha: "abc123",
            headBranch: "mullion/task-7",
            baseBranch: "main",
            ciStatus: "success",
            actionsRuns: [],
          },
        ],
        prSummary: { total: 1, pass: 1, fail: 0, pending: 0, unknown: 0 },
      },
    };
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const link = screen.getByRole("link", { name: /#12/ });
    expect(link).toHaveAttribute("href", "https://github.com/o/r/pull/12");
    expect(link.querySelector(".github-panel-ci-dot.good")).toBeInTheDocument();
  });

  it("shows no PR badge when no open PR matches the task's branch", () => {
    tasks = [makeTask({ id: 7, status: "reviewing", branchName: "mullion/task-7" })];
    prsByProject = {
      1: {
        prs: [
          {
            number: 3,
            title: "unrelated",
            htmlUrl: "https://github.com/o/r/pull/3",
            author: "mullion-bot",
            headSha: "def456",
            headBranch: "some-other-branch",
            baseBranch: "main",
            ciStatus: "failure",
            actionsRuns: [],
          },
        ],
        prSummary: { total: 1, pass: 0, fail: 1, pending: 0, unknown: 0 },
      },
    };
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    expect(screen.queryByRole("link", { name: /#3/ })).toBeNull();
  });

  it("clicking the PR badge does not also open the task drawer", async () => {
    const user = userEvent.setup();
    tasks = [makeTask({ id: 7, status: "reviewing", branchName: "mullion/task-7" })];
    prsByProject = {
      1: {
        prs: [
          {
            number: 12,
            title: "fix: the widget",
            htmlUrl: "https://github.com/o/r/pull/12",
            author: "mullion-bot",
            headSha: "abc123",
            headBranch: "mullion/task-7",
            baseBranch: "main",
            ciStatus: "in_progress",
            actionsRuns: [],
          },
        ],
        prSummary: { total: 1, pass: 0, fail: 0, pending: 1, unknown: 0 },
      },
    };
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    await user.click(screen.getByRole("link", { name: /#12/ }));

    expect(screen.queryByTestId("task-detail-stub")).toBeNull();
  });

  // Hermes review, PR #577/#580 — the PR badge sits inside the draggable
  // card; a completed drag's trailing click lands on this anchor too, and
  // stopPropagation alone doesn't stop its default navigation.
  it("suppresses the PR badge's own default navigation after a card drag-and-drop, not just the drawer open", () => {
    tasks = [
      makeTask({
        id: 7,
        status: "reviewing",
        boardOrder: 0,
        title: "first",
        branchName: "mullion/task-7",
      }),
      makeTask({ id: 8, status: "reviewing", boardOrder: 1, title: "second" }),
    ];
    prsByProject = {
      1: {
        prs: [
          {
            number: 12,
            title: "fix: the widget",
            htmlUrl: "https://github.com/o/r/pull/12",
            author: "mullion-bot",
            headSha: "abc123",
            headBranch: "mullion/task-7",
            baseBranch: "main",
            ciStatus: "success",
            actionsRuns: [],
          },
        ],
        prSummary: { total: 1, pass: 1, fail: 0, pending: 0, unknown: 0 },
      },
    };
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const cards = document.querySelectorAll(".task-card");
    const dataTransfer = createDataTransfer({ "application/x-mullion-task": "7" });
    act(() => cards[0].dispatchEvent(createDragEvent("dragstart", dataTransfer)));
    cards[1].dispatchEvent(createDragEvent("drop", dataTransfer));
    cards[0].dispatchEvent(createDragEvent("dragend", dataTransfer));

    const link = screen.getByRole("link", { name: /#12/ });
    // fireEvent's return value is `!event.defaultPrevented` — false here
    // means preventDefault WAS called, i.e. the drag suppressed the badge's
    // own navigation too, not just the card's drawer-open handler.
    const notPrevented = fireEvent.click(link);
    expect(notPrevented).toBe(false);
    expect(screen.queryByTestId("task-detail-stub")).toBeNull();
  });

  it("shows a disabled-claim hint on a ready card when taskMasterEnabled is off", () => {
    taskMasterEnabled = false;
    tasks = [makeTask({ id: 1, status: "ready" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByText(/Task Master is off/)).toBeInTheDocument();
  });

  it("carries the full title as a tooltip for the (possibly clamped) card title", () => {
    tasks = [makeTask({ id: 1, title: "A very long task title that might get clamped" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByText("A very long task title that might get clamped")).toHaveAttribute(
      "title",
      "A very long task title that might get clamped",
    );
  });

  it("links the issue badge to the issue's htmlUrl", () => {
    tasks = [makeTask({ id: 1, issueNumber: 42, htmlUrl: "https://github.com/o/r/issues/42" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    const link = screen.getByRole("link", { name: /#42/ });
    expect(link).toHaveAttribute("href", "https://github.com/o/r/issues/42");
  });

  it("renders the issue badge as plain text (not a link) when htmlUrl is null", () => {
    tasks = [makeTask({ id: 1, issueNumber: 42, htmlUrl: null })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.queryByRole("link", { name: /#42/ })).toBeNull();
    expect(screen.getByText("#42")).toBeInTheDocument();
  });

  it("shows time in status, sourced from the timestamp matching the task's own column", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-03T00:00:00.000Z"));
    tasks = [
      makeTask({
        id: 1,
        status: "reviewing",
        createdAt: "2025-12-01T00:00:00.000Z",
        reviewingAt: "2026-01-02T00:00:00.000Z",
      }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    // reviewingAt (1 day before "now"), not the much-older createdAt.
    expect(screen.getByText("1d ago")).toBeInTheDocument();
    vi.useRealTimers();
  });

  // Hermes review — a Failed task falls into the same createdAt fallback
  // as backlog/ready, but "how long has this been sitting here" isn't the
  // right story for it: a task can run for weeks and fail yesterday, and a
  // bare age would misleadingly read as if it just failed. There's no
  // failedAt column to read instead, so the label is qualified rather than
  // the timestamp source changed.
  it("qualifies the age as 'created' rather than a bare duration on a failed card", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-08T00:00:00.000Z"));
    tasks = [makeTask({ id: 1, status: "failed", createdAt: "2025-12-18T00:00:00.000Z" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByText("created 21d ago")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("shows a bare duration (not 'created') for a non-failed card using the same createdAt fallback", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-08T00:00:00.000Z"));
    tasks = [makeTask({ id: 1, status: "backlog", createdAt: "2025-12-18T00:00:00.000Z" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByText("21d ago")).toBeInTheDocument();
    expect(screen.queryByText("created 21d ago")).toBeNull();
    vi.useRealTimers();
  });

  it("shows a warning glyph with an accessible name for a task with a GitHub sync error", () => {
    tasks = [makeTask({ id: 1, githubSyncError: "401 Unauthorized" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByTitle("GitHub sync: 401 Unauthorized")).toBeInTheDocument();
    // Hermes review — this was an icon-only span with no accessible name;
    // the title tooltip alone doesn't reach screen readers.
    expect(screen.getByLabelText("GitHub sync error: 401 Unauthorized")).toBeInTheDocument();
  });

  it("shows the failure reason on a failed card", () => {
    tasks = [makeTask({ id: 1, status: "failed", failureReason: "budget exceeded" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByText("budget exceeded")).toBeInTheDocument();
  });

  it("shows a review-round indicator once a reviewing task has been auto-returned to the worker", () => {
    tasks = [makeTask({ id: 1, status: "reviewing", reviewRounds: 1 })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByText(/Round 1/)).toBeInTheDocument();
  });

  it("shows no review-round indicator before any auto-return has happened", () => {
    tasks = [makeTask({ id: 1, status: "reviewing", reviewRounds: 0 })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.queryByText(/Round/)).toBeNull();
  });

  it("shows 'No tasks yet.' with the mullion-task hint when there are no tasks", () => {
    tasks = [];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByText("No tasks yet.")).toBeInTheDocument();
    expect(screen.getByText(/mullion-task/)).toBeInTheDocument();
  });

  // store.tasksLoaded.test.ts covers the flag's own semantics; this is the
  // consumer side — without gating on it, this message flashed on every
  // single board open (tasks always starts as [] until the mount effect's
  // own refreshTasks() lands), not just on a genuinely empty board.
  it("does not show 'No tasks yet.' before the first refreshTasks() attempt has landed", () => {
    tasks = [];
    tasksLoaded = false;
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.queryByText("No tasks yet.")).toBeNull();
  });

  it("still renders the seven columns while tasksLoaded is false", () => {
    tasks = [];
    tasksLoaded = false;
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(
      screen.getAllByText(/^Backlog$|^Ready$|^Claimed$|^In Progress$|^Reviewing$|^Done$|^Failed$/, {
        selector: ".kanban-column-title",
      }),
    ).toHaveLength(7);
  });

  it("calls refreshTasks on mount", () => {
    tasks = [makeTask({ id: 1 })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(refreshTasks).toHaveBeenCalled();
  });
});

describe("UnifiedBoard task create form", () => {
  it("creates a task via the toolbar form", async () => {
    tasks = [makeTask({ id: 1 })];
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /New task/ }));
    await user.type(screen.getByPlaceholderText("Task title"), "New local task");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(createTask).toHaveBeenCalledWith(1, "New local task");
  });

  it("shows an error and re-enables Create when createTask rejects", async () => {
    createTask.mockRejectedValueOnce(new Error("network down"));
    tasks = [makeTask({ id: 1 })];
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /New task/ }));
    await user.type(screen.getByPlaceholderText("Task title"), "New local task");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(screen.getByText("Failed to create task")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).not.toBeDisabled();
    expect(screen.getByPlaceholderText("Task title")).toHaveValue("New local task");
  });

  it("disables Create and shows 'Creating…' while the request is in flight", async () => {
    let resolveCreate: (() => void) | undefined;
    createTask.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCreate = () => resolve(makeTask({}));
        }),
    );
    tasks = [makeTask({ id: 1 })];
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /New task/ }));
    await user.type(screen.getByPlaceholderText("Task title"), "New local task");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Creating…" }));
    expect(createTask).toHaveBeenCalledTimes(1);

    resolveCreate!();
    await vi.waitFor(() => expect(screen.queryByPlaceholderText("Task title")).toBeNull());
  });
});

describe("UnifiedBoard task drag-and-drop", () => {
  it("persists a same-column reorder via updateTask boardOrder, no status change", () => {
    tasks = [
      makeTask({ id: 1, status: "ready", boardOrder: 0, title: "first" }),
      makeTask({ id: 2, status: "ready", boardOrder: 1, title: "second" }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const readyColumn = screen
      .getByText("Ready", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!;
    const cards = readyColumn.querySelectorAll(".task-card");
    expect(cards).toHaveLength(2);

    const dataTransfer = createDataTransfer({ "application/x-mullion-task": "1" });
    act(() => cards[0].dispatchEvent(createDragEvent("dragstart", dataTransfer)));
    cards[1].dispatchEvent(createDragEvent("drop", dataTransfer));

    expect(updateTask).toHaveBeenCalledWith(1, { boardOrder: 1 });
    expect(updateTask).toHaveBeenCalledWith(2, { boardOrder: 0 });
  });

  // Hermes review — a completed HTML5 drag-and-drop still fires a plain
  // click on the source element right after dragend. Without a guard, a
  // drag-reorder would also pop the task's drawer open uninvited.
  it("suppresses the click that follows a completed drag-reorder, so it doesn't also open the drawer", () => {
    tasks = [
      makeTask({ id: 1, status: "ready", boardOrder: 0, title: "first" }),
      makeTask({ id: 2, status: "ready", boardOrder: 1, title: "second" }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const readyColumn = screen
      .getByText("Ready", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!;
    const cards = readyColumn.querySelectorAll(".task-card");

    const dataTransfer = createDataTransfer({ "application/x-mullion-task": "1" });
    act(() => cards[0].dispatchEvent(createDragEvent("dragstart", dataTransfer)));
    cards[1].dispatchEvent(createDragEvent("drop", dataTransfer));
    cards[0].dispatchEvent(createDragEvent("dragend", dataTransfer));

    fireEvent.click(cards[0]);
    expect(screen.queryByTestId("task-detail-stub")).toBeNull();
  });

  it("persists a cross-column drag between backlog and ready with a status patch", () => {
    tasks = [makeTask({ id: 1, status: "backlog", boardOrder: 0, title: "solo" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const backlogCard = screen
      .getByText("Backlog", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!
      .querySelector(".task-card")!;
    const readyColumnBody = screen
      .getByText("Ready", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!
      .querySelector(".kanban-column-body")!;

    const dataTransfer = createDataTransfer({ "application/x-mullion-task": "1" });
    act(() => backlogCard.dispatchEvent(createDragEvent("dragstart", dataTransfer)));
    readyColumnBody.dispatchEvent(createDragEvent("drop", dataTransfer));

    expect(updateTask).toHaveBeenCalledWith(1, { boardOrder: 0, status: "ready" });
  });

  it("does not persist a drop into a non-drag-editable column (e.g. Done)", () => {
    tasks = [makeTask({ id: 1, status: "ready", boardOrder: 0 })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const readyCard = screen
      .getByText("Ready", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!
      .querySelector(".task-card")!;
    const doneColumnBody = screen
      .getByText("Done", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!
      .querySelector(".kanban-column-body")!;

    const dataTransfer = createDataTransfer({ "application/x-mullion-task": "1" });
    act(() => readyCard.dispatchEvent(createDragEvent("dragstart", dataTransfer)));
    doneColumnBody.dispatchEvent(createDragEvent("drop", dataTransfer));

    expect(updateTask).not.toHaveBeenCalled();
  });

  it("does not persist a drop FROM a non-drag-editable column into ready (source-side guard)", () => {
    tasks = [makeTask({ id: 1, status: "done", boardOrder: 0 })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const doneCard = screen
      .getByText("Done", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!
      .querySelector(".task-card")!;
    const readyColumnBody = screen
      .getByText("Ready", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!
      .querySelector(".kanban-column-body")!;

    const dataTransfer = createDataTransfer({ "application/x-mullion-task": "1" });
    act(() => doneCard.dispatchEvent(createDragEvent("dragstart", dataTransfer)));
    readyColumnBody.dispatchEvent(createDragEvent("drop", dataTransfer));

    expect(updateTask).not.toHaveBeenCalled();
  });

  it("does nothing when the dragged payload isn't a mullion task id", () => {
    tasks = [
      makeTask({ id: 1, status: "ready", boardOrder: 0, title: "first" }),
      makeTask({ id: 2, status: "ready", boardOrder: 1, title: "second" }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const readyColumn = screen
      .getByText("Ready", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!;
    const cards = readyColumn.querySelectorAll(".task-card");

    const dataTransfer = createDataTransfer({ "text/plain": "not a task" });
    cards[1].dispatchEvent(createDragEvent("drop", dataTransfer));

    expect(updateTask).not.toHaveBeenCalled();
  });

  it("only highlights a column as a drop target when the drag is actually valid there", () => {
    tasks = [makeTask({ id: 1, status: "ready", boardOrder: 0 })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const readyCard = screen
      .getByText("Ready", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!
      .querySelector(".task-card")!;
    const doneColumnBody = screen
      .getByText("Done", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!
      .querySelector(".kanban-column-body")!;
    const backlogColumnBody = screen
      .getByText("Backlog", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!
      .querySelector(".kanban-column-body")!;

    const dataTransfer = createDataTransfer({ "application/x-mullion-task": "1" });
    act(() => readyCard.dispatchEvent(createDragEvent("dragstart", dataTransfer)));

    act(() => doneColumnBody.dispatchEvent(createDragEvent("dragover", dataTransfer)));
    expect(doneColumnBody.classList.contains("kanban-card-drop-target")).toBe(false);

    act(() => backlogColumnBody.dispatchEvent(createDragEvent("dragover", dataTransfer)));
    expect(backlogColumnBody.classList.contains("kanban-card-drop-target")).toBe(true);
  });
});

describe("UnifiedBoard nested task session strip", () => {
  it("renders a live worker strip for task.sessionId and excludes it from the ad-hoc lane", () => {
    sessions = [makeSession({ id: 7, projectId: 1, command: "claude", sessionStatus: "working" })];
    tasks = [makeTask({ id: 1, status: "in_progress", sessionId: 7 })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    expect(screen.getByText("worker · Working")).toBeInTheDocument();
    // Ad-hoc lane must report no sessions — the linked one is nested on its
    // task's card instead.
    expect(screen.getByText("No sessions without a task.")).toBeInTheDocument();
  });

  // Hermes review — rowClassNameForSeverity's class was applied to the card
  // and strip in JS but had no matching CSS rule (it was only ever styled
  // under `.session-item.status-*`), so the "blocked worker visible at
  // column-scan distance" mitigation was a silent no-op. styles.css now has
  // matching `.task-card.status-*`/`.task-card-session-strip.status-*`
  // rules; this asserts the JS side actually applies the class name they
  // target, closing the loop between the two.
  it("hoists a blocked worker's severity class onto both the card and its strip", () => {
    sessions = [
      makeSession({
        id: 7,
        projectId: 1,
        command: "claude",
        sessionStatus: "api_error",
        sessionStatusSeverity: "failed",
      }),
    ];
    tasks = [makeTask({ id: 1, status: "in_progress", sessionId: 7 })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    expect(document.querySelector(".task-card.status-attention")).not.toBeNull();
    expect(document.querySelector(".task-card-session-strip.status-attention")).not.toBeNull();
  });

  it("renders a distinct, labelled review strip alongside the worker strip", () => {
    sessions = [
      makeSession({ id: 7, projectId: 1, command: "claude", sessionStatus: "working" }),
      makeSession({ id: 8, projectId: 1, command: "codex", sessionStatus: "idle" }),
    ];
    tasks = [makeTask({ id: 1, status: "reviewing", sessionId: 7, reviewSessionId: 8 })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const strips = Array.from(document.querySelectorAll(".task-card-session-strip"));
    expect(strips).toHaveLength(2);
    // Each strip's title attribute carries its own role ("worker"/"review")
    // and its own live status — this is what actually makes them distinct
    // rather than two copies of the same content.
    expect(strips.map((s) => s.getAttribute("title"))).toEqual(["worker: Working", "review: Idle"]);
    // Hermes review — the role also needs to be in the VISIBLE text, not
    // just title/aria-label on a non-focusable, roleless span that screen
    // readers may not reliably expose.
    expect(strips.map((s) => s.textContent)).toEqual(["worker · Working", "review · Idle"]);
  });

  it("renders a muted 'ended' chip when the linked session is no longer in sessions", () => {
    sessions = [];
    tasks = [makeTask({ id: 1, status: "in_progress", sessionId: 999 })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const strip = document.querySelector(".task-card-session-strip.is-gone");
    expect(strip).not.toBeNull();
    expect(strip?.textContent).toContain("ended");
  });

  it("clicking the strip switches to list view and opens the session, not the drawer", async () => {
    sessions = [makeSession({ id: 7, projectId: 1, command: "claude" })];
    tasks = [makeTask({ id: 1, status: "in_progress", sessionId: 7 })];
    const onOpenSession = vi.fn();
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={onOpenSession} onSessionEnded={vi.fn()} />);

    const strip = document.querySelector(".task-card-session-strip")!;
    await user.click(strip);

    expect(setViewMode).toHaveBeenCalledWith("list");
    expect(onOpenSession).toHaveBeenCalledWith(sessions[0]);
    // Order matters, not just that both were called: the board is a
    // z-index-100 overlay, so a session opened before the view switches
    // away from "kanban" would render its terminal invisibly behind it.
    expect(setViewMode.mock.invocationCallOrder[0]).toBeLessThan(
      onOpenSession.mock.invocationCallOrder[0],
    );
    expect(screen.queryByTestId("task-detail-stub")).toBeNull();
  });

  // Hermes review — the strip used to be draggable with the session MIME
  // on the (wrong) assumption there was no reachable drop target for it
  // inside the board. The ad-hoc lane's own LaneCard accepts exactly that
  // MIME for its reorder: dropping a task-linked strip there highlighted a
  // valid target, silently no-op'd (task-linked ids are excluded from every
  // lane column), and a completed drag's stray click then opened the
  // session — actively navigating the user out of the board, not a
  // harmlessly dead affordance. Fixed by not making the strip draggable at
  // all; this asserts that fix rather than the removed behavior.
  it("is not draggable, so it can never be dropped onto a lane card", () => {
    sessions = [makeSession({ id: 7, projectId: 1, command: "claude" })];
    tasks = [makeTask({ id: 1, status: "in_progress", sessionId: 7 })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const strip = document.querySelector(".task-card-session-strip")!;
    expect(strip.getAttribute("draggable")).not.toBe("true");
  });

  // The strip previously nested a role="button"/tabIndex={0} element inside
  // the task card's own role="button" — two independently-focusable
  // interactive elements with unrelated actions. It's mouse-only now (the
  // card's own keyboard activation opens the drawer instead), so it must
  // not be a separate tab stop.
  it("is not its own tab stop (avoids nesting inside the card's own button role)", () => {
    sessions = [makeSession({ id: 7, projectId: 1, command: "claude" })];
    tasks = [makeTask({ id: 1, status: "in_progress", sessionId: 7 })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const strip = document.querySelector(".task-card-session-strip")!;
    expect(strip.getAttribute("role")).not.toBe("button");
    expect(strip.getAttribute("tabindex")).toBeNull();
  });
});

describe("UnifiedBoard detail drawer", () => {
  it("opens the drawer with the right taskId when a card body is clicked, and closes it", async () => {
    tasks = [makeTask({ id: 5, status: "ready", title: "Open me" })];
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    expect(screen.queryByTestId("task-detail-stub")).toBeNull();
    await user.click(screen.getByText("Open me"));

    const stub = screen.getByTestId("task-detail-stub");
    expect(stub.dataset.taskId).toBe("5");

    await user.click(screen.getByLabelText("Close task detail"));
    expect(screen.queryByTestId("task-detail-stub")).toBeNull();
  });

  it("passes the board's wrapped openSession (not the raw prop) to TaskDetail", async () => {
    tasks = [makeTask({ id: 5, status: "ready", title: "Open me" })];
    const onOpenSession = vi.fn();
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={onOpenSession} onSessionEnded={vi.fn()} />);

    await user.click(screen.getByText("Open me"));
    await user.click(screen.getByText("stub open session"));

    // If the drawer ever received the raw onOpenSession prop directly
    // instead of the board's setViewMode-then-onOpenSession wrapper,
    // setViewMode would not be called here — Claim/Retry from the drawer
    // would then open a terminal panel invisible behind the board's own
    // z-index-100 overlay.
    expect(setViewMode).toHaveBeenCalledWith("list");
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 5 }));
    expect(setViewMode.mock.invocationCallOrder[0]).toBeLessThan(
      onOpenSession.mock.invocationCallOrder[0],
    );
  });

  // Independent review — this cleanup also runs on UnifiedBoard's own
  // unmount, not just a normal drawer close: openSession calls
  // setViewMode("list") before onOpenSession, and App.tsx only renders
  // UnifiedBoard while viewMode === "kanban", so opening a session from
  // inside the drawer (or from a strip on another card while a drawer is
  // open) unmounts the whole board with detailTaskId still set. By then the
  // triggering card has already been detached along with the rest of the
  // tree, so calling .focus() on it is a no-op; isConnected skips that call
  // rather than fighting a view switch already in flight.
  it("skips the no-op focus-restore when the board unmounts instead of a normal drawer close", async () => {
    tasks = [makeTask({ id: 5, status: "ready", title: "Open me" })];
    const user = userEvent.setup();
    const { unmount } = render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const card = screen.getByText("Open me").closest(".task-card") as HTMLElement;

    await user.click(card);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Spy after the opening click (which itself focuses the card as part of
    // simulating a real pointer interaction) — only the cleanup's own call
    // is under test here.
    const focusSpy = vi.spyOn(card, "focus");
    expect(() => unmount()).not.toThrow();
    expect(focusSpy).not.toHaveBeenCalled();
  });

  // Hermes review — the drawer was a bare <aside> with no dialog semantics:
  // no role="dialog", focus never moved in on open, and it was never
  // restored on close.
  it("has dialog semantics, moves focus in on open, and restores it on close", async () => {
    tasks = [makeTask({ id: 5, status: "ready", title: "Open me" })];
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const card = screen.getByText("Open me").closest(".task-card") as HTMLElement;
    card.focus();
    await user.click(card);

    const dialog = screen.getByRole("dialog", { name: "Task detail" });
    // Deliberately NOT aria-modal — Hermes review: the background is not
    // actually inert (clicking another card switches the drawer's task by
    // design, there's no backdrop), and ARIA APG requires aria-modal only
    // when the background truly is inert. role="dialog" plus the existing
    // focus management is honest about what this drawer actually is.
    expect(dialog).not.toHaveAttribute("aria-modal");
    expect(screen.getByLabelText("Close task detail")).toHaveFocus();

    await user.click(screen.getByLabelText("Close task detail"));
    expect(card).toHaveFocus();
  });

  // Hermes review — Escape used to be a window-level listener, so it also
  // closed the drawer for a keypress meant for an unrelated modal (e.g. the
  // command palette) sitting above the board. Scoping it to the drawer's
  // own onKeyDown means it only fires when focus is actually inside it.
  it("closes on Escape only when focus is inside the drawer, not from elsewhere", async () => {
    tasks = [makeTask({ id: 5, status: "ready", title: "Open me" })];
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    await user.click(screen.getByText("Open me"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // An Escape dispatched outside the dialog (nothing inside it focused)
    // must not close it - this is what proves the handler is scoped to the
    // drawer's own subtree via bubbling, not attached to window.
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // A disabled button (e.g. TaskDetail's Claim/Approve when Task Master is
  // off) can't actually receive focus — a trap that treats it as focusable
  // anyway "wraps" onto a dead end and leaves focus stuck instead.
  it("skips disabled elements when computing the Tab focus-trap boundaries", async () => {
    tasks = [makeTask({ id: 5, status: "ready", title: "Open me" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    await userEvent.setup().click(screen.getByText("Open me"));

    const closeButton = screen.getByLabelText("Close task detail");
    const stubOpenButton = screen.getByText("stub open session");
    expect(closeButton).toHaveFocus();

    fireEvent.keyDown(closeButton, { key: "Tab", shiftKey: true });
    expect(stubOpenButton).toHaveFocus();
  });

  // Switching straight from one card's drawer to another's must not lose
  // the original click target: React runs the outgoing drawer's cleanup
  // (which restores focus to whatever was captured) before the incoming
  // drawer's effect body runs, so capturing "last focused" inside the
  // effect itself would read the element focus was just moved BACK to,
  // not the card that was actually clicked to open the new drawer.
  it("restores focus to the second card, not the first, after switching drawers directly", async () => {
    tasks = [
      makeTask({ id: 5, status: "ready", title: "First task" }),
      makeTask({ id: 6, status: "ready", title: "Second task" }),
    ];
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const firstCard = screen.getByText("First task").closest(".task-card") as HTMLElement;
    const secondCard = screen.getByText("Second task").closest(".task-card") as HTMLElement;

    firstCard.focus();
    await user.click(firstCard);
    expect(screen.getByTestId("task-detail-stub").dataset.taskId).toBe("5");

    secondCard.focus();
    await user.click(secondCard);
    expect(screen.getByTestId("task-detail-stub").dataset.taskId).toBe("6");

    await user.click(screen.getByLabelText("Close task detail"));
    expect(secondCard).toHaveFocus();
  });
});

// Hermes review — a first version of this PR claimed the drawer was
// "resizable via a drag handle ... clamped against the measured board
// width" with no implementation to back it up: no handle, no width state,
// no clamp, no test. This suite covers the actual implementation.
describe("UnifiedBoard detail drawer resize", () => {
  it("renders the resize handle only while the drawer is open", async () => {
    tasks = [makeTask({ id: 5, status: "ready", title: "Open me" })];
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    expect(document.querySelector(".kanban-detail-resize-handle")).toBeNull();
    await user.click(screen.getByText("Open me"));
    expect(document.querySelector(".kanban-detail-resize-handle")).toBeInTheDocument();
  });

  it("grows the drawer on a leftward drag and persists the width to localStorage", () => {
    tasks = [makeTask({ id: 5, status: "ready", title: "Open me" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    fireEvent.click(screen.getByText("Open me"));

    const main = document.querySelector(".kanban-unified-main") as HTMLElement;
    // jsdom does no layout, so clientWidth is 0 by default — mocked here to
    // a realistic board width so the clamp (container width - 240px column
    // reserve) doesn't immediately floor every resize to MIN_DRAWER_WIDTH.
    Object.defineProperty(main, "clientWidth", { value: 1600, configurable: true });
    const handle = document.querySelector(".kanban-detail-resize-handle") as HTMLElement;

    fireEvent.mouseDown(handle, { clientX: 800 });
    expect(document.body.style.cursor).toBe("col-resize");
    // Handle sits on the drawer's LEFT border — dragging left (clientX
    // decreases) grows the drawer, same direction Dock.tsx's own height
    // handle uses on its own axis.
    fireEvent.mouseMove(window, { clientX: 750 });
    fireEvent.mouseUp(window);

    expect(document.body.style.cursor).toBe("");
    expect(main.style.getPropertyValue("--task-drawer-width")).toBe("430px");
    expect(localStorage.getItem("crs.taskDrawerWidth")).toBe("430");
  });

  // Independent review — the only assertion the drag test above makes on
  // localStorage is its FINAL value after mouseup, which would still pass
  // even if the persist effect's own dependency array were accidentally
  // widened to write on every intermediate value during the drag (exactly
  // what its `eslint-disable-next-line react-hooks/exhaustive-deps` exists
  // to prevent). This asserts the width var updates live but nothing is
  // written to localStorage until the drag actually ends.
  it("does not write to localStorage mid-drag, only once the drag ends", () => {
    tasks = [makeTask({ id: 5, status: "ready", title: "Open me" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    fireEvent.click(screen.getByText("Open me"));

    const main = document.querySelector(".kanban-unified-main") as HTMLElement;
    Object.defineProperty(main, "clientWidth", { value: 1600, configurable: true });
    const handle = document.querySelector(".kanban-detail-resize-handle") as HTMLElement;

    fireEvent.mouseDown(handle, { clientX: 800 });
    fireEvent.mouseMove(window, { clientX: 750 });
    expect(main.style.getPropertyValue("--task-drawer-width")).toBe("430px");
    expect(localStorage.getItem("crs.taskDrawerWidth")).toBeNull();

    fireEvent.mouseUp(window);
    expect(localStorage.getItem("crs.taskDrawerWidth")).toBe("430");
  });

  it("clamps the drawer width so at least one column stays visible", () => {
    tasks = [makeTask({ id: 5, status: "ready", title: "Open me" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    fireEvent.click(screen.getByText("Open me"));

    const main = document.querySelector(".kanban-unified-main") as HTMLElement;
    // A narrow board (500px) reserves 240px for columns, capping the
    // drawer at 260px — below MIN_DRAWER_WIDTH (300), so the floor wins.
    Object.defineProperty(main, "clientWidth", { value: 500, configurable: true });
    const handle = document.querySelector(".kanban-detail-resize-handle") as HTMLElement;

    fireEvent.mouseDown(handle, { clientX: 800 });
    fireEvent.mouseMove(window, { clientX: 0 });
    fireEvent.mouseUp(window);

    expect(main.style.getPropertyValue("--task-drawer-width")).toBe("300px");
  });

  it("restores a persisted width on mount", async () => {
    localStorage.setItem("crs.taskDrawerWidth", "500");
    tasks = [makeTask({ id: 5, status: "ready", title: "Open me" })];
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    await user.click(screen.getByText("Open me"));
    const main = document.querySelector(".kanban-unified-main") as HTMLElement;
    expect(main.style.getPropertyValue("--task-drawer-width")).toBe("500px");
  });
});

describe("UnifiedBoard ad-hoc session lane", () => {
  it("groups unlinked sessions into severity sub-groups", () => {
    sessions = [
      makeSession({ id: 1, projectId: 1, command: "working-one" }),
      makeSession({
        id: 2,
        projectId: 1,
        command: "attn-one",
        sessionStatus: "needs_input",
        sessionStatusSeverity: "waiting",
      }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    expect(screen.getByText("working-one")).toBeInTheDocument();
    expect(screen.getByText("attn-one")).toBeInTheDocument();
    expect(screen.getByText("Needs Attention")).toBeInTheDocument();
  });

  it("shows the lane empty state when every sub-group is empty", () => {
    sessions = [];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByText("No sessions without a task.")).toBeInTheDocument();
  });

  // Hermes review — adhocSessionsByColumn has no project data to check, so
  // a session whose project has since been deleted was still counted in
  // laneTotal even though its own render loop skips it (`if (!project)
  // return null`), making the header count exceed what's actually visible.
  it("excludes sessions with a missing project from the lane header count", () => {
    sessions = [
      makeSession({ id: 1, projectId: 1, command: "has-project" }),
      makeSession({ id: 2, projectId: 999, command: "deleted-project" }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const button = screen.getByRole("button", { name: /Ad-hoc sessions/ });
    expect(button.parentElement?.querySelector(".kanban-lane-count")?.textContent).toBe("1");
    expect(screen.getByText("has-project")).toBeInTheDocument();
    expect(screen.queryByText("deleted-project")).toBeNull();
  });

  // Hermes review — the aggregate header fixed above filters by
  // projectsById, but the per-group title count next to each severity
  // sub-group's own heading didn't, so the same inconsistency could show
  // up one level down (a group whose only session has a deleted project
  // would show "1" next to its title with zero cards under it).
  it("excludes sessions with a missing project from each sub-group's own count", () => {
    sessions = [
      makeSession({
        id: 1,
        projectId: 1,
        command: "has-project",
        sessionStatusSeverity: "waiting",
      }),
      makeSession({
        id: 2,
        projectId: 999,
        command: "deleted-project",
        sessionStatusSeverity: "waiting",
      }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const attnTitle = screen.getByText("Needs Attention").closest(".kanban-lane-group-title");
    expect(attnTitle?.querySelector("span")?.textContent).toBe("1");
    expect(screen.getByText("has-project")).toBeInTheDocument();
    expect(screen.queryByText("deleted-project")).toBeNull();
  });

  // Hermes review — a group whose every session lost its project rendered
  // an empty header (title + a stale "0"/positive count, no cards under
  // it), since the outer group filter used the raw unfiltered session
  // list. The whole group must not render at all in that case.
  it("does not render a sub-group at all when every session in it has a missing project", () => {
    sessions = [
      makeSession({ id: 1, projectId: 1, command: "has-project" }),
      makeSession({
        id: 2,
        projectId: 999,
        command: "deleted-project",
        sessionStatusSeverity: "waiting",
      }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    expect(screen.queryByText("Needs Attention")).toBeNull();
    expect(screen.getByText("has-project")).toBeInTheDocument();
  });

  it("points the collapse button's aria-controls at the lane body it toggles", () => {
    sessions = [makeSession({ id: 1, command: "working-one" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const button = screen.getByRole("button", { name: /Ad-hoc sessions/ });
    const controlsId = button.getAttribute("aria-controls");
    expect(controlsId).toBeTruthy();
    expect(document.getElementById(controlsId!)).not.toBeNull();
  });

  it("collapses and re-expands the lane body when the collapse button is clicked", async () => {
    sessions = [makeSession({ id: 1, command: "working-one" })];
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const button = screen.getByRole("button", { name: /Ad-hoc sessions/ });
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById("kanban-lane-body")).not.toBeNull();

    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("kanban-lane-body")).toBeNull();
    expect(screen.queryByText("working-one")).toBeNull();

    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById("kanban-lane-body")).not.toBeNull();
    expect(screen.getByText("working-one")).toBeInTheDocument();
  });

  it("excludes dock sessions and honors hideEndedSessions", () => {
    hideEndedSessions = true;
    sessions = [
      makeSession({ id: 1, kind: "dock", command: "dock-monitor" }),
      makeSession({
        id: 2,
        status: "exited",
        sessionStatus: "exited",
        sessionStatusSeverity: "gone",
        command: "should-be-hidden",
      }),
      makeSession({ id: 3, command: "still-here" }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    expect(screen.queryByText("dock-monitor")).toBeNull();
    expect(screen.queryByText("should-be-hidden")).toBeNull();
    expect(screen.getByText("still-here")).toBeInTheDocument();
  });

  it("reorders lane cards within a severity sub-group via setKanbanColumnOrder", () => {
    sessions = [
      makeSession({ id: 1, projectId: 1, command: "first" }),
      makeSession({ id: 2, projectId: 1, command: "second" }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const cards = document.querySelectorAll(".kanban-lane-group .kanban-card");
    expect(cards).toHaveLength(2);

    const dataTransfer = createDataTransfer({ "application/x-mullion-session": "1" });
    act(() => cards[0].dispatchEvent(createDragEvent("dragstart", dataTransfer)));
    cards[1].dispatchEvent(createDragEvent("drop", dataTransfer));

    expect(setKanbanColumnOrder).toHaveBeenCalledWith("working", [2, 1]);
  });

  // Hermes review — dragover can only see dataTransfer.types, not the
  // dragged id, so a card couldn't tell on its own whether an incoming
  // drag started in its OWN severity group or a different one. Every group
  // sits contiguous in one lane (unlike KanbanBoard's separate columns),
  // so a card in a different group would still highlight as a valid
  // target and the drop would then silently no-op.
  it("does not accept a drop from a different severity sub-group", () => {
    sessions = [
      makeSession({ id: 1, projectId: 1, command: "attn-one", sessionStatusSeverity: "waiting" }),
      makeSession({ id: 2, projectId: 1, command: "working-one" }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const attnCard = screen.getByText("attn-one").closest(".kanban-card") as HTMLElement;
    const workingCard = screen.getByText("working-one").closest(".kanban-card") as HTMLElement;

    const dataTransfer = createDataTransfer({ "application/x-mullion-session": "1" });
    act(() => attnCard.dispatchEvent(createDragEvent("dragstart", dataTransfer)));
    workingCard.dispatchEvent(createDragEvent("drop", dataTransfer));

    expect(setKanbanColumnOrder).not.toHaveBeenCalled();
  });

  it("switches to list view and opens the session on a lane card click", async () => {
    sessions = [makeSession({ id: 1, projectId: 1, command: "click-me" })];
    const onOpenSession = vi.fn();
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={onOpenSession} onSessionEnded={vi.fn()} />);

    await user.click(screen.getByText("click-me"));

    expect(setViewMode).toHaveBeenCalledWith("list");
    expect(onOpenSession).toHaveBeenCalledWith(sessions[0]);
    expect(setViewMode.mock.invocationCallOrder[0]).toBeLessThan(
      onOpenSession.mock.invocationCallOrder[0],
    );
  });
});
