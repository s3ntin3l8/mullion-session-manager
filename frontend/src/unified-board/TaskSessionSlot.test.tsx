// @vitest-environment jsdom
// UnifiedBoard's nested worker/review session strip — split out of the
// former monolithic UnifiedBoard.test.tsx (PR 28, Wave 5 of
// .claude/plans/can-we-do-a-warm-cocke.md), owns every test that exercises
// TaskSessionSlot.tsx's own region. Still mounts the full `<UnifiedBoard>`
// (same reasoning as session-row/Header.test.tsx's own header comment) —
// the strip's status label/logo are derived by TaskSessionSlot itself off
// the linked session's live store data, which is simplest to drive through
// a real board render.
import type * as layoutTierModule from "../lib/layoutTier.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
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
const requestOpenTask = vi.fn();
const openRightSidebarTask = vi.fn();

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
    requestOpenTask,
    openRightSidebarTask,
    settings: { sessions: { confirmBeforeKill: false } },
    theme: "dark",
    events,
    sessionGitStatuses,
    gitDiffStats,
    gitBranchesByProject,
    prsByProject,
  };
}

// useOpenTask (which the board uses to open a task) reads the layout tier; the
// real one resolves it from matchMedia, which jsdom does not provide. These
// tests assert the desktop path (selection in the sidebar's Tasks view).
vi.mock("../lib/layoutTier.js", async (importOriginal) => ({
  ...(await importOriginal<typeof layoutTierModule>()),
  useLayoutContext: () => ({ tier: "desktop" as const }),
}));

vi.mock("../store/index.js", () => {
  const useDashboardStore = (selector?: (s: unknown) => unknown) => {
    const state = storeState();
    return selector ? selector(state) : state;
  };
  useDashboardStore.getState = storeState;
  return { useDashboardStore };
});

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
  requestOpenTask.mockClear();
  openRightSidebarTask.mockClear();
  localStorage.clear();
});

// The lane starts collapsed (#2336); most tests read its body, so they render
// the board and open the lane first.
function renderExpanded(ui: ReactElement) {
  const result = render(ui);
  fireEvent.click(screen.getByRole("button", { name: /Ad-hoc sessions/ }));
  return result;
}

describe("UnifiedBoard nested task session strip", () => {
  it("renders a live worker strip for task.sessionId and excludes it from the ad-hoc lane", () => {
    sessions = [makeSession({ id: 7, projectId: 1, command: "claude", sessionStatus: "working" })];
    tasks = [makeTask({ id: 1, status: "in_progress", sessionId: 7 })];
    renderExpanded(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

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
    // Each strip's open button carries its own role ("worker"/"review") and
    // its own live status in its title — this is what actually makes them
    // distinct rather than two copies of the same content.
    expect(strips.map((s) => s.querySelector("button")!.getAttribute("title"))).toEqual([
      "worker: Working",
      "review: Idle",
    ]);
    // Hermes review — the role also needs to be in the VISIBLE text (which is
    // also the button's accessible name), not just in a title.
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

  it("clicking the strip opens the session (via the board's own onOpenSession prop, unwrapped), not the drawer", async () => {
    // Issue: the setViewMode-before-onOpenSession ordering this used to
    // assert has moved to usePanelOpener.ts's own leaveTaskView — see that
    // hook's own tests. UnifiedBoard just forwards whatever onOpenSession
    // it's given straight through to this strip now.
    sessions = [makeSession({ id: 7, projectId: 1, command: "claude" })];
    tasks = [makeTask({ id: 1, status: "in_progress", sessionId: 7 })];
    const onOpenSession = vi.fn();
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={onOpenSession} onSessionEnded={vi.fn()} />);

    const strip = document.querySelector(".task-card-session-strip")!;
    await user.click(strip);

    expect(onOpenSession).toHaveBeenCalledWith(sessions[0]);
    expect(setViewMode).not.toHaveBeenCalled();
    expect(openRightSidebarTask).not.toHaveBeenCalled();
  });

  // Hermes review — the strip used to be draggable with the session MIME
  // on the (wrong) assumption there was no reachable drop target for it
  // inside the board. The ad-hoc lane's own unified-board/LaneCard.tsx
  // accepts exactly that MIME for its reorder: dropping a task-linked strip
  // there highlighted a valid target, silently no-op'd (task-linked ids are
  // excluded from every lane column), and a completed drag's stray click
  // then opened the session — actively navigating the user out of the
  // board, not a harmlessly dead affordance. Fixed by not making the strip
  // draggable at all; this asserts that fix rather than the removed
  // behavior.
  it("is not draggable, so it can never be dropped onto a lane card", () => {
    sessions = [makeSession({ id: 7, projectId: 1, command: "claude" })];
    tasks = [makeTask({ id: 1, status: "in_progress", sessionId: 7 })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const strip = document.querySelector(".task-card-session-strip")!;
    expect(strip.getAttribute("draggable")).not.toBe("true");
  });

  // The strip used to be a mouse-only span, because it sat inside the task
  // card's own role="button". The card root is a plain container now (#2873),
  // so the strip holds one real <button> (a tab stop that keyboard users can use
  // to open the session). The strip itself is not the button: the setup badge
  // is a button too and must not nest inside one.
  it("holds a real open button, reachable by keyboard, that opens the session without opening the task", async () => {
    sessions = [makeSession({ id: 7, projectId: 1, command: "claude", setupStatus: "failed" })];
    tasks = [makeTask({ id: 1, status: "in_progress", sessionId: 7 })];
    const onOpenSession = vi.fn();
    render(<UnifiedBoard onOpenSession={onOpenSession} onSessionEnded={vi.fn()} />);

    const strip = document.querySelector<HTMLElement>(".task-card-session-strip")!;
    expect(strip.tagName).not.toBe("BUTTON");
    const open = strip.querySelector<HTMLElement>("button.task-card-session-strip-open")!;
    expect(open.getAttribute("type")).toBe("button");
    expect(open.getAttribute("tabindex")).toBeNull();
    open.focus();
    expect(open).toHaveFocus();
    // Enter on a focused button fires a click, which reaches the strip's handler.
    await userEvent.setup().keyboard("{Enter}");
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    // The setup badge is a sibling button, not nested in the open button.
    expect(strip.querySelectorAll("button button")).toHaveLength(0);
    expect(open.querySelector("button")).toBeNull();
    expect(strip.querySelector("button.setup-badge")).not.toBeNull();
  });
});
