// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  openSessionPanel,
  openTimelinePanel,
  openBrowserPanePanel,
  openTaskDetailPanel,
  openOrFocusProjectPanel,
  closeLegacyPanels,
  dropSessionPanel,
  hasTiledPanels,
  stripFloatingPanels,
  stripMaximizedNode,
  stripHiddenHeaders,
  serializeForPersist,
  applyMobilePresentation,
  attentionTransitionPanelIds,
  newChildSessionIds,
  childPanelPosition,
  shouldAutoOpenChildPanels,
  extractSessionIds,
  resolveActiveProjectId,
  parseDeepLinkSessionId,
  handleGlobalEscape,
} from "./panelUtils.js";
import type { DockviewApi, DockviewGroupPanel, SerializedDockview } from "dockview-react";
import { DEFAULT_SETTINGS } from "./api/index.js";
import type { Session, Task } from "./api/index.js";

// `location.type` mirrors the live dockview panel API this module reads to
// decide float-vs-dock (issue #121): "grid" for anything actually tiled
// (including edge/split groups), "floating" for a peek panel.
function mockPanel(id: string, locationType: "grid" | "floating" = "grid", overrides = {}) {
  return {
    id,
    api: { setActive: vi.fn(), close: vi.fn(), location: { type: locationType } },
    ...overrides,
  } as unknown as ReturnType<DockviewApi["getPanel"]>;
}

// A grid-target group for dropSessionPanel tests — real DockviewGroupPanels
// expose the same `api.location.type` shape panels do. `header.hidden` is
// mutable (a plain object, not a getter/setter) so applyMobilePresentation's
// tests below can assert against it directly the same way the real
// DockviewGroupPanel.header does (see panelUtils.ts's own comment on that).
function mockGroup(id: string, locationType: "grid" | "floating" = "grid") {
  return {
    id,
    api: { location: { type: locationType } },
    header: { hidden: false },
  } as unknown as DockviewGroupPanel;
}

function mockDockviewApi(): DockviewApi {
  const panels = new Map<string, ReturnType<DockviewApi["getPanel"]>>();
  return {
    getPanel: vi.fn((id: string) => panels.get(id) ?? null),
    addPanel: vi.fn((opts) => {
      const p = mockPanel(opts.id, opts.floating ? "floating" : "grid", opts);
      panels.set(opts.id, p);
      return p;
    }),
    maximizeGroup: vi.fn(),
    get panels() {
      return Array.from(panels.values());
    },
  } as unknown as DockviewApi;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const PROJECTS = [
  { id: 1, name: "project-alpha" },
  { id: 2, name: null },
];

const EXISTING_SESSION: Session = {
  id: 1,
  projectId: 1,
  parentSessionId: null,
  command: "claude",
  name: null,
  nameLocked: false,
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
  sessionStatus: "idle",
  sessionStatusSeverity: "dormant",
  sessionStatusDetail: null,
  hookEmits: [],
  pendingDevServerPort: null,
  outstandingBackgroundTasks: [],
  sessionStatusAttentionRequired: false,
};

const NEW_SESSION: Session = {
  ...EXISTING_SESSION,
  id: 2,
  projectId: 1,
  command: "codex",
};

const SESSION_NO_PROJECT: Session = {
  ...EXISTING_SESSION,
  id: 3,
  projectId: 999,
  command: "opencode",
};

describe("openSessionPanel", () => {
  it("focuses an existing panel without creating a new one", () => {
    const api = mockDockviewApi();
    api.addPanel({ id: "session-1", component: "terminal", params: {} });
    const existing = api.getPanel("session-1")!;
    existing.api.setActive = vi.fn();

    openSessionPanel(api, EXISTING_SESSION, false, PROJECTS);

    expect(existing.api.setActive).toHaveBeenCalledTimes(1);
    expect(api.addPanel).toHaveBeenCalledTimes(1); // only the setup call
  });

  it("docks full-screen into an empty workspace (issue #121)", () => {
    const api = mockDockviewApi();

    openSessionPanel(api, NEW_SESSION, false, PROJECTS);

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-2",
        position: { direction: "right" },
      }),
    );
    const addCall = (api.addPanel as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(addCall).not.toHaveProperty("floating");
    expect(api.maximizeGroup).not.toHaveBeenCalled();
  });

  it("floats (peeks) when a tiled panel already exists, sized above the terminal floor", () => {
    const api = mockDockviewApi();
    api.addPanel({ id: "session-1", component: "terminal", params: {} }); // tiled

    openSessionPanel(api, NEW_SESSION, false, PROJECTS);

    // An explicit size, not dockview's own 300x300 default (constants.js) —
    // that comes out under pty-manager.ts's MIN_TERMINAL_COLS/ROWS floor at
    // the terminal's default fontSize, which is exactly what made a
    // freshly-floated session ignore keyboard input (issue: small panes/
    // floating windows ignoring input). See desktopPositioning's own comment
    // in panelUtils.ts for the derivation.
    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-2",
        floating: { width: 720, height: 460 },
      }),
    );
    expect(api.maximizeGroup).not.toHaveBeenCalled();
  });

  it("does not float on mobile; maximizes instead", () => {
    const api = mockDockviewApi();

    openSessionPanel(api, NEW_SESSION, true, PROJECTS);

    const addCall = (api.addPanel as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(addCall.id).toBe("session-2");
    expect(addCall).not.toHaveProperty("floating");
    expect(api.maximizeGroup).toHaveBeenCalledTimes(1);
  });

  it("creates a panel with the session command as title", () => {
    const api = mockDockviewApi();

    openSessionPanel(api, NEW_SESSION, false, PROJECTS);

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining("codex"),
      }),
    );
  });

  it("handles a session with no matching project gracefully", () => {
    const api = mockDockviewApi();

    openSessionPanel(api, SESSION_NO_PROJECT, false, PROJECTS);

    expect(api.addPanel).toHaveBeenCalledTimes(1);
  });
});

