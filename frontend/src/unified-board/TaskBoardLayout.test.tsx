// @vitest-environment jsdom
// The Task Master board's cards and columns (epic #2847, #2841): Claimed folded into
// In progress, the compact card (linked issue / PR, project, epic tag, session pills),
// blocked stacks, empty-column rails, and grouping into epic / project lanes. Mounts the
// full `<UnifiedBoard>` because the invariants worth testing (a drop translating through
// `absoluteDropIndex`, a lane refusing a foreign card) are properties of the board, its
// columns and its filters together (#610).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, within } from "@testing-library/react";
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
let selectedTaskId: number | null = null;

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
    pendingOpenTaskId: null,
    selectedTaskId,
    setPendingOpenTaskId: vi.fn(),
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

// jsdom has no DataTransfer/DragEvent — same stub as UnifiedBoard.test.tsx.
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

type User = ReturnType<typeof userEvent.setup>;

const renderBoard = (props: { selectedTaskId?: number | null } = {}) =>
  render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} {...props} />);

async function openMenu(user: User, name: string) {
  if (screen.queryByRole("group", { name })) return;
  await user.click(screen.getByRole("button", { name: new RegExp(`^${name}\\b`) }));
}
const column = (title: string) =>
  screen
    .getByText(title, { selector: ".kanban-column-title" })
    .closest<HTMLElement>(".kanban-column")!;
const cardTitles = (root: Element) =>
  [...root.querySelectorAll(".task-card-title")].map((e) => e.textContent);
const cardByTitle = (title: string) =>
  screen.getByText(title, { selector: ".task-card-title" }).closest<HTMLElement>(".task-card")!;

/** Drags the card titled `from` onto the card titled `to`. */
function dragOnto(from: string, to: string, id: number) {
  const dataTransfer = createDataTransfer({ "application/x-mullion-task": String(id) });
  act(() => cardByTitle(from).dispatchEvent(createDragEvent("dragstart", dataTransfer)));
  cardByTitle(to).dispatchEvent(createDragEvent("drop", dataTransfer));
}

const epicA = {
  parentIssueNumber: 10,
  parentIssueRepo: "acme/widgets",
  parentIssueTitle: "Parent A",
};
const epicB = {
  parentIssueNumber: 20,
  parentIssueRepo: "acme/widgets",
  parentIssueTitle: "Parent B",
};
const blocker = (number: number) => [
  {
    owner: "acme",
    repo: "widgets",
    number,
    title: `blocker ${number}`,
    htmlUrl: `https://github.com/acme/widgets/issues/${number}`,
  },
];

describe("Claimed folded into In progress", () => {
  it("lists a queued task under In progress, after the running ones, with its queued hint", () => {
    tasks = [
      makeTask({ id: 1, status: "claimed", title: "waiting", boardOrder: 0 }),
      makeTask({ id: 2, status: "in_progress", title: "running", boardOrder: 5 }),
    ];
    renderBoard();
    expect(screen.queryByText("Claimed", { selector: ".kanban-column-title" })).toBeNull();
    const inProgress = column("In Progress");
    expect(cardTitles(inProgress)).toEqual(["running", "waiting"]);
    expect(inProgress.querySelector(".kanban-column-count")).toHaveTextContent("2");
    expect(within(inProgress).getByText("Queued — waiting for a free slot")).toHaveClass(
      "task-card-queued",
    );
  });

  it("still reorders queued tasks among themselves, aimed at the Claimed status", () => {
    tasks = [
      makeTask({ id: 1, status: "in_progress", title: "running", boardOrder: 0 }),
      makeTask({ id: 2, status: "claimed", title: "queued-a", boardOrder: 0 }),
      makeTask({ id: 3, status: "claimed", title: "queued-b", boardOrder: 1 }),
    ];
    renderBoard();
    dragOnto("queued-b", "queued-a", 3);
    expect(updateTask).toHaveBeenCalledWith(3, { boardOrder: 0 });
    expect(updateTask).toHaveBeenCalledWith(2, { boardOrder: 1 });
    expect(updateTask).toHaveBeenCalledTimes(2);
  });

  it("counts queued tasks under In progress on the phone strip", () => {
    tasks = [
      makeTask({ id: 1, status: "claimed", title: "waiting" }),
      makeTask({ id: 2, status: "in_progress", title: "running" }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} phone />);
    const strip = screen.getByRole("group", { name: "Task status" });
    expect(within(strip).queryByText("Claimed")).toBeNull();
    // The phone's Active segment folds In progress (and so the queued tasks) with Reviewing.
    expect(within(strip).getByRole("button", { name: /Active/ })).toHaveTextContent("2");
  });

  it("counts queued tasks under In progress on the tablet's per-status chips", () => {
    tasks = [
      makeTask({ id: 1, status: "claimed", title: "waiting" }),
      makeTask({ id: 2, status: "in_progress", title: "running" }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} phone columnCount={2} />);
    const strip = screen.getByRole("group", { name: "Task status" });
    expect(within(strip).queryByText("Claimed")).toBeNull();
    expect(within(strip).getByRole("button", { name: /In Progress/ })).toHaveTextContent("2");
  });
});

