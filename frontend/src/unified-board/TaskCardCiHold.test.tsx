// @vitest-environment jsdom
// The board card for a task parked on a red CI check (`ci-unfixable` /
// `ci-still-red`). Split from TaskCard.test.tsx, which is at its size ceiling;
// it mounts the full `<UnifiedBoard>` the same way.
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

describe("a parked red CI check", () => {
  const parked = {
    status: "reviewing" as const,
    autoReturnCapAnnouncedAt: "2026-01-01T00:00:00.000Z",
    reviewSessionId: 9,
    reviewFindingsIngestedSessionId: 9,
    lastReviewVerdict: "approved" as const,
  };

  it("names the check on an APPROVED card (the approval used to hide the park)", () => {
    tasks = [
      makeTask({
        id: 1,
        ...parked,
        approvalState: "awaiting-human",
        needsHumanReason: "ci-unfixable",
        ciHoldNote: "dependency-audit — no patched release",
      }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    const line = screen.getByTestId("ci-hold-needs-human");
    // The card names the check; the worker's reason stays in the tooltip.
    expect(line).toHaveTextContent(
      "a CI check can't be fixed from this PR (dependency-audit), needs a human",
    );
    expect(line).toHaveAttribute("title", "dependency-audit — no patched release");
  });

  it("shows once, not also as a Round line, when rounds were spent and nothing is approved", () => {
    tasks = [
      makeTask({
        id: 1,
        ...parked,
        approvalState: null,
        autoReturnRounds: 5,
        needsHumanReason: "ci-still-red",
        ciHoldNote: "codecov/patch",
      }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByTestId("ci-hold-needs-human")).toHaveTextContent(
      "CI still red after the worker and two reruns (codecov/patch), needs a human",
    );
    expect(screen.queryByText(/Round 5/)).toBeNull();
  });

  it("counts the checks instead of listing several, with the full note in the tooltip", () => {
    const note =
      "test-frontend / test-merge, test-frontend / test-shard (1), test-frontend / lint-and-test — a base-branch regression";
    tasks = [makeTask({ id: 1, ...parked, needsHumanReason: "ci-unfixable", ciHoldNote: note })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    const line = screen.getByTestId("ci-hold-needs-human");
    expect(line).toHaveTextContent(
      "a CI check can't be fixed from this PR (3 checks), needs a human",
    );
    expect(line).toHaveAttribute("title", note);
  });

  it("clears when the task is re-armed (no stop stamp)", () => {
    tasks = [
      makeTask({
        id: 1,
        ...parked,
        autoReturnCapAnnouncedAt: null,
        needsHumanReason: "ci-unfixable",
        ciHoldNote: "dependency-audit",
      }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.queryByTestId("ci-hold-needs-human")).toBeNull();
  });
});