// openTimelinePanel (issue #212) has no isMobile param — see panelUtils.ts's
// own comment on why: it's called from PaneTab.tsx's overflow menu, which
// has no access to App.tsx's live isMobile React state. It reads a live
// matchMedia() check instead, so these tests stub that directly rather than
// passing a boolean like openSessionPanel's tests do above.
function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

describe("openTimelinePanel", () => {
  it("focuses an existing timeline panel without creating a new one", () => {
    stubMatchMedia(false);
    const api = mockDockviewApi();
    api.addPanel({ id: "timeline-1", component: "timeline", params: {} });
    const existing = api.getPanel("timeline-1")!;
    existing.api.setActive = vi.fn();

    openTimelinePanel(api, EXISTING_SESSION);

    expect(existing.api.setActive).toHaveBeenCalledTimes(1);
    expect(api.addPanel).toHaveBeenCalledTimes(1); // only the setup call
  });

  it("docks full-screen into an empty workspace, same as openSessionPanel", () => {
    stubMatchMedia(false);
    const api = mockDockviewApi();

    openTimelinePanel(api, NEW_SESSION);

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "timeline-2",
        component: "timeline",
        params: { sessionIds: [2] },
        position: { direction: "right" },
      }),
    );
    expect(api.maximizeGroup).not.toHaveBeenCalled();
  });

  it("floats (peeks) when a tiled panel already exists", () => {
    stubMatchMedia(false);
    const api = mockDockviewApi();
    api.addPanel({ id: "session-1", component: "terminal", params: {} }); // tiled

    openTimelinePanel(api, NEW_SESSION);

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "timeline-2", floating: { width: 720, height: 460 } }),
    );
    expect(api.maximizeGroup).not.toHaveBeenCalled();
  });

  it("does not float on mobile (per matchMedia); maximizes instead", () => {
    stubMatchMedia(true);
    const api = mockDockviewApi();

    openTimelinePanel(api, NEW_SESSION);

    const addCall = (api.addPanel as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(addCall.id).toBe("timeline-2");
    expect(addCall).not.toHaveProperty("floating");
    expect(api.maximizeGroup).toHaveBeenCalledTimes(1);
  });

  it("titles the panel using the session's name, falling back to its command", () => {
    stubMatchMedia(false);
    const api = mockDockviewApi();

    openTimelinePanel(api, NEW_SESSION);

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining("codex") }),
    );
  });
});

describe("openBrowserPanePanel", () => {
  it("focuses an existing browser pane without creating a new one", () => {
    stubMatchMedia(false);
    const api = mockDockviewApi();
    api.addPanel({ id: "browserPane-1", component: "browserPane", params: {} });
    const existing = api.getPanel("browserPane-1")!;
    existing.api.setActive = vi.fn();

    openBrowserPanePanel(api, EXISTING_SESSION);

    expect(existing.api.setActive).toHaveBeenCalledTimes(1);
    expect(api.addPanel).toHaveBeenCalledTimes(1); // only the setup call
  });

  it("docks full-screen into an empty workspace, same as openSessionPanel/openTimelinePanel", () => {
    stubMatchMedia(false);
    const api = mockDockviewApi();

    openBrowserPanePanel(api, NEW_SESSION);

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "browserPane-2",
        component: "browserPane",
        params: { sessionId: 2 },
        position: { direction: "right" },
      }),
    );
    expect(api.maximizeGroup).not.toHaveBeenCalled();
  });

  it("floats (peeks) when a tiled panel already exists", () => {
    stubMatchMedia(false);
    const api = mockDockviewApi();
    api.addPanel({ id: "session-1", component: "terminal", params: {} }); // tiled

    openBrowserPanePanel(api, NEW_SESSION);

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "browserPane-2", floating: { width: 720, height: 460 } }),
    );
    expect(api.maximizeGroup).not.toHaveBeenCalled();
  });

  it("does not float on mobile (per matchMedia); maximizes instead", () => {
    stubMatchMedia(true);
    const api = mockDockviewApi();

    openBrowserPanePanel(api, NEW_SESSION);

    const addCall = (api.addPanel as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(addCall.id).toBe("browserPane-2");
    expect(addCall).not.toHaveProperty("floating");
    expect(api.maximizeGroup).toHaveBeenCalledTimes(1);
  });

  it("titles the panel using the session's name, falling back to its command", () => {
    stubMatchMedia(false);
    const api = mockDockviewApi();

    openBrowserPanePanel(api, NEW_SESSION);

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining("codex") }),
    );
  });
});

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    projectId: 1,
    projectName: "demo",
    issueNumber: null,
    title: "Fix the thing",
    body: null,
    htmlUrl: null,
    status: "ready",
    boardOrder: 0,
    sessionId: null,
    seedDelivered: null,
    reviewSessionId: null,
    reviewSeedDelivered: null,
    reviewFindings: null,
    reviewRounds: 0,
    worktreePath: null,
    branchName: null,
    agent: null,
    reviewAgent: null,
    agentCommand: null,
    prUrl: null,
    prNumber: null,
    assignee: null,
    failureReason: null,
    githubSyncError: null,
    baseSha: null,
    dependencyCount: null,
    blockedState: "clear",
    blockers: [],
    parentIssueNumber: null,
    parentIssueRepo: null,
    parentIssueTitle: null,
    subIssueTotal: null,
    subIssueCompleted: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    claimedAt: null,
    startedAt: null,
    reviewingAt: null,
    completedAt: null,
    ...overrides,
  };
}

