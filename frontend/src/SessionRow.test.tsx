// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionRow } from "./Sidebar.js";
import type {
  GitBranchesResult,
  GitDiffStats,
  GitHubPRsStatus,
  GitStatus,
  NotificationEvent,
  Project,
  Session,
} from "./api.js";

// ConfirmButton checks settings.sessions.confirmBeforeKill from the store —
// default it to false so the test doesn't need a full store hydrate. Every
// mutable slice below is a `let` (not inlined into the factory) so
// individual tests can reassign it before rendering — mirrors
// PaneTab.test.tsx's own mutable-mock-state pattern for this same store
// mock shape.
let events: Record<number, NotificationEvent[]>;
let sessionGitStatuses: Record<number, GitStatus | null>;
let gitDiffStats: Record<number, GitDiffStats | null>;
let gitBranchesByProject: Record<number, GitBranchesResult | undefined>;
let prsByProject: Record<number, GitHubPRsStatus | undefined>;
vi.mock("./store.js", () => ({
  useDashboardStore: (selector: (s: unknown) => unknown) =>
    selector({
      settings: { sessions: { confirmBeforeKill: false } },
      theme: "dark",
      events,
      sessionGitStatuses,
      gitDiffStats,
      gitBranchesByProject,
      prsByProject,
    }),
}));

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: 1,
    projectId: 1,
    name: null,
    nameLocked: false,
    command: "claude code",
    cwd: null,
    kind: "terminal",
    status: "active",
    createdAt: "",
    lastAttachedAt: null,
    alive: true,
    subscriberCount: 0,
    activity: "working",
    lastActivityAt: Date.now(),
    attention: false,
    attentionAt: null,
    lastTitle: null,
    ...overrides,
  };
}

