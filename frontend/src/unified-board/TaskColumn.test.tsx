// @vitest-environment jsdom
// UnifiedBoard's status columns — split out of the former monolithic
// UnifiedBoard.test.tsx (PR 28, Wave 5 of
// .claude/plans/can-we-do-a-warm-cocke.md), owns every test that exercises
// TaskColumn.tsx's own region (column counts, the board-level empty state,
// and the tasksLoaded mount gating that decides whether it shows). Card
// content itself is TaskCard.test.tsx's concern — see that file's own
// header comment. Still mounts the full `<UnifiedBoard>` (same reasoning as
// session-row/Header.test.tsx's own header comment).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { UnifiedBoard } from "../UnifiedBoard.js";
import type {
  GitBranchesResult,
  GitDiffStats,
  GitHubPRsStatus,
  GitStatus,
  NotificationEvent,
  Project,
  Session,
  Task,
} from "../api.js";
import { makeProject, makeTask } from "../test/fixtures.js";

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

vi.mock("../store.js", () => {
  const useDashboardStore = (selector?: (s: unknown) => unknown) => {
    const state = storeState();
    return selector ? selector(state) : state;
  };
  useDashboardStore.getState = storeState;
  return { useDashboardStore };
});

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
