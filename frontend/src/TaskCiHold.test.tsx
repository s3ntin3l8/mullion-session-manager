// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskDetail } from "./TaskDetail.js";
import { makeTask } from "./test/fixtures.js";
import type * as ApiModule from "./api/index.js";
import type { Task } from "./api/index.js";

// A red CI check the worker could not fix. The task keeps its approval through
// a CI fix, so the park must be shown even when `approvalState` is set (it used
// to be hidden behind it), and "Merge anyway" is offered only for a merge held
// by named non-required checks.
let tasks: Task[];
const mergeTask = vi.fn(async () => makeTask({}));

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
      mergeTask,
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

beforeEach(() => mergeTask.mockClear());

describe("TaskDetail: a parked red CI check", () => {
  const parked = {
    status: "reviewing" as const,
    autoReturnCapAnnouncedAt: "2026-01-01T00:00:00.000Z",
    approvalState: "awaiting-human" as const,
    reviewSessionId: 9,
    reviewFindingsIngestedSessionId: 9,
    lastReviewVerdict: "approved" as const,
  };

  it("names the unfixable check and the worker's reason even though the task is approved", () => {
    tasks = [
      makeTask({
        id: 1,
        ...parked,
        needsHumanReason: "ci-unfixable",
        ciHoldNote: "dependency-audit — upstream advisory, no patched release",
      }),
    ];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    const strip = screen.getByTestId("ci-hold-needs-human");
    expect(strip).toHaveTextContent(
      "Needs a human: a CI check can't be fixed from this PR: dependency-audit — upstream advisory, no patched release",
    );
    expect(strip).toHaveTextContent('use "Merge anyway"');
  });

  it("labels ci-still-red the same way, with no round spent", () => {
    tasks = [
      makeTask({
        id: 1,
        ...parked,
        autoReturnRounds: 0,
        needsHumanReason: "ci-still-red",
        ciHoldNote: "codecov/patch",
      }),
    ];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    expect(screen.getByTestId("ci-hold-needs-human")).toHaveTextContent(
      "CI still red after the worker and two reruns: codecov/patch",
    );
  });

  it("does not repeat itself as a 'Round N' line when rounds were spent and nothing is approved", () => {
    tasks = [
      makeTask({
        id: 1,
        ...parked,
        approvalState: null,
        autoReturnRounds: 5,
        needsHumanReason: "ci-unfixable",
        ciHoldNote: "dependency-audit",
      }),
    ];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    expect(screen.getAllByText(/a CI check can't be fixed from this PR/)).toHaveLength(1);
    expect(screen.queryByText(/Round 5/)).toBeNull();
  });

  it("is not shown once the stop stamp is gone (the task was re-armed)", () => {
    tasks = [
      makeTask({
        id: 1,
        ...parked,
        autoReturnCapAnnouncedAt: null,
        needsHumanReason: "ci-unfixable",
        ciHoldNote: "dependency-audit",
      }),
    ];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    expect(screen.queryByTestId("ci-hold-needs-human")).toBeNull();
  });
});

describe("TaskDetail: Merge anyway", () => {
  const held = {
    status: "done" as const,
    prNumber: 9,
    prUrl: "https://x/pull/9",
    mergeRequestedAt: "2026-01-01T00:00:00.000Z",
    mergeError:
      'Held: a non-required check is red — dependency-audit. Fix it, or use "Merge anyway" to override.',
  };

  it("is offered beside Retry merge when only named non-required checks hold the merge", async () => {
    tasks = [makeTask({ id: 1, ...held, mergeOverridable: true })];
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Retry merge" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Merge anyway" }));
    expect(mergeTask).toHaveBeenCalledWith(1, { overrideNonRequiredChecks: true });
  });

  it("is absent for any other hold, and Merge now stays a plain re-arm", async () => {
    tasks = [
      makeTask({ id: 1, ...held, mergeError: "Required checks are red", mergeOverridable: false }),
    ];
    const user = userEvent.setup();
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Merge anyway" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry merge" }));
    expect(mergeTask).toHaveBeenCalledWith(1);
  });

  it("is absent once the PR has merged", () => {
    tasks = [
      makeTask({ id: 1, ...held, mergeOverridable: true, mergedAt: "2026-01-02T00:00:00.000Z" }),
    ];
    render(<TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Merge anyway" })).toBeNull();
  });
});
