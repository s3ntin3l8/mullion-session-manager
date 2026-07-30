// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionRow } from "./Sidebar.js";
import {
  api,
  type GitBranchesResult,
  type GitDiffStats,
  type GitHubPRsStatus,
  type GitStatus,
  type NotificationEvent,
  type Project,
  type Session,
  type GitFileDiffResponse,
} from "./api.js";
import { parseUnifiedDiff } from "./diffUtils.js";

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
// Issue #271 — PromoteDialog (rendered from SessionRow's kebab menu / the
// promoteState==="pending" auto-open) reads these two store actions.
const promoteSessionMock = vi.fn().mockResolvedValue(undefined);
const declinePromoteMock = vi.fn().mockResolvedValue(undefined);
const renameSessionMock = vi.fn().mockResolvedValue(undefined);
// Issue #351 — session.hookEmits (matched adapter emits surfaced on each
// session) determines whether statusEstimated renders. Tests that don't
// care about estimated status get hookEmits: [] from makeSession's default.
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
      promoteSession: promoteSessionMock,
      declinePromote: declinePromoteMock,
      renameSession: renameSessionMock,
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
    liveCwd: null,
    previewBranch: null,
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
    // `activity: "working"` default above. Sidebar.tsx's status dot/label
    // now renders off sessionStatus/sessionStatusSeverity/
    // sessionStatusDetail directly, not the raw permissionState/planState/
    // errorState/endedReason fields above — tests exercising that rendering
    // override these too (see the "promote to worktree" describe block
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
  autoFetch: null,
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
  liveCwd: null,
  previewBranch: null,
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
  // Rich statuses (issue: extend surfaced session statuses).
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

