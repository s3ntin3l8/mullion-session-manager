// @vitest-environment jsdom
// UnifiedBoard's "New task" toolbar — split out of the former monolithic
// UnifiedBoard.test.tsx (PR 28, Wave 5 of
// .claude/plans/can-we-do-a-warm-cocke.md), owns every test that exercises
// TasksToolbar.tsx's own region. Still mounts the full `<UnifiedBoard>`
// (same reasoning as session-row/Header.test.tsx's own header comment) —
// TasksToolbar's `createTask` prop is threaded down from the board's own
// `useDashboardStore.getState().createTask`, so a full mount is the
// simplest way to exercise the real wiring without hand-building the prop.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UnifiedBoard } from "../UnifiedBoard.js";
import type {
  ClearDoneResult,
  GitBranchesResult,
  GitDiffStats,
  GitHubPRsStatus,
  GitStatus,
  NotificationEvent,
  Project,
  Session,
  Task,
} from "../api/index.js";
import { makeProject, makeTask } from "../test/fixtures.js";

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
const clearDoneTasks = vi.fn(async (): Promise<ClearDoneResult> => ({
  deleted: [],
  failed: [],
  branches: [],
  remaining: 0,
}));

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
    clearDoneTasks,
    settings: { sessions: { confirmBeforeKill: false } },
    theme: "dark",
    events,
    sessionGitStatuses,
    gitDiffStats,
    gitBranchesByProject,
    prsByProject,
  };
}

vi.mock("../store/index.js", () => {
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
// own reads.
vi.mock("../TaskDetail.js", () => ({
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
      <button disabled>disabled stub action</button>
    </div>
  ),
}));

beforeEach(() => {
  sessions = [];
  projects = [makeProject({ id: 1, name: "demo" }), makeProject({ id: 2, name: "other" })];
  tasks = [];
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
  clearDoneTasks.mockReset();
  clearDoneTasks.mockResolvedValue({ deleted: [], failed: [], branches: [], remaining: 0 });
  localStorage.clear();
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

// #746 — bulk "Clear done" affordance in the same toolbar.
describe("UnifiedBoard clear-done", () => {
  it("shows a confirm step before calling clearDoneTasks", async () => {
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Clear done" }));
    expect(screen.getByText(/can't be undone/)).toBeInTheDocument();
    expect(clearDoneTasks).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Confirm clear" }));
    expect(clearDoneTasks).toHaveBeenCalledWith({
      projectIds: undefined,
      deleteBranches: false,
    });
  });

  it("cancels back to the Clear done button without calling clearDoneTasks", async () => {
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Clear done" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("button", { name: "Clear done" })).toBeInTheDocument();
    expect(clearDoneTasks).not.toHaveBeenCalled();
  });

  it("passes deleteBranches: true when the checkbox is checked", async () => {
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Clear done" }));
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Confirm clear" }));

    expect(clearDoneTasks).toHaveBeenCalledWith({
      projectIds: undefined,
      deleteBranches: true,
    });
  });

  it("scopes projectIds to the active project filter", async () => {
    tasks = [makeTask({ id: 1, projectId: 1, status: "ready" })];
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    // Activate the project-1 chip in the sidebar-style filter bar.
    await user.click(screen.getByRole("button", { name: "demo" }));
    await user.click(screen.getByRole("button", { name: "Clear done" }));
    await user.click(screen.getByRole("button", { name: "Confirm clear" }));

    expect(clearDoneTasks).toHaveBeenCalledWith({ projectIds: [1], deleteBranches: false });
  });

  it("loops until remaining is 0, accumulating results across calls", async () => {
    clearDoneTasks
      .mockResolvedValueOnce({ deleted: [1, 2], failed: [], branches: [], remaining: 1 })
      .mockResolvedValueOnce({ deleted: [3], failed: [], branches: [], remaining: 0 });
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Clear done" }));
    await user.click(screen.getByRole("button", { name: "Confirm clear" }));

    await vi.waitFor(() => expect(clearDoneTasks).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Cleared 3 done task(s).")).toBeInTheDocument();
  });

  it("renders the per-row failure list on partial failure, without discarding successes", async () => {
    clearDoneTasks.mockResolvedValue({
      deleted: [1],
      failed: [{ id: 2, error: "still open and labeled" }],
      branches: [],
      remaining: 0,
    });
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Clear done" }));
    await user.click(screen.getByRole("button", { name: "Confirm clear" }));

    expect(await screen.findByText("Cleared 1 done task(s).")).toBeInTheDocument();
    expect(screen.getByText(/Task #2: still open and labeled/)).toBeInTheDocument();
  });

  it("renders skipped-branch reasons alongside a successful row deletion", async () => {
    clearDoneTasks.mockResolvedValue({
      deleted: [1],
      failed: [],
      branches: [{ id: 1, branch: "mullion/task-1", deleted: false, reason: "not-merged" }],
      remaining: 0,
    });
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Clear done" }));
    await user.click(screen.getByRole("button", { name: "Confirm clear" }));

    expect(
      await screen.findByText(/Branch mullion\/task-1 not deleted: not-merged/),
    ).toBeInTheDocument();
  });

  it("shows a generic error when clearDoneTasks rejects", async () => {
    clearDoneTasks.mockRejectedValueOnce(new Error("network down"));
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Clear done" }));
    await user.click(screen.getByRole("button", { name: "Confirm clear" }));

    expect(await screen.findByText("Failed to clear done tasks")).toBeInTheDocument();
  });
});
