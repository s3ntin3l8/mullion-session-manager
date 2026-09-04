// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PaneTab } from "./PaneTab.js";
import { api } from "./api/index.js";
import type { GitStatus, NotificationEvent, Project, Session } from "./api/index.js";
import type { IDockviewPanel, IDockviewPanelHeaderProps } from "dockview-react";
import type { TerminalPaneParams } from "./TerminalPane.js";

// Issue #212's "View timeline" overflow-menu item (now PaneActionsMenu.tsx,
// rendered as a normal child of PaneTab — see that file's own extraction
// comment) calls openTimelinePanel directly with props.containerApi —
// mocked so this file's own tests never need a real DockviewApi, only
// somewhere to point containerApi at (see makeProps below) and something to
// assert the call landed correctly. openBrowserPanePanel is the same shape
// for "Open Agent Browser", not currently exercised by name here but still
// needed so PaneActionsMenu's import resolves to a callable. panelSessionId
// is real (not a spy) — PaneTab.tsx's own groupHasAttention needs its actual
// narrowing behavior, not a mock.
vi.mock("./panelUtils.js", () => ({
  openTimelinePanel: vi.fn(),
  openBrowserPanePanel: vi.fn(),
  resetTiledGroupWidths: vi.fn(),
  canResetTiledGroupWidths: vi.fn(() => true),
  panelSessionId: (panel: { params?: { sessionId?: unknown } }) => {
    const id = panel.params?.sessionId;
    return typeof id === "number" ? id : undefined;
  },
}));

vi.mock("./api/index.js", () => ({
  api: {
    getProjectGitBranches: vi.fn(),
  },
}));

// PaneTab only reads sessions/projects/gitStatuses/events/lastSeenSeq/
// dismissedEventKeys/renameSession/deleteSession/theme/
// settings.sessions.confirmBeforeKill/markEventSeen off the store — mirrors
// SessionRow.test.tsx's minimal selector-based mock rather than hydrating
// the real store. `useDashboardStore` also needs a `.getState()` — PaneTab's
// mark-seen effect reads/writes through that rather than the reactive
// selector (see its own comment) — backed by the same mutable state so a
// test can call markEventSeen (via the captured onDidActiveChange handler)
// and then assert against updated `lastSeenSeq`.
let session: Session;
// Sibling sessions in the same dockview group (#98 item 1's group-attention
// test) — empty by default; `sessions` below is always `[session,
// ...extraSessions]` so most tests never need to touch this.
let extraSessions: Session[];
let projects: Project[];
let gitStatuses: Record<number, GitStatus | null>;
let sessionGitStatuses: Record<number, GitStatus | null>;
let events: Record<number, NotificationEvent[]>;
let lastSeenSeq: Record<number, number>;
let dismissedEventKeys: Record<string, true>;
// #719 — per-session mute set. Mutable so the mute test can flip it without
// re-mocking the store; defaults empty (unmuted) like the real store init.
let mutedSessionIds: number[] = [];
const markEventSeen = vi.fn((sessionId: number, seq: number) => {
  const current = lastSeenSeq[sessionId] ?? 0;
  if (seq > current) lastSeenSeq = { ...lastSeenSeq, [sessionId]: seq };
});
// Issue: narrow headers overflow — PaneActionsMenu.tsx's own "Split right"/
// "Split down" items (a fallback for PaneHeaderActions.tsx's header-level
// buttons, which hide entirely below a certain group width) read this.
const requestSplit = vi.fn();

function storeState() {
  return {
    sessions: [session, ...extraSessions],
    projects,
    gitStatuses,
    sessionGitStatuses,
    events,
    lastSeenSeq,
    dismissedEventKeys,
    mutedSessionIds,
    renameSession: vi.fn(),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    theme: "dark",
    settings: {
      sessions: { confirmBeforeKill: false },
      layoutMode: "desktop",
      tabletPaneCap: 2,
    },
    markEventSeen,
    requestSplit,
  };
}

// eventKey (real implementation, not a mock) — PaneTab.tsx imports this as a
// plain named export alongside useDashboardStore, so the mock module below
// must still provide it.
function eventKey(sessionId: number, seq: number): string {
  return `${sessionId}:${seq}`;
}

vi.mock("./store/index.js", () => {
  const useDashboardStore = (selector: (s: unknown) => unknown) => selector(storeState());
  useDashboardStore.getState = () => storeState();
  return { useDashboardStore, eventKey };
});

