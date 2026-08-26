// @vitest-environment jsdom
// Integration-level SessionRow tests only — behaviors that only make sense
// at the fully-assembled row (drag-and-drop, click-through, keyboard a11y,
// the depth prop, cascade-aware end-session confirmation, title/status-line
// wiring, and the PromoteDialog trigger/auto-open). Split out of the former
// monolithic 1912-line SessionRow.test.tsx (PR 27 phase 2, Wave 5 of
// .claude/plans/can-we-do-a-warm-cocke.md) — region-specific behavior now
// lives alongside its component in session-row/*.test.tsx:
//   - session-row/Header.test.tsx — kebab menu, status label, rename
//   - session-row/GitLine.test.tsx — row 3, git details
//   - session-row/FileChanges.test.tsx — row 4, file-change chips + diff
//   - session-row/Chips.test.tsx — rows 5/6, subagent + background-task chips
// diffUtils.ts's own parseUnifiedDiff pure-function tests (previously
// piggybacked here) moved to diffUtils.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionRow } from "./Sidebar.js";
import {
  type GitBranchesResult,
  type GitDiffStats,
  type GitHubPRsStatus,
  type GitStatus,
  type NotificationEvent,
  type Project,
  type Session,
} from "./api/index.js";
import { makeSession, makeProject } from "./test/fixtures.js";

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
// Phase 5 (Track B, issue #196 5.6) — the full session list, used to
// compute a row's live child count for the cascade-aware kill confirmation.
// Defaults to [] in beforeEach; tests exercising the cascade UI set it
// before rendering.
let sessions: Session[];
// Issue #271 — PromoteDialog (rendered from SessionRow's kebab menu / the
// promoteState==="pending" auto-open) reads these two store actions.
const promoteSessionMock = vi.fn().mockResolvedValue(undefined);
const declinePromoteMock = vi.fn().mockResolvedValue(undefined);
const renameSessionMock = vi.fn().mockResolvedValue(undefined);
// Issue #351 — session.hookEmits (matched adapter emits surfaced on each
// session) determines whether statusEstimated renders. Tests that don't
// care about estimated status get hookEmits: [] from makeSession's default.
vi.mock("./store/index.js", () => {
  // The state object is built INSIDE the selector callback (call-time, during
  // render) rather than at mock-definition (hoisted) time, so the `let`
  // module-level fixtures (events/sessions/...) are initialized by the time
  // the component actually reads them — referencing them at definition time
  // would hit the temporal-dead-zone error vitest warns about.
  const useDashboardStore = (selector: (s: unknown) => unknown) =>
    selector({
      settings: { sessions: { confirmBeforeKill: false } },
      theme: "dark",
      events,
      sessionGitStatuses,
      gitDiffStats,
      gitBranchesByProject,
      prsByProject,
      sessions,
      mutedSessionIds: [],
      promoteSession: promoteSessionMock,
      declinePromote: declinePromoteMock,
      renameSession: renameSessionMock,
      toggleSessionMute: vi.fn(),
    });
  useDashboardStore.getState = () => ({
    events,
    sessions,
    mutedSessionIds: [],
    toggleSessionMute: vi.fn(),
  });
  return { useDashboardStore };
});

