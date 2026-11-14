// @vitest-environment jsdom
// UnifiedBoard's own orchestration — split (PR 28, Wave 5 of
// .claude/plans/can-we-do-a-warm-cocke.md) alongside unified-board/*.tsx.
// This file keeps every test that exercises the BOARD's own state rather
// than a single sub-component's presentation: task drag-and-drop (spans
// TaskColumn.tsx's drop targets, TaskCard.tsx's drag source, and this
// file's own `applyDrop`/`updateTask` call), and how a card click opens a task
// (the board has no drawer of its own since #2843: it selects the task in the
// sidebar from 700px, or opens the docked panel on the phone, #3011).
// Per-region tests live in unified-board/TasksToolbar.test.tsx,
// unified-board/TaskColumn.test.tsx, unified-board/TaskCard.test.tsx,
// unified-board/TaskSessionSlot.test.tsx, and unified-board/LaneCard.test.tsx
// — see each file's own header comment.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UnifiedBoard } from "./UnifiedBoard.js";
import type * as layoutTierModule from "./lib/layoutTier.js";
import type {
  GitBranchesResult,
  GitDiffStats,
  GitHubPRsStatus,
  GitStatus,
  NotificationEvent,
  Project,
  Session,
  Task,
} from "./api/index.js";
import { makeProject, makeSession, makeTask } from "./test/fixtures.js";
import { resetPhoneBackStackForTests } from "./hooks/usePhoneBackStack.js";

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
let tasksError: string | null;
let taskMasterEnabled: boolean;
let kanbanOrder: Record<string, number[]>;
let events: Record<number, NotificationEvent[]>;
let sessionGitStatuses: Record<number, GitStatus | null>;
let gitDiffStats: Record<number, GitDiffStats | null>;
let gitBranchesByProject: Record<number, GitBranchesResult | undefined>;
let prsByProject: Record<number, GitHubPRsStatus | undefined>;
let hideEndedSessions: boolean;
let selectedTaskId: number | null = null;
// The tier useOpenTask reads (lib/layoutTier.ts's useLayoutContext); the real
// one resolves it from matchMedia, which jsdom does not provide.
let layoutTier: "desktop" | "tablet" | "phone" = "desktop";
const requestOpenTask = vi.fn();
const openRightSidebarTask = vi.fn();

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
    tasksError,
    taskMasterEnabled,
    kanbanOrder,
    setKanbanColumnOrder,
    deleteSession,
    setViewMode,
    selectedTaskId,
    requestOpenTask,
    openRightSidebarTask,
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
    mutedSessionIds: [] as number[],
  };
}

vi.mock("./lib/layoutTier.js", async (importOriginal) => ({
  ...(await importOriginal<typeof layoutTierModule>()),
  useLayoutContext: () => ({ tier: layoutTier }),
}));