// Captures the handler passed to props.api.onDidActiveChange so a test can
// simulate dockview firing it (the "tab became active" transition PaneTab
// clears its badge on).
let activeChangeHandler: ((e: { isActive: boolean }) => void) | null;

function makeProps(
  overrides: { isActive?: boolean; groupPanels?: Partial<IDockviewPanel>[] } = {},
): IDockviewPanelHeaderProps<TerminalPaneParams> {
  activeChangeHandler = null;
  return {
    api: {
      // Split (PaneActionsMenu.tsx's "Split right"/"Split down" items)
      // passes this straight through to requestSplit as the reference
      // panel — a real value here (not left undefined) is what lets those
      // tests actually prove it's THIS tab's own id being forwarded.
      id: `session-${session.id}`,
      title: "claude code",
      setTitle: vi.fn(),
      close: vi.fn(),
      isActive: overrides.isActive ?? false,
      onDidActiveChange: vi.fn((cb: (e: { isActive: boolean }) => void) => {
        activeChangeHandler = cb;
        return { dispose: vi.fn() };
      }),
      group: { panels: overrides.groupPanels ?? [] },
    },
    // A stable marker object, not a real DockviewApi — the "View timeline"
    // test below only asserts this exact reference was forwarded to
    // openTimelinePanel, never calls anything on it.
    containerApi: { __marker: "containerApi" },
    params: { sessionId: session.id },
  } as unknown as IDockviewPanelHeaderProps<TerminalPaneParams>;
}

const BASE_SESSION: Session = {
  id: 1,
  projectId: 1,
  parentSessionId: null,
  name: "claude code",
  nameLocked: true,
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
  activity: "idle",
  lastActivityAt: Date.now(),
  attention: false,
  attentionAt: null,
  lastTitle: null,
  gateState: "idle",
  gates: [],
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
  // `activity: "idle"`/`attention: false` defaults above. PaneTab.tsx's
  // status badge/dot and its group-attention/just-fired-burst tracking now
  // read sessionStatus/sessionStatusAttentionRequired directly, not the raw
  // attention/activity fields above — tests exercising those override these
  // too (see the group-attention and "just fired" describe blocks below).
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
  sessionStatus: "idle",
  sessionStatusSeverity: "dormant",
  sessionStatusDetail: null,
  hookEmits: [],
  pendingDevServerPort: null,
  outstandingBackgroundTasks: [],
  sessionStatusAttentionRequired: false,
};

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    seq: 1,
    sessionId: session.id,
    kind: "attention",
    ts: 1000,
    payload: { attention: true },
    ...overrides,
  };
}

// jsdom's ResizeObserver doesn't exist; PaneTab only needs observe/disconnect
// to not throw — the mount-time callback-ref measurement (not this observer)
// is what these tests exercise.
beforeEach(() => {
  session = { ...BASE_SESSION };
  extraSessions = [];
  projects = [];
  gitStatuses = {};
  sessionGitStatuses = {};
  events = {};
  lastSeenSeq = {};
  dismissedEventKeys = {};
  mutedSessionIds = [];
  markEventSeen.mockClear();
  requestSplit.mockClear();
  vi.stubGlobal(
    "ResizeObserver",
    vi.fn(function () {
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    }),
  );
  vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 250,
  } as DOMRect);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Phase 5 (Track B, issue #196 5.6) — same cascade-aware confirmation as
// Sidebar.tsx's SessionRow ConfirmButton, via the overflow menu's own
// arm-then-click-again kill item instead.
describe("kill session cascade confirmation (issue #196 5.6)", () => {
  async function openOverflowMenu(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByTitle("More…"));
  }

  it("kills immediately on first click with no live children (confirmBeforeKill off)", async () => {
    const user = userEvent.setup();
    const props = makeProps();
    render(<PaneTab {...props} />);
    await openOverflowMenu(user);
    await user.click(screen.getByText("Kill session"));
    expect(props.api.close).toHaveBeenCalledTimes(1);
  });

  it("requires arming (does not close on the first click) with a live child, even with confirmBeforeKill off", async () => {
    extraSessions = [{ ...BASE_SESSION, id: 2, parentSessionId: session.id, status: "active" }];
    const user = userEvent.setup();
    const props = makeProps();
    render(<PaneTab {...props} />);
    await openOverflowMenu(user);
    const killItem = screen.getByText("Kill session (1 child will detach)");
    await user.click(killItem);
    expect(props.api.close).not.toHaveBeenCalled();
    expect(screen.getByText("Click again to kill")).toBeInTheDocument();
    await user.click(screen.getByText("Click again to kill"));
    expect(props.api.close).toHaveBeenCalledTimes(1);
  });

  it("pluralizes and ignores a killed child in the count", async () => {
    extraSessions = [
      { ...BASE_SESSION, id: 2, parentSessionId: session.id, status: "active" },
      { ...BASE_SESSION, id: 3, parentSessionId: session.id, status: "active" },
      { ...BASE_SESSION, id: 4, parentSessionId: session.id, status: "killed" },
    ];
    const user = userEvent.setup();
    render(<PaneTab {...makeProps()} />);
    await openOverflowMenu(user);
    expect(screen.getByText("Kill session (2 children will detach)")).toBeInTheDocument();
  });
});