const PROJECT: Project = makeProject();

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
  parentSessionId: null,
  name: null,
  nameLocked: false,
  command: "claude code",
  cwd: null,
  env: null,
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
  outstandingBackgroundTasks: [],
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

  // P10 — the session row is the single most-used control in the app;
  // before this fix it was a bare <div onClick draggable> with no keyboard
  // support at all. Same role="button"/tabIndex/Enter-Space pattern as
  // UnifiedBoard.tsx's TaskCard and NotificationBell.tsx's EventRow.
  describe("keyboard accessibility (P10)", () => {
    it("is a focusable role=button", () => {
      render(<SessionRow session={SESSION} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />);
      const row = screen.getByRole("button", { name: /claude code/i });
      expect(row).toHaveAttribute("tabIndex", "0");
    });

    it("fires onOpen on Enter when the row itself is focused", async () => {
      const onOpen = vi.fn();
      const user = userEvent.setup();
      render(<SessionRow session={SESSION} project={PROJECT} onOpen={onOpen} onEnd={vi.fn()} />);

      const row = screen.getByRole("button", { name: /claude code/i });
      row.focus();
      await user.keyboard("{Enter}");

      expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it("fires onOpen on Space when the row itself is focused", async () => {
      const onOpen = vi.fn();
      const user = userEvent.setup();
      render(<SessionRow session={SESSION} project={PROJECT} onOpen={onOpen} onEnd={vi.fn()} />);

      const row = screen.getByRole("button", { name: /claude code/i });
      row.focus();
      await user.keyboard(" ");

      expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it("does not double-fire onOpen when a nested kebab-menu button is clicked", async () => {
      const onOpen = vi.fn();
      const user = userEvent.setup();
      render(<SessionRow session={SESSION} project={PROJECT} onOpen={onOpen} onEnd={vi.fn()} />);

      await user.click(screen.getByTitle("More…"));

      expect(onOpen).not.toHaveBeenCalled();
    });

    it("does not fire onOpen when Enter is pressed while a nested button has focus", async () => {
      const onOpen = vi.fn();
      const user = userEvent.setup();
      render(<SessionRow session={SESSION} project={PROJECT} onOpen={onOpen} onEnd={vi.fn()} />);

      screen.getByTitle("More…").focus();
      await user.keyboard("{Enter}");

      expect(onOpen).not.toHaveBeenCalled();
    });
  });

  // Phase 5 (Track B, issue #195 5.5b) — the CSS custom property styles.css
  // reads for hierarchical indent; SessionRow itself doesn't compute a
  // margin, just forwards `depth` as `--session-depth`.
  describe("depth prop (Phase 5, issue #195 5.5b)", () => {
    it("sets no --session-depth style at the default depth (0)", () => {
      const onOpen = vi.fn();
      const onEnd = vi.fn();
      render(<SessionRow session={SESSION} project={PROJECT} onOpen={onOpen} onEnd={onEnd} />);
      const row = screen.getByText("claude code").closest(".session-item") as HTMLElement;
      expect(row.style.getPropertyValue("--session-depth")).toBe("");
    });

    it("sets --session-depth when depth is 1", () => {
      const onOpen = vi.fn();
      const onEnd = vi.fn();
      render(
        <SessionRow session={SESSION} project={PROJECT} onOpen={onOpen} onEnd={onEnd} depth={1} />,
      );
      const row = screen.getByText("claude code").closest(".session-item") as HTMLElement;
      expect(row.style.getPropertyValue("--session-depth")).toBe("1");
    });
  });

  // Phase 5 (Track B, issue #196 5.6) — the mock store's
  // settings.sessions.confirmBeforeKill is false, so with no live children
  // the end-session button fires onEnd on the very first click (this is
  // the pre-existing behavior every other test in this file relies on).
  // With live children present it must always arm first, regardless of
  // that setting, so the detach consequence is visible before it fires.
  describe("cascade-aware end-session confirmation (issue #196 5.6)", () => {
    it("fires onEnd on the first click when there are no live children", async () => {
      const onEnd = vi.fn();
      const user = userEvent.setup();
      render(<SessionRow session={SESSION} project={PROJECT} onOpen={vi.fn()} onEnd={onEnd} />);
      await user.click(screen.getByTitle("End this session (the program will be terminated)"));
      expect(onEnd).toHaveBeenCalledTimes(1);
    });

    it("requires arming (does not fire on the first click) when a live child exists, even with confirmBeforeKill off", async () => {
      sessions = [SESSION, makeSession({ id: 43, parentSessionId: SESSION.id, status: "active" })];
      const onEnd = vi.fn();
      const user = userEvent.setup();
      render(<SessionRow session={SESSION} project={PROJECT} onOpen={vi.fn()} onEnd={onEnd} />);
      const button = screen.getByTitle(
        "End this session — 1 running child session will keep running independently",
      );
      await user.click(button);
      expect(onEnd).not.toHaveBeenCalled();
      await user.click(button);
      expect(onEnd).toHaveBeenCalledTimes(1);
    });

    it("pluralizes the child count in the title", () => {
      sessions = [
        SESSION,
        makeSession({ id: 43, parentSessionId: SESSION.id, status: "active" }),
        makeSession({ id: 44, parentSessionId: SESSION.id, status: "active" }),
      ];
      render(<SessionRow session={SESSION} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />);
      expect(
        screen.getByTitle(
          "End this session — 2 running child sessions will keep running independently",
        ),
      ).toBeTruthy();
    });

    it("ignores a killed child — does not require arming", async () => {
      sessions = [SESSION, makeSession({ id: 43, parentSessionId: SESSION.id, status: "killed" })];
      const onEnd = vi.fn();
      const user = userEvent.setup();
      render(<SessionRow session={SESSION} project={PROJECT} onOpen={vi.fn()} onEnd={onEnd} />);
      await user.click(screen.getByTitle("End this session (the program will be terminated)"));
      expect(onEnd).toHaveBeenCalledTimes(1);
    });
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

  // 3a — SessionRow's own contribution to the fix: forward PromoteDialog's
  // onPromoted callback through unchanged, so the caller (Sidebar.tsx's
  // ProjectSection/VirtualizedProjectTree, which bind it to
  // onSessionEnded+onOpenSession) actually gets told about the replacement
  // session instead of it silently vanishing into the sidebar.
  it("forwards onPromoted from PromoteDialog with the newly-created session", async () => {
    const newSession = makeSession({ id: 999 });
    promoteSessionMock.mockResolvedValueOnce(newSession);
    const onPromoted = vi.fn();
    const user = userEvent.setup();
    render(
      <SessionRow
        session={makeSession({ promoteSuggestedBaseRef: "main" })}
        project={PROJECT}
        onOpen={vi.fn()}
        onEnd={vi.fn()}
        onPromoted={onPromoted}
      />,
    );

    await user.click(screen.getByTitle("More…"));
    await user.click(await screen.findByText("Promote to worktree…"));
    await user.click(await screen.findByText("Create worktree"));

    await vi.waitFor(() => expect(onPromoted).toHaveBeenCalledWith(newSession));
  });
});