// Phase 6 (6.5/#218) — same open-or-focus/float-if-tiled shape as
// openTimelinePanel above, called from TasksPanelWrapper via
// props.containerApi.
describe("openTaskDetailPanel", () => {
  it("focuses an existing task detail panel without creating a new one", () => {
    stubMatchMedia(false);
    const api = mockDockviewApi();
    api.addPanel({ id: "task-detail-1", component: "task-detail", params: {} });
    const existing = api.getPanel("task-detail-1")!;
    existing.api.setActive = vi.fn();

    openTaskDetailPanel(api, makeTask({ id: 1 }));

    expect(existing.api.setActive).toHaveBeenCalledTimes(1);
    expect(api.addPanel).toHaveBeenCalledTimes(1); // only the setup call
  });

  it("docks full-screen into an empty workspace, same as openTimelinePanel", () => {
    stubMatchMedia(false);
    const api = mockDockviewApi();

    openTaskDetailPanel(api, makeTask({ id: 2, title: "Add widget" }));

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "task-detail-2",
        component: "task-detail",
        params: { taskId: 2 },
        title: "Task: Add widget",
        position: { direction: "right" },
      }),
    );
    expect(api.maximizeGroup).not.toHaveBeenCalled();
  });
});

// PR 34h — generalizes the six near-identical project-scoped `onOpen*`
// callbacks App.tsx used to declare inline (GitHub, Git, Agent Rules, Dock
// Config, Skills, Browser). Same open-or-focus/float-if-tiled shape as
// openTaskDetailPanel above, keyed by project id with a config table instead
// of six hardcoded copies.
describe("openOrFocusProjectPanel", () => {
  const GITHUB_CONFIG = { kind: "github", titleLabel: "GitHub", applyDesktopPositioning: true };

  it("focuses an existing panel without creating a new one (desktop)", () => {
    const api = mockDockviewApi();
    api.addPanel({ id: "github-1", component: "github", params: {} });
    const existing = api.getPanel("github-1")!;
    existing.api.setActive = vi.fn();

    openOrFocusProjectPanel(api, 1, PROJECTS, false, GITHUB_CONFIG);

    expect(existing.api.setActive).toHaveBeenCalledTimes(1);
    expect(api.maximizeGroup).not.toHaveBeenCalled();
    expect(api.addPanel).toHaveBeenCalledTimes(1); // only the setup call
  });

  it("focuses an existing panel and maximizes it on mobile", () => {
    const api = mockDockviewApi();
    api.addPanel({ id: "github-1", component: "github", params: {} });
    const existing = api.getPanel("github-1")!;

    openOrFocusProjectPanel(api, 1, PROJECTS, true, GITHUB_CONFIG);

    expect(existing.api.setActive).toHaveBeenCalledTimes(1);
    expect(api.maximizeGroup).toHaveBeenCalledWith(existing);
  });

  it("docks full-screen into an empty workspace, titled from the matching project", () => {
    const api = mockDockviewApi();

    openOrFocusProjectPanel(api, 1, PROJECTS, false, GITHUB_CONFIG);

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "github-1",
        component: "github",
        title: "GitHub: project-alpha",
        params: { projectId: 1 },
        position: { direction: "right" },
      }),
    );
    expect(api.maximizeGroup).not.toHaveBeenCalled();
  });

  it("floats (peeks) when a tiled panel already exists", () => {
    const api = mockDockviewApi();
    api.addPanel({ id: "session-1", component: "terminal", params: {} }); // tiled

    openOrFocusProjectPanel(api, 1, PROJECTS, false, GITHUB_CONFIG);

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "github-1", floating: { width: 720, height: 460 } }),
    );
  });

  it("does not float on mobile when creating a new panel; maximizes instead", () => {
    const api = mockDockviewApi();

    openOrFocusProjectPanel(api, 1, PROJECTS, true, GITHUB_CONFIG);

    const addCall = (api.addPanel as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(addCall).not.toHaveProperty("floating");
    expect(addCall).not.toHaveProperty("position");
    expect(api.maximizeGroup).toHaveBeenCalledTimes(1);
  });

  it("falls back to the bare label when no matching project is found", () => {
    const api = mockDockviewApi();

    openOrFocusProjectPanel(api, 999, PROJECTS, false, GITHUB_CONFIG);

    expect(api.addPanel).toHaveBeenCalledWith(expect.objectContaining({ title: "GitHub" }));
  });

  it("derives the panel id/component from `kind`, distinctly per panel type", () => {
    const api = mockDockviewApi();

    openOrFocusProjectPanel(api, 1, PROJECTS, false, {
      kind: "dock-config",
      titleLabel: "Dock",
      applyDesktopPositioning: true,
    });

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "dock-config-1", component: "dock-config" }),
    );
  });

  // Regression guard for onOpenBrowser's pre-existing asymmetry (see this
  // config field's own doc comment in panelUtils.ts): with
  // applyDesktopPositioning: false, a newly-created desktop panel gets
  // neither `floating` nor `position` — even when a tiled panel already
  // exists, unlike every other panel kind.
  it("applyDesktopPositioning: false omits both floating and position, even with a tiled panel present", () => {
    const api = mockDockviewApi();
    api.addPanel({ id: "session-1", component: "terminal", params: {} }); // tiled

    openOrFocusProjectPanel(api, 1, PROJECTS, false, {
      kind: "browser",
      titleLabel: "Preview",
      applyDesktopPositioning: false,
    });

    const addCall = (api.addPanel as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(addCall).not.toHaveProperty("floating");
    expect(addCall).not.toHaveProperty("position");
  });
});

