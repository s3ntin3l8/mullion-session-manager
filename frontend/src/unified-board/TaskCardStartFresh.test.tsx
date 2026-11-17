// @vitest-environment jsdom
// TaskCard.tsx's own region, split out of TaskCard.test.tsx (issue #3194)
// because that file was already at the repo's 1200-code-line ceiling and the
// merge with main pushed it over. The subject here is one thing: the card of
// a retry that WAITS for its original host — the preserved branch is on that
// host and not on origin, so the retry cannot start anywhere else, and the
// card offers the operator's way out ("Start fresh": abandon that branch —
// it stays on that host, with its commits — and run the task from scratch).
//
// The store harness is the same one TaskCard.test.tsx uses (the board is
// still mounted in full, for the same reason: the card's own behaviour is
// what is under test, and the board is what renders it).
import type * as layoutTierModule from "../lib/layoutTier.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UnifiedBoard } from "../UnifiedBoard.js";
import type {
  GitBranchesResult,
  GitDiffStats,
  GitHubPRsStatus,
  GitStatus,
  NotificationEvent,
  Host,
  Project,
  Session,
  Task,
} from "../api/index.js";
import { makeProject, makeTask } from "../test/fixtures.js";
import { ApiError } from "../api/client.js";

let sessions: Session[];
let hosts: Host[];
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
// #3194 — "Start fresh" on a card whose retry waits for its original host.
const startFreshTask = vi.fn(async () => makeTask({}));
const requestOpenTask = vi.fn();
const openRightSidebarTask = vi.fn();
const openRightSidebarPr = vi.fn();
const openRightSidebarIssue = vi.fn();

function storeState() {
  return {
    sessions,
    hosts,
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
    startFreshTask,
    requestOpenTask,
    openRightSidebarTask,
    openRightSidebarPr,
    openRightSidebarIssue,
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
  useLayoutContext: () => ({ tier: "desktop" as const, tabletPaneCap: 2 }),
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
  hosts = [];
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
  startFreshTask.mockClear();
  requestOpenTask.mockClear();
  openRightSidebarTask.mockClear();
  localStorage.clear();
});

describe("a card for a retry waiting for its host (#3194)", () => {
  it("offers 'Start fresh', saying that the commits stay on that host", () => {
    tasks = [makeTask({ id: 1, status: "claimed", sessionId: null, retryHostId: "macbook" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Start fresh" });
    expect(button.getAttribute("title")).toContain("macbook");
    expect(button.getAttribute("title")).toContain("commits stay there");
  });

  it("starts the task fresh when the button is clicked", async () => {
    const user = userEvent.setup();
    tasks = [makeTask({ id: 1, status: "claimed", sessionId: null, retryHostId: "macbook" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Start fresh" }));
    expect(startFreshTask).toHaveBeenCalledWith(1);
  });

  it("reports a refused 'Start fresh' on the card instead of failing silently", async () => {
    const user = userEvent.setup();
    startFreshTask.mockRejectedValueOnce(new ApiError("This task is not waiting for a host", 409));
    tasks = [makeTask({ id: 1, status: "claimed", sessionId: null, retryHostId: "macbook" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Start fresh" }));
    expect(await screen.findByText("This task is not waiting for a host")).toBeInTheDocument();
  });

  it("does not offer it for a task that is not waiting for a host", () => {
    tasks = [makeTask({ id: 1, status: "claimed", sessionId: null, retryHostId: null })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Start fresh" })).toBeNull();
    // The ordinary queued hint still shows.
    expect(screen.getByText("Queued — waiting for a free slot")).toBeInTheDocument();
  });

  // Issue #3194 — a card that says "Not dispatched yet: …" must not ALSO say
  // "Queued — waiting for a free slot": two contradictory statements about
  // the same card, and the second one is wrong (the task is waiting for a
  // host, not for a slot).
  it("does not claim a waiting card is queued for a free slot", () => {
    tasks = [
      makeTask({
        id: 1,
        status: "claimed",
        sessionId: null,
        retryHostId: null,
        failureReason: "preparing a checkout on linux",
      }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByText(/Not dispatched yet/)).toBeInTheDocument();
    expect(screen.queryByText("Queued — waiting for a free slot")).toBeNull();
  });
});