describe("compact card", () => {
  it("links the issue and the PR, and always shows the project", () => {
    projects = [makeProject({ id: 1, name: "demo" })];
    tasks = [
      makeTask({
        id: 1,
        status: "reviewing",
        title: "linked",
        issueNumber: 2418,
        htmlUrl: "https://github.com/acme/widgets/issues/2418",
        prNumber: 2833,
        prUrl: "https://github.com/acme/widgets/pull/2833",
      }),
    ];
    renderBoard();
    const card = cardByTitle("linked");
    expect(within(card).getByRole("link", { name: /#2418/ })).toHaveAttribute(
      "href",
      "https://github.com/acme/widgets/issues/2418",
    );
    expect(within(card).getByRole("link", { name: "PR #2833" })).toHaveAttribute(
      "href",
      "https://github.com/acme/widgets/pull/2833",
    );
    expect(card.querySelector(".task-card-project")).toHaveTextContent("demo");
  });

  it("colours the card edge and the epic tag from the epic, stably", () => {
    tasks = [
      makeTask({ id: 1, status: "ready", title: "one", ...epicA }),
      makeTask({ id: 2, status: "ready", title: "two", ...epicA }),
      makeTask({ id: 3, status: "ready", title: "bare" }),
    ];
    renderBoard();
    const colour = (title: string) =>
      (cardByTitle(title) as HTMLElement).style.getPropertyValue("--task-epic-colour");
    expect(colour("one")).toMatch(/^var\(--lane-[1-6]\)$/);
    expect(colour("one")).toBe(colour("two"));
    expect(colour("bare")).toBe("");
    expect(within(cardByTitle("one")).getByRole("link", { name: /epic #10/ })).toBeInTheDocument();
  });

  it("rings the selected task and marks it current", () => {
    tasks = [
      makeTask({ id: 1, status: "ready", title: "picked" }),
      makeTask({ id: 2, status: "ready", title: "other" }),
    ];
    renderBoard({ selectedTaskId: 1 });
    expect(cardByTitle("picked")).toHaveClass("task-card-selected");
    expect(cardByTitle("picked")).toHaveAttribute("aria-current", "true");
    expect(cardByTitle("other")).not.toHaveClass("task-card-selected");
  });

  it("follows the store's selection (what the sidebar shows) when no prop is passed", () => {
    tasks = [
      makeTask({ id: 1, status: "ready", title: "picked" }),
      makeTask({ id: 2, status: "ready", title: "other" }),
    ];
    selectedTaskId = 2;
    try {
      renderBoard();
      expect(cardByTitle("other")).toHaveClass("task-card-selected");
      expect(cardByTitle("picked")).not.toHaveClass("task-card-selected");
    } finally {
      selectedTaskId = null;
    }
  });
});

describe("blocked stacks", () => {
  const blocked = (id: number, by: number) =>
    makeTask({
      id,
      status: "ready",
      title: `blocked ${id}`,
      boardOrder: id,
      blockedState: "blocked",
      blockers: blocker(by),
    });

  it("collapses three or more cards blocked by the same task, expanding in place", async () => {
    tasks = [
      makeTask({ id: 1, status: "ready", title: "free", boardOrder: 0 }),
      blocked(2, 7),
      blocked(3, 7),
      blocked(4, 7),
    ];
    const user = userEvent.setup();
    renderBoard();
    const ready = column("Ready");
    const summary = within(ready).getByRole("button", { name: /3 blocked by #7/ });
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(cardTitles(ready)).toEqual(["free"]);
    expect(within(ready).getByRole("link", { name: "Open blocker #7 on GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/acme/widgets/issues/7",
    );

    await user.click(summary);
    expect(summary).toHaveAttribute("aria-expanded", "true");
    expect(cardTitles(ready)).toEqual(["free", "blocked 2", "blocked 3", "blocked 4"]);
    // The summary already says what blocks them, so the cards drop their own strip.
    expect(ready.querySelector(".task-card-blocked-strip")).toBeNull();
  });

  it("leaves one or two blocked cards as ordinary cards with their own strip", () => {
    tasks = [blocked(2, 7), blocked(3, 7)];
    renderBoard();
    const ready = column("Ready");
    expect(within(ready).queryByRole("button", { name: /blocked by/ })).toBeNull();
    expect(ready.querySelectorAll(".task-card-blocked-strip")).toHaveLength(2);
  });

  it("stacks by blocker set: different blockers form different stacks", () => {
    tasks = [blocked(2, 7), blocked(3, 7), blocked(4, 7), blocked(5, 9), blocked(6, 9)];
    renderBoard();
    const ready = column("Ready");
    expect(within(ready).getByRole("button", { name: /3 blocked by #7/ })).toBeInTheDocument();
    expect(within(ready).queryByRole("button", { name: /blocked by #9/ })).toBeNull();
    expect(cardTitles(ready)).toEqual(["blocked 5", "blocked 6"]);
  });

  it("does not stack cards whose blocker is not linkable", () => {
    const hidden = (id: number) =>
      makeTask({
        id,
        status: "ready",
        title: `hidden ${id}`,
        blockedState: "blocked",
        blockers: [
          { owner: "", repo: "", number: 0, title: "1 blocker not visible", htmlUrl: null },
        ],
      });
    tasks = [hidden(1), hidden(2), hidden(3)];
    renderBoard();
    expect(cardTitles(column("Ready"))).toHaveLength(3);
  });

  it("dropping a card on the summary lands before the stack's first member", () => {
    tasks = [
      blocked(2, 7),
      blocked(3, 7),
      blocked(4, 7),
      makeTask({ id: 1, status: "ready", title: "free", boardOrder: 10 }),
    ];
    renderBoard();
    const dataTransfer = createDataTransfer({ "application/x-mullion-task": "1" });
    act(() => cardByTitle("free").dispatchEvent(createDragEvent("dragstart", dataTransfer)));
    within(column("Ready"))
      .getByRole("button", { name: /3 blocked by #7/ })
      .closest(".task-stack-head")!
      .dispatchEvent(createDragEvent("drop", dataTransfer));
    expect(updateTask).toHaveBeenCalledWith(1, { boardOrder: 0 });
    expect(updateTask).toHaveBeenCalledWith(2, { boardOrder: 1 });
    expect(updateTask).toHaveBeenCalledWith(3, { boardOrder: 2 });
    expect(updateTask).toHaveBeenCalledWith(4, { boardOrder: 3 });
  });
});

describe("empty columns", () => {
  it("shrink to a rail with the name and a zero count, and opens for a valid drag", () => {
    tasks = [makeTask({ id: 1, status: "ready", title: "solo" })];
    renderBoard();
    const done = column("Done");
    expect(done).toHaveClass("kanban-column-rail");
    expect(done).toHaveTextContent("0");
    expect(done.querySelector(".kanban-column-empty")).toBeNull();

    const dataTransfer = createDataTransfer({ "application/x-mullion-task": "1" });
    act(() => cardByTitle("solo").dispatchEvent(createDragEvent("dragstart", dataTransfer)));
    // Backlog can take a ready card, so its rail opens into a drop target.
    expect(column("Backlog")).not.toHaveClass("kanban-column-rail");
    expect(column("Backlog").querySelector(".kanban-column-body")).not.toBeNull();
    // Done cannot, so it stays a rail.
    expect(column("Done")).toHaveClass("kanban-column-rail");
  });

  it("stay full columns on the phone, where one column shows at a time", () => {
    tasks = [makeTask({ id: 1, status: "ready", title: "solo" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} phone />);
    expect(document.querySelector(".kanban-column-rail")).toBeNull();
  });
});

describe("group by", () => {
  const grouped = (by: "epic" | "project") => localStorage.setItem("crs.taskGroupBy", by);

  it("groups into epic lanes titled #number + title, with progress and a link, No epic last", () => {
    grouped("epic");
    tasks = [
      makeTask({ id: 1, status: "ready", title: "a1", ...epicA }),
      makeTask({ id: 2, status: "done", title: "a2", ...epicA }),
      makeTask({ id: 3, status: "ready", title: "b1", ...epicB }),
      makeTask({ id: 4, status: "ready", title: "loose" }),
    ];
    renderBoard();
    const lanes = screen.getAllByRole("region");
    expect(lanes.map((l) => l.getAttribute("aria-label"))).toEqual([
      "#10 Parent A",
      "#20 Parent B",
      "No epic",
    ]);
    const laneA = screen.getByRole("region", { name: "#10 Parent A" });
    expect(laneA).toHaveTextContent("1/2 done");
    expect(within(laneA).getByRole("link", { name: "Open epic on GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/acme/widgets/issues/10",
    );
    expect(cardTitles(laneA).sort()).toEqual(["a1", "a2"]);
  });

  it("reads an epic's progress from its own task when it is on the board", () => {
    grouped("epic");
    tasks = [
      makeTask({
        id: 99,
        status: "ready",
        title: "the epic",
        issueNumber: 10,
        htmlUrl: "https://github.com/acme/widgets/issues/10",
        subIssueTotal: 9,
        subIssueCompleted: 3,
      }),
      makeTask({ id: 1, status: "ready", title: "child", ...epicA }),
    ];
    renderBoard();
    expect(screen.getByRole("region", { name: "#10 Parent A" })).toHaveTextContent("3/9 closed");
  });

  it("groups into project lanes", () => {
    grouped("project");
    tasks = [
      makeTask({ id: 1, projectId: 1, status: "ready", title: "in demo" }),
      makeTask({ id: 2, projectId: 2, status: "ready", title: "in other" }),
    ];
    renderBoard();
    expect(screen.getAllByRole("region").map((l) => l.getAttribute("aria-label"))).toEqual([
      "demo",
      "other",
    ]);
  });

  it("is chosen from the Display menu and persisted", async () => {
    tasks = [makeTask({ id: 1, status: "ready", title: "a1", ...epicA })];
    const user = userEvent.setup();
    renderBoard();
    expect(screen.queryAllByRole("region")).toHaveLength(0);
    await openMenu(user, "Display");
    await user.click(screen.getByRole("radio", { name: "Epic" }));
    expect(localStorage.getItem("crs.taskGroupBy")).toBe("epic");
    expect(screen.getByRole("region", { name: "#10 Parent A" })).toBeInTheDocument();
  });

  it("keeps the flat columns when grouped but nothing is visible", () => {
    grouped("epic");
    tasks = [];
    renderBoard();
    expect(screen.getByText("Ready", { selector: ".kanban-column-title" })).toBeInTheDocument();
    expect(screen.queryAllByRole("region")).toHaveLength(0);
  });

  it("refuses a drop into another lane: nothing is written", () => {
    grouped("epic");
    tasks = [
      makeTask({ id: 1, status: "ready", title: "in A", boardOrder: 0, ...epicA }),
      makeTask({ id: 2, status: "ready", title: "in B", boardOrder: 0, ...epicB }),
    ];
    renderBoard();
    dragOnto("in A", "in B", 1);
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("reorders inside a lane exactly as inside a filtered column — boardOrder stays correct (#610)", () => {
    grouped("epic");
    // A task from the other lane sits between the two lane-A cards in boardOrder.
    tasks = [
      makeTask({ id: 1, status: "ready", title: "first", boardOrder: 0, ...epicA }),
      makeTask({ id: 3, status: "ready", title: "hidden", boardOrder: 1, ...epicB }),
      makeTask({ id: 2, status: "ready", title: "second", boardOrder: 2, ...epicA }),
    ];
    renderBoard();
    dragOnto("first", "second", 1);
    expect(updateTask).toHaveBeenCalledWith(3, { boardOrder: 0 });
    expect(updateTask).toHaveBeenCalledWith(2, { boardOrder: 1 });
    expect(updateTask).toHaveBeenCalledWith(1, { boardOrder: 2 });
    expect(updateTask).toHaveBeenCalledTimes(3);
  });

  it("moves a card between Backlog and Ready inside its own lane", () => {
    grouped("epic");
    tasks = [
      makeTask({ id: 1, status: "backlog", title: "in A", boardOrder: 0, ...epicA }),
      makeTask({ id: 2, status: "ready", title: "other A", boardOrder: 0, ...epicA }),
    ];
    renderBoard();
    dragOnto("in A", "other A", 1);
    expect(updateTask).toHaveBeenCalledWith(1, { boardOrder: 0, status: "ready" });
  });
});

describe("card density", () => {
  it("is Compact by default, and Comfortable is chosen from the Display menu and persisted", async () => {
    tasks = [makeTask({ id: 1, status: "ready" })];
    const user = userEvent.setup();
    const { container } = renderBoard();
    const board = () => container.querySelector(".kanban-unified-tasks")!;
    expect(board()).toHaveClass("task-density-compact");
    await openMenu(user, "Display");
    await user.click(screen.getByRole("radio", { name: "Comfortable" }));
    expect(board()).toHaveClass("task-density-comfortable");
    expect(localStorage.getItem("crs.taskDensity")).toBe("comfortable");
  });
});