describe("closeLegacyPanels", () => {
  it("closes a restored legacy panel and reports it closed", () => {
    const api = mockDockviewApi();
    api.addPanel({ id: "tasks", component: "tasks", params: {} });
    const panel = api.getPanel("tasks")!;

    const closed = closeLegacyPanels(api);

    expect(closed).toBe(true);
    expect(panel.api.close).toHaveBeenCalledTimes(1);
  });

  it("is a no-op and reports false when no legacy panel is present", () => {
    const api = mockDockviewApi();

    const closed = closeLegacyPanels(api);

    expect(closed).toBe(false);
    expect(api.getPanel).toHaveBeenCalledWith("tasks");
  });
});

// Phase 6 (6.5/#218) — extractSessionIds now also matches SessionTimeline's
// widened `sessionIds` array param, alongside every other panel type's
// plain `sessionId` field, so a timeline panel still counts toward
// findSessionWorkspace's cross-workspace lookup.
describe("extractSessionIds", () => {
  it("collects a plain sessionId field (terminal/browserPane panels)", () => {
    expect(extractSessionIds({ views: [{ params: { sessionId: 7 } }] })).toEqual(new Set([7]));
  });

  it("collects every entry of a sessionIds array field (timeline panels)", () => {
    expect(extractSessionIds({ views: [{ params: { sessionIds: [3, 4] } }] })).toEqual(
      new Set([3, 4]),
    );
  });

  it("merges both shapes across a mixed layout", () => {
    expect(
      extractSessionIds({
        views: [{ params: { sessionId: 1 } }, { params: { sessionIds: [2, 3] } }],
      }),
    ).toEqual(new Set([1, 2, 3]));
  });

  it("returns an empty set for a null layout", () => {
    expect(extractSessionIds(null)).toEqual(new Set());
  });
});

describe("parseDeepLinkSessionId (issue #95 prerequisite)", () => {
  it("parses a valid positive integer", () => {
    expect(parseDeepLinkSessionId("?session=42")).toBe(42);
  });

  it("returns null when the param is absent", () => {
    expect(parseDeepLinkSessionId("")).toBeNull();
    expect(parseDeepLinkSessionId("?other=1")).toBeNull();
  });

  it("returns null for a non-numeric value", () => {
    expect(parseDeepLinkSessionId("?session=abc")).toBeNull();
  });

  it("returns null for an empty value", () => {
    expect(parseDeepLinkSessionId("?session=")).toBeNull();
  });

  it("returns null for zero or a negative id", () => {
    expect(parseDeepLinkSessionId("?session=0")).toBeNull();
    expect(parseDeepLinkSessionId("?session=-1")).toBeNull();
  });

  it("returns null for a non-integer value", () => {
    expect(parseDeepLinkSessionId("?session=3.5")).toBeNull();
  });

  it("reads the param out of a query string with other params present", () => {
    expect(parseDeepLinkSessionId("?foo=bar&session=9&baz=1")).toBe(9);
  });

  it("rejects non-decimal numeric grammars Number() would otherwise accept", () => {
    expect(parseDeepLinkSessionId("?session=0x2A")).toBeNull();
    expect(parseDeepLinkSessionId("?session=0o52")).toBeNull();
    expect(parseDeepLinkSessionId("?session=0b101010")).toBeNull();
    expect(parseDeepLinkSessionId("?session=1e2")).toBeNull();
  });

  it("rejects a digit string too long to round-trip through Number() exactly", () => {
    // 2^53 + 1 stringified — passes the decimal-only regex but Number()
    // would silently round it, so isSafeInteger must reject it.
    expect(parseDeepLinkSessionId("?session=90071992547409921")).toBeNull();
    // Comfortably within Number.MAX_SAFE_INTEGER still parses normally.
    expect(parseDeepLinkSessionId("?session=9007199254740991")).toBe(9007199254740991);
  });
});

describe("hasTiledPanels", () => {
  it("is false for an empty workspace", () => {
    const api = mockDockviewApi();
    expect(hasTiledPanels(api)).toBe(false);
  });

  it("is false when the only panel is floating", () => {
    const api = mockDockviewApi();
    api.addPanel({ id: "session-1", component: "terminal", params: {}, floating: true });
    expect(hasTiledPanels(api)).toBe(false);
  });

  it("is true once a tiled panel exists", () => {
    const api = mockDockviewApi();
    api.addPanel({ id: "session-1", component: "terminal", params: {} });
    expect(hasTiledPanels(api)).toBe(true);
  });
});

