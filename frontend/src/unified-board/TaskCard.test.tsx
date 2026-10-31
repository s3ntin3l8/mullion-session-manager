// @vitest-environment jsdom
// UnifiedBoard's individual task cards — split out of the former monolithic
// UnifiedBoard.test.tsx (PR 28, Wave 5 of
// .claude/plans/can-we-do-a-warm-cocke.md), owns every test that exercises
// TaskCard.tsx's own region (title/project/issue/PR/agent/age/sync-error/
// failure-reason/review-round content, and the card's own drag-suppresses-
// click guard on its PR badge). Column-level concerns (counts, empty state)
// are TaskColumn.test.tsx's — see that file's own header comment. Still
// mounts the full `<UnifiedBoard>` (same reasoning as
// session-row/Header.test.tsx's own header comment).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
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
import { makeHost, makeProject, makeSession, makeTask } from "../test/fixtures.js";

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

function storeState() {
  return {
    pendingOpenTaskId: null,
    setPendingOpenTaskId: vi.fn(),
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
  useDashboardStore.getState = storeState;
  return { useDashboardStore };
});

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
  localStorage.clear();
});

describe("UnifiedBoard task columns", () => {
  describe("awaiting-merge badge", () => {
    const base = { status: "done" as const, prNumber: 9, prUrl: "https://github.com/o/r/pull/9" };
    const BADGE = "PR open — needs merge";

    it("shows for done + PR + no mergedAt, with the merge-on-approve-off reason", () => {
      tasks = [makeTask({ id: 1, ...base, mergedAt: null, mergeRequestedAt: null })];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      expect(screen.getByText(BADGE)).toHaveAttribute(
        "title",
        "Merge on approve is off for this project",
      );
    });

    it("is absent for merged and PR-less done tasks", () => {
      tasks = [
        makeTask({ id: 1, ...base, mergedAt: "2026-01-01T00:00:00.000Z" }),
        makeTask({ id: 2, status: "done", prNumber: null, prUrl: null }),
      ];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      expect(screen.queryByText(BADGE)).toBeNull();
    });

    it("reads 'waiting' when a merge is requested with no error", () => {
      tasks = [
        makeTask({ id: 1, ...base, mergedAt: null, mergeRequestedAt: "2026-01-01T00:00:00.000Z" }),
      ];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      expect(screen.getByText(BADGE)).toHaveAttribute("title", "Merge requested, waiting");
    });

    it("carries mergeError text when present", () => {
      tasks = [
        makeTask({
          id: 1,
          ...base,
          mergedAt: null,
          mergeRequestedAt: "2026-01-01T00:00:00.000Z",
          mergeError: "PR is unstable",
        }),
      ];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      expect(screen.getByText(BADGE)).toHaveAttribute("title", "PR is unstable");
    });
  });

  it("shows the project name, issue number, and agent on a card", () => {
    tasks = [
      makeTask({
        id: 1,
        status: "in_progress",
        issueNumber: 42,
        htmlUrl: "https://github.com/o/r/issues/42",
        agentCommand: "claude code --dangerously-skip-permissions",
      }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    expect(screen.getAllByText("demo").length).toBeGreaterThan(0);
    expect(screen.getByText("#42")).toBeInTheDocument();
    expect(screen.getByText("claude")).toBeInTheDocument();
  });

  it("shows the matched PR's number and CI status on a card, joined by branchName", () => {
    tasks = [makeTask({ id: 7, status: "reviewing", branchName: "mullion/task-7" })];
    prsByProject = {
      1: {
        prs: [
          {
            number: 12,
            title: "fix: the widget",
            htmlUrl: "https://github.com/o/r/pull/12",
            author: "mullion-bot",
            headSha: "abc123",
            headBranch: "mullion/task-7",
            baseBranch: "main",
            ciStatus: "success",
            actionsRuns: [],
          },
        ],
        prSummary: { total: 1, pass: 1, fail: 0, pending: 0, unknown: 0 },
      },
    };
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const link = screen.getByRole("link", { name: /#12/ });
    expect(link).toHaveAttribute("href", "https://github.com/o/r/pull/12");
    expect(link.querySelector(".github-panel-ci-dot.good")).toBeInTheDocument();
  });

  it("prefers the task's recorded PR number over the branch (matchSessionPr)", () => {
    tasks = [makeTask({ id: 7, status: "reviewing", branchName: "mullion/task-7", prNumber: 21 })];
    const pr = (number: number, headBranch: string) => ({
      number,
      title: `pr ${number}`,
      htmlUrl: `https://github.com/o/r/pull/${number}`,
      author: "mullion-bot",
      headSha: "abc",
      headBranch,
      baseBranch: "main",
      ciStatus: "success" as const,
      actionsRuns: [],
    });
    prsByProject = {
      1: {
        prs: [pr(12, "mullion/task-7"), pr(21, "worker-switched-branch")],
        prSummary: { total: 2, pass: 2, fail: 0, pending: 0, unknown: 0 },
      },
    };
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    expect(screen.getByRole("link", { name: /#21/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /#12/ })).toBeNull();
  });

  it("shows no PR badge when no open PR matches the task's branch", () => {
    tasks = [makeTask({ id: 7, status: "reviewing", branchName: "mullion/task-7" })];
    prsByProject = {
      1: {
        prs: [
          {
            number: 3,
            title: "unrelated",
            htmlUrl: "https://github.com/o/r/pull/3",
            author: "mullion-bot",
            headSha: "def456",
            headBranch: "some-other-branch",
            baseBranch: "main",
            ciStatus: "failure",
            actionsRuns: [],
          },
        ],
        prSummary: { total: 1, pass: 0, fail: 1, pending: 0, unknown: 0 },
      },
    };
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    expect(screen.queryByRole("link", { name: /#3/ })).toBeNull();
  });

  it("clicking the PR badge does not also open the task drawer", async () => {
    const user = userEvent.setup();
    tasks = [makeTask({ id: 7, status: "reviewing", branchName: "mullion/task-7" })];
    prsByProject = {
      1: {
        prs: [
          {
            number: 12,
            title: "fix: the widget",
            htmlUrl: "https://github.com/o/r/pull/12",
            author: "mullion-bot",
            headSha: "abc123",
            headBranch: "mullion/task-7",
            baseBranch: "main",
            ciStatus: "in_progress",
            actionsRuns: [],
          },
        ],
        prSummary: { total: 1, pass: 0, fail: 0, pending: 1, unknown: 0 },
      },
    };
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    await user.click(screen.getByRole("link", { name: /#12/ }));

    expect(screen.queryByTestId("task-detail-stub")).toBeNull();
  });

  // Hermes review, PR #577/#580 — the PR badge sits inside the draggable
  // card; a completed drag's trailing click lands on this anchor too, and
  // stopPropagation alone doesn't stop its default navigation.
  it("suppresses the PR badge's own default navigation after a card drag-and-drop, not just the drawer open", () => {
    tasks = [
      makeTask({
        id: 7,
        status: "reviewing",
        boardOrder: 0,
        title: "first",
        branchName: "mullion/task-7",
      }),
      makeTask({ id: 8, status: "reviewing", boardOrder: 1, title: "second" }),
    ];
    prsByProject = {
      1: {
        prs: [
          {
            number: 12,
            title: "fix: the widget",
            htmlUrl: "https://github.com/o/r/pull/12",
            author: "mullion-bot",
            headSha: "abc123",
            headBranch: "mullion/task-7",
            baseBranch: "main",
            ciStatus: "success",
            actionsRuns: [],
          },
        ],
        prSummary: { total: 1, pass: 1, fail: 0, pending: 0, unknown: 0 },
      },
    };
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const cards = document.querySelectorAll(".task-card");
    const dataTransfer = createDataTransfer({ "application/x-mullion-task": "7" });
    act(() => cards[0].dispatchEvent(createDragEvent("dragstart", dataTransfer)));
    cards[1].dispatchEvent(createDragEvent("drop", dataTransfer));
    cards[0].dispatchEvent(createDragEvent("dragend", dataTransfer));

    const link = screen.getByRole("link", { name: /#12/ });
    // fireEvent's return value is `!event.defaultPrevented` — false here
    // means preventDefault WAS called, i.e. the drag suppressed the badge's
    // own navigation too, not just the card's drawer-open handler.
    const notPrevented = fireEvent.click(link);
    expect(notPrevented).toBe(false);
    expect(screen.queryByTestId("task-detail-stub")).toBeNull();
  });

  it("shows a disabled-claim hint on a ready card when taskMasterEnabled is off", () => {
    taskMasterEnabled = false;
    tasks = [makeTask({ id: 1, status: "ready" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByText(/Task Master is off/)).toBeInTheDocument();
  });

  // Task-claim queueing (rate-limit-storm fix) — "claimed" now means
  // queued, waiting for a free slot (task-claim.ts's enqueueTask/
  // dispatchClaimedTask split). A queued card has no session yet, which
  // otherwise looks identical to a genuinely stuck claimed task whose
  // session was reaped — this hint is the tell.
  it("shows a queued hint on a claimed card with no session yet", () => {
    tasks = [
      makeTask({ id: 1, status: "claimed", sessionId: null, queuedAt: "2026-01-01T00:00:00.000Z" }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByText(/Queued — waiting for a free slot/)).toBeInTheDocument();
  });

  it("does not show the queued hint once a claimed card actually has a session", () => {
    tasks = [makeTask({ id: 1, status: "claimed", sessionId: 5 })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.queryByText(/Queued — waiting for a free slot/)).toBeNull();
  });

  it("shows a review-in-flight hint while the review agent hasn't finished yet", () => {
    tasks = [
      makeTask({
        id: 1,
        status: "reviewing",
        reviewSessionId: 9,
        reviewFindingsIngestedSessionId: null,
      }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByText(/Review in progress/)).toBeInTheDocument();
  });

  it("hides the review-in-flight hint once findings are ingested — awaiting manual approval instead", () => {
    tasks = [
      makeTask({
        id: 1,
        status: "reviewing",
        reviewSessionId: 9,
        reviewFindingsIngestedSessionId: 9,
      }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.queryByText(/Review in progress/)).toBeNull();
  });

  it("never shows the review-in-flight hint for a reviewing task with no review agent configured", () => {
    tasks = [
      makeTask({
        id: 1,
        status: "reviewing",
        reviewSessionId: null,
        reviewFindingsIngestedSessionId: null,
      }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.queryByText(/Review in progress/)).toBeNull();
  });

  it("carries the full title as a tooltip for the (possibly clamped) card title", () => {
    tasks = [makeTask({ id: 1, title: "A very long task title that might get clamped" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByText("A very long task title that might get clamped")).toHaveAttribute(
      "title",
      "A very long task title that might get clamped",
    );
  });

  it("links the issue badge to the issue's htmlUrl", () => {
    tasks = [makeTask({ id: 1, issueNumber: 42, htmlUrl: "https://github.com/o/r/issues/42" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    const link = screen.getByRole("link", { name: /#42/ });
    expect(link).toHaveAttribute("href", "https://github.com/o/r/issues/42");
  });

  it("renders the issue badge as plain text (not a link) when htmlUrl is null", () => {
    tasks = [makeTask({ id: 1, issueNumber: 42, htmlUrl: null })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.queryByRole("link", { name: /#42/ })).toBeNull();
    expect(screen.getByText("#42")).toBeInTheDocument();
  });

  // #701 — sub-issue hierarchy chips.
  describe("parent/sub-issue chips (#701)", () => {
    it("shows the parent's title when known, linking to its GitHub issue", () => {
      tasks = [
        makeTask({
          id: 1,
          parentIssueNumber: 30,
          parentIssueRepo: "s3ntin3l8/branchdam",
          parentIssueTitle: "Phase 5 — Tier-1 project introspection",
        }),
      ];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      const link = screen.getByRole("link", {
        name: /Phase 5 — Tier-1 project introspection/,
      });
      expect(link).toHaveAttribute("href", "https://github.com/s3ntin3l8/branchdam/issues/30");
    });

    it("falls back to a bare #N when the parent's title hasn't been filled yet", () => {
      tasks = [
        makeTask({
          id: 1,
          parentIssueNumber: 30,
          parentIssueRepo: "s3ntin3l8/branchdam",
          parentIssueTitle: null,
        }),
      ];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      expect(screen.getByRole("link", { name: /#30/ })).toBeInTheDocument();
    });

    it("shows no parent chip when parentIssueNumber is null", () => {
      tasks = [makeTask({ id: 1, parentIssueNumber: null })];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      expect(screen.queryByRole("link", { name: /#30/ })).toBeNull();
    });

    it("the parent link stopPropagations, not opening the drawer on click", async () => {
      const user = userEvent.setup();
      tasks = [
        makeTask({
          id: 1,
          parentIssueNumber: 30,
          parentIssueRepo: "s3ntin3l8/branchdam",
          parentIssueTitle: "Phase 5",
        }),
      ];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      const link = screen.getByRole("link", { name: /Phase 5/ });
      await user.click(link);
      expect(screen.queryByTestId("task-detail-stub")).toBeNull();
    });

    it("shows a sub-issue N/M chip when subIssueTotal is positive", () => {
      tasks = [makeTask({ id: 1, subIssueTotal: 4, subIssueCompleted: 1 })];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      expect(screen.getByText("1/4")).toBeInTheDocument();
    });

    it("shows no sub-issue chip when subIssueTotal is null or zero", () => {
      tasks = [
        makeTask({ id: 1, subIssueTotal: null, subIssueCompleted: null }),
        makeTask({ id: 2, subIssueTotal: 0, subIssueCompleted: 0, title: "second" }),
      ];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      expect(screen.queryByText("0/0")).toBeNull();
      expect(screen.queryByText(/^\d+\/\d+$/)).toBeNull();
    });
  });

  it("shows time in status, sourced from the timestamp matching the task's own column", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-03T00:00:00.000Z"));
    tasks = [
      makeTask({
        id: 1,
        status: "reviewing",
        createdAt: "2025-12-01T00:00:00.000Z",
        reviewingAt: "2026-01-02T00:00:00.000Z",
      }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    // reviewingAt (1 day before "now"), not the much-older createdAt.
    expect(screen.getByText("1d ago")).toBeInTheDocument();
    vi.useRealTimers();
  });

  // Hermes review — a Failed task falls into the same createdAt fallback
  // as backlog/ready, but "how long has this been sitting here" isn't the
  // right story for it: a task can run for weeks and fail yesterday, and a
  // bare age would misleadingly read as if it just failed. There's no
  // failedAt column to read instead, so the label is qualified rather than
  // the timestamp source changed.
  it("qualifies the age as 'created' rather than a bare duration on a failed card", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-08T00:00:00.000Z"));
    tasks = [makeTask({ id: 1, status: "failed", createdAt: "2025-12-18T00:00:00.000Z" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByText("created 21d ago")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("shows a bare duration (not 'created') for a non-failed card using the same createdAt fallback", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-08T00:00:00.000Z"));
    tasks = [makeTask({ id: 1, status: "backlog", createdAt: "2025-12-18T00:00:00.000Z" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByText("21d ago")).toBeInTheDocument();
    expect(screen.queryByText("created 21d ago")).toBeNull();
    vi.useRealTimers();
  });

  describe("an approved task waiting on a human (#2234)", () => {
    const approved = {
      status: "reviewing" as const,
      reviewSessionId: 9,
      reviewFindingsIngestedSessionId: 9,
      lastReviewVerdict: "approved" as const,
    };

    it("round N: says approved and needs your approval, not 'returned to worker'", () => {
      tasks = [
        makeTask({ id: 1, ...approved, autoReturnRounds: 2, approvalState: "awaiting-human" }),
      ];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      expect(screen.getByRole("status")).toHaveTextContent(
        "Round 3 · approved, needs your approval",
      );
      expect(screen.queryByText(/returned to worker/)).toBeNull();
    });

    it("round 0: drops the round prefix", () => {
      tasks = [makeTask({ id: 1, ...approved, approvalState: "awaiting-human" })];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      expect(screen.getByRole("status")).toHaveTextContent(/^Approved, needs your approval$/);
    });

    it("auto-approve project: says it auto-approves once CI is green", () => {
      tasks = [
        makeTask({ id: 1, ...approved, autoReturnRounds: 1, approvalState: "auto-pending" }),
      ];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      expect(screen.getByRole("status")).toHaveTextContent(
        "Round 2 · approved, auto-approving once CI is green",
      );
    });

    it("capped but approved: the approval wins over the cap wording", () => {
      tasks = [
        makeTask({
          id: 1,
          ...approved,
          autoReturnRounds: 2,
          autoReturnCapped: true,
          autoReturnCapAnnouncedAt: "2026-01-01T00:00:00.000Z",
          approvalState: "awaiting-human",
        }),
      ];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      expect(screen.getByRole("status")).toHaveTextContent("approved, needs your approval");
      expect(screen.queryByText(/round cap reached/)).toBeNull();
    });

    it("no strip when approvalState is null", () => {
      tasks = [makeTask({ id: 1, status: "reviewing", autoReturnRounds: 1 })];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.getByText(/returned to worker/)).toBeInTheDocument();
    });
  });

  describe("a Hermes review run (no session)", () => {
    const run = { status: "reviewing" as const, reviewSessionId: null, reviewRunId: "run_1" };

    it("running: shows the badge and the in-progress hint", () => {
      tasks = [makeTask({ id: 1, ...run })];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      expect(screen.getByTestId("task-card-hermes-review")).toHaveTextContent(
        "Hermes review · running",
      );
      expect(screen.getByText("Review in progress")).toBeInTheDocument();
    });

    it("finished and approved: badge says finished and the approval chip shows", () => {
      tasks = [
        makeTask({
          id: 1,
          ...run,
          reviewRunIngestedId: "run_1",
          lastReviewVerdict: "approved",
          approvalState: "awaiting-human",
        }),
      ];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      expect(screen.getByTestId("task-card-hermes-review")).toHaveTextContent(
        "Hermes review · finished",
      );
      expect(screen.getByRole("status")).toHaveTextContent("Approved, needs your approval");
      expect(screen.queryByText("Review in progress")).toBeNull();
    });

    it("finished inconclusive: finished badge, no approval chip", () => {
      tasks = [makeTask({ id: 1, ...run, reviewRunIngestedId: "run_1" })];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      expect(screen.getByTestId("task-card-hermes-review")).toHaveTextContent("finished");
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("unsent: says it could not be sent and never shows the id or in-flight", () => {
      tasks = [makeTask({ id: 1, ...run, reviewRunId: "unsent:1:r0:x0", reviewRunUnsent: true })];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      expect(screen.getByTestId("task-card-hermes-review")).toHaveTextContent(
        "Hermes review · could not be sent",
      );
      expect(screen.queryByText(/unsent:/)).toBeNull();
      expect(screen.queryByText("Review in progress")).toBeNull();
    });

    it("no run and no session: no Hermes badge", () => {
      tasks = [makeTask({ id: 1, status: "reviewing" })];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      expect(screen.queryByTestId("task-card-hermes-review")).toBeNull();
    });
  });

  describe("a reviewing task with no live review session", () => {
    it("explains the auto-rebase hold-back instead of looking idle", () => {
      tasks = [
        makeTask({
          id: 1,
          status: "reviewing",
          reviewPhase: "rebasing",
          reReviewAt: Date.now() + 10 * 60_000,
          reviewFindings: "## Round 1\n\n**Verdict:** approved — ok",
        }),
      ];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      expect(screen.getByRole("status")).toHaveTextContent(
        /Reviewed, then conflicted with main — auto-rebasing; re-review starts in 10m at the latest/,
      );
    });

    it("stays quiet for the no-reviewer config: every reviewing task of such a project would carry the line", () => {
      tasks = [makeTask({ id: 1, status: "reviewing", reviewPhase: "no-reviewer" })];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("says a review is waiting to start when nothing holds it back", () => {
      tasks = [makeTask({ id: 1, status: "reviewing", reviewPhase: "awaiting-review" })];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      expect(screen.getByRole("status")).toHaveTextContent("Waiting for the review to start");
    });
  });

  describe("where the task will run (#2236)", () => {
    const hostChip = () => document.querySelector(".task-card-host");

    it("shows no chip on a local-only install", () => {
      hosts = [makeHost({ id: "local", name: "local" })];
      tasks = [makeTask({ id: 1, status: "ready" })];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      expect(hostChip()).toBeNull();
    });

    it("shows 'pinned · <host>' for a project on a remote host", () => {
      hosts = [makeHost({ id: "local", name: "local" }), makeHost({ id: "h1", name: "mac-mini" })];
      projects = [makeProject({ id: 1, name: "demo", hostId: "h1" })];
      tasks = [makeTask({ id: 1, status: "ready" })];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      expect(hostChip()).toHaveTextContent("pinned · mac-mini");
    });

    it("shows 'auto' for a local project with remote hosts available", () => {
      hosts = [makeHost({ id: "local", name: "local" }), makeHost({ id: "h1", name: "mac-mini" })];
      tasks = [makeTask({ id: 1, status: "ready" })];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      expect(hostChip()).toHaveTextContent("auto");
    });

    it("shows the Platform:/Host: requirement", () => {
      hosts = [makeHost({ id: "local", name: "local" }), makeHost({ id: "h1", name: "mac-mini" })];
      tasks = [
        makeTask({ id: 1, status: "ready", placementRequirement: '{"platform":"darwin"}' }),
        makeTask({ id: 2, status: "ready", placementRequirement: '{"hostId":"h1"}' }),
      ];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      const chips = Array.from(document.querySelectorAll(".task-card-host")).map(
        (e) => e.textContent,
      );
      expect(chips).toEqual(["needs darwin", "needs mac-mini"]);
    });

    it("shows the worker session's actual host once it exists", () => {
      hosts = [makeHost({ id: "local", name: "local" }), makeHost({ id: "h1", name: "mac-mini" })];
      sessions = [makeSession({ id: 50, resolvedHostId: "h1", placementReason: null })];
      tasks = [makeTask({ id: 1, status: "in_progress", sessionId: 50 })];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      expect(hostChip()).toHaveTextContent("on mac-mini");
    });
  });

  describe("a push held for workflow approval (#2108)", () => {
    const hold = JSON.stringify({ sha: "a".repeat(40), files: [".github/workflows/ci.yml"] });

    it("shows a 'Needs workflow approval' strip, naming the files in its tooltip", () => {
      tasks = [makeTask({ id: 1, status: "reviewing", workflowChange: hold })];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      const strip = screen.getByRole("status");
      expect(strip).toHaveTextContent("Needs workflow approval");
      expect(strip).toHaveAttribute("title", expect.stringContaining(".github/workflows/ci.yml"));
    });

    it("is absent when nothing is held, and for a corrupt value", () => {
      tasks = [
        makeTask({ id: 1, status: "reviewing", workflowChange: null }),
        makeTask({ id: 2, status: "reviewing", workflowChange: "{not json" }),
      ];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      expect(screen.queryByText("Needs workflow approval")).toBeNull();
    });

    it("is separate from the generic sync-error triangle", () => {
      tasks = [makeTask({ id: 1, status: "reviewing", workflowChange: hold })];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      expect(document.querySelector(".task-card-sync-error")).toBeNull();
    });

    it("shows one warning for a workflow hold that supersedes a rejected push", () => {
      tasks = [
        makeTask({
          id: 1,
          status: "reviewing",
          workflowChange: hold,
          githubSyncError:
            "refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission",
        }),
      ];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      expect(screen.getByRole("status")).toHaveTextContent("Needs workflow approval");
      expect(document.querySelector(".task-card-sync-error")).toBeNull();
      expect(document.querySelector(".task-card-sync-error-text")).toBeNull();
    });

    it("combines an unrelated sync error into the workflow warning without a second glyph", () => {
      tasks = [
        makeTask({
          id: 1,
          status: "reviewing",
          workflowChange: hold,
          githubSyncError: "403 Forbidden",
        }),
      ];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
      const strip = screen.getByRole("status");
      expect(strip).toHaveTextContent("Needs workflow approval · GitHub sync error");
      expect(strip).toHaveAccessibleName(
        "Needs workflow approval; GitHub sync error: 403 Forbidden",
      );
      expect(strip).toHaveAttribute("title", expect.stringContaining("403 Forbidden"));
      expect(document.querySelector(".task-card-sync-error")).toBeNull();
      expect(document.querySelector(".task-card-sync-error-text")).toHaveTextContent(
        "403 Forbidden",
      );
    });

    it("clicking the strip opens the task drawer, where the approval control lives", async () => {
      const user = userEvent.setup();
      tasks = [makeTask({ id: 9, status: "reviewing", workflowChange: hold })];
      render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

      await user.click(screen.getByText("Needs workflow approval"));

      expect(screen.getByTestId("task-detail-stub")).toBeInTheDocument();
    });
  });

  it("also renders the sync error as (aria-hidden) text so phone CSS can show it without a hover tooltip", () => {
    tasks = [makeTask({ id: 1, githubSyncError: "401 Unauthorized" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    const text = document.querySelector(".task-card-sync-error-text");
    expect(text).toHaveTextContent("401 Unauthorized");
    expect(text).toHaveAttribute("aria-hidden", "true");
  });

  it("shows a warning glyph with an accessible name for a task with a GitHub sync error", () => {
    tasks = [makeTask({ id: 1, githubSyncError: "401 Unauthorized" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByTitle("GitHub sync: 401 Unauthorized")).toBeInTheDocument();
    // Hermes review — this was an icon-only span with no accessible name;
    // the title tooltip alone doesn't reach screen readers.
    expect(screen.getByLabelText("GitHub sync error: 401 Unauthorized")).toBeInTheDocument();
  });

  it("issue: shows a blocked glyph with an accessible name for a blocked task, promoted to a full-width strip", () => {
    tasks = [
      makeTask({
        id: 1,
        blockedState: "blocked",
        blockers: [
          {
            owner: "acme",
            repo: "widgets",
            number: 12,
            title: "The blocker",
            htmlUrl: "https://x/12",
          },
        ],
      }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByTitle("Blocked by #12")).toBeInTheDocument();
    expect(screen.getByLabelText("Blocked by #12")).toBeInTheDocument();
    expect(screen.getByText("Blocked by #12")).toBeInTheDocument();
    // Promoted out of the meta row — its own full-width strip, not the
    // small inline chip the `unresolved` state still uses.
    expect(document.querySelector(".task-card-blocked-strip")).toBeInTheDocument();
    expect(document.querySelector(".task-card-blocked")).toBeNull();
    // The card itself gets the accent-border/dimmed treatment, visible at
    // column-scan distance without opening the card.
    expect(document.querySelector(".task-card-is-blocked")).toBeInTheDocument();
  });

  it("issue: shows a +N suffix for multiple blockers", () => {
    tasks = [
      makeTask({
        id: 1,
        blockedState: "blocked",
        blockers: [
          { owner: "acme", repo: "widgets", number: 12, title: "one", htmlUrl: "https://x/12" },
          { owner: "acme", repo: "widgets", number: 13, title: "two", htmlUrl: "https://x/13" },
        ],
      }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByRole("img", { name: /^Blocked by #12, #13/ })).toHaveTextContent(
      "Blocked by #12 +1",
    );
  });

  it("#667 — shows a muted 'checking' state for an unresolved dependency check", () => {
    tasks = [makeTask({ id: 1, blockedState: "unresolved", blockers: [] })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByTitle("Checking dependencies…")).toBeInTheDocument();
    expect(screen.getByLabelText("Dependency state not yet checked")).toBeInTheDocument();
    // `unresolved` stays the small inline chip — not promoted to the
    // full-width strip or the card-level accent border, which are reserved
    // for a verified `blocked` state.
    expect(document.querySelector(".task-card-blocked-strip")).toBeNull();
    expect(document.querySelector(".task-card-is-blocked")).toBeNull();
  });

  it("#667 — shows nothing for a clear (the common, zero-dependency) task", () => {
    tasks = [makeTask({ id: 1, blockedState: "clear", blockers: [] })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.queryByTitle("Checking dependencies…")).toBeNull();
    expect(screen.queryByText(/^Blocked by/)).toBeNull();
    expect(document.querySelector(".task-card-blocked-strip")).toBeNull();
    expect(document.querySelector(".task-card-is-blocked")).toBeNull();
  });

  it("shows the failure reason on a failed card", () => {
    tasks = [makeTask({ id: 1, status: "failed", failureReason: "budget exceeded" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByText("budget exceeded")).toBeInTheDocument();
  });

  // #1997 — a QUEUED task's last dispatch error, distinct from a terminal failure.
  it("#1997 — shows why a queued (claimed) task is not dispatching, distinct from a failure", () => {
    tasks = [
      makeTask({
        id: 1,
        status: "claimed",
        failureReason: "could not resolve the base ref on host mac: ECONNREFUSED",
        dispatchFailingSince: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    const note = document.querySelector(".task-card-dispatch-reason");
    expect(note).not.toBeNull();
    expect(note?.textContent).toMatch(
      /Not dispatched yet \(3h ago\): could not resolve the base ref/,
    );
    // Not the terminal-failure treatment.
    expect(document.querySelector(".task-card-failure-reason")).toBeNull();
  });

  it("#1997 — shows no dispatch note for a queued task without a recorded reason", () => {
    tasks = [makeTask({ id: 1, status: "claimed", failureReason: null })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(document.querySelector(".task-card-dispatch-reason")).toBeNull();
  });

  it("#1997 — shows the reason without a 'since' when the failure clock is unset", () => {
    tasks = [makeTask({ id: 1, status: "claimed", failureReason: "spawn failed" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(document.querySelector(".task-card-dispatch-reason")?.textContent).toBe(
      "Not dispatched yet: spawn failed",
    );
  });

  it("#2364 — shows which issue a claimed task is waiting for", () => {
    tasks = [makeTask({ id: 1, status: "claimed", failureReason: "Waiting for #2346 to close" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(document.querySelector(".task-card-dispatch-reason")?.textContent).toBe(
      "Not dispatched yet: Waiting for #2346 to close",
    );
  });

  it("#1997 — a failed card keeps the terminal treatment, not the dispatch note", () => {
    tasks = [makeTask({ id: 1, status: "failed", failureReason: "budget exceeded" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(document.querySelector(".task-card-dispatch-reason")).toBeNull();
    expect(document.querySelector(".task-card-failure-reason")).not.toBeNull();
  });

  it("shows a review-round indicator once a reviewing task has been auto-returned to the worker", () => {
    tasks = [makeTask({ id: 1, status: "reviewing", autoReturnRounds: 1 })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByText(/Round 1/)).toBeInTheDocument();
  });

  it("shows no review-round indicator before any auto-return has happened", () => {
    tasks = [makeTask({ id: 1, status: "reviewing", autoReturnRounds: 0 })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.queryByText(/Round/)).toBeNull();
  });

  // Issue #1038 — capped but not yet announced: autoReturnRounds hit the
  // cap at the START of the last permitted round, while a worker session
  // (or the confirming review that follows it) may still be running. The
  // card must not claim "needs a human" until one of the three cap-notice
  // comments has actually landed on the PR.
  it("shows a review-in-flight wording, not 'needs a human', once capped but before the cap is announced", () => {
    tasks = [
      makeTask({
        id: 1,
        status: "reviewing",
        autoReturnRounds: 2,
        autoReturnCapped: true,
        autoReturnCapAnnouncedAt: null,
      }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByText(/Round 2 · review in flight/)).toBeInTheDocument();
    expect(screen.queryByText(/needs a human/)).toBeNull();
    expect(screen.queryByText(/returned to worker/)).toBeNull();
  });

  // Task 258971's investigation, refined by issue #1038: "returned to
  // worker" implies an automatic cycle still in motion — once the round
  // budget is spent AND the cap notice has actually been posted, the card
  // must say a human is needed instead.
  it("shows the round-cap wording, not 'returned to worker', once the cap has been announced", () => {
    tasks = [
      makeTask({
        id: 1,
        status: "reviewing",
        autoReturnRounds: 2,
        autoReturnCapped: true,
        autoReturnCapAnnouncedAt: "2026-09-04T09:34:44.000Z",
      }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByText(/Round 2 · round cap reached, needs a human/)).toBeInTheDocument();
    expect(screen.queryByText(/returned to worker/)).toBeNull();
    expect(screen.queryByText(/review in flight/)).toBeNull();
  });

  it.each([
    ["no-progress", /Round 1 · worker returned without a change, needs a human/],
    ["finding-persisted", /Round 1 · same finding still open after two rounds, needs a human/],
    ["cap", /Round 1 · round cap reached, needs a human/],
    [null, /Round 1 · round cap reached, needs a human/],
  ] as const)("says why the loop stopped when the reason is %s", (reason, expected) => {
    tasks = [
      makeTask({
        id: 1,
        status: "reviewing",
        autoReturnRounds: 1,
        autoReturnCapped: false,
        autoReturnCapAnnouncedAt: "2026-09-04T09:34:44.000Z",
        needsHumanReason: reason,
      }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  // Issue #1038 — the round badge already covers "still working"/"needs a
  // human" once a round has been spent; the generic "Review in progress"
  // hint must not also render and repeat/contradict it.
  it("suppresses the generic 'Review in progress' hint once a round badge is showing", () => {
    tasks = [
      makeTask({
        id: 1,
        status: "reviewing",
        reviewSessionId: 5,
        reviewFindingsIngestedSessionId: null,
        autoReturnRounds: 1,
      }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByText(/Round 1 · returned to worker/)).toBeInTheDocument();
    expect(screen.queryByText("Review in progress")).toBeNull();
  });
});