const PROJECT: Project = {
  id: 1,
  name: "demo",
  cwd: "/home/x/demo",
  hostId: "local",
  devServerUrl: null,
  detectedDevServerPort: null,
  currentBranch: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

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

// jsdom doesn't implement DataTransfer/DragEvent; provide minimal stubs.
function createDataTransfer(): DataTransfer {
  const map = new Map<string, string>();
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
  const event = new Event(type, { bubbles: true }) as unknown as DragEvent;
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  return event;
}

const SESSION: Session = {
  id: 42,
  projectId: 1,
  name: null,
  nameLocked: false,
  command: "claude code",
  cwd: null,
  kind: "terminal",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastAttachedAt: "2026-01-01T00:00:00.000Z",
  alive: true,
  subscriberCount: 1,
  activity: "working",
  lastActivityAt: Date.now(),
  attention: false,
  attentionAt: null,
  lastTitle: null,
};

beforeEach(() => {
  events = {};
  sessionGitStatuses = {};
  gitDiffStats = {};
  gitBranchesByProject = {};
  prsByProject = {};
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

describe("SessionRow", () => {
  it("sets application/x-mullion-session on drag start", () => {
    const onOpen = vi.fn();
    const onEnd = vi.fn();

    render(<SessionRow session={SESSION} project={PROJECT} onOpen={onOpen} onEnd={onEnd} />);

    const row = screen.getByText("claude code").closest(".session-item")!;

    const dataTransfer = createDataTransfer();
    row.dispatchEvent(createDragEvent("dragstart", dataTransfer));

    expect(dataTransfer.getData("application/x-mullion-session")).toBe("42");
    expect(dataTransfer.getData("text/plain")).toBe("claude code");
    expect(dataTransfer.effectAllowed).toBe("move");
  });

  it("fires onClick on a plain click (not a drag)", async () => {
    const onOpen = vi.fn();
    const onEnd = vi.fn();
    const user = userEvent.setup();

    render(<SessionRow session={SESSION} project={PROJECT} onOpen={onOpen} onEnd={onEnd} />);

    const row = screen.getByText("claude code").closest(".session-item")!;
    await user.click(row);

    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe("SessionRow title display", () => {
  it("shows command when no name and no lastTitle", () => {
    render(
      <SessionRow
        session={makeSession({ command: "npm run build" })}
        project={PROJECT}
        onOpen={vi.fn()}
        onEnd={vi.fn()}
      />,
    );
    expect(screen.getByText("npm run build")).toBeTruthy();
  });

  it("shows lastTitle when present and not locked", () => {
    render(
      <SessionRow
        session={makeSession({
          name: "Claude Code · my-project",
          command: "claude -p 'fix bug'",
          lastTitle: "fixing the bug",
        })}
        project={PROJECT}
        onOpen={vi.fn()}
        onEnd={vi.fn()}
      />,
    );
    expect(screen.getByText("fixing the bug")).toBeTruthy();
    expect(screen.queryByText("Claude Code · my-project")).toBeNull();
    expect(screen.queryByText("claude -p 'fix bug'")).toBeNull();
  });

  it("shows session.name when nameLocked even with lastTitle present", () => {
    render(
      <SessionRow
        session={makeSession({
          name: "my custom session",
          nameLocked: true,
          command: "claude",
          lastTitle: "ignored osc title",
        })}
        project={PROJECT}
        onOpen={vi.fn()}
        onEnd={vi.fn()}
      />,
    );
    expect(screen.getByText("my custom session")).toBeTruthy();
    expect(screen.queryByText("ignored osc title")).toBeNull();
  });

  it("shows monospace class for command fallback, not for lastTitle", () => {
    const { container: cmdContainer } = render(
      <SessionRow
        session={makeSession({ command: "npm test", lastTitle: null })}
        project={PROJECT}
        onOpen={vi.fn()}
        onEnd={vi.fn()}
      />,
    );
    expect(cmdContainer.querySelector(".session-name.mono")).toBeTruthy();

    const { container: oscContainer } = render(
      <SessionRow
        session={makeSession({ command: "npm test", lastTitle: "running tests" })}
        project={PROJECT}
        onOpen={vi.fn()}
        onEnd={vi.fn()}
      />,
    );
    expect(oscContainer.querySelector(".session-name.mono")).toBeNull();
  });
});

describe("SessionRow status line (issue #167)", () => {
  it("renders no status line when the session has no events yet", () => {
    const { container } = render(
      <SessionRow session={makeSession({})} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    expect(container.querySelector(".session-event-line")).toBeNull();
  });

  it("shows the latest event's text, uncolored, for an idle-ish event", () => {
    events = {
      1: [
        {
          seq: 1,
          sessionId: 1,
          kind: "title_change",
          ts: Date.now(),
          payload: { title: "running tests" },
        },
      ],
    };
    const { container } = render(
      <SessionRow session={makeSession({})} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    const line = container.querySelector(".session-event-line");
    expect(line?.textContent).toBe("running tests");
    expect(line?.classList.contains("attention")).toBe(false);
  });

  it("shows the latest event's text, colored, for an attention event", () => {
    events = {
      1: [
        {
          seq: 1,
          sessionId: 1,
          kind: "attention",
          ts: Date.now(),
          payload: { attention: true, signal: "bell" },
        },
      ],
    };
    const { container } = render(
      <SessionRow session={makeSession({})} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    const line = container.querySelector(".session-event-line");
    expect(line?.textContent).toBe("Bell");
    expect(line?.classList.contains("attention")).toBe(true);
  });

  it("falls back to an earlier describable event when the latest event's shape isn't recognized", () => {
    events = {
      1: [
        {
          seq: 1,
          sessionId: 1,
          kind: "title_change",
          ts: Date.now(),
          payload: { title: "running tests" },
        },
        {
          // A status_change with neither "exited" nor a recognized screen
          // value describeEvent() returns null for — the line should still
          // show the earlier title_change rather than going blank.
          seq: 2,
          sessionId: 1,
          kind: "status_change",
          ts: Date.now(),
          payload: { reason: "something-not-yet-taught" },
        },
      ],
    };
    const { container } = render(
      <SessionRow session={makeSession({})} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    const line = container.querySelector(".session-event-line");
    expect(line?.textContent).toBe("running tests");
    expect(line?.classList.contains("attention")).toBe(false);
  });

  it("picks the highest-seq event when several are buffered for a session", () => {
    events = {
      1: [
        {
          seq: 1,
          sessionId: 1,
          kind: "title_change",
          ts: Date.now() - 1000,
          payload: { title: "older title" },
        },
        {
          seq: 2,
          sessionId: 1,
          kind: "status_change",
          ts: Date.now(),
          payload: { reason: "exited" },
        },
      ],
    };
    const { container } = render(
      <SessionRow session={makeSession({})} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    expect(container.querySelector(".session-event-line")?.textContent).toBe("Exited");
  });
});

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
      },
    };
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    await user.click(container.querySelector(".session-git-toggle")!);

    const worktreeLabel = container.querySelector(".session-git-worktree");
    expect(worktreeLabel?.textContent).toBe("feature-x");
  });

  it("shows no worktree label for a session at the project's own (main) cwd", async () => {
    const session = makeRow3Session({});
    sessionGitStatuses = { [session.id]: CLEAN_STATUS };
    gitBranchesByProject = {
      1: {
        branches: [{ name: "main", isCurrent: true }],
        worktrees: [{ path: PROJECT.cwd, branch: "main", isMain: true }],
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
        prSummary: { total: 2, pass: 1, fail: 1, pending: 0 },
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
        prSummary: { total: 1, pass: 0, fail: 1, pending: 0 },
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
        prSummary: { total: 1, pass: 1, fail: 0, pending: 0 },
      },
    };
    gitDiffStats = { [session.id]: { filesChanged: 3, insertions: 12, deletions: 4 } };

    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    await user.click(container.querySelector(".session-git-toggle")!);

    expect(container.querySelector(".session-git-branch")?.textContent).toBe("feature/x");
    expect(container.querySelector(".session-git-worktree")?.textContent).toBe("feature-x");
    expect(container.querySelector(".session-git-pr")?.textContent).toContain("9");
    expect(container.querySelector(".session-git-diffstat")?.textContent).toContain("3 files");
  });
});