describe("dropSessionPanel", () => {
  it("focuses an existing panel", () => {
    const api = mockDockviewApi();
    const target = null;
    api.addPanel({ id: "session-2", component: "terminal", params: {} });
    const existing = api.getPanel("session-2")!;
    existing.api.setActive = vi.fn();

    dropSessionPanel(api, NEW_SESSION, PROJECTS, target);

    expect(existing.api.setActive).toHaveBeenCalledTimes(1);
    expect(api.addPanel).toHaveBeenCalledTimes(1);
  });

  it("docks into the grid when dropped on empty space (issue #121)", () => {
    const api = mockDockviewApi();

    dropSessionPanel(api, NEW_SESSION, PROJECTS, null);

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-2",
        position: { direction: "right" },
      }),
    );
    const addCall = (api.addPanel as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(addCall).not.toHaveProperty("floating");
  });

  it("docks into the grid when the drop target is a floating group, not floats onto it", () => {
    const api = mockDockviewApi();
    const floatingGroup = mockGroup("float-group-1", "floating");

    dropSessionPanel(api, NEW_SESSION, PROJECTS, {
      group: floatingGroup,
      location: "content",
      position: "center",
    });

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-2",
        position: { direction: "right" },
      }),
    );
    const addCall = (api.addPanel as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(addCall).not.toHaveProperty("floating");
  });

  it("adds a panel within a group when dropped on the center", () => {
    const api = mockDockviewApi();
    const group = mockGroup("group-1");

    dropSessionPanel(api, NEW_SESSION, PROJECTS, {
      group,
      location: "content",
      position: "center",
    });

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-2",
        position: { referenceGroup: group, direction: "within" },
      }),
    );
  });

  it("adds a panel on the edge of a group with the correct direction", () => {
    const api = mockDockviewApi();
    const group = mockGroup("group-1");

    dropSessionPanel(api, NEW_SESSION, PROJECTS, {
      group,
      location: "edge",
      position: "right",
    });

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-2",
      }),
    );
    const addCall = (api.addPanel as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(addCall.position.referenceGroup).toBe(group);
    expect(addCall.position.direction).toBe("right");
  });
});