describe("SessionRow row 4 — file changes (issue #177)", () => {
  it("renders no strip when the session has no file_change events", () => {
    const { container } = render(
      <SessionRow session={makeSession({})} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    expect(container.querySelector(".session-file-changes-line")).toBeNull();
  });

  it("renders no strip for a session with only non-file_change events", () => {
    events = {
      1: [{ seq: 1, sessionId: 1, kind: "title_change", ts: Date.now(), payload: { title: "x" } }],
    };
    const { container } = render(
      <SessionRow session={makeSession({})} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    expect(container.querySelector(".session-file-changes-line")).toBeNull();
  });

  it("renders one chip per distinct path, most-recently-changed first", () => {
    events = {
      1: [
        {
          seq: 1,
          sessionId: 1,
          kind: "file_change",
          ts: Date.now(),
          payload: { path: "src/a.ts", action: "modify" },
        },
        {
          seq: 2,
          sessionId: 1,
          kind: "file_change",
          ts: Date.now(),
          payload: { path: "src/b.ts", action: "create" },
        },
      ],
    };
    const { container } = render(
      <SessionRow session={makeSession({})} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    const chips = container.querySelectorAll(".session-file-change-chip");
    expect(chips).toHaveLength(2);
    // seq 2 (b.ts) is more recent than seq 1 (a.ts) -> shown first.
    expect(chips[0].querySelector(".session-file-change-name")?.textContent).toBe("b.ts");
    expect(chips[0].querySelector(".session-file-change-letter")?.textContent).toBe("A");
    expect(chips[0].querySelector(".github-panel-ci-dot")?.classList.contains("good")).toBe(true);
    expect(chips[1].querySelector(".session-file-change-name")?.textContent).toBe("a.ts");
    expect(chips[1].querySelector(".session-file-change-letter")?.textContent).toBe("M");
    expect(chips[1].querySelector(".github-panel-ci-dot")?.classList.contains("pending")).toBe(
      true,
    );
  });

  it("collapses repeated events for the same path into one chip with the latest action", () => {
    events = {
      1: [
        {
          seq: 1,
          sessionId: 1,
          kind: "file_change",
          ts: Date.now(),
          payload: { path: "src/a.ts", action: "create" },
        },
        {
          seq: 2,
          sessionId: 1,
          kind: "file_change",
          ts: Date.now(),
          payload: { path: "src/a.ts", action: "modify" },
        },
        {
          seq: 3,
          sessionId: 1,
          kind: "file_change",
          ts: Date.now(),
          payload: { path: "src/a.ts", action: "modify" },
        },
      ],
    };
    const { container } = render(
      <SessionRow session={makeSession({})} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    const chips = container.querySelectorAll(".session-file-change-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0].querySelector(".session-file-change-letter")?.textContent).toBe("M");
  });

  it("shows the D badge for a deleted file", () => {
    events = {
      1: [
        {
          seq: 1,
          sessionId: 1,
          kind: "file_change",
          ts: Date.now(),
          payload: { path: "src/gone.ts", action: "delete" },
        },
      ],
    };
    const { container } = render(
      <SessionRow session={makeSession({})} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    const chip = container.querySelector(".session-file-change-chip");
    expect(chip?.querySelector(".session-file-change-letter")?.textContent).toBe("D");
    expect(chip?.querySelector(".github-panel-ci-dot")?.classList.contains("bad")).toBe(true);
  });

  it("caps the number of chips shown at 5, keeping the most recent", () => {
    events = {
      1: Array.from({ length: 7 }, (_, i) => ({
        seq: i + 1,
        sessionId: 1,
        kind: "file_change" as const,
        ts: Date.now(),
        payload: { path: `src/file-${i}.ts`, action: "modify" as const },
      })),
    };
    const { container } = render(
      <SessionRow session={makeSession({})} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    const chips = container.querySelectorAll(".session-file-change-chip");
    expect(chips).toHaveLength(5);
    // Most recent 5 of 7 -> file-2 through file-6.
    expect(chips[0].querySelector(".session-file-change-name")?.textContent).toBe("file-6.ts");
    expect(chips[4].querySelector(".session-file-change-name")?.textContent).toBe("file-2.ts");
  });

  it("expands a minimal path + action + count detail on click, and collapses on a second click", async () => {
    events = {
      1: [
        {
          seq: 1,
          sessionId: 1,
          kind: "file_change",
          ts: Date.now(),
          payload: { path: "src/a.ts", action: "modify" },
        },
        {
          seq: 2,
          sessionId: 1,
          kind: "file_change",
          ts: Date.now(),
          payload: { path: "src/a.ts", action: "modify" },
        },
      ],
    };
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={makeSession({})} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    expect(container.querySelector(".session-file-change-detail")).toBeNull();

    await user.click(container.querySelector(".session-file-change-chip")!);
    const detail = container.querySelector(".session-file-change-detail");
    expect(detail?.querySelector(".session-file-change-detail-path")?.textContent).toBe("src/a.ts");
    expect(detail?.querySelector(".session-file-change-detail-meta")?.textContent).toBe(
      "M · 2 changes",
    );

    await user.click(container.querySelector(".session-file-change-chip")!);
    expect(container.querySelector(".session-file-change-detail")).toBeNull();
  });

  it("clicking a chip does not fire onOpen", async () => {
    events = {
      1: [
        {
          seq: 1,
          sessionId: 1,
          kind: "file_change",
          ts: Date.now(),
          payload: { path: "src/a.ts", action: "modify" },
        },
      ],
    };
    const onOpen = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={makeSession({})} project={PROJECT} onOpen={onOpen} onEnd={vi.fn()} />,
    );

    await user.click(container.querySelector(".session-file-change-chip")!);

    expect(onOpen).not.toHaveBeenCalled();
  });

  it("renders a loading spinner while the diff is loading, and then renders formatted diff lines when resolved", async () => {
    events = {
      1: [
        {
          seq: 1,
          sessionId: 1,
          kind: "file_change",
          ts: Date.now(),
          payload: { path: "src/a.ts", action: "modify" },
        },
      ],
    };
    let resolveDiffPromise!: (value: GitFileDiffResponse) => void;
    const diffPromise = new Promise<GitFileDiffResponse>((resolve) => {
      resolveDiffPromise = resolve;
    });
    const spy = vi.spyOn(api, "getSessionGitFileDiff").mockReturnValue(diffPromise);

    const user = userEvent.setup();
    const { container } = render(
      <SessionRow
        session={makeSession({ id: 1 })}
        project={PROJECT}
        onOpen={vi.fn()}
        onEnd={vi.fn()}
      />,
    );

    const chip = container.querySelector(".session-file-change-chip")!;
    await user.click(chip);

    // spinner is shown
    expect(container.querySelector(".session-diff-spinner")?.textContent).toBe("…");
    expect(spy).toHaveBeenCalledWith(1, "src/a.ts");

    // resolve mock API response
    await act(async () => {
      resolveDiffPromise({
        patch: [
          "diff --git a/src/a.ts b/src/a.ts",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -1,2 +1,3 @@",
          " unchanged context",
          "-deleted line",
          "+added line",
        ].join("\n"),
      });
    });

    // diff lines are rendered with the correct classes
    expect(container.querySelector(".session-diff-spinner")).toBeNull();
    const lines = container.querySelectorAll(".session-diff-line");
    expect(lines).toHaveLength(7);
    expect(lines[0].classList.contains("session-diff-file")).toBe(true);
    expect(lines[1].classList.contains("session-diff-file")).toBe(true);
    expect(lines[2].classList.contains("session-diff-file")).toBe(true);
    expect(lines[3].classList.contains("session-diff-hunk")).toBe(true);
    expect(lines[4].classList.contains("session-diff-context")).toBe(true);
    expect(lines[5].classList.contains("session-diff-del")).toBe(true);
    expect(lines[6].classList.contains("session-diff-add")).toBe(true);

    spy.mockRestore();
  });

  it("shows 'No changes' message if API returns no changes (null patch)", async () => {
    events = {
      1: [
        {
          seq: 1,
          sessionId: 1,
          kind: "file_change",
          ts: Date.now(),
          payload: { path: "src/a.ts", action: "modify" },
        },
      ],
    };
    const spy = vi.spyOn(api, "getSessionGitFileDiff").mockResolvedValue({ patch: null });
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow
        session={makeSession({ id: 1 })}
        project={PROJECT}
        onOpen={vi.fn()}
        onEnd={vi.fn()}
      />,
    );

    const chip = container.querySelector(".session-file-change-chip")!;
    await user.click(chip);

    // wait for render
    await screen.findByText("No changes");
    expect(container.querySelector(".session-diff-empty")).toBeTruthy();

    spy.mockRestore();
  });
});

describe("SessionRow row 5 — subagents (Phase 5 Track A, #195/5.5a)", () => {
  // Same fresh-id-per-test rationale as makeRow3Session above — the
  // localStorage-backed expanded-subagent-rows Set is module-level and never
  // reset between tests.
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

describe("SessionRow promote to worktree (issue #271)", () => {
  beforeEach(() => {
    // PromoteDialog fetches branches for its base-ref picker on mount —
    // 204 ("not applicable") is a harmless default these tests don't
    // otherwise care about.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens the promote dialog from the kebab menu for an active session", async () => {
    const user = userEvent.setup();
    render(
      <SessionRow session={makeSession({})} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    expect(screen.queryByText("Promote to worktree")).not.toBeInTheDocument();
    await user.click(screen.getByTitle("More…"));
    await user.click(await screen.findByText("Promote to worktree…"));

    expect(await screen.findByText("Promote to worktree")).toBeInTheDocument();
  });

  it("does not show the kebab menu for a killed session", () => {
    render(
      <SessionRow
        session={makeSession({ status: "killed" })}
        project={PROJECT}
        onOpen={vi.fn()}
        onEnd={vi.fn()}
      />,
    );
    expect(screen.queryByTitle("More…")).not.toBeInTheDocument();
  });

  it("auto-opens the promote dialog when promoteState is pending (an agent-triggered request)", async () => {
    render(
      <SessionRow
        session={makeSession({
          promoteState: "pending",
          promoteSummary: "start work on the bug fix",
          promoteSuggestedBaseRef: "main",
        })}
        project={PROJECT}
        onOpen={vi.fn()}
        onEnd={vi.fn()}
      />,
    );

    expect(await screen.findByText("Promote to worktree")).toBeInTheDocument();
    expect(
      screen.getByText("The agent asked to start work in an isolated worktree."),
    ).toBeInTheDocument();
  });

  it("does not auto-open when promoteState is idle", () => {
    render(
      <SessionRow session={makeSession({})} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    expect(screen.queryByText("Promote to worktree")).not.toBeInTheDocument();
  });

  it("shows 'Needs permission' label when sessionStatus is awaiting_permission", async () => {
    const session = makeSession({
      permissionState: "pending",
      sessionStatus: "awaiting_permission",
      sessionStatusSeverity: "blocked",
    });
    const { findByText } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    expect(await findByText("Needs permission")).toBeInTheDocument();
  });

  it("shows 'Plan ready' label when sessionStatus is awaiting_plan", async () => {
    const session = makeSession({
      planState: "pending",
      sessionStatus: "awaiting_plan",
      sessionStatusSeverity: "blocked",
    });
    const { findByText } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    expect(await findByText("Plan ready")).toBeInTheDocument();
  });

  it("shows 'API error' label when sessionStatus is api_error", async () => {
    const session = makeSession({
      errorState: "api_error",
      sessionStatus: "api_error",
      sessionStatusSeverity: "failed",
    });
    const { findByText } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    expect(await findByText("API error")).toBeInTheDocument();
  });

  it("shows 'exited: clear' label when sessionStatus is exited with a matching detail", async () => {
    const session = makeSession({
      status: "exited",
      endedReason: "clear",
      sessionStatus: "exited",
      sessionStatusSeverity: "gone",
      sessionStatusDetail: "clear",
    });
    const { findByText } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    expect(await findByText("exited: clear")).toBeInTheDocument();
  });

  it("shows 'Finished' label when sessionStatus is finished", async () => {
    const session = makeSession({
      lastTurnEndedAt: Date.now(),
      sessionStatus: "finished",
      sessionStatusSeverity: "done",
    });
    const { findByText } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    expect(await findByText("Finished")).toBeInTheDocument();
  });

  it("renders a long sessionStatusDetail as a single truncating label with a title, not a spilling one (sidebar overflow fix)", async () => {
    const longDetail =
      'Bash: grep -n "OUTPUT_IMMUNE_KINDS" -A 30 /home/bjoern/projects/claude-remote-session/src';
    const session = makeSession({
      errorState: "tool_failure",
      sessionStatus: "tool_failure",
      sessionStatusSeverity: "failed",
      sessionStatusDetail: longDetail,
    });
    const { container, findByText } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    const label = await findByText(`Tool failure: ${longDetail}`);
    expect(label).toHaveClass("session-status-label");
    expect(label).toHaveAttribute("title", `Tool failure: ${longDetail}`);
    // Exactly one label span — the overflow guard is CSS (ellipsis), not a
    // second truncated element rendered alongside the full text.
    expect(container.querySelectorAll(".session-status-label")).toHaveLength(1);
  });

  // Issue #319 — estimated status rendering: when an agent's emits DON'T
  // cover a session's status, the row gets .status-estimated styling and the
  // dot gets the .estimated class + a tooltip explaining it's inferred.
  it("renders estimated styling when agent emits don't cover the session status", async () => {
    const session = makeSession({
      command: "claude code",
      sessionStatus: "api_error",
      sessionStatusSeverity: "failed",
      hookEmits: [], // no emits -> api_error is unreachable
      pendingDevServerPort: null,
    });
    render(<SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />);

    // Row-level: should have both status-attention (severity stripe) and
    // status-estimated (dotted border-left) classes.
    const row = await screen.findByText("API error").then((el) => el.closest(".session-item"));
    expect(row).toBeTruthy();
    expect(row!.classList.contains("status-attention")).toBe(true);
    expect(row!.classList.contains("status-estimated")).toBe(true);

    // Dot: should carry .estimated class and tooltip.
    const dot = row!.querySelector(".session-dot-wrap");
    expect(dot).toBeTruthy();
    expect(dot!.getAttribute("title")).toBe(
      "Estimated status — this agent doesn't report this state directly",
    );
    expect(dot!.querySelector(".session-dot-error.estimated")).toBeTruthy();
  });

  it("does not render estimated styling when agent emits cover the session status", async () => {
    const session = makeSession({
      command: "claude code",
      sessionStatus: "api_error",
      sessionStatusSeverity: "failed",
      hookEmits: ["stop_failure"], // covers api_error
      pendingDevServerPort: null,
    });
    render(<SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />);

    const row = await screen.findByText("API error").then((el) => el.closest(".session-item"));
    expect(row).toBeTruthy();
    expect(row!.classList.contains("status-attention")).toBe(true);
    expect(row!.classList.contains("status-estimated")).toBe(false);

    const dot = row!.querySelector(".session-dot-wrap");
    expect(dot).toBeTruthy();
    expect(dot!.getAttribute("title")).toBeNull();
    expect(dot!.querySelector(".session-dot-error:not(.estimated)")).toBeTruthy();
  });

  it("double-clicking the session name opens rename input pre-filled with the current title", async () => {
    const session = makeSession({ lastTitle: "My Shell Session", command: "bash" });
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    const nameEl = container.querySelector(".session-name")!;
    await user.dblClick(nameEl);

    const input = container.querySelector(".session-rename-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe("My Shell Session");
    expect(container.querySelector(".session-name")).toBeNull();
  });

  it("double-clicking the session name fills the rename input with the nameLocked name", async () => {
    const session = makeSession({
      name: "Renamed Title",
      nameLocked: true,
      lastTitle: "Original Title",
      command: "bash",
    });
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    const nameEl = container.querySelector(".session-name")!;
    await user.dblClick(nameEl);

    const input = container.querySelector(".session-rename-input") as HTMLInputElement;
    expect(input.value).toBe("Renamed Title");
  });

  it("commits the rename on Enter and calls renameSession", async () => {
    renameSessionMock.mockClear();
    const session = makeSession({ command: "bash" });
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    const nameEl = container.querySelector(".session-name")!;
    await user.dblClick(nameEl);
    const input = container.querySelector(".session-rename-input") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "New Name");
    await user.keyboard("{Enter}");

    expect(renameSessionMock).toHaveBeenCalledWith(session.id, "New Name");
    // Should revert to showing the span, not the input
    expect(container.querySelector(".session-name")).toBeTruthy();
    expect(container.querySelector(".session-rename-input")).toBeNull();
  });

  it("does not call renameSession on Enter when the input is empty", async () => {
    renameSessionMock.mockClear();
    const session = makeSession({ command: "bash" });
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    const nameEl = container.querySelector(".session-name")!;
    await user.dblClick(nameEl);
    const input = container.querySelector(".session-rename-input") as HTMLInputElement;
    await user.clear(input);
    await user.keyboard("{Enter}");

    expect(renameSessionMock).not.toHaveBeenCalled();
    expect(container.querySelector(".session-name")).toBeTruthy();
  });

  it("cancels the rename on Escape", async () => {
    renameSessionMock.mockClear();
    const session = makeSession({ lastTitle: "Original", command: "bash" });
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    const nameEl = container.querySelector(".session-name")!;
    await user.dblClick(nameEl);
    const input = container.querySelector(".session-rename-input") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "Typed But Cancelled");
    await user.keyboard("{Escape}");

    expect(renameSessionMock).not.toHaveBeenCalled();
    expect(container.querySelector(".session-name")).toBeTruthy();
    expect(container.querySelector(".session-rename-input")).toBeNull();
    expect(container.querySelector(".session-name")!.textContent).toBe("Original");
  });

  it("commits the rename on blur (click away)", async () => {
    renameSessionMock.mockClear();
    const session = makeSession({ command: "bash" });
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    const nameEl = container.querySelector(".session-name")!;
    await user.dblClick(nameEl);
    const input = container.querySelector(".session-rename-input") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "Blur Rename");
    // Click somewhere else to blur the input
    await user.click(container.querySelector(".session-item")!);

    expect(renameSessionMock).toHaveBeenCalledWith(session.id, "Blur Rename");
    expect(container.querySelector(".session-name")).toBeTruthy();
  });

  it("opens the rename input from the kebab menu Rename item", async () => {
    const session = makeSession({
      command: "bash",
      status: "active",
      lastTitle: "Kebab Rename",
    });
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    await user.click(screen.getByTitle("More…"));
    await user.click(await screen.findByText("Rename"));

    const input = container.querySelector(".session-rename-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe("Kebab Rename");
  });
});

describe("parseUnifiedDiff", () => {
  it("classifies added lines as 'add'", () => {
    expect(parseUnifiedDiff("+added line")).toEqual([{ type: "add", text: "+added line" }]);
  });

  it("classifies '+++ ' file-header lines as 'file'", () => {
    expect(parseUnifiedDiff("+++ b/path/to/file.ts")).toEqual([
      { type: "file", text: "+++ b/path/to/file.ts" },
    ]);
  });

  it("classifies deleted lines as 'del'", () => {
    expect(parseUnifiedDiff("-removed line")).toEqual([{ type: "del", text: "-removed line" }]);
  });

  it("classifies '--- ' file-header lines as 'file'", () => {
    expect(parseUnifiedDiff("--- a/path/to/file.ts")).toEqual([
      { type: "file", text: "--- a/path/to/file.ts" },
    ]);
  });

  it("classifies hunk headers (@@) as 'hunk'", () => {
    expect(parseUnifiedDiff("@@ -1,4 +1,5 @@")).toEqual([
      { type: "hunk", text: "@@ -1,4 +1,5 @@" },
    ]);
  });

  it("classifies 'diff --git' lines as 'file'", () => {
    expect(parseUnifiedDiff("diff --git a/file.ts b/file.ts")).toEqual([
      { type: "file", text: "diff --git a/file.ts b/file.ts" },
    ]);
  });

  it("classifies unmarked context lines as 'context'", () => {
    expect(parseUnifiedDiff("  unchanged context line")).toEqual([
      { type: "context", text: "  unchanged context line" },
    ]);
  });

  it("handles a full unified diff patch", () => {
    const patch = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,4 +1,5 @@",
      " unchanged",
      "+added",
      "-removed",
      " more context",
    ].join("\n");
    expect(parseUnifiedDiff(patch)).toEqual([
      { type: "file", text: "diff --git a/src/foo.ts b/src/foo.ts" },
      { type: "file", text: "--- a/src/foo.ts" },
      { type: "file", text: "+++ b/src/foo.ts" },
      { type: "hunk", text: "@@ -1,4 +1,5 @@" },
      { type: "context", text: " unchanged" },
      { type: "add", text: "+added" },
      { type: "del", text: "-removed" },
      { type: "context", text: " more context" },
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});
