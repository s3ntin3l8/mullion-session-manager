// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "./Sidebar.js";
import type * as ApiModule from "./api.js";
import type { Host, Project, Session } from "./api.js";

// U3 (audit finding — "nothing degrades gracefully past ~20 sessions") —
// covers the sidebar's new search/chip filter, persisted project collapse
// state, and the above-threshold virtualized rendering path
// (VirtualizedProjectTree in Sidebar.tsx). Mirrors UnifiedBoard.test.tsx's
// own store-mock shape (a `storeState()` factory serving all three call
// shapes the real zustand hook supports: no selector -> whole state, a
// selector -> selector(state), .getState() -> whole state) since Sidebar
// reads the store the same three ways across its own body and the child
// components it mounts (ProjectHeader, SessionRow, HierarchyToggle).
let projects: Project[];
let sessions: Session[];
let hosts: Host[];
let hideEndedSessions: boolean;
const refreshProjects = vi.fn().mockResolvedValue(undefined);
const refreshSessions = vi.fn().mockResolvedValue(undefined);
const refreshHosts = vi.fn().mockResolvedValue(undefined);
const refreshTasks = vi.fn().mockResolvedValue(undefined);
const createProject = vi.fn().mockResolvedValue(undefined);
const deleteProject = vi.fn().mockResolvedValue(undefined);
const updateProject = vi.fn().mockResolvedValue(undefined);
const deleteSession = vi.fn().mockResolvedValue(undefined);
const renameSession = vi.fn().mockResolvedValue(undefined);
const subscribeToGitHubProject = vi.fn();
const unsubscribeFromGitHubProject = vi.fn();
const setHierarchicalView = vi.fn();

function storeState() {
  return {
    projects,
    sessions,
    hosts,
    tasks: [],
    hideEndedSessions,
    settings: { sessions: { confirmBeforeKill: false }, projectRoots: [] },
    settingsLoaded: true,
    hierarchicalView: false,
    setHierarchicalView,
    theme: "dark",
    events: {},
    gitStatuses: {},
    sessionGitStatuses: {},
    gitDiffStats: {},
    gitBranchesByProject: {},
    prsByProject: {},
    renameSession,
    refreshProjects,
    refreshSessions,
    refreshHosts,
    refreshTasks,
    createProject,
    deleteProject,
    updateProject,
    deleteSession,
    subscribeToGitHubProject,
    unsubscribeFromGitHubProject,
  };
}

vi.mock("./store.js", () => {
  const useDashboardStore = (selector?: (s: unknown) => unknown) => {
    const state = storeState();
    return selector ? selector(state) : state;
  };
  useDashboardStore.getState = storeState;
  return { useDashboardStore };
});

// SourceControlSection has its own store surface (activePanelId,
// fetchProjectGit, a module-level setState call) unrelated to anything this
// file tests — stubbed away rather than grown into the mock above, same
// "stub the unrelated child" pattern Dock.test.tsx uses for TerminalPane and
// UnifiedBoard.test.tsx uses for TaskDetail.
vi.mock("./SourceControlSection.js", () => ({
  SourceControlSection: () => null,
}));

// DiscoverProjects (inline in Sidebar.tsx, not separately mockable) calls
// api.discoverProjects on mount — overridden to resolve empty rather than
// hitting a real fetch() jsdom can't serve.
vi.mock("./api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: { ...actual.api, discoverProjects: vi.fn().mockResolvedValue([]) } };
});

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: 1,
    projectId: 1,
    parentSessionId: null,
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
  ruleFiles: [],
  defaultAgent: null,
  defaultReviewAgent: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const NOOP_PROPS = {
  onOpenSession: vi.fn(),
  onOpenSessionAsFloat: vi.fn(),
  onSessionEnded: vi.fn(),
  onOpenProjectLauncher: vi.fn(),
  onOpenSettingsProjects: vi.fn(),
  onOpenTasks: vi.fn(),
  onOpenGit: vi.fn(),
};