describe("stripFloatingPanels", () => {
  const GRID_PANEL = { id: "session-1", contentComponent: "terminal", title: "alpha" };
  const FLOAT_PANEL_SINGLE = { id: "session-2", contentComponent: "terminal", title: "bravo" };
  const FLOAT_PANEL_GRID = { id: "session-3", contentComponent: "terminal", title: "charlie" };

  function makeSerialized(overrides?: {
    floatingGroups?: unknown[];
    activeGroup?: string;
    extraPanels?: Record<string, unknown>;
  }): SerializedDockview {
    const panels: Record<string, unknown> = {
      "session-1": GRID_PANEL,
      "session-2": FLOAT_PANEL_SINGLE,
      ...(overrides?.extraPanels ?? {}),
    };
    const floatingGroups =
      overrides && "floatingGroups" in overrides
        ? overrides.floatingGroups
        : [
            {
              data: { views: ["session-2"], activeView: "session-2", id: "float-group-1" },
              position: { width: 400, height: 300, x: 100, y: 100 },
            },
          ];
    return {
      grid: {
        root: {
          type: "leaf" as const,
          data: { views: ["session-1"], activeView: "session-1", id: "main-group" },
        },
        height: 500,
        width: 800,
        orientation: "HORIZONTAL",
      },
      panels,
      activeGroup: overrides?.activeGroup ?? "main-group",
      floatingGroups,
    } as unknown as SerializedDockview;
  }

  it("strips a floating group backed by fg.data", () => {
    const serialized = makeSerialized();
    const result = stripFloatingPanels(serialized);

    expect(result.panels).not.toHaveProperty("session-2");
    expect(result.panels).toHaveProperty("session-1");
  });

  it("strips a floating group backed by fg.grid", () => {
    const serialized = makeSerialized({
      extraPanels: { "session-3": FLOAT_PANEL_GRID },
      floatingGroups: [
        {
          grid: {
            root: {
              type: "leaf" as const,
              data: { views: ["session-3"], activeView: "session-3", id: "float-group-2" },
            },
            width: 300,
            height: 200,
            orientation: "HORIZONTAL" as const,
          },
          position: { width: 400, height: 300, x: 200, y: 100 },
        },
      ],
    });

    const result = stripFloatingPanels(serialized);
    expect(result.panels).not.toHaveProperty("session-3");
  });

  it("preserves the main grid panels untouched", () => {
    const serialized = makeSerialized();
    const result = stripFloatingPanels(serialized);

    expect(result.panels).toHaveProperty("session-1");
    expect(result.panels["session-1"]).toEqual(GRID_PANEL);
    expect(result.panels).not.toHaveProperty("session-2");
  });

  it("clears activeGroup when it points to a floating group", () => {
    const serialized = makeSerialized({ activeGroup: "session-2" });
    const result = stripFloatingPanels(serialized);

    expect(result).not.toHaveProperty("activeGroup");
  });

  it("preserves activeGroup when it points to the main grid", () => {
    const serialized = makeSerialized({ activeGroup: "session-1" });
    const result = stripFloatingPanels(serialized);

    expect(result.activeGroup).toBe("session-1");
  });

  it("removes the floatingGroups key from the output", () => {
    const serialized = makeSerialized();
    const result = stripFloatingPanels(serialized);

    expect(result).not.toHaveProperty("floatingGroups");
  });

  it("returns the input unchanged when there are no floating groups", () => {
    const serialized = makeSerialized({ floatingGroups: undefined });
    const result = stripFloatingPanels(serialized);

    expect(result).toBe(serialized);
    expect(result.panels).toHaveProperty("session-1");
    expect(result.panels).toHaveProperty("session-2");
  });

  it("does not mutate the input", () => {
    const serialized = makeSerialized();
    const copy = makeSerialized();

    stripFloatingPanels(serialized);

    expect(serialized).toEqual(copy);
  });

  describe("stripMaximizedNode (issue #85)", () => {
    it("removes grid.maximizedNode from the output", () => {
      const serialized = makeSerialized();
      const withMaximized = {
        ...serialized,
        grid: { ...serialized.grid, maximizedNode: { location: [0] } },
      } as unknown as SerializedDockview;

      const result = stripMaximizedNode(withMaximized);

      expect(result.grid).not.toHaveProperty("maximizedNode");
    });

    it("returns the input unchanged when there is no maximizedNode", () => {
      const serialized = makeSerialized();

      const result = stripMaximizedNode(serialized);

      expect(result).toBe(serialized);
    });

    it("returns the input unchanged when grid itself is missing (defensive guard)", () => {
      const serialized = { ...makeSerialized(), grid: undefined } as unknown as SerializedDockview;

      const result = stripMaximizedNode(serialized);

      expect(result).toBe(serialized);
    });

    it("does not mutate the input", () => {
      const serialized = makeSerialized();
      const withMaximized = {
        ...serialized,
        grid: { ...serialized.grid, maximizedNode: { location: [0] } },
      } as unknown as SerializedDockview;
      const copy = JSON.parse(JSON.stringify(withMaximized));

      stripMaximizedNode(withMaximized);

      expect(withMaximized).toEqual(copy);
    });

    it("preserves the rest of grid untouched", () => {
      const serialized = makeSerialized();
      const withMaximized = {
        ...serialized,
        grid: { ...serialized.grid, maximizedNode: { location: [0] } },
      } as unknown as SerializedDockview;

      const result = stripMaximizedNode(withMaximized);

      expect(result.grid.root).toEqual(serialized.grid.root);
      expect(result.grid.height).toBe(serialized.grid.height);
      expect(result.grid.width).toBe(serialized.grid.width);
    });
  });

  // Mobile UI/UX overhaul, item A.3 — mirrors stripMaximizedNode's own test
  // shape one field over: `hideHeader` (set by applyMobilePresentation) is
  // pure viewport presentation and must never round-trip through a saved
  // workspace layout, exactly like grid.maximizedNode above.
  describe("stripHiddenHeaders", () => {
    it("removes hideHeader from a leaf group node", () => {
      const serialized = makeSerialized();
      const withHidden = {
        ...serialized,
        grid: {
          ...serialized.grid,
          root: {
            ...serialized.grid.root,
            data: { ...serialized.grid.root.data, hideHeader: true },
          },
        },
      } as unknown as SerializedDockview;

      const result = stripHiddenHeaders(withHidden);

      expect(result.grid.root.data).not.toHaveProperty("hideHeader");
    });

    it("recurses into a branch node's children", () => {
      const serialized = makeSerialized();
      const withHidden = {
        ...serialized,
        grid: {
          ...serialized.grid,
          root: {
            type: "branch",
            data: [
              { type: "leaf", data: { views: ["session-1"], id: "group-1", hideHeader: true } },
              { type: "leaf", data: { views: ["session-2"], id: "group-2" } },
            ],
          },
        },
      } as unknown as SerializedDockview;

      const result = stripHiddenHeaders(withHidden);

      const [first, second] = result.grid.root.data as unknown as Array<{ data: unknown }>;
      expect(first?.data).not.toHaveProperty("hideHeader");
      expect(second?.data).toEqual({ views: ["session-2"], id: "group-2" });
    });

    it("returns the input unchanged when there is no hideHeader", () => {
      const serialized = makeSerialized();

      const result = stripHiddenHeaders(serialized);

      expect(result.grid.root).toEqual(serialized.grid.root);
    });

    it("returns the input unchanged when grid.root is missing (defensive guard)", () => {
      const serialized = { ...makeSerialized(), grid: undefined } as unknown as SerializedDockview;

      const result = stripHiddenHeaders(serialized);

      expect(result).toBe(serialized);
    });
  });

  describe("serializeForPersist (issue #85)", () => {
    function mockApiWithJSON(serialized: SerializedDockview): DockviewApi {
      return { toJSON: vi.fn(() => serialized) } as unknown as DockviewApi;
    }

    it("strips floating panels, maximizedNode, and hideHeader in one pass", () => {
      const serialized = makeSerialized({ activeGroup: "session-2" });
      const withMaximized = {
        ...serialized,
        grid: {
          ...serialized.grid,
          maximizedNode: { location: [0] },
          root: {
            ...serialized.grid.root,
            data: { ...serialized.grid.root.data, hideHeader: true },
          },
        },
      } as unknown as SerializedDockview;
      const api = mockApiWithJSON(withMaximized);

      const result = serializeForPersist(api);

      expect(result.panels).not.toHaveProperty("session-2");
      expect(result).not.toHaveProperty("floatingGroups");
      expect(result.grid).not.toHaveProperty("maximizedNode");
      expect(result.grid.root.data).not.toHaveProperty("hideHeader");
    });

    it("is a no-op pass-through when there is nothing to strip", () => {
      const serialized = makeSerialized({ floatingGroups: undefined });
      const api = mockApiWithJSON(serialized);

      const result = serializeForPersist(api);

      expect(result.panels).toHaveProperty("session-1");
      expect(result.panels).toHaveProperty("session-2");
      expect(result.grid).not.toHaveProperty("maximizedNode");
    });
  });
});

