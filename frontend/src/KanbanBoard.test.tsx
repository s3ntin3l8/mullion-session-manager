// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { KanbanBoard } from "./KanbanBoard.js";
import type {
  GitBranchesResult,
  GitDiffStats,
  GitHubPRsStatus,
  GitStatus,
  NotificationEvent,
  Project,
  Session,
} from "./api.js";

// Same shape as SessionRow.test.tsx's own store mock (KanbanBoard mounts
// SessionRow for each card, so this needs to cover both what KanbanBoard
// itself reads via a whole-store destructure — `useDashboardStore()`, no
// selector, same call shape Sidebar.tsx uses — and what SessionRow reads via
// individual selectors). The mock below handles both call shapes the way
// the real zustand hook does: no selector -> whole state, a selector ->
// selector(state).
let sessions: Session[];
let projects: Project[];
let kanbanOrder: Record<string, number[]>;
let events: Record<number, NotificationEvent[]>;
let sessionGitStatuses: Record<number, GitStatus | null>;
let gitDiffStats: Record<number, GitDiffStats | null>;
let gitBranchesByProject: Record<number, GitBranchesResult | undefined>;
let prsByProject: Record<number, GitHubPRsStatus | undefined>;

const setKanbanColumnOrder = vi.fn((columnId: string, order: number[]) => {
  kanbanOrder = { ...kanbanOrder, [columnId]: order };
});
const setViewMode = vi.fn();
const deleteSession = vi.fn(async () => {});

let hideEndedSessions: boolean;

function storeState() {
  return {
    sessions,
    projects,
    kanbanOrder,
    setKanbanColumnOrder,
    deleteSession,
    setViewMode,
    hideEndedSessions,
    settings: { sessions: { confirmBeforeKill: false } },
    theme: "dark",
    events,
    sessionGitStatuses,
    gitDiffStats,
    gitBranchesByProject,
    prsByProject,
  };
}

vi.mock("./store.js", () => ({
  useDashboardStore: (selector?: (s: unknown) => unknown) => {
    const state = storeState();
    return selector ? selector(state) : state;
  },
}));

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: 1,
    projectId: 1,
    parentSessionId: null,
    name: null,
    nameLocked: false,
    command: "claude code",
    cwd: null,
    liveCwd: null,
    previewBranch: null,
    kind: "terminal",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastAttachedAt: null,
    alive: true,
    subscriberCount: 0,
    activity: "working",
    lastActivityAt: Date.now(),
    attention: false,
    attentionAt: null,
    lastTitle: null,
    gateState: "idle",
    gatePrompt: null,
    promoteState: "idle",
    promoteSummary: null,
    promoteSuggestedBaseRef: null,
    permissionState: "idle",
    planState: "idle",
    errorState: "idle",
    endedReason: null,
    liveBranch: null,
    // Rich statuses (issue: extend surfaced session statuses) — matches the
    // `activity: "working"` default above; columnForSession now keys off
    // sessionStatusSeverity, not the raw fields, so tests exercising column
    // placement must override this too (see the column-placement test
    // below).
    exitCode: null,
    attentionKind: null,
    errorDetail: null,
    lastAssistantMessage: null,
    compactState: "idle",
    subagentCount: 0,
    subagents: [],
    elicitationState: "idle",
    elicitationServer: null,
    lastTurnEndedAt: null,
    stateRestored: true,
    staleHooks: false,
    restoredVersion: null,
    sessionStatus: "working",
    sessionStatusSeverity: "busy",
    sessionStatusDetail: null,
    sessionStatusAttentionRequired: false,
    hookEmits: [],
    pendingDevServerPort: null,
    outstandingBackgroundTasks: [],
    ...overrides,
  };
}

function makeProject(overrides: Partial<Project>): Project {
  return {
    id: 1,
    name: "demo",
    cwd: "/home/x/demo",
    hostId: "local",
    devServerUrl: null,
    detectedDevServerPort: null,
    currentBranch: null,
    autoFetch: null,
    ruleFiles: [],
    defaultAgent: null,
    defaultReviewAgent: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// jsdom doesn't implement DataTransfer/DragEvent — mirrors SessionRow.test.tsx's
// own stub.
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
  projects = [makeProject({ id: 1, name: "demo" }), makeProject({ id: 2, name: "other" })];
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
});