vi.mock("./store/index.js", () => {
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
  tasksError = null;
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
  requestOpenTask.mockClear();
  openRightSidebarTask.mockClear();
  selectedTaskId = null;
  layoutTier = "desktop";
  deleteSession.mockClear();
  refreshTasks.mockClear();
  updateTask.mockClear();
  createTask.mockClear();
  // The board's persisted filter and layout settings — same precedent as
  // Dock.test.tsx's own localStorage.clear(), so one test's choice can't leak
  // into the next.
  localStorage.clear();
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
  // drag-reorder would also open the task's detail uninvited.
  it("suppresses the click that follows a completed drag-reorder, so it doesn't also open the task", () => {
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
    expect(openRightSidebarTask).not.toHaveBeenCalled();
    expect(requestOpenTask).not.toHaveBeenCalled();
  });

  it("persists a cross-column drag between backlog and ready with a status patch", () => {
    tasks = [makeTask({ id: 1, status: "backlog", boardOrder: 0, title: "solo" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const backlogCard = screen
      .getByText("Backlog", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!
      .querySelector(".task-card")!;

    const dataTransfer = createDataTransfer({ "application/x-mullion-task": "1" });
    act(() => backlogCard.dispatchEvent(createDragEvent("dragstart", dataTransfer)));
    // Ready is empty, so it was a narrow rail; it opens once a card that can land
    // there is being dragged, and only then has a body to drop on.
    const readyColumnBody = screen
      .getByText("Ready", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!
      .querySelector(".kanban-column-body")!;
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
    const dataTransfer = createDataTransfer({ "application/x-mullion-task": "1" });
    act(() => readyCard.dispatchEvent(createDragEvent("dragstart", dataTransfer)));
    // Done is empty and cannot take this card, so it stays a rail with no drop body.
    const doneColumn = screen
      .getByText("Done", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!;
    expect(doneColumn.querySelector(".kanban-column-body")).toBeNull();
    doneColumn.dispatchEvent(createDragEvent("drop", dataTransfer));

    expect(updateTask).not.toHaveBeenCalled();
  });

  it("does not persist a drop FROM a non-drag-editable column into ready (source-side guard)", () => {
    tasks = [makeTask({ id: 1, status: "done", boardOrder: 0 })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const doneCard = screen
      .getByText("Done", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!
      .querySelector(".task-card")!;

    const dataTransfer = createDataTransfer({ "application/x-mullion-task": "1" });
    act(() => doneCard.dispatchEvent(createDragEvent("dragstart", dataTransfer)));
    // A done card cannot land in Ready, whose empty column therefore stays a rail.
    const readyColumn = screen
      .getByText("Ready", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!;
    expect(readyColumn.querySelector(".kanban-column-body")).toBeNull();
    readyColumn.dispatchEvent(createDragEvent("drop", dataTransfer));

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
    const dataTransfer = createDataTransfer({ "application/x-mullion-task": "1" });
    act(() => readyCard.dispatchEvent(createDragEvent("dragstart", dataTransfer)));

    // Done cannot take the card: it stays a rail and never becomes a drop target.
    const doneColumn = screen
      .getByText("Done", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!;
    act(() => doneColumn.dispatchEvent(createDragEvent("dragover", dataTransfer)));
    expect(doneColumn.querySelector(".kanban-column-body")).toBeNull();
    expect(doneColumn.classList.contains("kanban-card-drop-target")).toBe(false);

    // Backlog can: its empty rail opens and highlights.
    const backlogColumnBody = screen
      .getByText("Backlog", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!
      .querySelector(".kanban-column-body")!;
    act(() => backlogColumnBody.dispatchEvent(createDragEvent("dragover", dataTransfer)));
    expect(backlogColumnBody.classList.contains("kanban-card-drop-target")).toBe(true);
  });
});

// #610 cut a project filter for this exact reason: "the drag/reorder math
// indexes against the rendered list, not the full store list, and
// filtering would silently corrupt boardOrder on drop." tasksBoard.test.ts
// covers absoluteDropIndex's own math in isolation; these tests cover the
// board actually wiring it up — persistence, rendering, and that a drag
// inside a filtered column produces the same updateTask calls dragging the
// same two cards with no filter active would.
describe("UnifiedBoard opening a task (#2843: no board drawer)", () => {
  it("desktop: a card click shows the task in the sidebar's Tasks detail, not a drawer", async () => {
    tasks = [makeTask({ id: 5, status: "ready", title: "Open me" })];
    const user = userEvent.setup();
    const { container } = render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    await user.click(screen.getByText("Open me"));

    expect(openRightSidebarTask).toHaveBeenCalledTimes(1);
    expect(openRightSidebarTask).toHaveBeenCalledWith(5);
    expect(requestOpenTask).not.toHaveBeenCalled();
    expect(container.querySelector(".kanban-detail-drawer")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Task detail" })).toBeNull();
  });

  // #3011 — from 700px (the 851px fold is the tablet tier) a card opens the
  // right sidebar's detail; the docked panel is the phone's alone.
  it("tablet (851px): a card click opens the sidebar detail, never the docked panel", async () => {
    tasks = [makeTask({ id: 8, status: "in_progress", title: "Open on the fold" })];
    layoutTier = "tablet";
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    await user.click(screen.getByText("Open on the fold"));

    expect(openRightSidebarTask).toHaveBeenCalledWith(8);
    expect(requestOpenTask).not.toHaveBeenCalled();
  });

  it("phone: a card click asks for the full-screen docked panel instead", async () => {
    tasks = [makeTask({ id: 7, status: "in_progress", title: "Open on phone" })];
    layoutTier = "phone";
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} phone />);

    await user.click(screen.getByText("Open on phone"));

    expect(requestOpenTask).toHaveBeenCalledTimes(1);
    expect(requestOpenTask).toHaveBeenCalledWith(7);
    expect(openRightSidebarTask).not.toHaveBeenCalled();
  });

  it("rings the card whose task the store has selected, and only that one", () => {
    tasks = [
      makeTask({ id: 1, status: "ready", title: "first" }),
      makeTask({ id: 2, status: "ready", title: "second" }),
    ];
    selectedTaskId = 2;
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const current = document.querySelectorAll('.task-card[aria-current="true"]');
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain("second");
  });

  it("keeps the selection ring when the sidebar's selection is for a task the filters hide", () => {
    tasks = [makeTask({ id: 1, status: "ready", title: "only visible" })];
    selectedTaskId = 99;
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    expect(document.querySelectorAll('.task-card[aria-current="true"]')).toHaveLength(0);
    expect(screen.getByText("only visible")).toBeInTheDocument();
  });
});

// The board's filters (project picker, quick views, Filter and Display menus, facets
// panel, legacy-key migration) are tested in unified-board/TaskFilterBar.test.tsx, which
// mounts this same board.

// Audit finding 15 — a FAILED task fetch is not an empty task list. The
// tasks slice keeps the last-known-good list on failure (so `tasks` stays
// []) and records the failure in `tasksError`; before this, the board
// rendered "No tasks yet." and invited the user to create a task, which is
// actively misleading when the real cause is that the list could not be
// loaded.
describe("UnifiedBoard task load failure (audit finding 15)", () => {
  it("says the task list could not be loaded instead of 'No tasks yet.'", () => {
    tasks = [];
    tasksError = "Failed to fetch";
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    expect(screen.getByText("Couldn't load tasks.")).toBeInTheDocument();
    // The error's own message, so the user can tell WHAT went wrong
    // rather than only that something did.
    expect(screen.getByText("Failed to fetch")).toBeInTheDocument();
    expect(screen.queryByText("No tasks yet.")).toBeNull();
    // The "create a task" invitation is exactly what a failed load must
    // not show — it sends the user off to fix the wrong problem.
    expect(screen.queryByText(/mullion-task/)).toBeNull();
  });

  it("keeps the six columns underneath the error note, so the board's shape stays legible", () => {
    tasks = [];
    tasksError = "Failed to fetch";
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    expect(
      screen.getAllByText(/^Backlog$|^Ready$|^In Progress$|^Reviewing$|^Done$|^Failed$/, {
        selector: ".kanban-column-title",
      }),
    ).toHaveLength(6);
  });

  // The board keeps the last-known-good list on a failed refresh, so the
  // columns below the note are REAL tasks — saying "Couldn't load tasks."
  // next to them would read as if there were no tasks at all. This is the
  // same split Sidebar and Source Control already make.
  it("says the tasks on screen are the last known ones when the refresh fails", () => {
    tasks = [makeTask({ id: 5, status: "ready", title: "Still here" })];
    tasksError = "Failed to fetch";
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    expect(
      screen.getByText("Could not refresh tasks — showing the last known list."),
    ).toBeInTheDocument();
    expect(screen.getByText("Failed to fetch")).toBeInTheDocument();
    // NOT the "there are no tasks" wording — there are.
    expect(screen.queryByText("Couldn't load tasks.")).toBeNull();
    expect(screen.getByText("Still here")).toBeInTheDocument();
  });

  it("still says the list could not be loaded when there are no tasks to show", () => {
    tasks = [];
    tasksError = "Failed to fetch";
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    expect(screen.getByText("Couldn't load tasks.")).toBeInTheDocument();
    expect(screen.queryByText("Could not refresh tasks — showing the last known list.")).toBeNull();
  });

  it("re-runs the task fetch when Retry is clicked", async () => {
    tasks = [];
    tasksError = "Failed to fetch";
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    // The mount effect's own refreshTasks() call is not the one under
    // test here — clear it so the assertion is about the click alone.
    refreshTasks.mockClear();
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(refreshTasks).toHaveBeenCalledTimes(1);
  });

  it("still shows the ordinary empty state when the task list loaded fine", () => {
    tasks = [];
    tasksError = null;
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    expect(screen.getByText("No tasks yet.")).toBeInTheDocument();
    expect(screen.getByText(/mullion-task/)).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load tasks.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

describe("UnifiedBoard tablet layout (columnCount 2)", () => {
  const renderTablet = () =>
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} phone columnCount={2} />);
  const shownTitles = () =>
    Array.from(document.querySelectorAll(".kanban-column-title")).map((el) => el.textContent);

  beforeEach(() => {
    tasks = [
      makeTask({ id: 1, status: "ready", title: "r1" }),
      makeTask({ id: 3, status: "in_progress", title: "ip1" }),
      makeTask({ id: 4, status: "done", title: "d1" }),
    ];
  });

  it("shows two adjacent columns starting at the default one, both chips pressed", () => {
    renderTablet();
    expect(shownTitles()).toHaveLength(2);
    expect(shownTitles()[0]).toBe("In Progress");
    expect(screen.getByRole("button", { name: /^In Progress/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const pressed = screen
      .getByRole("group", { name: "Task status" })
      .querySelectorAll('[aria-pressed="true"]');
    expect(pressed).toHaveLength(2);
    expect(document.querySelector(".kanban-unified-columns")).toHaveClass(
      "kanban-unified-columns--split",
    );
  });

  it("keeps the pair put when a chip that is already on screen is picked", async () => {
    renderTablet();
    const before = shownTitles();
    const second = screen
      .getByRole("group", { name: "Task status" })
      .querySelectorAll<HTMLElement>('[aria-pressed="true"]')[1]!;
    await userEvent.click(second);
    expect(shownTitles()).toEqual(before);
  });

  it("moves the window to a picked chip, clamped at the end", async () => {
    renderTablet();
    await userEvent.click(screen.getByRole("button", { name: /^Ready/ }));
    expect(shownTitles()[0]).toBe("Ready");
    await userEvent.click(screen.getByRole("button", { name: /^Failed/ }));
    expect(shownTitles()).toHaveLength(2);
    expect(shownTitles()[1]).toBe("Failed");
  });

  it("phone (columnCount 1) is never split: its Active segment stacks its two columns", () => {
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} phone />);
    expect(shownTitles()).toEqual(["In Progress", "Reviewing"]);
    expect(document.querySelector(".kanban-unified-columns")).not.toHaveClass(
      "kanban-unified-columns--split",
    );
  });
});

describe("UnifiedBoard ad-hoc strip summary", () => {
  beforeEach(() => {
    sessions = [
      makeSession({ id: 11, projectId: 1, name: "w1", sessionStatusSeverity: "busy" }),
      makeSession({ id: 12, projectId: 1, name: "w2", sessionStatusSeverity: "busy" }),
      makeSession({ id: 13, projectId: 1, name: "stuck", sessionStatusSeverity: "blocked" }),
      makeSession({ id: 14, projectId: 1, name: "quiet", sessionStatusSeverity: "dormant" }),
      // Its project is gone: neither counted, dotted nor drawn.
      makeSession({ id: 15, projectId: 99, name: "orphan", sessionStatusSeverity: "busy" }),
    ];
  });

  const dotTones = () =>
    Array.from(document.querySelectorAll(".kanban-lane-dot")).map((el) =>
      el.className.replace("kanban-lane-dot kanban-lane-dot--", ""),
    );

  it("collapsed, shows the count, one dot per session and a one-line summary", () => {
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(document.querySelector(".kanban-lane-count")?.textContent).toBe("4");
    expect(document.querySelector(".kanban-lane-summary")?.textContent).toBe(
      "2 running · 1 needs you · 1 idle",
    );
    expect(dotTones()).toEqual(["attention", "running", "running", "idle"]);
    expect(document.querySelector(".kanban-lane-body")).toBeNull();
  });

  it("keeps the summary while expanded", async () => {
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Ad-hoc sessions/ }));
    expect(document.querySelector(".kanban-lane-summary")?.textContent).toBe(
      "2 running · 1 needs you · 1 idle",
    );
    expect(document.querySelectorAll(".kanban-card")).toHaveLength(4);
  });

  it("is the same strip on the phone, where it is new, and expands to the sessions", async () => {
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} phone />);
    expect(document.querySelector(".kanban-lane-summary")?.textContent).toBe(
      "2 running · 1 needs you · 1 idle",
    );
    expect(document.querySelectorAll(".kanban-card")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: /Ad-hoc sessions/ }));
    expect(document.querySelectorAll(".kanban-card")).toHaveLength(4);
  });

  it("points the toggle at the lane body only while it exists", async () => {
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    const toggle = screen.getByRole("button", { name: /Ad-hoc sessions/ });
    expect(toggle).not.toHaveAttribute("aria-controls");
    await userEvent.click(toggle);
    const body = document.querySelector(".kanban-lane-body");
    expect(body).not.toBeNull();
    expect(body!.id).not.toBe("");
    expect(toggle).toHaveAttribute("aria-controls", body!.id);
  });

  it("shows no dots or summary when there are no ad-hoc sessions", () => {
    sessions = [];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(document.querySelector(".kanban-lane-count")?.textContent).toBe("0");
    expect(document.querySelector(".kanban-lane-dots")).toBeNull();
    expect(document.querySelector(".kanban-lane-summary")).toBeNull();
  });
});

describe("UnifiedBoard phone layout", () => {
  const renderPhone = () =>
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} phone />);
  const shownTitles = () =>
    Array.from(document.querySelectorAll(".kanban-column-title")).map((el) => el.textContent);

  beforeEach(() => {
    tasks = [
      makeTask({ id: 1, status: "ready", title: "r1" }),
      makeTask({ id: 2, status: "ready", title: "r2" }),
      makeTask({ id: 3, status: "in_progress", title: "ip1" }),
      makeTask({ id: 4, status: "done", title: "d1" }),
    ];
  });

  it("shows a four-segment control with per-segment counts and only the default segment", () => {
    renderPhone();
    const strip = screen.getByRole("group", { name: "Task status" });
    expect(strip).toHaveClass("tasks-phone-strip--segmented");
    expect(
      within(strip)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Backlog0", "Ready2", "Active1", "Done1"]);
    // Default: Active is the first actionable non-empty segment; it shows its
    // two statuses' columns stacked.
    expect(shownTitles()).toEqual(["In Progress", "Reviewing"]);
    expect(screen.getByRole("button", { name: /^Active/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("ip1")).toBeInTheDocument();
    expect(screen.queryByText("r1")).toBeNull();
  });

  it("folds Reviewing into Active and Failed into Done in the segment counts", () => {
    tasks = [
      makeTask({ id: 1, status: "in_progress", title: "a" }),
      makeTask({ id: 2, status: "claimed", title: "queued" }),
      makeTask({ id: 3, status: "reviewing", title: "b" }),
      makeTask({ id: 4, status: "done", title: "c" }),
      makeTask({ id: 5, status: "failed", title: "d" }),
    ];
    renderPhone();
    const strip = screen.getByRole("group", { name: "Task status" });
    expect(strip).toHaveTextContent("Active3");
    expect(strip).toHaveTextContent("Done2");
  });

  it("on tablet, scrolls the selected chip into view, on mount and when the column changes", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    try {
      render(
        <UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} phone columnCount={2} />,
      );
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.contexts[0]).toHaveTextContent("In Progress");
      await userEvent.click(screen.getByRole("button", { name: /^Ready/ }));
      expect(scrollIntoView).toHaveBeenCalledTimes(2);
      expect(scrollIntoView.mock.contexts[1]).toHaveTextContent("Ready");
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  });

  it("switches column from the strip", async () => {
    renderPhone();
    await userEvent.click(screen.getByRole("button", { name: /^Ready/ }));
    expect(shownTitles()).toEqual(["Ready"]);
    expect(screen.getByText("r1")).toBeInTheDocument();
    expect(screen.queryByText("ip1")).toBeNull();
  });

  it("drops Done/Failed from the strip under Hide done and falls back from a hidden pick", async () => {
    renderPhone();
    await userEvent.click(screen.getByRole("button", { name: /^Done/ }));
    expect(shownTitles()).toEqual(["Done", "Failed"]);
    await userEvent.click(screen.getByRole("button", { name: /Filter/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Hide Done & Failed" }));
    await userEvent.click(screen.getByRole("button", { name: "Close filters" }));
    expect(screen.queryByRole("button", { name: /^Done/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Failed/ })).toBeNull();
    expect(shownTitles()).toEqual(["In Progress", "Reviewing"]);
  });

  it("shows the ad-hoc strip below the list, and keeps its filters out of the page (they live in the sheet)", async () => {
    tasks = [
      makeTask({ id: 1, status: "ready", title: "r1", projectId: 1 }),
      makeTask({ id: 2, status: "ready", title: "r2", projectId: 2 }),
    ];
    renderPhone();
    expect(screen.getByRole("button", { name: /Ad-hoc sessions/ })).toBeInTheDocument();
    expect(document.querySelector(".task-filter-bar")).toBeNull();
    expect(screen.queryByRole("group", { name: "Quick views" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Filter/ }));
    const sheet = screen.getByRole("dialog", { name: "Task filters" });
    expect(within(sheet).getByRole("group", { name: "Quick views" })).toBeInTheDocument();
    expect(within(sheet).getByRole("checkbox", { name: /^demo/ })).toBeInTheDocument();
    expect(sheet).toHaveTextContent("Clear done");
  });

  it("counts active filters on the Filter button", async () => {
    renderPhone();
    expect(screen.getByRole("button", { name: /^Filter$/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Filter$/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Hide Done & Failed" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Show archived" }));
    await userEvent.click(screen.getByRole("button", { name: "Close filters" }));
    expect(screen.getByRole("button", { name: "Filter (2)" })).toBeInTheDocument();
  });

  it("creates a task from the phone toolbar's New task form", async () => {
    renderPhone();
    await userEvent.click(screen.getByRole("button", { name: "New task" }));
    await userEvent.type(screen.getByPlaceholderText("Task title"), "from phone{Enter}");
    expect(createTask).toHaveBeenCalledWith(1, "from phone");
  });

  it("the Filter sheet closes on Escape and hosts the two-step Clear done", async () => {
    renderPhone();
    await userEvent.click(screen.getByRole("button", { name: /^Filter/ }));
    await userEvent.click(screen.getByRole("button", { name: "Clear done" }));
    expect(screen.getByRole("button", { name: "Confirm clear" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Task filters" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Task filters" })).toBeNull();
  });

  it("Android back closes the Filter sheet", async () => {
    resetPhoneBackStackForTests();
    const pushState = vi.spyOn(window.history, "pushState").mockImplementation(() => {});
    vi.spyOn(window.history, "back").mockImplementation(() => {});
    try {
      renderPhone();
      await userEvent.click(screen.getByRole("button", { name: /^Filter/ }));
      expect(pushState).toHaveBeenCalledTimes(1);
      act(() => void window.dispatchEvent(new PopStateEvent("popstate")));
      expect(screen.queryByRole("dialog", { name: "Task filters" })).toBeNull();
    } finally {
      resetPhoneBackStackForTests();
      vi.restoreAllMocks();
    }
  });

  it("is unchanged when not phone: every column, the lane, no strip or filter sheet", () => {
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(shownTitles()).toHaveLength(6);
    expect(screen.getByText(/Ad-hoc sessions/)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Task status" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Task filters" })).toBeNull();
    expect(document.querySelector(".tasks-panel-toolbar--phone")).toBeNull();
    expect(screen.getByRole("group", { name: "Quick views" })).toBeInTheDocument();
  });

  it("starts with the ad-hoc sessions lane collapsed, keeps the count, and toggles it open and closed", async () => {
    sessions = [
      makeSession({ id: 11, projectId: 1, name: "adhoc-one" }),
      makeSession({ id: 12, projectId: 1, name: "adhoc-two" }),
    ];
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const toggle = screen.getByRole("button", { name: /Ad-hoc sessions/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector(".kanban-lane-count")?.textContent).toBe("2");
    expect(document.querySelector(".kanban-lane-body")).toBeNull();
    expect(document.querySelectorAll(".kanban-card")).toHaveLength(0);

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector(".kanban-lane-body")).not.toBeNull();
    expect(document.querySelectorAll(".kanban-card")).toHaveLength(2);

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelectorAll(".kanban-card")).toHaveLength(0);
    expect(document.querySelector(".kanban-lane-count")?.textContent).toBe("2");
  });
});
