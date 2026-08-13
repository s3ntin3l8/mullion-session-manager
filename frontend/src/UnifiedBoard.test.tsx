// @vitest-environment jsdom
// UnifiedBoard's own orchestration — split (PR 28, Wave 5 of
// .claude/plans/can-we-do-a-warm-cocke.md) alongside unified-board/*.tsx.
// This file keeps every test that exercises the BOARD's own state rather
// than a single sub-component's presentation: task drag-and-drop (spans
// TaskColumn.tsx's drop targets, TaskCard.tsx's drag source, and this
// file's own `applyDrop`/`updateTask` call), and the detail drawer plus its
// resize (both owned entirely by UnifiedBoard itself, not a sub-component).
// Per-region tests live in unified-board/TasksToolbar.test.tsx,
// unified-board/TaskColumn.test.tsx, unified-board/TaskCard.test.tsx,
// unified-board/TaskSessionSlot.test.tsx, and unified-board/LaneCard.test.tsx
// — see each file's own header comment.
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
} from "./api/index.js";
import { makeProject, makeTask } from "./test/fixtures.js";

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

// #610 cut a project filter for this exact reason: "the drag/reorder math
// indexes against the rendered list, not the full store list, and
// filtering would silently corrupt boardOrder on drop." tasksBoard.test.ts
// covers absoluteDropIndex's own math in isolation; these tests cover the
// board actually wiring it up — persistence, rendering, and that a drag
// inside a filtered column produces the same updateTask calls dragging the
// same two cards with no filter active would.
describe("UnifiedBoard project filter", () => {
  it("shows no filter bar with a single project", () => {
    projects = [makeProject({ id: 1, name: "demo" })];
    tasks = [makeTask({ id: 1, projectId: 1, status: "ready" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.queryByRole("group", { name: "Filter by project" })).toBeNull();
  });

  it("hides tasks from unselected projects and shows a Clear affordance", async () => {
    tasks = [
      makeTask({ id: 1, projectId: 1, projectName: "demo", status: "ready", title: "demo task" }),
      makeTask({ id: 2, projectId: 2, projectName: "other", status: "ready", title: "other task" }),
    ];
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    expect(screen.getByText("demo task")).toBeInTheDocument();
    expect(screen.getByText("other task")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "demo" }));

    expect(screen.getByText("demo task")).toBeInTheDocument();
    expect(screen.queryByText("other task")).toBeNull();
    expect(screen.getByRole("button", { name: "demo" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "Show every project" }));
    expect(screen.getByText("other task")).toBeInTheDocument();
  });

  it("persists the selected projects to localStorage and restores them on remount", async () => {
    projects = [makeProject({ id: 1, name: "demo" }), makeProject({ id: 2, name: "other" })];
    tasks = [
      makeTask({ id: 1, projectId: 1, status: "ready", title: "demo task" }),
      makeTask({ id: 2, projectId: 2, status: "ready", title: "other task" }),
    ];
    const user = userEvent.setup();
    const first = render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "demo" }));
    expect(JSON.parse(localStorage.getItem("crs.taskProjectFilter")!)).toEqual([1]);
    first.unmount();

    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByText("demo task")).toBeInTheDocument();
    expect(screen.queryByText("other task")).toBeNull();
  });

  it("drops an id belonging to a since-deleted project rather than blanking the board", () => {
    localStorage.setItem("crs.taskProjectFilter", JSON.stringify([1, 999]));
    projects = [makeProject({ id: 1, name: "demo" })];
    tasks = [makeTask({ id: 1, projectId: 1, status: "ready", title: "demo task" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByText("demo task")).toBeInTheDocument();
  });

  it("shows a distinct empty state when the filter hides every task, with a one-click Clear", async () => {
    tasks = [makeTask({ id: 1, projectId: 2, status: "ready", title: "other task" })];
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "demo" }));
    expect(screen.getByText("No tasks in the selected projects.")).toBeInTheDocument();
    expect(screen.queryByText("No tasks yet.")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Clear the project filter" }));
    expect(screen.getByText("other task")).toBeInTheDocument();
  });

  it("reorders identically whether dragged inside a filtered column or with no filter active", async () => {
    // Same "demo" pair as the unfiltered reorder test above, plus a hidden
    // "other"-project task interleaved between them in boardOrder — the
    // filtered case must still emit the exact same two updateTask calls.
    tasks = [
      makeTask({ id: 1, projectId: 1, status: "ready", boardOrder: 0, title: "first" }),
      makeTask({ id: 3, projectId: 2, status: "ready", boardOrder: 1, title: "hidden" }),
      makeTask({ id: 2, projectId: 1, status: "ready", boardOrder: 2, title: "second" }),
    ];
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "demo" }));

    const readyColumn = screen
      .getByText("Ready", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!;
    const cards = readyColumn.querySelectorAll(".task-card");
    expect(cards).toHaveLength(2); // "hidden" is filtered out of the render

    const dataTransfer = createDataTransfer({ "application/x-mullion-task": "1" });
    act(() => cards[0].dispatchEvent(createDragEvent("dragstart", dataTransfer)));
    cards[1].dispatchEvent(createDragEvent("drop", dataTransfer));

    // Dragging task 1 onto task 2 pushes everything between their OLD
    // positions up by one to make room — including hidden task 3, which
    // sits between them in boardOrder even though its own card never
    // rendered. That's correct, not a leak: an unfiltered drag of the same
    // two cards onto each other (task 3 rendered in between, in full view)
    // produces this exact same three-way reshuffle, since task 3's card
    // would sit at the identical index in the full column either way.
    expect(updateTask).toHaveBeenCalledWith(3, { boardOrder: 0 });
    expect(updateTask).toHaveBeenCalledWith(2, { boardOrder: 1 });
    expect(updateTask).toHaveBeenCalledWith(1, { boardOrder: 2 });
    expect(updateTask).toHaveBeenCalledTimes(3);
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