describe("KanbanBoard column placement", () => {
  it("sorts sessions into Working/Needs Attention/Finished/Idle/Exited by sessionStatusSeverity", () => {
    sessions = [
      makeSession({
        id: 1,
        projectId: 1,
        sessionStatus: "working",
        sessionStatusSeverity: "busy",
        command: "working-one",
      }),
      makeSession({
        id: 5,
        projectId: 1,
        sessionStatus: "idle",
        sessionStatusSeverity: "dormant",
        command: "idle-one",
      }),
      makeSession({
        id: 2,
        projectId: 1,
        sessionStatus: "needs_input",
        sessionStatusSeverity: "waiting",
        command: "attn-one",
      }),
      makeSession({
        id: 6,
        projectId: 1,
        sessionStatus: "finished",
        sessionStatusSeverity: "done",
        command: "finished-one",
      }),
      makeSession({
        id: 3,
        projectId: 1,
        status: "exited",
        sessionStatus: "exited",
        sessionStatusSeverity: "gone",
        command: "exited-one",
      }),
      // A killed session is excluded from the board entirely (same rule as
      // Sidebar.tsx's own list) — it never gets git/event details fetched
      // (store.ts scopes those to `status !== "killed"`), so showing it here
      // would just be a detail-less tombstone. Filtered by the raw `status`
      // column (unaffected by the sessionStatus/sessionStatusSeverity
      // derivation), so no override needed for those two fields here.
      makeSession({ id: 4, projectId: 2, status: "killed", command: "killed-one" }),
    ];

    render(<KanbanBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const columns = screen.getAllByText(/^Working$|^Needs Attention$|^Finished$|^Idle$|^Exited$/, {
      selector: ".kanban-column-title",
    });
    expect(columns).toHaveLength(5);

    const workingColumn = screen
      .getByText("Working", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!;
    expect(workingColumn.textContent).toContain("working-one");
    expect(workingColumn.querySelector(".kanban-column-count")?.textContent).toBe("1");

    const idleColumn = screen
      .getByText("Idle", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!;
    expect(idleColumn.textContent).toContain("idle-one");
    expect(idleColumn.querySelector(".kanban-column-count")?.textContent).toBe("1");

    const attentionColumn = screen
      .getByText("Needs Attention", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!;
    expect(attentionColumn.textContent).toContain("attn-one");
    expect(attentionColumn.querySelector(".kanban-column-count")?.textContent).toBe("1");

    const finishedColumn = screen
      .getByText("Finished", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!;
    expect(finishedColumn.textContent).toContain("finished-one");
    expect(finishedColumn.querySelector(".kanban-column-count")?.textContent).toBe("1");

    // Issue #331 — the finished card must not wear the Needs-Attention row
    // tint (rowClassNameForSeverity, sessionStatus.ts): a session that
    // completed successfully is not one that needs attention.
    const finishedRow = screen.getByText("finished-one").closest(".session-item")!;
    expect(finishedRow.classList.contains("status-finished")).toBe(true);
    expect(finishedRow.classList.contains("status-attention")).toBe(false);

    const exitedColumn = screen
      .getByText("Exited", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!;
    expect(exitedColumn.textContent).toContain("exited-one");
    expect(exitedColumn.textContent).not.toContain("killed-one");
    expect(exitedColumn.querySelector(".kanban-column-count")?.textContent).toBe("1");
  });

  it("excludes dock sessions, same kind scoping as the sidebar's own list", () => {
    sessions = [
      makeSession({ id: 1, kind: "dock", command: "dock-monitor" }),
      makeSession({ id: 2, kind: "terminal", command: "real-session" }),
    ];

    render(<KanbanBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    expect(screen.queryByText("dock-monitor")).toBeNull();
    expect(screen.getByText("real-session")).toBeTruthy();
    const workingColumn = screen
      .getByText("Working", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!;
    expect(workingColumn.querySelector(".kanban-column-count")?.textContent).toBe("1");
  });

  it("shows an empty-state note for a column with no sessions", () => {
    sessions = [];
    render(<KanbanBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getAllByText("No sessions")).toHaveLength(5);
  });

  it("shows the owning project's name on each card (cross-project board)", () => {
    sessions = [makeSession({ id: 1, projectId: 2, command: "s1" })];
    render(<KanbanBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByText("other")).toBeTruthy();
  });

  it("hides exited sessions when hideEndedSessions is on, same as the sidebar", () => {
    hideEndedSessions = true;
    sessions = [
      makeSession({ id: 1, status: "active", command: "still-here" }),
      makeSession({ id: 2, status: "exited", command: "should-be-hidden" }),
    ];

    render(<KanbanBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    expect(screen.getByText("still-here")).toBeTruthy();
    expect(screen.queryByText("should-be-hidden")).toBeNull();
    const exitedColumn = screen
      .getByText("Exited", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!;
    expect(exitedColumn.querySelector(".kanban-column-count")?.textContent).toBe("0");
  });

  it("never shows a git-details toggle on a card — details are always expanded", () => {
    sessions = [makeSession({ id: 1, command: "s1" })];
    sessionGitStatuses = {
      1: {
        branch: "main",
        hash: "abc123",
        ahead: 0,
        behind: 0,
        isClean: true,
        hasConflicts: false,
        files: [],
      },
    };

    const { container } = render(<KanbanBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    expect(container.querySelector(".session-git-toggle")).toBeNull();
    expect(container.querySelector(".session-git-line")).not.toBeNull();
  });
});

describe("KanbanBoard drag-to-reorder within a column", () => {
  it("reorders two cards in the same column via a native drag/drop", () => {
    sessions = [
      makeSession({ id: 1, projectId: 1, command: "first" }),
      makeSession({ id: 2, projectId: 1, command: "second" }),
    ];

    const { container } = render(<KanbanBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const workingColumn = screen
      .getByText("Working", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!;
    const cards = workingColumn.querySelectorAll(".kanban-card");
    expect(cards).toHaveLength(2);

    // Drag session 1 ("first", card index 0) onto card index 1 ("second").
    const dataTransfer = createDataTransfer({ "application/x-mullion-session": "1" });
    cards[1].dispatchEvent(createDragEvent("drop", dataTransfer));

    expect(setKanbanColumnOrder).toHaveBeenCalledWith("working", [2, 1]);
    void container;
  });

  it("does nothing when the dragged payload isn't a mullion session id", () => {
    sessions = [
      makeSession({ id: 1, projectId: 1, command: "first" }),
      makeSession({ id: 2, projectId: 1, command: "second" }),
    ];
    render(<KanbanBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const workingColumn = screen
      .getByText("Working", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!;
    const cards = workingColumn.querySelectorAll(".kanban-card");
    const dataTransfer = createDataTransfer({ "text/plain": "not a session" });
    cards[1].dispatchEvent(createDragEvent("drop", dataTransfer));

    expect(setKanbanColumnOrder).not.toHaveBeenCalled();
  });
});

describe("KanbanBoard card open", () => {
  it("switches back to list view and opens the session on card click", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    sessions = [makeSession({ id: 1, projectId: 1, command: "click-me" })];
    const onOpenSession = vi.fn();
    render(<KanbanBoard onOpenSession={onOpenSession} onSessionEnded={vi.fn()} />);

    const user = userEvent.setup();
    await user.click(screen.getByText("click-me"));

    expect(setViewMode).toHaveBeenCalledWith("list");
    expect(onOpenSession).toHaveBeenCalledWith(sessions[0]);
  });
});

describe("KanbanBoard cards stay flat (Phase 5 Track A, #195/5.5a)", () => {
  it("never renders subagent rows on a card, even for a session with subagents", () => {
    sessions = [
      makeSession({
        id: 1,
        projectId: 1,
        command: "claude code",
        hookEmits: ["subagent"],
        subagents: [
          {
            agentId: "subagent-test-id-1",
            agentType: "code-reviewer",
            startedAt: Date.now() - 60_000,
            endedAt: null,
            summary: null,
            fileChanges: 2,
            toolFailures: 0,
            eventCount: 3,
          },
        ],
      }),
    ];
    const { container } = render(<KanbanBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    expect(container.querySelector(".session-subagents-line")).toBeNull();
    expect(container.querySelector(".session-subagent-chip")).toBeNull();
  });
});
