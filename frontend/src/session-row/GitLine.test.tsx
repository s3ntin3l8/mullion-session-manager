// @vitest-environment jsdom
// SessionRow row 3 — git details (issue #202). Split out of the former
// monolithic SessionRow.test.tsx (PR 27 phase 2, Wave 5 of
// .claude/plans/can-we-do-a-warm-cocke.md) — this file owns every test that
// exercises the git-details toggle/line, i.e. everything GitLine.tsx (plus
// the toggle button in Header.tsx, and the gitExpanded gate in SessionRow
// itself) renders. Still mounts the full `<SessionRow>` (not GitLine in
// isolation) — GitLine itself is a pure, store-independent presentational
// component with no interesting internal behavior to test standalone; what's
// actually under test here is the derivation (worktree/PR/branch matching)
// SessionRow performs before handing GitLine its props, so a real mount is
// the only way to exercise that. Matches this codebase's own precedent for
// split component test files (see settings/sections/Settings.*.test.tsx,
// which mount the top-level `Settings` rather than each section component).
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
      mutedSessionIds: [],
      toggleSessionMute: vi.fn(),
    }),
}));

const PROJECT: Project = makeProject();

const CLEAN_STATUS: GitStatus = {
  branch: "main",
  hash: "abc1234",
  ahead: 0,
  behind: 0,
  files: [],
  isClean: true,
  hasConflicts: false,
};

const DIRTY_STATUS: GitStatus = {
  branch: "feature/x",
  hash: "def5678",
  ahead: 0,
  behind: 0,
  files: [{ path: "a.txt", status: "M" }],
  isClean: false,
  hasConflicts: false,
};

beforeEach(() => {
  events = {};
  sessionGitStatuses = {};
  gitDiffStats = {};
  gitBranchesByProject = {};
  prsByProject = {};
  sessions = [];
  localStorage.clear();
});

// Row 3's expand/collapse toggle persists via a module-level Set in
// Sidebar.tsx, read once at import time — it isn't reset between tests
// (there's no test-only escape hatch for it, and adding a non-component
// export to this file would trip react-refresh/only-export-components). A
// fresh, never-before-toggled session id per test sidesteps that instead:
// each test's own toggle can't collide with an earlier test's state for a
// different id.
let nextRow3SessionId = 10_000;
function makeRow3Session(overrides: Partial<Session>): Session {
  return makeSession({ id: nextRow3SessionId++, ...overrides });
}

