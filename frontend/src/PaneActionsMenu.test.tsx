// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PaneActionsMenu } from "./PaneActionsMenu.js";
import { api } from "./api/index.js";
import type { DockviewApi, DockviewPanelApi } from "dockview";
import type { Session, Project } from "./api/index.js";
import type { TerminalPaneParams } from "./TerminalPane.js";

// Code review finding on PR #613 — PaneActionsMenu is now a standalone
// component (api/params/containerApi/onRename/triggerClassName, not
// IDockviewPanelHeaderProps) reused by both PaneTab.tsx's desktop tab strip
// and App.tsx's mobile pane bar. PaneTab.test.tsx already exercises its
// full behavior (kill-arm, focus management, promote, timeline) through
// PaneTab — this file covers it as the standalone contract both callers
// actually depend on: the trigger's own accessibility attributes, the
// `onRename` callback wiring (PaneTab and the mobile bar each own a
// different rename UI — see PaneActionsMenu.tsx's own comment on why), and
// the non-terminal-panel (`params: undefined`) case the mobile bar hits for
// every non-session panel in `dockviewApi.panels`.
const resetTiledGroupWidths = vi.fn();
// Untyped (no inline implementation, unlike a `vi.fn(() => true)` initial
// value would give it) so the `(...args) => fn(...args)` spread wrapper
// below type-checks the same way resetTiledGroupWidths's own does — an
// initial implementation narrows vi.fn's inferred signature to that
// implementation's own arity, which a spread call can't satisfy. Defaults
// to eligible via beforeEach's own `.mockReturnValue(true)` below, so the
// existing click-through tests don't each have to opt back in — the
// dedicated "disabled" describe block overrides it per-test.
const canResetTiledGroupWidths = vi.fn();

vi.mock("./panelUtils.js", () => ({
  openTimelinePanel: vi.fn(),
  openBrowserPanePanel: vi.fn(),
  openOrFocusSessionPanel: vi.fn(),
  resetTiledGroupWidths: (...args: unknown[]) => resetTiledGroupWidths(...args),
  canResetTiledGroupWidths: (...args: unknown[]) => canResetTiledGroupWidths(...args),
}));

vi.mock("./api/index.js", () => ({
  api: {
    getProjectGitBranches: vi.fn(),
  },
}));

let session: Session;
let projects: Project[];
let promoteSessionMock: ReturnType<typeof vi.fn>;
// Issue: narrow headers overflow — "Split right"/"Split down" (a fallback
// for PaneHeaderActions.tsx's own header-level buttons, which hide entirely
// below a certain group width) read this off the store.
const requestSplit = vi.fn();
// #719 — per-session mute. Mocked so the mute-item test can assert on the
// toggle call; `mutedSessionIds` is mutable so the label reflects mute state.
const toggleSessionMute = vi.fn();
let mutedSessionIds: number[] = [];

function storeState() {
  return {
    sessions: [session],
    projects,
    deleteSession: vi.fn().mockResolvedValue(undefined),
    theme: "dark",
    settings: {
      sessions: { confirmBeforeKill: false },
      layoutMode: "desktop",
      tabletPaneCap: 2,
    },
    promoteSession: promoteSessionMock,
    declinePromote: vi.fn().mockResolvedValue(undefined),
    requestSplit,
    mutedSessionIds,
    toggleSessionMute,
  };
}

vi.mock("./store/index.js", () => {
  const useDashboardStore = (selector: (s: unknown) => unknown) => selector(storeState());
  useDashboardStore.getState = () => storeState();
  return { useDashboardStore };
});

