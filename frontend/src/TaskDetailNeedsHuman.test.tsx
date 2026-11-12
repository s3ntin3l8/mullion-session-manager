// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TaskDetail } from "./TaskDetail.js";
import { makeTask } from "./test/fixtures.js";
import type * as ApiModule from "./api/index.js";
import type { Task } from "./api/index.js";

// #2750 — the merge-tied "needs a human" reasons are labelled in the drawer
// even when the review loop never stopped (no round spent, no cap stamp).
let tasks: Task[];

vi.mock("./store/index.js", () => ({
  useDashboardStore: (selector?: (s: unknown) => unknown) => {
    const state = {
      settings: undefined,
      tasks,
      sessions: [],
      hosts: [],
      projects: [],
      events: {},
      taskMasterEnabled: true,
      taskMasterEnv: null,
      prsByProject: {},
      updateTask: vi.fn(),
      refreshTasks: vi.fn(async () => {}),
      openRightSidebarPr: vi.fn(),
      requestOpenSession: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
  eventKey: (sessionId: number, seq: number) => `${sessionId}:${seq}`,
}));

vi.mock("./api/index.js", async () => {
  const actual = await vi.importActual<typeof ApiModule>("./api/index.js");
  return { ...actual, api: { ...actual.api, listProjectActions: vi.fn(async () => []) } };
});

describe("TaskDetail merge-tied needs-a-human reasons", () => {
  it.each([
    ["rebase-exhausted", /Needs a human: auto-rebase gave up, the PR still conflicts with main/],
    ["blocked-threads", /Needs a human: merge blocked on unresolved review conversations/],
    // #2904 — a stuck non-Actions status must read as a Codecov-side stall, not
    // as a task that is merely reviewing.
    ["ci-status-stalled", /Needs a human: a CI status stayed pending after green CI/],
  ] as const)("labels %s", (reason, expected) => {
    tasks = [makeTask({ id: 1, status: "done", needsHumanReason: reason })];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it("shows the review-post-failed block with the sync error, and not once it is cleared", () => {
    tasks = [
      makeTask({
        id: 1,
        status: "done",
        needsHumanReason: "review-post-failed",
        githubSyncError: "Not Found",
        reviewFindings: "## Round 1\nAll good.",
      }),
    ];
    const { unmount } = render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(
      screen.getByText(/approving review could not be posted to GitHub, needs a human — Not Found/),
    ).toBeInTheDocument();
    unmount();
    tasks = [
      makeTask({
        id: 1,
        status: "done",
        needsHumanReason: null,
        githubSyncError: "Not Found",
        reviewFindings: "## Round 1\nAll good.",
      }),
    ];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.queryByText(/could not be posted to GitHub/)).toBeNull();
  });

  it("shows the review-post block from the terminal marker alone, and not once it is cleared", () => {
    // reviewPostFailed rides beside whatever needsHumanReason the task carries.
    tasks = [
      makeTask({
        id: 1,
        status: "reviewing",
        needsHumanReason: "cap",
        reviewPostFailed: true,
        githubSyncError: "Not Found",
        reviewFindings: "## Round 1\nAll good.",
      }),
    ];
    const { unmount } = render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(
      screen.getByText(/approving review could not be posted to GitHub, needs a human — Not Found/),
    ).toBeInTheDocument();
    unmount();
    tasks = [
      makeTask({
        id: 1,
        status: "reviewing",
        needsHumanReason: "cap",
        reviewPostFailed: false,
        githubSyncError: "Not Found",
        reviewFindings: "## Round 1\nAll good.",
      }),
    ];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.queryByText(/could not be posted to GitHub/)).toBeNull();
  });

  it("shows nothing for a merged task", () => {
    tasks = [
      makeTask({
        id: 1,
        status: "done",
        needsHumanReason: "blocked-threads",
        mergedAt: "2026-09-04T09:34:44.000Z",
      }),
    ];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.queryByText(/Needs a human/)).toBeNull();
  });

  it("hides the review-post-failed block after the task is merged", () => {
    tasks = [
      makeTask({
        id: 1,
        status: "done",
        needsHumanReason: "review-post-failed",
        githubSyncError: "Not Found",
        reviewFindings: "## Round 1\nAll good.",
        mergedAt: "2026-09-04T09:34:44.000Z",
      }),
    ];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);
    expect(screen.queryByText(/approving review could not be posted to GitHub/)).toBeNull();
  });
});
