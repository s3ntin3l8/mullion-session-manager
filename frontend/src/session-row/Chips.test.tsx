// @vitest-environment jsdom
// SessionRow row 5 (subagents, Phase 5 Track A #195/5.5a) and row 6
// (background tasks, issue #428). Split out of the former monolithic
// SessionRow.test.tsx (PR 27 phase 2, Wave 5 of
// .claude/plans/can-we-do-a-warm-cocke.md) — owns every test that exercises
// the two chip strips Chips.tsx renders. Still mounts the full
// `<SessionRow>` (see GitLine.test.tsx's own header comment for why — same
// reasoning: showSubagentsRow/showBackgroundTasksRow are gated on
// session.hookEmits via isStatusReachable, a SessionRow-level derivation
// Chips.tsx never performs itself).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionRow } from "../Sidebar.js";
import {
  type GitBranchesResult,
  type GitDiffStats,
  type GitHubPRsStatus,
  type GitStatus,
  type NotificationEvent,
  type Project,
  type Session,
} from "../api/index.js";
import { makeSession, makeProject } from "../test/fixtures.js";

let events: Record<number, NotificationEvent[]>;
let sessionGitStatuses: Record<number, GitStatus | null>;
let gitDiffStats: Record<number, GitDiffStats | null>;
let gitBranchesByProject: Record<number, GitBranchesResult | undefined>;
let prsByProject: Record<number, GitHubPRsStatus | undefined>;
let sessions: Session[];
const promoteSessionMock = vi.fn().mockResolvedValue(undefined);
const declinePromoteMock = vi.fn().mockResolvedValue(undefined);
const renameSessionMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../store/index.js", () => ({
  useDashboardStore: (selector: (s: unknown) => unknown) =>
    selector({
      settings: { sessions: { confirmBeforeKill: false } },
      theme: "dark",
      events,
      sessionGitStatuses,
      gitDiffStats,
      gitBranchesByProject,
      prsByProject,
      sessions,
      promoteSession: promoteSessionMock,
      declinePromote: declinePromoteMock,
      renameSession: renameSessionMock,
      mutedSessionIds: [],
      toggleSessionMute: vi.fn(),
    }),
}));

const PROJECT: Project = makeProject();

// Sidebar declutter — rows 5/6 now render behind SessionRow's own details
// chevron (session-row/Header.tsx's `.session-git-toggle`, renamed in
// meaning but not in class — see that component's own comment), collapsed
// by default. Every test below that expects a chip strip has to open it
// first. Checks `aria-expanded` rather than clicking unconditionally, same
// as FileChanges.test.tsx's own helper — belt-and-suspenders against the
// module-level expanded-rows Set some tests below might otherwise share.
function openDetails(container: HTMLElement): void {
  const toggle = container.querySelector(".session-git-toggle");
  if (toggle && toggle.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(toggle);
  }
}

beforeEach(() => {
  events = {};
  sessionGitStatuses = {};
  gitDiffStats = {};
  gitBranchesByProject = {};
  prsByProject = {};
  sessions = [];
  localStorage.clear();
});