const BASE_SESSION: Session = {
  id: 1,
  projectId: 1,
  parentSessionId: null,
  name: "claude code",
  nameLocked: true,
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
  activity: "idle",
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

function makeApi(overrides: Partial<DockviewPanelApi> = {}): DockviewPanelApi {
  return {
    id: "session-1",
    title: "claude code",
    close: vi.fn(),
    ...overrides,
  } as unknown as DockviewPanelApi;
}

const CONTAINER_API = { __marker: "containerApi" } as unknown as DockviewApi;

beforeEach(() => {
  session = { ...BASE_SESSION };
  projects = [];
  promoteSessionMock = vi.fn();
  requestSplit.mockClear();
  toggleSessionMute.mockClear();
  mutedSessionIds = [];
  canResetTiledGroupWidths.mockClear();
  canResetTiledGroupWidths.mockReturnValue(true);
});

describe("PaneActionsMenu", () => {
  it("renders the trigger with the caller's own className and accessible attributes", () => {
    render(
      <PaneActionsMenu
        api={makeApi()}
        params={{ sessionId: session.id }}
        containerApi={CONTAINER_API}
        onRename={vi.fn()}
        triggerClassName="mobile-tab-btn"
      />,
    );

    const trigger = screen.getByTitle("More…");
    expect(trigger).toHaveClass("mobile-tab-btn");
    expect(trigger).toHaveAttribute("aria-label", "More actions");
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("opens the menu on click and flips aria-expanded", async () => {
    const user = userEvent.setup();
    render(
      <PaneActionsMenu
        api={makeApi()}
        params={{ sessionId: session.id }}
        containerApi={CONTAINER_API}
        onRename={vi.fn()}
        triggerClassName="pane-tab-btn"
      />,
    );

    const trigger = screen.getByTitle("More…");
    await user.click(trigger);

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("invokes the onRename callback (not an internal rename UI) and closes the menu", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    render(
      <PaneActionsMenu
        api={makeApi()}
        params={{ sessionId: session.id }}
        containerApi={CONTAINER_API}
        onRename={onRename}
        triggerClassName="pane-tab-btn"
      />,
    );

    await user.click(screen.getByTitle("More…"));
    await user.click(screen.getByText("Rename"));

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes the pane via the passed-in api.close(), not a resolved panel handle", async () => {
    const user = userEvent.setup();
    const closeSpy = vi.fn();
    render(
      <PaneActionsMenu
        api={makeApi({ close: closeSpy })}
        params={{ sessionId: session.id }}
        containerApi={CONTAINER_API}
        onRename={vi.fn()}
        triggerClassName="pane-tab-btn"
      />,
    );

    await user.click(screen.getByTitle("More…"));
    await user.click(screen.getByText("Kill session"));

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  // Issue: narrow headers overflow — fallback for PaneHeaderActions.tsx's
  // own split-right/split-down buttons, which hide entirely below a certain
  // group width; this menu item is what keeps split reachable from a pane
  // that's narrow enough to need it.
  describe("Split right/down", () => {
    it("calls requestSplit with the passed-in api.id and 'right', closing the menu", async () => {
      const user = userEvent.setup();
      render(
        <PaneActionsMenu
          api={makeApi({ id: "session-42" })}
          params={{ sessionId: session.id }}
          containerApi={CONTAINER_API}
          onRename={vi.fn()}
          triggerClassName="pane-tab-btn"
        />,
      );

      await user.click(screen.getByTitle("More…"));
      await user.click(screen.getByText("Split right"));

      expect(requestSplit).toHaveBeenCalledWith("session-42", "right");
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("calls requestSplit with the passed-in api.id and 'below'", async () => {
      const user = userEvent.setup();
      render(
        <PaneActionsMenu
          api={makeApi({ id: "session-42" })}
          params={{ sessionId: session.id }}
          containerApi={CONTAINER_API}
          onRename={vi.fn()}
          triggerClassName="pane-tab-btn"
        />,
      );

      await user.click(screen.getByTitle("More…"));
      await user.click(screen.getByText("Split down"));

      expect(requestSplit).toHaveBeenCalledWith("session-42", "below");
    });
  });

  // Manual repair for the fold/unfold pane-skew bug — offered from every
  // panel type (no `session` gate), same as "Move" above, since it acts on
  // the whole tiled grid rather than this specific pane.
  describe("Reset pane sizes", () => {
    it("calls resetTiledGroupWidths with the passed-in containerApi, closing the menu", async () => {
      const user = userEvent.setup();
      resetTiledGroupWidths.mockClear();
      render(
        <PaneActionsMenu
          api={makeApi({ id: "session-42" })}
          params={{ sessionId: session.id }}
          containerApi={CONTAINER_API}
          onRename={vi.fn()}
          triggerClassName="pane-tab-btn"
        />,
      );

      await user.click(screen.getByTitle("More…"));
      await user.click(screen.getByText("Reset pane sizes"));

      expect(resetTiledGroupWidths).toHaveBeenCalledWith(CONTAINER_API);
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("is still offered on a panel with no resolvable session", async () => {
      const user = userEvent.setup();
      render(
        <PaneActionsMenu
          api={makeApi({ id: "timeline-1" })}
          params={undefined}
          containerApi={CONTAINER_API}
          onRename={vi.fn()}
          triggerClassName="pane-tab-btn"
        />,
      );

      await user.click(screen.getByTitle("More…"));

      expect(screen.getByText("Reset pane sizes")).toBeInTheDocument();
    });

    // Independent code review — canResetTiledGroupWidths shares
    // resetTiledGroupWidths's own eligibility guards (fewer than two tiled
    // groups, or a multi-row grid), so the menu item disables itself
    // instead of staying clickable-but-silently-inert when there's nothing
    // to redistribute.
    it("disables itself with an explanatory title when canResetTiledGroupWidths is false", async () => {
      canResetTiledGroupWidths.mockReturnValue(false);
      resetTiledGroupWidths.mockClear();
      const user = userEvent.setup();
      render(
        <PaneActionsMenu
          api={makeApi({ id: "session-42" })}
          params={{ sessionId: session.id }}
          containerApi={CONTAINER_API}
          onRename={vi.fn()}
          triggerClassName="pane-tab-btn"
        />,
      );

      await user.click(screen.getByTitle("More…"));
      const item = screen.getByText("Reset pane sizes").closest("button");

      expect(item).toBeDisabled();
      expect(item).toHaveAttribute("title", "No skewed row of tiled panes to reset");

      await user.click(item!);

      expect(resetTiledGroupWidths).not.toHaveBeenCalled();
    });
  });

  // The mobile bar renders this for every panel in dockviewApi.panels, not
  // just terminal ones — a github/git/timeline/browser panel has no plain
  // `sessionId` at all (timeline's params carry `sessionIds`, plural).
  // Hermes review, PR #613 — Rename and Kill must be GATED on session, not
  // just left to silently no-op: ungated, Rename opened an input whose
  // commit silently discarded the typed name, and Kill was a no-op button
  // that looked destructive but did nothing. Only the always-disabled
  // "Move" item is session-independent by design.
  describe("panel with no resolvable session (non-terminal panel)", () => {
    it("hides Rename, the kill divider, and Kill session — shows only the disabled Move item", async () => {
      const user = userEvent.setup();
      render(
        <PaneActionsMenu
          api={makeApi()}
          params={undefined as TerminalPaneParams | undefined}
          containerApi={CONTAINER_API}
          onRename={vi.fn()}
          triggerClassName="pane-tab-btn"
        />,
      );

      await user.click(screen.getByTitle("More…"));

      expect(screen.queryByText("Rename")).not.toBeInTheDocument();
      expect(screen.queryByText("Kill session")).not.toBeInTheDocument();
      // Split is meaningless without a resolvable session — same gate as
      // Rename/Kill above.
      expect(screen.queryByText("Split right")).not.toBeInTheDocument();
      expect(screen.queryByText("Split down")).not.toBeInTheDocument();
      expect(screen.getByText("Move (drag tab)").closest("button")).toBeDisabled();
    });

    it("hides View timeline, Open Agent Browser, and Promote to worktree", async () => {
      const user = userEvent.setup();
      render(
        <PaneActionsMenu
          api={makeApi()}
          params={undefined as TerminalPaneParams | undefined}
          containerApi={CONTAINER_API}
          onRename={vi.fn()}
          triggerClassName="pane-tab-btn"
        />,
      );

      await user.click(screen.getByTitle("More…"));

      expect(screen.queryByText("View timeline")).not.toBeInTheDocument();
      expect(screen.queryByText("Open Agent Browser")).not.toBeInTheDocument();
      expect(screen.queryByText("Promote to worktree…")).not.toBeInTheDocument();
    });
  });

  // Real HTTP call inside PromoteDialog's own effect — not this component's
  // concern, just needs to not blow up when the item is clicked.
  it("opens the PromoteDialog on Promote to worktree", async () => {
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
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    vi.mocked(api.getProjectGitBranches).mockResolvedValue({
      branches: [{ name: "main", isCurrent: true }],
      remoteBranches: [],
      worktrees: [],
    });
    const user = userEvent.setup();
    render(
      <PaneActionsMenu
        api={makeApi()}
        params={{ sessionId: session.id }}
        containerApi={CONTAINER_API}
        onRename={vi.fn()}
        triggerClassName="pane-tab-btn"
      />,
    );

    await user.click(screen.getByTitle("More…"));
    await user.click(screen.getByText("Promote to worktree…"));

    expect(screen.getByText("Base ref")).toBeInTheDocument();
  });

  // 3a — a promote used to just kill the source pane with nothing visibly
  // replacing it (the new session only ever showed up in the sidebar after
  // its own next refresh). This pane's own session IS the one promote
  // kills, so on success it must close itself and hand off to the
  // replacement, not go quietly dead.
  it("closes this pane and opens the replacement session's panel once promote succeeds", async () => {
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
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    vi.mocked(api.getProjectGitBranches).mockResolvedValue({
      branches: [{ name: "main", isCurrent: true }],
      remoteBranches: [],
      worktrees: [],
    });
    const newSession = { ...session, id: 999, cwd: "/home/x/mullion/.mullion-worktrees/x" };
    promoteSessionMock.mockResolvedValue(newSession);
    const { openOrFocusSessionPanel } = await import("./panelUtils.js");
    const paneApi = makeApi();
    const user = userEvent.setup();
    render(
      <PaneActionsMenu
        api={paneApi}
        params={{ sessionId: session.id }}
        containerApi={CONTAINER_API}
        onRename={vi.fn()}
        triggerClassName="pane-tab-btn"
      />,
    );

    await user.click(screen.getByTitle("More…"));
    await user.click(screen.getByText("Promote to worktree…"));
    await screen.findByText("Base ref");
    await user.click(screen.getByText("Create worktree"));

    await vi.waitFor(() => expect(promoteSessionMock).toHaveBeenCalled());
    expect(paneApi.close).toHaveBeenCalled();
    expect(openOrFocusSessionPanel).toHaveBeenCalledWith(
      CONTAINER_API,
      newSession,
      { tier: "desktop", tabletPaneCap: 2 },
      projects,
    );
  });
});

// #719 — per-session mute toggle in the overflow menu.
describe("PaneActionsMenu — mute notifications (#719)", () => {
  it("offers 'Mute notifications' and toggles the session on click", async () => {
    const user = userEvent.setup();
    render(
      <PaneActionsMenu
        api={makeApi()}
        params={{ sessionId: session.id }}
        containerApi={CONTAINER_API}
        onRename={vi.fn()}
        triggerClassName="pane-tab-btn"
      />,
    );

    await user.click(screen.getByTitle("More…"));
    const muteItem = screen.getByText("Mute notifications");
    await user.click(muteItem);

    expect(toggleSessionMute).toHaveBeenCalledWith(session.id);
    // closeMenuAfterAction closes the menu after the toggle.
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("labels the item 'Unmute notifications' and toggles when already muted", async () => {
    mutedSessionIds = [session.id];
    const user = userEvent.setup();
    render(
      <PaneActionsMenu
        api={makeApi()}
        params={{ sessionId: session.id }}
        containerApi={CONTAINER_API}
        onRename={vi.fn()}
        triggerClassName="pane-tab-btn"
      />,
    );

    await user.click(screen.getByTitle("More…"));
    const unmuteItem = screen.getByText("Unmute notifications");
    await user.click(unmuteItem);

    expect(toggleSessionMute).toHaveBeenCalledWith(session.id);
  });
});