describe("SessionRow row 3 — git details (issue #202)", () => {
  it("renders no toggle and no git line when the session has no git status", () => {
    const session = makeRow3Session({});
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    expect(container.querySelector(".session-git-toggle")).toBeNull();
    expect(container.querySelector(".session-git-line")).toBeNull();
  });

  it("renders no toggle when git status is null (fetched, not a repo)", () => {
    const session = makeRow3Session({});
    sessionGitStatuses = { [session.id]: null };
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    expect(container.querySelector(".session-git-toggle")).toBeNull();
  });

  it("renders a toggle, collapsed by default, when git status is present", () => {
    const session = makeRow3Session({});
    sessionGitStatuses = { [session.id]: CLEAN_STATUS };
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    expect(container.querySelector(".session-git-toggle")).toBeTruthy();
    expect(container.querySelector(".session-git-line")).toBeNull();
  });

  it("expands to show branch + clean dirty-dot on toggle click", async () => {
    const session = makeRow3Session({});
    sessionGitStatuses = { [session.id]: CLEAN_STATUS };
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    await user.click(container.querySelector(".session-git-toggle")!);

    const line = container.querySelector(".session-git-line");
    expect(line).toBeTruthy();
    expect(line?.textContent).toContain("main");
    expect(container.querySelector(".session-git-branch")?.textContent).toBe("main");
    expect(container.querySelector(".project-git-dot.clean")).toBeTruthy();
  });

  it("shows the dirty dot for a session with changed files", async () => {
    const session = makeRow3Session({});
    sessionGitStatuses = { [session.id]: DIRTY_STATUS };
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    await user.click(container.querySelector(".session-git-toggle")!);

    expect(container.querySelector(".project-git-dot.dirty")).toBeTruthy();
  });

  it("shows the conflict dot for a session with unresolved conflicts", async () => {
    const session = makeRow3Session({});
    sessionGitStatuses = { [session.id]: { ...DIRTY_STATUS, hasConflicts: true } };
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    await user.click(container.querySelector(".session-git-toggle")!);

    expect(container.querySelector(".project-git-dot.conflict")).toBeTruthy();
  });

  it("toggling closed hides the git line again", async () => {
    const session = makeRow3Session({});
    sessionGitStatuses = { [session.id]: CLEAN_STATUS };
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    const toggle = container.querySelector(".session-git-toggle")!;
    await user.click(toggle);
    expect(container.querySelector(".session-git-line")).toBeTruthy();
    await user.click(toggle);
    expect(container.querySelector(".session-git-line")).toBeNull();
  });

  it("clicking the toggle does not fire onOpen", async () => {
    const session = makeRow3Session({});
    sessionGitStatuses = { [session.id]: CLEAN_STATUS };
    const onOpen = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={onOpen} onEnd={vi.fn()} />,
    );

    await user.click(container.querySelector(".session-git-toggle")!);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("persists the expanded state across remounts via localStorage", async () => {
    const session = makeRow3Session({});
    sessionGitStatuses = { [session.id]: CLEAN_STATUS };
    const user = userEvent.setup();
    const first = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    await user.click(first.container.querySelector(".session-git-toggle")!);
    expect(first.container.querySelector(".session-git-line")).toBeTruthy();
    first.unmount();

    const second = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    // Expanded state for this session id survives the remount (same
    // localStorage-backed Set the first render wrote to) — no click needed.
    expect(second.container.querySelector(".session-git-line")).toBeTruthy();
  });

  it("shows a worktree label only when the session's cwd matches a non-main worktree", async () => {
    const session = makeRow3Session({ cwd: "/home/x/demo-worktrees/feature-x" });
    sessionGitStatuses = { [session.id]: { ...DIRTY_STATUS, branch: "feature/x" } };
    gitBranchesByProject = {
      1: {
        branches: [{ name: "feature/x", isCurrent: false }],
        worktrees: [
          { path: PROJECT.cwd, branch: "main", isMain: true },
          { path: "/home/x/demo-worktrees/feature-x", branch: "feature/x", isMain: false },
        ],
        remoteBranches: [],
      },
    };
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    await user.click(container.querySelector(".session-git-toggle")!);

    const worktreeLabel = container.querySelector(".session-git-worktree");
    expect(worktreeLabel?.textContent).toBe("@ feature-x");
  });

  it("prefers the shell's live (OSC-7-announced) cwd over the static launch cwd for the worktree match", async () => {
    // Issue: sidebar worktree display — a session launched with no cwd
    // override at all (session.cwd stays null) whose shell later `cd`s into
    // a worktree should still show that worktree, once liveCwd reflects it.
    const session = makeRow3Session({ cwd: null, liveCwd: "/home/x/demo-worktrees/feature-x" });
    sessionGitStatuses = { [session.id]: { ...DIRTY_STATUS, branch: "feature/x" } };
    gitBranchesByProject = {
      1: {
        branches: [{ name: "feature/x", isCurrent: false }],
        worktrees: [
          { path: PROJECT.cwd, branch: "main", isMain: true },
          { path: "/home/x/demo-worktrees/feature-x", branch: "feature/x", isMain: false },
        ],
        remoteBranches: [],
      },
    };
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    await user.click(container.querySelector(".session-git-toggle")!);

    expect(container.querySelector(".session-git-worktree")?.textContent).toBe("@ feature-x");
  });

  it("shows no worktree label for a session at the project's own (main) cwd", async () => {
    const session = makeRow3Session({});
    sessionGitStatuses = { [session.id]: CLEAN_STATUS };
    gitBranchesByProject = {
      1: {
        branches: [{ name: "main", isCurrent: true }],
        worktrees: [{ path: PROJECT.cwd, branch: "main", isMain: true }],
        remoteBranches: [],
      },
    };
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    await user.click(container.querySelector(".session-git-toggle")!);

    expect(container.querySelector(".session-git-worktree")).toBeNull();
  });

  it("shows a matching PR (filtered by the session's own branch) with a CI dot", async () => {
    const session = makeRow3Session({});
    sessionGitStatuses = { [session.id]: { ...DIRTY_STATUS, branch: "feature/x" } };
    prsByProject = {
      1: {
        prs: [
          {
            number: 7,
            title: "Add feature x",
            htmlUrl: "https://github.com/o/r/pull/7",
            author: "dev",
            headSha: "abc",
            headBranch: "feature/x",
            baseBranch: "main",
            ciStatus: "success",
            actionsRuns: [],
          },
          {
            number: 8,
            title: "Unrelated PR",
            htmlUrl: "https://github.com/o/r/pull/8",
            author: "dev",
            headSha: "def",
            headBranch: "some-other-branch",
            baseBranch: "main",
            ciStatus: "failure",
            actionsRuns: [],
          },
        ],
        prSummary: { total: 2, pass: 1, fail: 1, pending: 0, unknown: 0 },
      },
    };
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    await user.click(container.querySelector(".session-git-toggle")!);

    const prLink = container.querySelector(".session-git-pr");
    expect(prLink?.textContent).toContain("7");
    expect(prLink?.querySelector(".github-panel-ci-dot.good")).toBeTruthy();
  });

  it("shows no PR badge when no open PR matches the session's branch", async () => {
    const session = makeRow3Session({});
    sessionGitStatuses = { [session.id]: CLEAN_STATUS };
    prsByProject = {
      1: {
        prs: [
          {
            number: 8,
            title: "Unrelated PR",
            htmlUrl: "https://github.com/o/r/pull/8",
            author: "dev",
            headSha: "def",
            headBranch: "some-other-branch",
            baseBranch: "main",
            ciStatus: "failure",
            actionsRuns: [],
          },
        ],
        prSummary: { total: 1, pass: 0, fail: 1, pending: 0, unknown: 0 },
      },
    };
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    await user.click(container.querySelector(".session-git-toggle")!);

    expect(container.querySelector(".session-git-pr")).toBeNull();
  });

  it("shows diff stats (files/insertions/deletions) when present", async () => {
    const session = makeRow3Session({});
    sessionGitStatuses = { [session.id]: DIRTY_STATUS };
    gitDiffStats = { [session.id]: { filesChanged: 3, insertions: 12, deletions: 4 } };
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    await user.click(container.querySelector(".session-git-toggle")!);

    const diffStat = container.querySelector(".session-git-diffstat");
    expect(diffStat?.textContent).toContain("3 files");
    expect(container.querySelector(".session-git-ins")?.textContent).toBe("+12");
    expect(container.querySelector(".session-git-del")?.textContent).toBe("-4");
  });

  it("omits diff stats when there are zero changed files", async () => {
    const session = makeRow3Session({});
    sessionGitStatuses = { [session.id]: CLEAN_STATUS };
    gitDiffStats = { [session.id]: { filesChanged: 0, insertions: 0, deletions: 0 } };
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    await user.click(container.querySelector(".session-git-toggle")!);

    expect(container.querySelector(".session-git-diffstat")).toBeNull();
  });

  it("shows worktree label, PR badge, and diff stats together in one row (single-line summary)", async () => {
    // Deliberately no width-based gating here — the sidebar's resizable
    // width defaults to (and can't go below) its own floor (store.ts's
    // SIDEBAR_MIN_WIDTH), so a JS threshold for hiding row 3 content would
    // either be unreachable or hide content at the *default* width. Row 3
    // is one line with CSS overflow/ellipsis truncation (same as row 2's
    // .session-event-line) — this test asserts everything renders
    // regardless of viewport, i.e. that no such gating crept back in.
    const session = makeRow3Session({ cwd: "/home/x/demo-worktrees/feature-x" });
    sessionGitStatuses = { [session.id]: { ...DIRTY_STATUS, branch: "feature/x" } };
    gitBranchesByProject = {
      1: {
        branches: [{ name: "feature/x", isCurrent: false }],
        worktrees: [
          { path: PROJECT.cwd, branch: "main", isMain: true },
          { path: "/home/x/demo-worktrees/feature-x", branch: "feature/x", isMain: false },
        ],
        remoteBranches: [],
      },
    };
    prsByProject = {
      1: {
        prs: [
          {
            number: 9,
            title: "Feature x",
            htmlUrl: "https://github.com/o/r/pull/9",
            author: "dev",
            headSha: "abc",
            headBranch: "feature/x",
            baseBranch: "main",
            ciStatus: "success",
            actionsRuns: [],
          },
        ],
        prSummary: { total: 1, pass: 1, fail: 0, pending: 0, unknown: 0 },
      },
    };
    gitDiffStats = { [session.id]: { filesChanged: 3, insertions: 12, deletions: 4 } };

    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    await user.click(container.querySelector(".session-git-toggle")!);

    expect(container.querySelector(".session-git-branch")?.textContent).toBe("feature/x");
    expect(container.querySelector(".session-git-worktree")?.textContent).toBe("@ feature-x");
    expect(container.querySelector(".session-git-pr")?.textContent).toContain("9");
    expect(container.querySelector(".session-git-diffstat")?.textContent).toContain("3 files");
  });
});