describe("SessionRow row 5 — subagents (Phase 5 Track A, #195/5.5a)", () => {
  // Same fresh-id-per-test rationale as GitLine.test.tsx's makeRow3Session —
  // the localStorage-backed expanded-subagent-rows Set is module-level and
  // never reset between tests.
  let nextRow5SessionId = 20_000;
  function makeRow5Session(overrides: Partial<Session>): Session {
    return makeSession({ id: nextRow5SessionId++, ...overrides });
  }

  const RUNNING_SUBAGENT = {
    agentId: "subagent-test-id-1",
    agentType: "code-reviewer",
    startedAt: Date.now() - 60_000,
    endedAt: null,
    summary: null,
    fileChanges: 2,
    toolFailures: 0,
    eventCount: 3,
  };

  const FINISHED_SUBAGENT = {
    agentId: "subagent-test-id-2",
    agentType: "explore",
    startedAt: Date.now() - 120_000,
    endedAt: Date.now() - 30_000,
    summary: "Looked at the auth module.",
    fileChanges: 0,
    toolFailures: 1,
    eventCount: 5,
  };

  it("renders no subagents row when the agent doesn't emit subagent (hookEmits gate)", () => {
    const session = makeRow5Session({ hookEmits: [], subagents: [RUNNING_SUBAGENT] });
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    expect(container.querySelector(".session-subagents-line")).toBeNull();
  });

  it("renders no subagents row when there are no subagents yet", () => {
    const session = makeRow5Session({ hookEmits: ["subagent"], subagents: [] });
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    expect(container.querySelector(".session-subagents-line")).toBeNull();
  });

  // Sidebar declutter — a live subagent always renders as its own chip; a
  // finished one collapses behind a "N done" summary toggle instead (see
  // lib/sidebarStatus.ts's partitionSubagents and Chips.tsx's own history
  // toggle). Every test below opens the row's details chevron first
  // (openDetails), and the ones exercising a finished subagent also open the
  // history toggle to reach its chip.
  function openSubagentHistory(container: HTMLElement): void {
    fireEvent.click(container.querySelector(".session-subagent-history-toggle")!);
  }

  it("renders the running subagent as a chip and the finished one behind a history toggle", () => {
    const session = makeRow5Session({
      hookEmits: ["subagent"],
      subagents: [RUNNING_SUBAGENT, FINISHED_SUBAGENT],
    });
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    openDetails(container);

    const liveChips = container.querySelectorAll(".session-subagents-line .session-subagent-chip");
    expect(liveChips).toHaveLength(1);
    expect(liveChips[0].querySelector(".session-subagent-name")?.textContent).toBe("code-reviewer");
    expect(liveChips[0].querySelector(".github-panel-ci-dot")?.classList.contains("pending")).toBe(
      true,
    );

    const toggle = container.querySelector(".session-subagent-history-toggle")!;
    expect(toggle.textContent).toContain("1 done");
    expect(container.querySelector(".session-subagent-history")).toBeNull();

    openSubagentHistory(container);
    const historyChips = container.querySelectorAll(
      ".session-subagent-history .session-subagent-chip",
    );
    expect(historyChips).toHaveLength(1);
    expect(historyChips[0].querySelector(".session-subagent-name")?.textContent).toBe("explore");
    expect(historyChips[0].querySelector(".github-panel-ci-dot")?.classList.contains("good")).toBe(
      true,
    );
  });

  it("shows finished subagents newest-first in the history list", () => {
    const OLDER_FINISHED = {
      ...FINISHED_SUBAGENT,
      agentId: "subagent-test-id-3",
      agentType: "older-agent",
      startedAt: Date.now() - 300_000,
      endedAt: Date.now() - 200_000,
    };
    const session = makeRow5Session({
      hookEmits: ["subagent"],
      subagents: [OLDER_FINISHED, FINISHED_SUBAGENT],
    });
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    openDetails(container);
    openSubagentHistory(container);

    const names = Array.from(
      container.querySelectorAll(".session-subagent-history .session-subagent-name"),
    ).map((el) => el.textContent);
    // FINISHED_SUBAGENT ended more recently than OLDER_FINISHED -> shown first.
    expect(names).toEqual(["explore", "older-agent"]);
  });

  it("shows no history toggle when every subagent is live", () => {
    const session = makeRow5Session({
      hookEmits: ["subagent"],
      subagents: [RUNNING_SUBAGENT],
    });
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    openDetails(container);
    expect(container.querySelector(".session-subagent-history-toggle")).toBeNull();
  });

  it("does not leak an open history list into a showSubagents={false} view of the same session (code review)", () => {
    // Regression test: `historyOpen` is seeded from a session-id-only
    // localStorage set (crs.expandedSubagentHistory), not scoped per view —
    // opening the history for a session in the sidebar (showSubagents=true)
    // must not also reveal it on that same session's card in a context that
    // explicitly opted out of subagents (LaneCard.tsx's showSubagents={false}
    // kanban cards), which renders no toggle to close it. A background task
    // is what actually mounts Chips.tsx in that kanban context at all — with
    // no outstanding one, Details.tsx never renders the "agents" detail row
    // in the first place (agentsVisible and bgVisible both false), which
    // would mask this exact bug.
    const session = makeRow5Session({
      hookEmits: ["subagent", "progress"],
      subagents: [FINISHED_SUBAGENT],
      outstandingBackgroundTasks: [
        { id: "task-1", type: "shell", status: "running", description: "tail logs" },
      ],
    });
    const sidebarView = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    openDetails(sidebarView.container);
    openSubagentHistory(sidebarView.container);
    expect(sidebarView.container.querySelector(".session-subagent-history")).toBeTruthy();
    sidebarView.unmount();

    const kanbanView = render(
      <SessionRow
        session={session}
        project={PROJECT}
        onOpen={vi.fn()}
        onEnd={vi.fn()}
        showSubagents={false}
        foldDetails={false}
      />,
    );
    // Confirm Chips.tsx actually mounted (via the background-tasks row) —
    // otherwise this test would pass vacuously regardless of the bug.
    expect(kanbanView.container.querySelector(".session-background-tasks-line")).toBeTruthy();
    expect(kanbanView.container.querySelector(".session-subagent-history")).toBeNull();
    expect(kanbanView.container.querySelector(".session-subagents-line")).toBeNull();
  });

  it("persists the history toggle's open state across remounts via localStorage", () => {
    const session = makeRow5Session({
      hookEmits: ["subagent"],
      subagents: [FINISHED_SUBAGENT],
    });
    const first = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    openDetails(first.container);
    openSubagentHistory(first.container);
    expect(first.container.querySelector(".session-subagent-history")).toBeTruthy();
    first.unmount();

    const second = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    openDetails(second.container);
    expect(second.container.querySelector(".session-subagent-history")).toBeTruthy();
  });

  it("falls back to a truncated agentId when agentType is null", () => {
    const session = makeRow5Session({
      hookEmits: ["subagent"],
      subagents: [{ ...RUNNING_SUBAGENT, agentType: null }],
    });
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    openDetails(container);
    expect(container.querySelector(".session-subagent-name")?.textContent).toBe(
      RUNNING_SUBAGENT.agentId.slice(0, 8),
    );
  });

  it("renders no control other than the chip itself (no kill handle for a live subagent)", () => {
    const session = makeRow5Session({ hookEmits: ["subagent"], subagents: [RUNNING_SUBAGENT] });
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    openDetails(container);
    const line = container.querySelector(".session-subagents-line")!;
    const chips = line.querySelectorAll(".session-subagent-chip");
    expect(line.querySelectorAll("button")).toHaveLength(chips.length);
  });

  it("expands a subagent's summary + counts on click, and collapses on a second click", async () => {
    const session = makeRow5Session({
      hookEmits: ["subagent"],
      subagents: [FINISHED_SUBAGENT],
    });
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    openDetails(container);
    openSubagentHistory(container);

    expect(container.querySelector(".session-subagent-detail")).toBeNull();

    await user.click(container.querySelector(".session-subagent-chip")!);
    const detail = container.querySelector(".session-subagent-detail");
    expect(detail?.querySelector(".session-subagent-summary")?.textContent).toBe(
      "Looked at the auth module.",
    );
    expect(detail?.querySelector(".session-subagent-detail-meta")?.textContent).toBe(
      "0 files · 1 tool failure",
    );

    await user.click(container.querySelector(".session-subagent-chip")!);
    expect(container.querySelector(".session-subagent-detail")).toBeNull();
  });

  it("clicking a subagent chip does not fire onOpen", async () => {
    const session = makeRow5Session({ hookEmits: ["subagent"], subagents: [RUNNING_SUBAGENT] });
    const onOpen = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={onOpen} onEnd={vi.fn()} />,
    );
    openDetails(container);

    await user.click(container.querySelector(".session-subagent-chip")!);

    expect(onOpen).not.toHaveBeenCalled();
  });

  it("does not confuse two different finished subagents' expanded state within the same session", async () => {
    const OTHER_FINISHED = { ...FINISHED_SUBAGENT, agentId: "subagent-test-id-4" };
    const session = makeRow5Session({
      hookEmits: ["subagent"],
      subagents: [FINISHED_SUBAGENT, OTHER_FINISHED],
    });
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    openDetails(container);
    openSubagentHistory(container);

    const chips = container.querySelectorAll(".session-subagent-history .session-subagent-chip");
    await user.click(chips[0]);

    expect(container.querySelectorAll(".session-subagent-detail")).toHaveLength(1);
  });
});

