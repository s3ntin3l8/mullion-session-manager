// @vitest-environment jsdom
// The board card for a task whose review ended without a verdict after its
// automatic re-arm (`review-inconclusive`). Split from TaskCard.test.tsx, which
// is at its size ceiling; it mounts the full `<UnifiedBoard>` the same way.
import type * as layoutTierModule from "../lib/layoutTier.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { UnifiedBoard } from "../UnifiedBoard.js";
import type { Task } from "../api/index.js";
import { makeProject, makeTask } from "../test/fixtures.js";

let tasks: Task[];

function storeState() {
  return {
    sessions: [],
    hosts: [],
    projects: [makeProject({ id: 1, name: "demo" })],
    tasks,
    tasksLoaded: true,
    taskMasterEnabled: true,
    kanbanOrder: {},
    setKanbanColumnOrder: vi.fn(),
    deleteSession: vi.fn(async () => {}),
    setViewMode: vi.fn(),
    hideEndedSessions: false,
    refreshTasks: vi.fn(async () => {}),
    updateTask: vi.fn(async () => makeTask({})),
    createTask: vi.fn(async () => makeTask({})),
    requestOpenTask: vi.fn(),
    openRightSidebarTask: vi.fn(),
    openRightSidebarPr: vi.fn(),
    openRightSidebarIssue: vi.fn(),
    settings: { sessions: { confirmBeforeKill: false } },
    theme: "dark",
    // The board publishes its status counts for the left rail.
    setBoardStatuses: () => {},
    events: {},
    sessionGitStatuses: {},
    gitDiffStats: {},
    gitBranchesByProject: {},
    prsByProject: {},
  };
}

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
  tasks = [];
});

describe("a review that is still inconclusive after its re-arm", () => {
  it.each([0, 2])("shows one needs-a-human line at autoReturnRounds %i", (rounds) => {
    tasks = [
      makeTask({
        id: 1,
        status: "reviewing",
        autoReturnCapAnnouncedAt: "2026-01-01T00:00:00.000Z",
        reviewSessionId: 9,
        reviewFindingsIngestedSessionId: 9,
        lastReviewVerdict: "inconclusive",
        autoReturnRounds: rounds,
        needsHumanReason: "review-inconclusive",
      }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getAllByTestId("review-inconclusive-needs-human")).toHaveLength(1);
    expect(screen.queryByText(/Round \d/)).toBeNull();
  });

  it("shows the line from the reason alone, even without the stop stamp", () => {
    tasks = [
      makeTask({
        id: 1,
        status: "reviewing",
        autoReturnCapAnnouncedAt: null,
        autoReturnRounds: 2,
        reviewSessionId: 9,
        lastReviewVerdict: "inconclusive",
        needsHumanReason: "review-inconclusive",
      }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getAllByTestId("review-inconclusive-needs-human")).toHaveLength(1);
  });
});