describe("PaneTab", () => {
  it("shows the status badge when the tab mounts at or above the narrow threshold", () => {
    render(<PaneTab {...makeProps()} />);

    expect(screen.getByText("Idle")).toBeInTheDocument();
  });

  it("hides the status badge when the tab mounts already narrower than the threshold", () => {
    // Regression check for the callback-ref fix: without it, `narrow` starts
    // false and the badge would render for one frame before the
    // ResizeObserver (which never fires in this test) corrected it.
    vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 100,
    } as DOMRect);

    render(<PaneTab {...makeProps()} />);

    expect(screen.queryByText("Idle")).not.toBeInTheDocument();
  });

  it("still shows the status dot when narrow, just not the badge", () => {
    vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 100,
    } as DOMRect);

    const { container } = render(<PaneTab {...makeProps()} />);

    expect(screen.queryByText("Idle")).not.toBeInTheDocument();
    expect(container.querySelector(".pane-tab-dot-idle")).toBeInTheDocument();
  });

  describe("branch sub-label (issue #96)", () => {
    beforeEach(() => {
      projects = [
        {
          id: session.projectId,
          name: "mullion",
          cwd: "/home/x/mullion",
          hostId: "local",
          devServerUrl: null,
          detectedDevServerPort: null,
          currentBranch: "main",
          autoFetch: null,
          ruleFiles: [],
          defaultAgent: null,
          defaultReviewAgent: null,
          mergeOnApprove: null,
          autoApprove: null,
          maxAutoReturnRounds: null,
          conventionalCommitTitles: null,
          autoTagRelease: null,
          injectAgentGuide: null,
          injectProjectBriefing: null,
          injectWorkflowConventions: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ];
    });

    it("shows the project's current branch", () => {
      render(<PaneTab {...makeProps()} />);
      expect(screen.getByText("main")).toBeInTheDocument();
    });

    it("appends a dirty marker when the project's git status is unclean", () => {
      gitStatuses = {
        [session.projectId]: {
          branch: "main",
          hash: "abc1234",
          ahead: 0,
          behind: 0,
          files: [{ path: "a.ts", status: "M" }],
          isClean: false,
          hasConflicts: false,
        },
      };
      render(<PaneTab {...makeProps()} />);
      expect(screen.getByText("main *")).toBeInTheDocument();
    });

    it("renders nothing when the project has no known branch", () => {
      projects = [{ ...projects[0], currentBranch: null }];
      const { container } = render(<PaneTab {...makeProps()} />);
      expect(container.querySelector(".pane-tab-branch")).not.toBeInTheDocument();
    });

    it("hides the branch label when narrow, same as the status badge", () => {
      vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockReturnValue({
        width: 100,
      } as DOMRect);
      const { container } = render(<PaneTab {...makeProps()} />);
      expect(container.querySelector(".pane-tab-branch")).not.toBeInTheDocument();
    });

    describe("worktree branch precedence", () => {
      beforeEach(() => {
        session.liveBranch = "main";
        session.liveCwd = "/home/x/mullion/.worktrees/feat/x";
        sessionGitStatuses = {
          [session.id]: {
            branch: "feature/x",
            hash: "def5678",
            ahead: 0,
            behind: 0,
            files: [],
            isClean: true,
            hasConflicts: false,
          },
        };
      });

      it("prefers sessionGitStatus over liveBranch when session is in a worktree", () => {
        render(<PaneTab {...makeProps()} />);
        expect(screen.getByText("feature/x")).toBeInTheDocument();
        expect(screen.queryByText("main")).not.toBeInTheDocument();
      });

      it("prefers liveBranch over sessionGitStatus when session is NOT in a worktree", () => {
        session.liveCwd = null;
        render(<PaneTab {...makeProps()} />);
        expect(screen.getByText("main")).toBeInTheDocument();
        expect(screen.queryByText("feature/x")).not.toBeInTheDocument();
      });

      it("falls back to liveBranch when in a worktree but sessionGitStatus is null", () => {
        sessionGitStatuses = {};
        render(<PaneTab {...makeProps()} />);
        expect(screen.getByText("main")).toBeInTheDocument();
      });

      it("falls back to project.currentBranch when both liveBranch and sessionGitStatus are missing in a worktree", () => {
        session.liveBranch = null;
        sessionGitStatuses = {};
        render(<PaneTab {...makeProps()} />);
        expect(screen.getByText("main")).toBeInTheDocument();
      });
    });
  });

  describe("unread badge (issue #168)", () => {
    it("shows no badge when there are no buffered events", () => {
      const { container } = render(<PaneTab {...makeProps()} />);
      expect(container.querySelector(".pane-tab-unread-badge")).not.toBeInTheDocument();
    });

    it("counts only notification-worthy events, not routine title/status-change ones", () => {
      events = {
        [session.id]: [
          makeEvent({ seq: 1, kind: "attention", payload: { attention: true } }),
          // Routine, high-frequency kinds — must not inflate the count.
          makeEvent({ seq: 2, kind: "title_change", payload: { title: "zsh" } }),
          makeEvent({ seq: 3, kind: "status_change", payload: { screen: "alt" } }),
          makeEvent({ seq: 4, kind: "status_change", payload: { reason: "exited" } }),
        ],
      };
      render(<PaneTab {...makeProps()} />);
      // 2 notify-worthy: the attention event and the "exited" status_change.
      expect(screen.getByText("2")).toBeInTheDocument();
    });

    it("shows the bell icon when any unread event is an attention signal", () => {
      events = {
        [session.id]: [makeEvent({ seq: 1, kind: "attention", payload: { attention: true } })],
      };
      const { container } = render(<PaneTab {...makeProps()} />);
      const badge = container.querySelector(".pane-tab-unread-badge");
      expect(badge).toHaveClass("attention");
    });

    it("shows no unread badge for a muted session (#719)", () => {
      // Same single attention event that produces a badge above — muting the
      // session must suppress the tab's unread badge entirely (the events
      // still exist; only the disturbance is silenced).
      mutedSessionIds = [session.id];
      events = {
        [session.id]: [makeEvent({ seq: 1, kind: "attention", payload: { attention: true } })],
      };
      const { container } = render(<PaneTab {...makeProps()} />);
      expect(container.querySelector(".pane-tab-unread-badge")).not.toBeInTheDocument();
    });

    it("shows the check icon when the only unread event is an exit", () => {
      events = {
        [session.id]: [makeEvent({ seq: 1, kind: "status_change", payload: { reason: "exited" } })],
      };
      const { container } = render(<PaneTab {...makeProps()} />);
      const badge = container.querySelector(".pane-tab-unread-badge");
      expect(badge).toHaveClass("exited");
      expect(badge).not.toHaveClass("attention");
    });

    it("excludes events at or below the already-seen cursor", () => {
      events = {
        [session.id]: [
          makeEvent({ seq: 1, kind: "attention", payload: { attention: true } }),
          makeEvent({ seq: 2, kind: "attention", payload: { attention: true } }),
        ],
      };
      lastSeenSeq = { [session.id]: 1 };
      render(<PaneTab {...makeProps()} />);
      expect(screen.getByText("1")).toBeInTheDocument();
    });

    it("excludes events dismissed from the notification panel (issue #169) even if still unread", () => {
      events = {
        [session.id]: [
          makeEvent({ seq: 1, kind: "attention", payload: { attention: true } }),
          makeEvent({ seq: 2, kind: "attention", payload: { attention: true } }),
        ],
      };
      dismissedEventKeys = { [`${session.id}:1`]: true };
      render(<PaneTab {...makeProps()} />);
      // Only seq 2 counts — seq 1 was dismissed, not marked read, so it must
      // not inflate the badge even though its own seq is still > lastSeenSeq.
      expect(screen.getByText("1")).toBeInTheDocument();
    });

    it("marks events seen (clearing the badge) once the tab becomes active", () => {
      events = {
        [session.id]: [makeEvent({ seq: 1 }), makeEvent({ seq: 5 })],
      };
      const { container, rerender } = render(<PaneTab {...makeProps({ isActive: false })} />);
      expect(container.querySelector(".pane-tab-unread-badge")).toBeInTheDocument();
      expect(markEventSeen).not.toHaveBeenCalled();

      // Simulate dockview firing the active-change event. Wrapped in act()
      // since the handler now only calls setIsActive (a state update, not a
      // direct side effect) — the actual markEventSeen call happens in a
      // follow-up effect that needs a flushed render to run.
      act(() => activeChangeHandler?.({ isActive: true }));
      expect(markEventSeen).toHaveBeenCalledWith(session.id, 5);

      // Re-render with the store's lastSeenSeq now reflecting that call
      // (the mock's markEventSeen updates the shared `lastSeenSeq`, same as
      // the real store action would) — the badge should be gone.
      rerender(<PaneTab {...makeProps({ isActive: true })} />);
      expect(container.querySelector(".pane-tab-unread-badge")).not.toBeInTheDocument();
    });

    it("marks events seen immediately when the tab is already active on mount", () => {
      events = {
        [session.id]: [makeEvent({ seq: 3 })],
      };
      render(<PaneTab {...makeProps({ isActive: true })} />);
      expect(markEventSeen).toHaveBeenCalledWith(session.id, 3);
    });

    it("marks a new event seen immediately if it arrives while the tab is already active — doesn't wait for a re-focus", () => {
      events = { [session.id]: [makeEvent({ seq: 1 })] };
      const { container, rerender } = render(<PaneTab {...makeProps({ isActive: true })} />);
      expect(markEventSeen).toHaveBeenCalledWith(session.id, 1);
      // The mock's markEventSeen already updated the shared `lastSeenSeq`
      // (same as the real store action would) — re-rendering off that,
      // same two-step pattern as the "becomes active" test above, confirms
      // the badge reflects it.
      rerender(<PaneTab {...makeProps({ isActive: true })} />);
      expect(container.querySelector(".pane-tab-unread-badge")).not.toBeInTheDocument();

      // A second event arrives while this tab is still the active one —
      // simulated by a re-render with a new `events` value, same as a real
      // store update from the /ws/events stream would trigger.
      events = { [session.id]: [makeEvent({ seq: 1 }), makeEvent({ seq: 2 })] };
      rerender(<PaneTab {...makeProps({ isActive: true })} />);
      expect(markEventSeen).toHaveBeenCalledWith(session.id, 2);
      rerender(<PaneTab {...makeProps({ isActive: true })} />);
      expect(container.querySelector(".pane-tab-unread-badge")).not.toBeInTheDocument();
    });
  });

  describe("narrow headers overflow — tight mode", () => {
    it("still shows the agent logo and full unread badge above the tight threshold", () => {
      // 170px is below NARROW_TAB_BADGE_THRESHOLD_PX (190, hides branch/
      // status badge) but above TIGHT_TAB_THRESHOLD_PX (150) — only the
      // narrow-mode drops should have kicked in yet.
      vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockReturnValue({
        width: 170,
      } as DOMRect);
      events = {
        [session.id]: [makeEvent({ seq: 1, kind: "attention", payload: { attention: true } })],
      };

      const { container } = render(<PaneTab {...makeProps()} />);

      expect(container.querySelector(".pane-tab-agent-logo")).toBeInTheDocument();
      const badge = container.querySelector(".pane-tab-unread-badge");
      expect(badge).not.toHaveClass("compact");
      expect(screen.getByText("1")).toBeInTheDocument();
    });

    it("drops the agent logo and collapses the unread badge to a bare dot below the tight threshold", () => {
      vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockReturnValue({
        width: 120,
      } as DOMRect);
      events = {
        [session.id]: [makeEvent({ seq: 1, kind: "attention", payload: { attention: true } })],
      };

      const { container } = render(<PaneTab {...makeProps()} />);

      expect(container.querySelector(".pane-tab-agent-logo")).not.toBeInTheDocument();
      const badge = container.querySelector(".pane-tab-unread-badge");
      expect(badge).toHaveClass("compact");
      // The count digit is dropped — the icon's title attribute still
      // carries the actual count for anyone who hovers.
      expect(screen.queryByText("1")).not.toBeInTheDocument();
      expect(badge).toHaveAttribute("title", expect.stringContaining("1 unread"));
    });

    it("reacts to a live resize crossing the tight threshold, same as the narrow one already does", () => {
      let resizeCallback: ResizeObserverCallback = () => {};
      vi.stubGlobal(
        "ResizeObserver",
        vi.fn(function (this: unknown, callback: ResizeObserverCallback) {
          resizeCallback = callback;
          return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
        }),
      );

      const { container } = render(<PaneTab {...makeProps()} />);
      expect(container.querySelector(".pane-tab-agent-logo")).toBeInTheDocument();

      act(() => {
        resizeCallback(
          [{ contentRect: { width: 120 } } as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      });

      expect(container.querySelector(".pane-tab-agent-logo")).not.toBeInTheDocument();
    });
  });

  describe("tab-group attention accent (#98 item 1)", () => {
    it("adds the group-attention class when a sibling panel's session has attention", () => {
      const sibling: Session = {
        ...BASE_SESSION,
        id: 2,
        attention: true,
        sessionStatus: "needs_input",
        sessionStatusSeverity: "waiting",
        sessionStatusAttentionRequired: true,
      };
      extraSessions = [sibling];
      const props = makeProps({
        groupPanels: [
          { params: { sessionId: session.id } } as unknown as IDockviewPanel,
          { params: { sessionId: sibling.id } } as unknown as IDockviewPanel,
        ],
      });
      const { container } = render(<PaneTab {...props} />);
      expect(container.querySelector(".pane-tab-group-attention")).toBeInTheDocument();
    });

    it("does not add the class when no panel in the group has attention", () => {
      const sibling: Session = { ...BASE_SESSION, id: 2, attention: false };
      extraSessions = [sibling];
      const { container } = render(
        <PaneTab
          {...makeProps({
            groupPanels: [
              { params: { sessionId: session.id } } as unknown as IDockviewPanel,
              { params: { sessionId: sibling.id } } as unknown as IDockviewPanel,
            ],
          })}
        />,
      );
      expect(container.querySelector(".pane-tab-group-attention")).not.toBeInTheDocument();
    });

    it("skips group panels with no sessionId (non-terminal panels) without erroring", () => {
      expect(() =>
        render(
          <PaneTab
            {...makeProps({
              groupPanels: [
                { params: {} } as unknown as IDockviewPanel,
                { params: undefined } as unknown as IDockviewPanel,
              ],
            })}
          />,
        ),
      ).not.toThrow();
    });
  });

  describe('"just fired" burst (#98 item 6)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("does not play the burst for a session already in attention on mount", () => {
      session.attention = true;
      session.sessionStatus = "needs_input";
      session.sessionStatusSeverity = "waiting";
      session.sessionStatusAttentionRequired = true;
      const { container } = render(<PaneTab {...makeProps()} />);
      expect(container.querySelector(".attention-just-fired")).not.toBeInTheDocument();
      // The steady-state ring is still there — only the one-shot burst is
      // gated on an observed transition.
      expect(container.querySelector(".attention-ring")).toBeInTheDocument();
    });

    it("plays the burst on a false->true transition, then settles back to steady state", () => {
      vi.useFakeTimers();
      const { container, rerender } = render(<PaneTab {...makeProps()} />);
      expect(container.querySelector(".attention-just-fired")).not.toBeInTheDocument();

      session = {
        ...session,
        attention: true,
        sessionStatus: "needs_input",
        sessionStatusSeverity: "waiting",
        sessionStatusAttentionRequired: true,
      };
      rerender(<PaneTab {...makeProps()} />);
      expect(container.querySelector(".attention-just-fired")).toBeInTheDocument();

      vi.advanceTimersByTime(1800);
      rerender(<PaneTab {...makeProps()} />);
      expect(container.querySelector(".attention-just-fired")).not.toBeInTheDocument();
      // Still flagged as attention throughout — only the extra burst class
      // is timed out, not the underlying state.
      expect(container.querySelector(".attention-ring")).toBeInTheDocument();
    });
  });

  describe("View timeline (issue #212)", () => {
    it("opens the overflow menu and calls openTimelinePanel with containerApi and this session", async () => {
      const { openTimelinePanel } = await import("./panelUtils.js");
      const props = makeProps();
      render(<PaneTab {...props} />);

      await userEvent.click(screen.getByTitle("More…"));
      await userEvent.click(screen.getByText("View timeline"));

      expect(openTimelinePanel).toHaveBeenCalledWith(props.containerApi, session, {
        tier: "desktop",
        tabletPaneCap: 2,
      });
    });
  });

  describe("Split right/down from the overflow menu (issue: narrow headers overflow)", () => {
    // Fallback for PaneHeaderActions.tsx's own split buttons, which hide
    // entirely below a certain group width — this menu item is what keeps
    // split reachable from a pane that's narrow enough to need it.
    it("calls requestSplit with this tab's own api.id and 'right'", async () => {
      const props = makeProps();
      render(<PaneTab {...props} />);

      await userEvent.click(screen.getByTitle("More…"));
      await userEvent.click(screen.getByText("Split right"));

      expect(requestSplit).toHaveBeenCalledWith(props.api.id, "right");
    });

    it("calls requestSplit with this tab's own api.id and 'below'", async () => {
      const props = makeProps();
      render(<PaneTab {...props} />);

      await userEvent.click(screen.getByTitle("More…"));
      await userEvent.click(screen.getByText("Split down"));

      expect(requestSplit).toHaveBeenCalledWith(props.api.id, "below");
    });
  });

  describe("Promote to worktree (issue #271, option 2)", () => {
    it("opens the overflow menu and shows the PromoteDialog", async () => {
      projects = [
        {
          id: session.projectId,
          name: "mullion",
          cwd: "/home/x/mullion",
          hostId: "local",
          devServerUrl: null,
          detectedDevServerPort: null,
          currentBranch: "main",
          autoFetch: null,
          ruleFiles: [],
          defaultAgent: null,
          defaultReviewAgent: null,
          mergeOnApprove: null,
          autoApprove: null,
          maxAutoReturnRounds: null,
          conventionalCommitTitles: null,
          autoTagRelease: null,
          injectAgentGuide: null,
          injectProjectBriefing: null,
          injectWorkflowConventions: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ];
      // Prevent real HTTP call in PromoteDialog's useEffect
      vi.mocked(api.getProjectGitBranches).mockResolvedValue({
        branches: [{ name: "main", isCurrent: true }],
        remoteBranches: [],
        worktrees: [],
      });
      const props = makeProps();
      render(<PaneTab {...props} />);

      await userEvent.click(screen.getByTitle("More…"));
      await userEvent.click(screen.getByText("Promote to worktree…"));

      expect(screen.getByText("Base ref")).toBeInTheDocument();
      expect(screen.getByText("Create worktree")).toBeInTheDocument();
    });
  });

  describe("bidirectional rename sync", () => {
    it("syncs the dockview tab title when the store session name changes", () => {
      session = { ...BASE_SESSION, name: "Renamed from Sidebar", nameLocked: true };
      const props = makeProps();
      render(<PaneTab {...props} />);

      expect(props.api.setTitle).toHaveBeenCalledWith("Renamed from Sidebar");
    });

    it("does not call setTitle when the titles already match", () => {
      session = { ...BASE_SESSION }; // name: "claude code" matches makeProps default
      const props = makeProps();
      render(<PaneTab {...props} />);

      expect(props.api.setTitle).not.toHaveBeenCalled();
    });
  });
});

