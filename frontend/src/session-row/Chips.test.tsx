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
import { render } from "@testing-library/react";
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
    }),
}));

const PROJECT: Project = makeProject();

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

  it("renders one chip per subagent when gated conditions are met", () => {
    const session = makeRow5Session({
      hookEmits: ["subagent"],
      subagents: [RUNNING_SUBAGENT, FINISHED_SUBAGENT],
    });
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    const chips = container.querySelectorAll(".session-subagent-chip");
    expect(chips).toHaveLength(2);
    expect(chips[0].querySelector(".session-subagent-name")?.textContent).toBe("code-reviewer");
    expect(chips[0].querySelector(".github-panel-ci-dot")?.classList.contains("pending")).toBe(
      true,
    );
    expect(chips[1].querySelector(".session-subagent-name")?.textContent).toBe("explore");
    expect(chips[1].querySelector(".github-panel-ci-dot")?.classList.contains("good")).toBe(true);
  });

  it("falls back to a truncated agentId when agentType is null", () => {
    const session = makeRow5Session({
      hookEmits: ["subagent"],
      subagents: [{ ...RUNNING_SUBAGENT, agentType: null }],
    });
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    expect(container.querySelector(".session-subagent-name")?.textContent).toBe(
      RUNNING_SUBAGENT.agentId.slice(0, 8),
    );
  });

  it("renders no control other than the chip itself (no kill handle for a subagent)", () => {
    const session = makeRow5Session({ hookEmits: ["subagent"], subagents: [RUNNING_SUBAGENT] });
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
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

    await user.click(container.querySelector(".session-subagent-chip")!);

    expect(onOpen).not.toHaveBeenCalled();
  });

  it("persists a chip's expanded state across remounts via localStorage", async () => {
    const session = makeRow5Session({
      hookEmits: ["subagent"],
      subagents: [FINISHED_SUBAGENT],
    });
    const user = userEvent.setup();
    const first = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    await user.click(first.container.querySelector(".session-subagent-chip")!);
    expect(first.container.querySelector(".session-subagent-detail")).toBeTruthy();
    first.unmount();

    const second = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    expect(second.container.querySelector(".session-subagent-detail")).toBeTruthy();
  });

  it("does not confuse two different subagents' expanded state within the same session", async () => {
    const session = makeRow5Session({
      hookEmits: ["subagent"],
      subagents: [RUNNING_SUBAGENT, FINISHED_SUBAGENT],
    });
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    const chips = container.querySelectorAll(".session-subagent-chip");
    await user.click(chips[0]);

    expect(container.querySelectorAll(".session-subagent-detail")).toHaveLength(1);
  });

  it("shows both details when two subagent chips are expanded at once, each directly after its own chip", async () => {
    const session = makeRow5Session({
      hookEmits: ["subagent"],
      subagents: [RUNNING_SUBAGENT, FINISHED_SUBAGENT],
    });
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    const chips = container.querySelectorAll(".session-subagent-chip");
    await user.click(chips[0]);
    await user.click(chips[1]);

    expect(container.querySelectorAll(".session-subagent-detail")).toHaveLength(2);
    // Each detail block immediately follows its own chip in DOM order — the
    // .session-subagent-detail's flex-basis:100% (styles.css) relies on this
    // markup order to lay each one out directly under its own chip rather
    // than sharing a flex line with an unrelated neighboring chip.
    const line = container.querySelector(".session-subagents-line")!;
    const children = Array.from(line.children);
    expect(children[0]).toHaveClass("session-subagent-chip");
    expect(children[1]).toHaveClass("session-subagent-detail");
    expect(children[2]).toHaveClass("session-subagent-chip");
    expect(children[3]).toHaveClass("session-subagent-detail");
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
    const line = container.querySelector(".session-background-tasks-line")!;
    expect(line.querySelectorAll("button")).toHaveLength(0);
  });
});