// App.tsx always renders <Sidebar> as the sole child of `.sidebar-wrapper`
// (the actual `overflow-y: auto` scroll container) — VirtualizedProjectTree
// locates it via `closest(".sidebar-wrapper")` rather than a threaded ref
// (see its own comment in Sidebar.tsx), so tests reproduce that same
// wrapping to match. Harmless for the below-threshold tests, which never
// mount VirtualizedProjectTree at all.
function renderSidebar(props: Partial<typeof NOOP_PROPS> = {}) {
  return render(
    <div className="sidebar-wrapper">
      <Sidebar {...NOOP_PROPS} {...props} />
    </div>,
  );
}

// jsdom doesn't implement DataTransfer/DragEvent — same minimal stub
// SessionRow.test.tsx already uses for its own drag-start assertion.
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

// jsdom never lays out CSS, so every element reports offsetHeight === 0 by
// default — @tanstack/react-virtual reads it directly for both the scroll
// container's own viewport height and each row's measured size (see
// NotificationBell.test.tsx's own stubVirtualizerLayout, which this
// mirrors: only the tests that push the session count above
// VIRTUALIZE_SESSION_THRESHOLD and so actually mount
// VirtualizedProjectTree need this).
function stubVirtualizerLayout() {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("sidebar-wrapper") ? 600 : 50;
    },
  });
  vi.stubGlobal(
    "ResizeObserver",
    vi.fn(function () {
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    }),
  );
}

beforeEach(() => {
  projects = [PROJECT];
  sessions = [];
  hosts = [];
  hideEndedSessions = false;
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Sidebar search filter (U3)", () => {
  it("shows everything when the filter is empty", () => {
    sessions = [
      makeSession({ id: 1, command: "claude code" }),
      makeSession({ id: 2, command: "npm run build" }),
    ];
    renderSidebar();
    expect(screen.getByText("claude code")).toBeTruthy();
    expect(screen.getByText("npm run build")).toBeTruthy();
  });

  it("narrows the visible session list by text", async () => {
    sessions = [
      makeSession({ id: 1, command: "claude code" }),
      makeSession({ id: 2, command: "npm run build" }),
    ];
    const user = userEvent.setup();
    renderSidebar();

    await user.type(screen.getByLabelText("Filter sessions"), "npm");

    expect(screen.queryByText("claude code")).toBeNull();
    expect(screen.getByText("npm run build")).toBeTruthy();
  });

  it("matches on project name too, keeping every one of that project's sessions visible", async () => {
    sessions = [
      makeSession({ id: 1, command: "claude code" }),
      makeSession({ id: 2, command: "npm run build" }),
    ];
    const user = userEvent.setup();
    renderSidebar();

    await user.type(screen.getByLabelText("Filter sessions"), "demo");

    expect(screen.getByText("claude code")).toBeTruthy();
    expect(screen.getByText("npm run build")).toBeTruthy();
  });

  it("hides a project entirely once none of its sessions match", async () => {
    sessions = [makeSession({ id: 1, command: "claude code" })];
    const user = userEvent.setup();
    const { container } = renderSidebar();

    await user.type(screen.getByLabelText("Filter sessions"), "nothing-matches-this");

    expect(container.querySelector(".project-row-header")).toBeNull();
    expect(screen.getByText("No sessions match")).toBeTruthy();
  });
});

