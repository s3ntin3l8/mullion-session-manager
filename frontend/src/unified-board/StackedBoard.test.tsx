// @vitest-environment jsdom
// The board stacks its statuses while it is narrow (#3011). Mounts the full
// <UnifiedBoard> with a ResizeObserver the test drives, since the decision is
// the board's own measured width and nothing else (not the tier, not the
// device).
import { useSyncExternalStore } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UnifiedBoard } from "../UnifiedBoard.js";
import type { Project, Session, Task } from "../api/index.js";
import { makeProject, makeTask } from "../test/fixtures.js";
import { STORAGE_KEYS } from "../lib/persistedState.js";

let tasks: Task[];
let projects: Project[];
let sessions: Session[];
let selectedTaskId: number | null;
const openRightSidebarTask = vi.fn();
const requestOpenTask = vi.fn();
const updateTask = vi.fn(async () => makeTask({}));
// The jump request the left rail and the strip raise (#3026), with the
// subscription a real store has, so a request re-renders the board.
let jumpRequest: { status: string; nonce: number } | null = null;
let publishedStatuses: unknown[] = [];
const storeListeners = new Set<() => void>();
let storeVersion = 0;
const requestStatusJump = (status: string) => {
  jumpRequest = { status, nonce: (jumpRequest?.nonce ?? 0) + 1 };
  storeVersion += 1;
  storeListeners.forEach((l) => l());
};

function storeState() {
  return {
    sessions,
    projects,
    tasks,
    tasksLoaded: true,
    tasksError: null,
    taskMasterEnabled: true,
    kanbanOrder: {},
    setKanbanColumnOrder: vi.fn(),
    deleteSession: vi.fn(),
    setViewMode: vi.fn(),
    openSessionInWorkspace: vi.fn(),
    selectedTaskId,
    requestOpenTask,
    openRightSidebarTask,
    hideEndedSessions: false,
    refreshTasks: vi.fn(async () => {}),
    updateTask,
    createTask: vi.fn(),
    settings: { sessions: { confirmBeforeKill: false } },
    theme: "dark",
    events: {},
    sessionGitStatuses: {},
    gitDiffStats: {},
    gitBranchesByProject: {},
    prsByProject: {},
    mutedSessionIds: [] as number[],
    statusJumpRequest: jumpRequest,
    requestStatusJump,
    setBoardStatuses: (entries: unknown[]) => {
      publishedStatuses = entries;
    },
  };
}

vi.mock("../store/index.js", () => {
  const useDashboardStore = (selector?: (s: unknown) => unknown) => {
    useSyncExternalStore(
      (l) => {
        storeListeners.add(l);
        return () => storeListeners.delete(l);
      },
      () => storeVersion,
    );
    const state = storeState();
    return selector ? selector(state) : state;
  };
  useDashboardStore.getState = storeState;
  return { useDashboardStore };
});

// The board's measured width and the observer that reports it.
let boardWidth = 0;
const observers: Array<() => void> = [];
class FakeResizeObserver {
  private cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
    observers.push(this.cb);
  }
  observe() {}
  disconnect() {
    const i = observers.indexOf(this.cb);
    if (i >= 0) observers.splice(i, 1);
  }
}
function resizeBoard(width: number) {
  boardWidth = width;
  act(() => observers.forEach((cb) => cb()));
}