// P11 — the overflow menu previously had no focus management at all and
// only `mousedown` outside-click could close it (a keyboard user who
// tabbed into it had no way to close it). Uses the shared useFocusTrap.ts
// hook, plus a menu-scoped Escape handler and role="menu"/role="menuitem".
describe("PaneTab overflow menu — focus management (P11)", () => {
  function openMenu() {
    const props = makeProps();
    render(<PaneTab {...props} />);
    return { toggle: screen.getByTitle("More…"), props };
  }

  it("is a role=menu with role=menuitem children, no aria-modal (no backdrop, same rule as UnifiedBoard's drawer)", async () => {
    const { toggle } = openMenu();
    await userEvent.click(toggle);

    const menu = screen.getByRole("menu");
    expect(menu).not.toHaveAttribute("aria-modal");
    expect(screen.getAllByRole("menuitem").length).toBeGreaterThan(0);
  });

  it("moves focus into the menu (onto the first item) when it opens", async () => {
    const { toggle } = openMenu();
    await userEvent.click(toggle);

    expect(screen.getByText("Rename").closest("button")).toHaveFocus();
  });

  it("restores focus to the toggle button when closed via outside click", async () => {
    const { toggle } = openMenu();
    await userEvent.click(toggle);
    expect(screen.getByText("Rename").closest("button")).toHaveFocus();

    // mousedown outside the menu and the toggle button both close it.
    await userEvent.click(document.body);

    expect(toggle).toHaveFocus();
  });

  it("closes on Escape, unlike before this fix (previously only mousedown outside-click worked)", async () => {
    const { toggle } = openMenu();
    await userEvent.click(toggle);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
  });

  it("traps Tab within the menu", async () => {
    const { toggle } = openMenu();
    await userEvent.click(toggle);

    const menu = screen.getByRole("menu");
    const items = Array.from(menu.querySelectorAll<HTMLElement>("button:not([disabled])"));
    const first = items[0]!;
    const last = items[items.length - 1]!;

    last.focus();
    await userEvent.tab();
    expect(first).toHaveFocus();

    first.focus();
    await userEvent.tab({ shift: true });
    expect(last).toHaveFocus();
  });

  // Hermes review (PR #592): role="menu" implies APG arrow-key navigation
  // among role="menuitem" children, on top of (not instead of) the Tab
  // trap above. The disabled "Move (drag tab)" item must be skipped, same
  // as it already is from the Tab order.
  it("moves focus among menu items with ArrowDown/ArrowUp, skipping the disabled item, and wraps at both ends", async () => {
    const { toggle } = openMenu();
    await userEvent.click(toggle);

    const menu = screen.getByRole("menu");
    const items = Array.from(
      menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'),
    );
    const rename = screen.getByText("Rename").closest("button")!;
    const killItem = items[items.length - 1]!;
    expect(rename).toHaveFocus();

    // Issue: narrow headers overflow — "Split right"/"Split down" now sit
    // between Rename and Move/View timeline (PaneActionsMenu.tsx), so
    // that's the next item ArrowDown reaches from Rename.
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByText("Split right").closest("button")).toHaveFocus();

    await userEvent.keyboard("{ArrowUp}");
    expect(rename).toHaveFocus();

    // Wraps backward past the first item to the last (non-disabled) one.
    await userEvent.keyboard("{ArrowUp}");
    expect(killItem).toHaveFocus();

    // Wraps forward past the last item back to the first.
    await userEvent.keyboard("{ArrowDown}");
    expect(rename).toHaveFocus();
  });

  it("moves focus to the first/last menu item with Home/End", async () => {
    const { toggle } = openMenu();
    await userEvent.click(toggle);

    const menu = screen.getByRole("menu");
    const items = Array.from(
      menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'),
    );
    const rename = items[0]!;
    const killItem = items[items.length - 1]!;

    await userEvent.keyboard("{End}");
    expect(killItem).toHaveFocus();

    await userEvent.keyboard("{Home}");
    expect(rename).toHaveFocus();
  });

  it("does not restore focus to the toggle button when closing by opening the timeline panel", async () => {
    const { toggle } = openMenu();
    await userEvent.click(toggle);

    await userEvent.click(screen.getByText("View timeline"));

    expect(toggle).not.toHaveFocus();
  });

  it("does not restore focus to the toggle button when the kill click closes the pane", async () => {
    const { toggle, props } = openMenu();
    await userEvent.click(toggle);

    await userEvent.click(screen.getByText("Kill session"));

    expect(props.api.close).toHaveBeenCalled();
    expect(toggle).not.toHaveFocus();
  });

  // Pins the trade-off documented alongside the outside-click handler's
  // `e.preventDefault()` (added to fix a focus-restore race — see that
  // handler's own comment in PaneTab.tsx): preventing mousedown's default
  // action only suppresses the browser's own focus-shift-on-mousedown, not
  // the click event itself, so a real interactive element sitting outside
  // the menu (here, the tab's own "Close pane" button, a sibling in the tab
  // bar, not the overflow menu) must still fire its own click handler
  // normally when clicked while the menu happens to be open.
  it("still fires a real button's own click handler when it closes the menu as an outside click", async () => {
    const { toggle, props } = openMenu();
    await userEvent.click(toggle);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await userEvent.click(
      screen.getByTitle("Close pane — detaches your view, session keeps running"),
    );

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(props.api.close).toHaveBeenCalled();
  });
});
