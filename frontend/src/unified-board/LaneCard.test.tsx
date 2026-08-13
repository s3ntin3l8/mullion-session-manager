// @vitest-environment jsdom
// UnifiedBoard's ad-hoc session lane — split out of the former monolithic
// UnifiedBoard.test.tsx (PR 28, Wave 5 of
// .claude/plans/can-we-do-a-warm-cocke.md), owns every test that exercises
// LaneCard.tsx's own region (grouping, empty states, collapse, and
// drag-to-reorder). Still mounts the full `<UnifiedBoard>` (same reasoning
// as session-row/Header.test.tsx's own header comment).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
} from "../api/index.js";
import { makeSession, makeProject, makeTask } from "../test/fixtures.js";

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

vi.mock("../store/index.js", () => {
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