describe("applyMobilePresentation (issue #85)", () => {
  function mockApiForPresentation(opts: {
    maximized: boolean;
    panels?: ReturnType<DockviewApi["getPanel"]>[];
    activePanel?: ReturnType<DockviewApi["getPanel"]> | null;
    groups?: DockviewGroupPanel[];
  }): DockviewApi {
    return {
      hasMaximizedGroup: vi.fn(() => opts.maximized),
      exitMaximizedGroup: vi.fn(),
      maximizeGroup: vi.fn(),
      panels: opts.panels ?? [],
      activePanel: opts.activePanel ?? null,
      groups: opts.groups ?? [],
    } as unknown as DockviewApi;
  }

  it("maximizes the active panel when mobile and nothing is maximized", () => {
    const active = mockPanel("session-1");
    const api = mockApiForPresentation({ maximized: false, panels: [active], activePanel: active });

    applyMobilePresentation(api, true);

    expect(api.maximizeGroup).toHaveBeenCalledWith(active);
  });

  it("falls back to the first panel when activePanel is null", () => {
    const first = mockPanel("session-1");
    const api = mockApiForPresentation({ maximized: false, panels: [first], activePanel: null });

    applyMobilePresentation(api, true);

    expect(api.maximizeGroup).toHaveBeenCalledWith(first);
  });

  it("is idempotent — no-ops when mobile and already maximized", () => {
    const active = mockPanel("session-1");
    const api = mockApiForPresentation({ maximized: true, panels: [active], activePanel: active });

    applyMobilePresentation(api, true);

    expect(api.maximizeGroup).not.toHaveBeenCalled();
  });

  it("no-ops on an empty panel list", () => {
    const api = mockApiForPresentation({ maximized: false, panels: [], activePanel: null });

    applyMobilePresentation(api, true);

    expect(api.maximizeGroup).not.toHaveBeenCalled();
  });

  it("exits maximization when leaving mobile with something maximized", () => {
    const api = mockApiForPresentation({ maximized: true });

    applyMobilePresentation(api, false);

    expect(api.exitMaximizedGroup).toHaveBeenCalledTimes(1);
  });

  it("no-ops when leaving mobile with nothing maximized", () => {
    const api = mockApiForPresentation({ maximized: false });

    applyMobilePresentation(api, false);

    expect(api.exitMaximizedGroup).not.toHaveBeenCalled();
  });

  // Mobile UI/UX overhaul, item A.2 — the fix for the reported "doubled pane
  // switcher": dockview's own tab strip must not render alongside App.tsx's
  // .mobile-tabs bar. Every group, not just the one being (de)maximized — a
  // desktop-authored layout can have several groups, and only one becomes
  // the maximized/visible one here (see applyMobilePresentation's own
  // comment on why).
  it("hides every group's header when entering mobile", () => {
    const active = mockPanel("session-1");
    const visibleGroup = mockGroup("group-1");
    const backgroundGroup = mockGroup("group-2");
    const api = mockApiForPresentation({
      maximized: false,
      panels: [active],
      activePanel: active,
      groups: [visibleGroup, backgroundGroup],
    });

    applyMobilePresentation(api, true);

    expect(visibleGroup.header.hidden).toBe(true);
    expect(backgroundGroup.header.hidden).toBe(true);
  });

  it("restores every group's header when leaving mobile", () => {
    const group = mockGroup("group-1");
    group.header.hidden = true;
    const api = mockApiForPresentation({ maximized: true, groups: [group] });

    applyMobilePresentation(api, false);

    expect(group.header.hidden).toBe(false);
  });
});

describe("attentionTransitionPanelIds (#98 item 4 — auto-focus on attention)", () => {
  // App.tsx's effect gates the whole feature on this before even calling
  // attentionTransitionPanelIds — asserting the actual default here (rather
  // than assuming) is the "off by default" half of this feature's test
  // coverage; the transition-detection tests below are the "properly
  // gated" half.
  it("defaults to off", () => {
    expect(DEFAULT_SETTINGS.notifications.autoFocusOnAttention).toBe(false);
  });

  it("returns a panel id for a session newly in attention", () => {
    const sessions = [{ id: 1, attention: true }];
    expect(attentionTransitionPanelIds(sessions, new Set())).toEqual(["session-1"]);
  });

  it("excludes a session already attention on the previous tick — fires once per transition, not every tick", () => {
    const sessions = [{ id: 1, attention: true }];
    expect(attentionTransitionPanelIds(sessions, new Set([1]))).toEqual([]);
  });

  it("excludes sessions that aren't currently in attention", () => {
    const sessions = [
      { id: 1, attention: false },
      { id: 2, attention: false },
    ];
    expect(attentionTransitionPanelIds(sessions, new Set())).toEqual([]);
  });

  it("handles a mix — new transition, already-seen, and never-attention — independently", () => {
    const sessions = [
      { id: 1, attention: true }, // new transition
      { id: 2, attention: true }, // already seen last tick
      { id: 3, attention: false }, // never attention
    ];
    expect(attentionTransitionPanelIds(sessions, new Set([2]))).toEqual(["session-1"]);
  });
});