function rect(left: number, top: number, width: number): DOMRect {
  return {
    left,
    top,
    width,
    height: 60,
    right: left + width,
    bottom: top + 60,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

const animate = vi.fn();
const scrollIntoView = vi.fn();
let reducedMotion = false;
const original = {
  rect: Element.prototype.getBoundingClientRect,
};

beforeEach(() => {
  jumpRequest = null;
  publishedStatuses = [];
  projects = [makeProject({ id: 1, name: "demo" })];
  sessions = [];
  tasks = [
    makeTask({ id: 1, status: "backlog", title: "Someday", boardOrder: 0 }),
    makeTask({ id: 2, status: "ready", title: "Next up", boardOrder: 0 }),
    makeTask({ id: 3, status: "in_progress", title: "Being built" }),
    makeTask({
      id: 4,
      status: "reviewing",
      title: "Waiting on you",
      approvalState: "awaiting-human",
    }),
    makeTask({ id: 5, status: "done", title: "Shipped" }),
  ];
  selectedTaskId = null;
  boardWidth = 0;
  observers.length = 0;
  reducedMotion = false;
  animate.mockClear();
  scrollIntoView.mockClear();
  openRightSidebarTask.mockClear();
  requestOpenTask.mockClear();
  updateTask.mockClear();
  localStorage.clear();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("prefers-reduced-motion") ? reducedMotion : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  // The board reports its width; a card is somewhere else in each layout.
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.classList.contains("kanban-unified")) return rect(0, 0, boardWidth);
    if (this.classList.contains("task-card")) {
      const stacked = this.closest('[data-board-layout="stacked"]') !== null;
      return stacked ? rect(12, 300, 360) : rect(400, 80, 180);
    }
    return original.rect.call(this);
  };
  Element.prototype.animate = animate as unknown as Element["animate"];
  Element.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = original.rect;
  // jsdom has neither; leave it that way for the other files.
  delete (Element.prototype as { animate?: unknown }).animate;
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  vi.unstubAllGlobals();
});

const renderBoard = () => render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
const layout = () => document.querySelector(".kanban-unified")?.getAttribute("data-board-layout");
const sectionOrder = () =>
  Array.from(document.querySelectorAll(".stacked-section")).map((s) =>
    s.getAttribute("data-status"),
  );
const header = (name: string) =>
  within(screen.getByRole("region", { name })).getAllByRole("button")[0];