describe("Sidebar status filter chips (U3)", () => {
  it("filters to only Attention-column sessions when the Attention chip is active", async () => {
    sessions = [
      makeSession({
        id: 1,
        command: "working session",
        sessionStatus: "working",
        sessionStatusSeverity: "busy",
      }),
      makeSession({
        id: 2,
        command: "blocked session",
        sessionStatus: "awaiting_permission",
        sessionStatusSeverity: "blocked",
      }),
    ];
    const user = userEvent.setup();
    renderSidebar();

    await user.click(screen.getByRole("button", { name: "Attention" }));

    expect(screen.queryByText("working session")).toBeNull();
    expect(screen.getByText("blocked session")).toBeTruthy();
  });

  it("clearing the chip restores every session", async () => {
    sessions = [
      makeSession({
        id: 1,
        command: "working session",
        sessionStatus: "working",
        sessionStatusSeverity: "busy",
      }),
      makeSession({
        id: 2,
        command: "blocked session",
        sessionStatus: "awaiting_permission",
        sessionStatusSeverity: "blocked",
      }),
    ];
    const user = userEvent.setup();
    renderSidebar();

    const chip = screen.getByRole("button", { name: "Attention" });
    await user.click(chip);
    await user.click(chip);

    expect(screen.getByText("working session")).toBeTruthy();
    expect(screen.getByText("blocked session")).toBeTruthy();
  });

  it("composes the Exited chip with hideEndedSessions rather than conflicting with it", async () => {
    // hideEndedSessions=on would normally strip this session out of the
    // base list before the chip filter ever runs — the explicit Exited
    // chip click must bypass that for its own selection (see
    // baseSessionsByProject's own comment in Sidebar.tsx), not report zero
    // results, which is the "conflict" this PR's own constraint rules out.
    hideEndedSessions = true;
    sessions = [
      makeSession({
        id: 1,
        command: "exited session",
        status: "exited",
        sessionStatus: "exited",
        sessionStatusSeverity: "gone",
      }),
    ];
    const user = userEvent.setup();
    renderSidebar();

    // Confirms the premise: with the chip OFF, hideEndedSessions alone hides it.
    expect(screen.queryByText("exited session")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Exited" }));

    expect(screen.getByText("exited session")).toBeTruthy();
  });
});

describe("Sidebar project collapse persistence (U3)", () => {
  it("persists collapse state across a remount, and writes it to localStorage", async () => {
    // A project id unique to this test — projectCollapsedState is a
    // module-level object hydrated once at import time (mirrors
    // expandedSessionRows's own module-scope precedent), so it isn't reset
    // between tests; a fresh id per test sidesteps cross-test collisions the
    // same way SessionRow.test.tsx's makeRow3Session does for session ids.
    const project: Project = { ...PROJECT, id: 77_001, name: "collapse-test" };
    projects = [project];
    sessions = [makeSession({ id: 77_002, projectId: project.id, command: "claude code" })];
    const user = userEvent.setup();
    const first = renderSidebar();

    expect(first.queryByText("claude code")).toBeTruthy();
    await user.click(screen.getByText("collapse-test"));
    expect(first.queryByText("claude code")).toBeNull();

    // Assert the write actually happened (not just that the in-memory
    // module object was mutated, which would make this test pass even if
    // the localStorage.setItem call were broken).
    const raw = localStorage.getItem("crs.projectCollapsed");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toMatchObject({ [project.id]: true });

    first.unmount();
    const second = renderSidebar();
    expect(second.queryByText("claude code")).toBeNull();
  });
});

describe("Sidebar virtualization (U3, above VIRTUALIZE_SESSION_THRESHOLD)", () => {
  beforeEach(() => {
    stubVirtualizerLayout();
  });

  it("renders at least one row through the virtualizer, and preserves click/drag on it", async () => {
    sessions = Array.from({ length: 25 }, (_, i) =>
      makeSession({ id: 1000 + i, command: `session-${i}` }),
    );
    const onOpenSession = vi.fn();
    const user = userEvent.setup();
    const { container } = renderSidebar({ onOpenSession });

    // Sanity-check the stub itself (NotificationBell.test.tsx's own
    // precedent) — if this ever renders zero session rows, the assertions
    // below would pass for the wrong reason.
    const rows = container.querySelectorAll(".session-item");
    expect(rows.length).toBeGreaterThan(0);

    const firstRow = screen.getByText("session-0").closest(".session-item")!;
    await user.click(firstRow);
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(onOpenSession.mock.calls[0][0].id).toBe(1000);

    const dataTransfer = createDataTransfer();
    const dragStart = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(dragStart, "dataTransfer", { value: dataTransfer });
    firstRow.dispatchEvent(dragStart);
    expect(dataTransfer.getData("application/x-mullion-session")).toBe("1000");
  });

  it("still threads the remote-host badge through the virtualized project header", () => {
    const remoteProject: Project = { ...PROJECT, hostId: "remote-1" };
    projects = [remoteProject];
    hosts = [
      {
        id: "remote-1",
        name: "build-box",
        baseUrl: null,
        isLocal: false,
        hasToken: true,
        createdAt: "",
        health: "online",
        lastSeenAt: null,
        lastCheckedAt: null,
      },
    ];
    sessions = Array.from({ length: 25 }, (_, i) =>
      makeSession({ id: 2000 + i, projectId: remoteProject.id, command: `session-${i}` }),
    );
    const { container } = renderSidebar();

    expect(container.querySelector(".project-host-badge")?.textContent).toBe("build-box");
  });
});
