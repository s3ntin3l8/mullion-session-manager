// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PaneActionsMenu } from "./PaneActionsMenu.js";
import { api } from "./api.js";
import type { DockviewApi, DockviewPanelApi } from "dockview";
import type { Session, Project } from "./api.js";
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
vi.mock("./panelUtils.js", () => ({
  openTimelinePanel: vi.fn(),
  openBrowserPanePanel: vi.fn(),
}));

vi.mock("./api.js", () => ({
  api: {
    getProjectGitBranches: vi.fn(),
  },
}));

let session: Session;
let projects: Project[];

function storeState() {
  return {
    sessions: [session],
    projects,
    deleteSession: vi.fn().mockResolvedValue(undefined),
    theme: "dark",
    settings: { sessions: { confirmBeforeKill: false } },
  };
}

vi.mock("./store.js", () => {
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
    title: "claude code",
    close: vi.fn(),
    ...overrides,
  } as unknown as DockviewPanelApi;
}

const CONTAINER_API = { __marker: "containerApi" } as unknown as DockviewApi;

beforeEach(() => {
  session = { ...BASE_SESSION };
  projects = [];
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
});