describe("UnifiedBoard stacked layout", () => {
  it("keeps lanes while the board is unmeasured or has room for three", () => {
    renderBoard();
    expect(layout()).toBe("lanes");
    resizeBoard(800);
    expect(layout()).toBe("lanes");
    expect(document.querySelector(".stacked-board")).toBeNull();
  });

  it("stacks from the first paint when the board is narrow", () => {
    boardWidth = 378;
    renderBoard();
    expect(layout()).toBe("stacked");
    // The first measurement is not a change: nothing travels.
    expect(animate).not.toHaveBeenCalled();
  });

  it("does not move or fade the selected card when the board starts narrow", () => {
    selectedTaskId = 2;
    boardWidth = 378;
    renderBoard();
    expect(layout()).toBe("stacked");
    expect(animate).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("lists active statuses first, Backlog and Done collapsed, each with a count", () => {
    boardWidth = 378;
    renderBoard();
    expect(sectionOrder()).toEqual(["reviewing", "in_progress", "ready", "backlog", "done"]);
    expect(header("Reviewing")).toHaveAttribute("aria-expanded", "true");
    expect(header("In Progress")).toHaveAttribute("aria-expanded", "true");
    expect(header("Ready")).toHaveAttribute("aria-expanded", "true");
    expect(header("Backlog")).toHaveAttribute("aria-expanded", "false");
    expect(header("Done")).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Next up")).toBeInTheDocument();
    expect(screen.queryByText("Someday")).toBeNull();
    expect(screen.queryByText("Shipped")).toBeNull();
    expect(within(header("Backlog")).getByText("1")).toBeInTheDocument();
  });

  it("puts a dot on a section holding a task that needs the owner", () => {
    boardWidth = 378;
    renderBoard();
    expect(
      within(header("Reviewing")).getByRole("img", { name: "A task here needs you" }),
    ).toBeInTheDocument();
    expect(within(header("Ready")).queryByRole("img")).toBeNull();
  });

  it("opens and folds a section from its header", async () => {
    boardWidth = 378;
    renderBoard();
    await userEvent.click(header("Backlog"));
    expect(screen.getByText("Someday")).toBeInTheDocument();
    await userEvent.click(header("Backlog"));
    expect(screen.queryByText("Someday")).toBeNull();
  });

  it("opens a task in the sidebar from a stacked card", async () => {
    boardWidth = 378;
    renderBoard();
    await userEvent.click(screen.getByText("Next up"));
    expect(openRightSidebarTask).toHaveBeenCalledWith(2);
    expect(requestOpenTask).not.toHaveBeenCalled();
  });

  it("with Hide done, Done shows as a header that does not open", () => {
    localStorage.setItem("crs.taskHideDone", "1");
    boardWidth = 378;
    renderBoard();
    expect(header("Done")).toBeDisabled();
    expect(header("Done")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Shipped")).toBeNull();
  });

  it("switches at the threshold in both directions, keeping the selected card in view", () => {
    selectedTaskId = 2;
    boardWidth = 900;
    renderBoard();
    expect(layout()).toBe("lanes");

    resizeBoard(539);
    expect(layout()).toBe("stacked");
    const card = document.querySelector('[data-task-id="2"]')!;
    expect(card).toHaveClass("task-card-selected");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    // It travels from where it was in the lanes to its new place.
    expect(animate).toHaveBeenCalledTimes(1);
    const [frames, options] = animate.mock.calls[0];
    expect(frames[0].transform).toBe("translate(388px, -220px) scaleX(0.5)");
    expect(frames[1].transform).toBe("none");
    expect(options.duration).toBe(420);

    resizeBoard(540);
    expect(layout()).toBe("lanes");
    expect(document.querySelector('[data-task-id="2"]')).toHaveClass("task-card-selected");
    expect(animate).toHaveBeenCalledTimes(2);
    expect(animate.mock.calls[1][0][0].transform).toBe("translate(-388px, 220px) scaleX(2)");
  });

  it("does not re-render the layout for a resize that stays on one side", () => {
    selectedTaskId = 2;
    boardWidth = 900;
    renderBoard();
    resizeBoard(700);
    expect(layout()).toBe("lanes");
    expect(animate).not.toHaveBeenCalled();
  });

  it("opens the selected task's section when it starts collapsed", () => {
    selectedTaskId = 1;
    boardWidth = 900;
    renderBoard();
    resizeBoard(400);
    expect(header("Backlog")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Someday")).toBeInTheDocument();
  });

  it("fades the card in place instead of moving it under reduced motion", () => {
    reducedMotion = true;
    selectedTaskId = 3;
    boardWidth = 900;
    renderBoard();
    resizeBoard(400);
    expect(animate).toHaveBeenCalledTimes(1);
    const [frames, options] = animate.mock.calls[0];
    expect(frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(options.duration).toBe(160);
  });

  it("re-opens a folded section when another of its tasks is selected", async () => {
    tasks = [...tasks, makeTask({ id: 6, status: "ready", title: "Also next", boardOrder: 1 })];
    selectedTaskId = 2;
    boardWidth = 378;
    const view = renderBoard();
    await userEvent.click(header("Ready"));
    expect(header("Ready")).toHaveAttribute("aria-expanded", "false");
    selectedTaskId = 6;
    view.rerender(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(header("Ready")).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector('[data-task-id="6"]')).toHaveClass("task-card-selected");
  });

  it("reorders within a stacked section by drag and drop", () => {
    tasks = [...tasks, makeTask({ id: 6, status: "ready", title: "Also next", boardOrder: 1 })];
    boardWidth = 378;
    renderBoard();
    const store = new Map<string, string>();
    const dataTransfer = {
      setData: (k: string, v: string) => store.set(k, v),
      getData: (k: string) => store.get(k) ?? "",
      get types() {
        return [...store.keys()];
      },
      effectAllowed: "none",
      dropEffect: "none",
      setDragImage() {},
    } as unknown as DataTransfer;
    const fire = (el: Element, type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
      act(() => {
        el.dispatchEvent(event);
      });
    };
    const second = document.querySelector('[data-task-id="6"]')!;
    const first = document.querySelector('[data-task-id="2"]')!;
    fire(second, "dragstart");
    fire(first, "dragover");
    fire(first, "drop");
    expect(updateTask).toHaveBeenCalled();
    for (const call of updateTask.mock.calls as unknown as Array<[number, { status?: string }]>) {
      expect(call[1].status).toBeUndefined();
    }
    expect((updateTask.mock.calls as unknown as Array<[number]>).map((c) => c[0])).toContain(6);
  });

  it("does nothing to the cards when none is selected", () => {
    boardWidth = 900;
    renderBoard();
    resizeBoard(400);
    expect(layout()).toBe("stacked");
    expect(animate).not.toHaveBeenCalled();
  });

  it("the status strip jumps to a section and opens it", async () => {
    boardWidth = 378;
    renderBoard();
    const strip = screen.getByRole("navigation", { name: "Jump to status" });
    expect(within(strip).getByRole("button", { name: "Reviewing, 1, needs you" })).toBeVisible();
    await userEvent.click(within(strip).getByRole("button", { name: "Backlog, 1" }));
    expect(header("Backlog")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Someday")).toBeInTheDocument();
    const section = screen.getByRole("region", { name: "Backlog" });
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(section);
  });

  it("a jump raised from outside the board (the rail) opens and scrolls to the section", () => {
    boardWidth = 378;
    renderBoard();
    expect(header("Backlog")).toHaveAttribute("aria-expanded", "false");
    scrollIntoView.mockClear();
    act(() => requestStatusJump("backlog"));
    expect(header("Backlog")).toHaveAttribute("aria-expanded", "true");
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(
      screen.getByRole("region", { name: "Backlog" }),
    );
    // The same status again scrolls again (a new nonce).
    scrollIntoView.mockClear();
    act(() => requestStatusJump("backlog"));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("does not replay a jump that was requested before the board mounted", () => {
    jumpRequest = { status: "backlog", nonce: 4 };
    boardWidth = 378;
    renderBoard();
    expect(header("Backlog")).toHaveAttribute("aria-expanded", "false");
  });

  it("scrolls the lane into view when the board shows lanes", () => {
    boardWidth = 900;
    renderBoard();
    expect(layout()).toBe("lanes");
    scrollIntoView.mockClear();
    act(() => requestStatusJump("reviewing"));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toHaveAttribute("data-status", "reviewing");
  });

  it("with Group by, jumps to the lane's column that holds cards, not an empty chip", () => {
    localStorage.setItem(STORAGE_KEYS.taskGroupBy, "project");
    projects = [makeProject({ id: 1, name: "demo" }), makeProject({ id: 2, name: "other" })];
    tasks = [
      makeTask({ id: 1, projectId: 1, status: "ready", title: "A" }),
      makeTask({
        id: 2,
        projectId: 2,
        status: "reviewing",
        title: "B",
        approvalState: "awaiting-human",
      }),
    ];
    boardWidth = 900;
    renderBoard();
    scrollIntoView.mockClear();
    act(() => requestStatusJump("reviewing"));
    const target = scrollIntoView.mock.contexts[0] as HTMLElement;
    expect(target).toHaveAttribute("data-status", "reviewing");
    expect(target).not.toHaveClass("kanban-column-rail");
    expect(target).toHaveTextContent("B");
    localStorage.removeItem(STORAGE_KEYS.taskGroupBy);
  });

  it("does not publish statuses on the phone, which has no rail", () => {
    boardWidth = 900;
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} phone />);
    expect(publishedStatuses).toEqual([]);
  });

  it("publishes its statuses, counts and needs-you flags for the rail", () => {
    boardWidth = 900;
    renderBoard();
    expect(publishedStatuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "reviewing", count: 1, needsYou: true, needsYouCount: 1 }),
        expect.objectContaining({ id: "backlog", count: 1, needsYou: false, needsYouCount: 0 }),
      ]),
    );
  });

  it("keeps the phone's own layout whatever the width", () => {
    boardWidth = 378;
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} phone />);
    expect(layout()).toBe("lanes");
  });
});