// Phase 5 (Track B, issue #194 5.4).
describe("newChildSessionIds", () => {
  it("defaults to off", () => {
    expect(DEFAULT_SETTINGS.sessions.autoOpenChildPanels).toBe(false);
  });

  it("returns a newly-appeared live child", () => {
    const sessions = [{ id: 2, parentSessionId: 1, status: "active" as const }];
    expect(newChildSessionIds(sessions, new Set())).toEqual([2]);
  });

  it("excludes a child already seen on the previous tick", () => {
    const sessions = [{ id: 2, parentSessionId: 1, status: "active" as const }];
    expect(newChildSessionIds(sessions, new Set([2]))).toEqual([]);
  });

  it("excludes a session with no parent — not a child at all", () => {
    const sessions = [{ id: 1, parentSessionId: null, status: "active" as const }];
    expect(newChildSessionIds(sessions, new Set())).toEqual([]);
  });

  it("excludes a child that is no longer active (exited/killed before this tick)", () => {
    const sessions = [{ id: 2, parentSessionId: 1, status: "killed" as const }];
    expect(newChildSessionIds(sessions, new Set())).toEqual([]);
  });

  it("handles a mix — new child, already-seen child, non-child, and inactive child — independently", () => {
    const sessions = [
      { id: 2, parentSessionId: 1, status: "active" as const }, // new
      { id: 3, parentSessionId: 1, status: "active" as const }, // already seen
      { id: 4, parentSessionId: null, status: "active" as const }, // not a child
      { id: 5, parentSessionId: 1, status: "exited" as const }, // inactive
    ];
    expect(newChildSessionIds(sessions, new Set([3]))).toEqual([2]);
  });
});

describe("childPanelPosition", () => {
  it("positions the child next to its parent's open panel", () => {
    const api = mockDockviewApi();
    const parentPanel = api.addPanel({
      id: "session-1",
      component: "terminal",
      params: { sessionId: 1 },
    });
    expect(childPanelPosition(api, 1)).toEqual({ referencePanel: parentPanel, direction: "right" });
  });

  it("returns undefined when the parent's panel isn't open", () => {
    const api = mockDockviewApi();
    expect(childPanelPosition(api, 1)).toBeUndefined();
  });
});

// Issue #447 — the auto-open effect's gate (App.tsx), extracted as a pure
// function so each of its five independent conditions is unit-tested
// without a live DockviewApi. Every case below flips exactly one input from
// the all-true baseline.
describe("shouldAutoOpenChildPanels", () => {
  const allTrue = {
    workspaceRestored: true,
    hasDockviewApi: true,
    autoOpenChildPanels: true,
    sessionsLoaded: true,
    restoring: false,
  };

  it("proceeds when every gate is satisfied", () => {
    expect(shouldAutoOpenChildPanels(allTrue)).toBe(true);
  });

  it("blocks when the workspace hasn't finished restoring", () => {
    expect(shouldAutoOpenChildPanels({ ...allTrue, workspaceRestored: false })).toBe(false);
  });

  it("blocks when there is no live DockviewApi yet", () => {
    expect(shouldAutoOpenChildPanels({ ...allTrue, hasDockviewApi: false })).toBe(false);
  });

  it("blocks when the setting is off (default)", () => {
    expect(shouldAutoOpenChildPanels({ ...allTrue, autoOpenChildPanels: false })).toBe(false);
  });

  it("blocks when sessions haven't loaded yet — avoids treating every pre-existing child as new", () => {
    expect(shouldAutoOpenChildPanels({ ...allTrue, sessionsLoaded: false })).toBe(false);
  });

  it("blocks during the same-tick workspace-switch restore window (issue #447)", () => {
    expect(shouldAutoOpenChildPanels({ ...allTrue, restoring: true })).toBe(false);
  });
});

describe("resolveActiveProjectId (issue #433's Source Control section)", () => {
  const sessions = [EXISTING_SESSION, SESSION_NO_PROJECT];

  it("returns null for a null activePanelId", () => {
    expect(resolveActiveProjectId(null, sessions)).toBeNull();
  });

  it("returns null for an unrecognized panel id shape", () => {
    expect(resolveActiveProjectId("settings", sessions)).toBeNull();
  });

  it.each(["git", "github", "agent-rules", "dock-config"])(
    "resolves a %s-<projectId> panel id directly to that project",
    (prefix) => {
      expect(resolveActiveProjectId(`${prefix}-42`, sessions)).toBe(42);
    },
  );

  it.each(["session", "timeline", "browserPane"])(
    "resolves a %s-<sessionId> panel id via the session's projectId",
    (prefix) => {
      expect(resolveActiveProjectId(`${prefix}-${EXISTING_SESSION.id}`, sessions)).toBe(
        EXISTING_SESSION.projectId,
      );
    },
  );

  it("returns null when the session-scoped panel's session isn't found", () => {
    expect(resolveActiveProjectId("session-999999", sessions)).toBeNull();
  });
});

// U9 — App.tsx's global window-level Escape handler calls this directly
// (see its own doc comment for why it lives here rather than as an
// App.test.tsx mount test: App.tsx pulls in real dockview/xterm/WS
// machinery this suite has never had to mock, so there's no existing
// full-mount pattern to extend). The bug this closes: the handler used to
// only clear `palette.open`, never `clearSplitRequest()` — but the palette
// also renders for a pending split-right/split-down splitRequest
// (App.tsx's own `paletteOpen = palette.open || (splitRequest !== null &&
// ...)`), and the palette's OWN Escape handler only fires while focus is
// inside its search input, so a split-triggered palette with focus moved
// elsewhere inside it (the project picker, a launcher row, the worktree
// checkbox, the base-ref dropdown) had no way to close via Escape at all.
describe("handleGlobalEscape (U9)", () => {
  it("clears the palette, closes settings, AND clears the split request", () => {
    const clearPalette = vi.fn();
    const closeSettings = vi.fn();
    const clearSplitRequest = vi.fn();

    handleGlobalEscape({ clearPalette, closeSettings, clearSplitRequest });

    expect(clearPalette).toHaveBeenCalledTimes(1);
    expect(closeSettings).toHaveBeenCalledTimes(1);
    // The actual regression: this used to never be called at all.
    expect(clearSplitRequest).toHaveBeenCalledTimes(1);
  });
});