describe("SessionRow row 6 — background tasks (issue #428)", () => {
  let nextRow6SessionId = 90_000;

  function makeRow6Session(overrides: Partial<Session>): Session {
    return makeSession({ id: nextRow6SessionId++, ...overrides });
  }

  const RUNNING_TASK = {
    id: "task-1",
    type: "subagent",
    status: "running",
    description: "Explore agent",
    agent_type: "Explore",
  };

  it("renders no background-tasks row when the agent doesn't emit progress (hookEmits gate)", () => {
    const session = makeRow6Session({
      hookEmits: [],
      outstandingBackgroundTasks: [RUNNING_TASK],
    });
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    expect(container.querySelector(".session-background-tasks-line")).toBeNull();
  });

  it("renders no background-tasks row when there is nothing outstanding", () => {
    const session = makeRow6Session({
      hookEmits: ["progress"],
      outstandingBackgroundTasks: [],
    });
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    expect(container.querySelector(".session-background-tasks-line")).toBeNull();
  });

  it("renders one chip per outstanding background task when gated conditions are met", () => {
    const session = makeRow6Session({
      hookEmits: ["progress"],
      outstandingBackgroundTasks: [
        RUNNING_TASK,
        { id: "task-2", type: "shell", status: "running", description: "tail logs" },
      ],
    });
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    openDetails(container);
    const chips = container.querySelectorAll(".session-background-task-chip");
    expect(chips).toHaveLength(2);
    expect(chips[0].querySelector(".session-background-task-desc")?.textContent).toBe(
      "Explore agent",
    );
    expect(chips[0].querySelector(".session-background-task-letter")?.textContent).toBe("S");
    expect(chips[1].querySelector(".session-background-task-desc")?.textContent).toBe("tail logs");
  });

  it("carries the task's type/detail in the chip's title attribute", () => {
    const session = makeRow6Session({
      hookEmits: ["progress"],
      outstandingBackgroundTasks: [RUNNING_TASK],
    });
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    openDetails(container);
    const chip = container.querySelector(".session-background-task-chip")!;
    expect(chip.getAttribute("title")).toBe("subagent: Explore");
  });

  it("renders no interactive controls (no kill/expand handle for a background task)", () => {
    const session = makeRow6Session({
      hookEmits: ["progress"],
      outstandingBackgroundTasks: [RUNNING_TASK],
    });
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    openDetails(container);
    const line = container.querySelector(".session-background-tasks-line")!;
    expect(line.querySelectorAll("button")).toHaveLength(0);
  });
});
