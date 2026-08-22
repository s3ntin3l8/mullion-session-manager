// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Virtualizer } from "@tanstack/react-virtual";
import { Sidebar } from "./Sidebar.js";
import { ApiError } from "./api/index.js";
import type * as ApiModule from "./api/index.js";
import type { Host, Project, Session, Task } from "./api/index.js";
import { makeSession, makeProject, makeHost, makeTask } from "./test/fixtures.js";

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
let showTaskSessions: boolean;
let tasks: Task[];
let viewMode: string;
const setShowTaskSessions = vi.fn();
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
const setViewMode = vi.fn();

function storeState() {
  return {
    projects,
    sessions,
    hosts,
    tasks,
    hideEndedSessions,
    showTaskSessions,
    setShowTaskSessions,
    settings: { sessions: { confirmBeforeKill: false }, projectRoots: [] },
    settingsLoaded: true,
    hierarchicalView: false,
    setHierarchicalView,
    viewMode,
    setViewMode,
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

vi.mock("./store/index.js", () => {
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
vi.mock("./api/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: { ...actual.api, discoverProjects: vi.fn().mockResolvedValue([]) } };
});

const PROJECT: Project = makeProject();

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
  tasks = [];
  hideEndedSessions = false;
  showTaskSessions = false;
  viewMode = "list";
  setViewMode.mockClear();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Independent-review round, PR #583 — guards the exact `getTotalSize()`
// behavior VirtualizedProjectTree's container-height calculation
// (Sidebar.tsx) depends on, against the real library rather than a claim
// about it. A prior review round asserted `getTotalSize()` INCLUDES
// `scrollMargin` and "fixed" a supposed double-count by subtracting it a
// second time from the container height; a later, independent review round
// found that undersized the container by exactly `scrollMargin` instead —
// `getTotalSize()` already nets the margin back out internally. Constructs
// the real, headless `@tanstack/virtual-core` `Virtualizer` directly (no
// DOM/React needed — `getTotalSize()`/`getMeasurements()` only read options
// and computed measurements, never `this.scrollElement`) against a known
// count/estimateSize/scrollMargin and asserts the hand-calculated
// expectation, so this fails immediately (not via a jsdom smoke-render
// that can't see real layout) if either the library's behavior or this
// file's assumption about it ever drifts.
describe("VirtualizedProjectTree size math (independent review, PR #583)", () => {
  function makeHeadlessVirtualizer(count: number, itemSize: number, scrollMargin: number) {
    return new Virtualizer({
      count,
      getScrollElement: () => null,
      estimateSize: () => itemSize,
      scrollMargin,
      observeElementRect: () => () => {},
      observeElementOffset: () => () => {},
      scrollToFn: () => {},
    });
  }

  it("getTotalSize() excludes scrollMargin — it is only the sum of item sizes", () => {
    const virtualizer = makeHeadlessVirtualizer(5, 10, 100);
    // Hand-calculated: 5 items * 10px each = 50. NOT 150 (which a
    // scrollMargin-inclusive getTotalSize() would return).
    expect(virtualizer.getTotalSize()).toBe(50);
  });

  it("getTotalSize() stays scrollMargin-independent when scrollMargin is 0", () => {
    const withMargin = makeHeadlessVirtualizer(5, 10, 100);
    const withoutMargin = makeHeadlessVirtualizer(5, 10, 0);
    expect(withMargin.getTotalSize()).toBe(withoutMargin.getTotalSize());
  });

  it("scrollMargin DOES offset each item's own raw start/end position", () => {
    // The margin isn't ignored — it shifts where items START (which is
    // exactly what VirtualizedProjectTree's `translateY(virtualRow.start -
    // scrollMargin)` compensates for), it just doesn't inflate the total.
    // `measurementsCache` (public) rather than the private `getMeasurements()`
    // method — `getTotalSize()` populates it as a side effect.
    const virtualizer = makeHeadlessVirtualizer(3, 10, 100);
    virtualizer.getTotalSize();
    expect(virtualizer.measurementsCache[0]).toMatchObject({ start: 100, end: 110 });
    expect(virtualizer.measurementsCache[2]).toMatchObject({ start: 120, end: 130 });
  });
});

describe("Sidebar Tasks entry — Tasks-as-a-destination", () => {
  it("is not marked active when viewMode is not kanban", () => {
    renderSidebar();
    const entry = screen.getByRole("button", { name: /Tasks/ });
    expect(entry).not.toHaveClass("active");
    expect(entry).toHaveAttribute("aria-pressed", "false");
  });

  it("is marked active while the Tasks board is the active view", () => {
    viewMode = "kanban";
    renderSidebar();
    const entry = screen.getByRole("button", { name: /Tasks/ });
    expect(entry).toHaveClass("active");
    expect(entry).toHaveAttribute("aria-pressed", "true");
  });

  // Issue: this entry already advertised itself as a toggle via
  // aria-pressed, but the click handler only ever called onOpenTasks
  // (always -> "kanban"), so clicking it a second time while already in
  // Tasks did nothing — the Toolbar's "Back" chevron was the only way out.
  it("clicking it while already in Tasks switches back to list view instead of calling onOpenTasks again", async () => {
    viewMode = "kanban";
    const onOpenTasks = vi.fn();
    const user = userEvent.setup();
    renderSidebar({ onOpenTasks });

    await user.click(screen.getByRole("button", { name: /Tasks/ }));

    expect(setViewMode).toHaveBeenCalledWith("list");
    expect(onOpenTasks).not.toHaveBeenCalled();
  });

  it("clicking it while NOT in Tasks still calls onOpenTasks, not setViewMode directly", async () => {
    viewMode = "list";
    const onOpenTasks = vi.fn();
    const user = userEvent.setup();
    renderSidebar({ onOpenTasks });

    await user.click(screen.getByRole("button", { name: /Tasks/ }));

    expect(onOpenTasks).toHaveBeenCalled();
    expect(setViewMode).not.toHaveBeenCalled();
  });
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

describe("Sidebar task session visibility (#9)", () => {
  it("hides a currently task-linked session when showTaskSessions is off", () => {
    sessions = [makeSession({ id: 1, command: "task worker session" })];
    tasks = [makeTask({ id: 7, sessionId: 1 })];
    showTaskSessions = false;
    renderSidebar();

    expect(screen.queryByText("task worker session")).toBeNull();
  });

  it("shows a currently task-linked session when showTaskSessions is on", () => {
    sessions = [makeSession({ id: 1, command: "task worker session" })];
    tasks = [makeTask({ id: 7, sessionId: 1 })];
    showTaskSessions = true;
    renderSidebar();

    expect(screen.getByText("task worker session")).toBeTruthy();
  });

  it("a session not linked to any task is unaffected by the toggle either way", () => {
    sessions = [makeSession({ id: 1, command: "ordinary session" })];
    tasks = [makeTask({ id: 7, sessionId: 2 })];
    showTaskSessions = false;
    renderSidebar();

    expect(screen.getByText("ordinary session")).toBeTruthy();
  });

  it("keeps a killed task-linked session hidden regardless of the toggle — the pre-existing status filter runs first", () => {
    sessions = [makeSession({ id: 1, command: "killed task session", status: "killed" })];
    tasks = [makeTask({ id: 7, sessionId: 1 })];
    showTaskSessions = true;
    renderSidebar();

    expect(screen.queryByText("killed task session")).toBeNull();
  });

  it("a task's reviewSessionId is linked too, not just sessionId", () => {
    sessions = [makeSession({ id: 2, command: "task review session" })];
    tasks = [makeTask({ id: 7, reviewSessionId: 2 })];
    showTaskSessions = false;
    renderSidebar();

    expect(screen.queryByText("task review session")).toBeNull();
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

  // Hermes review, PR #583 — an earlier version cached collapse state in a
  // Sidebar-owned Map snapshotted once at mount, which a below-threshold
  // `ProjectSection` toggle never wrote to; crossing VIRTUALIZE_SESSION_
  // THRESHOLD then silently re-expanded the project. This exercises the
  // exact repro: collapse while below threshold (the plain ProjectSection
  // path), grow the session count past the threshold via a rerender (the
  // same live `sessions` update a real poll tick would cause), and confirm
  // the collapsed project's sessions stay hidden once VirtualizedProjectTree
  // takes over — i.e. both rendering paths agree on the SAME live
  // (persisted) collapse state rather than each holding its own snapshot.
  it("keeps a project collapsed across the render path switching from ProjectSection to VirtualizedProjectTree", async () => {
    stubVirtualizerLayout();
    const collapseTarget: Project = { ...PROJECT, id: 77_201, name: "collapse-across-threshold" };
    const filler: Project = { ...PROJECT, id: 77_202, name: "filler-project" };
    projects = [collapseTarget, filler];
    sessions = [
      makeSession({ id: 77_211, projectId: collapseTarget.id, command: "a0" }),
      makeSession({ id: 77_212, projectId: collapseTarget.id, command: "a1" }),
      makeSession({ id: 77_213, projectId: collapseTarget.id, command: "a2" }),
    ];
    const user = userEvent.setup();
    const { rerender, queryByText } = renderSidebar();

    // Still below VIRTUALIZE_SESSION_THRESHOLD (3 sessions total) — this is
    // the plain ProjectSection path.
    expect(queryByText("a0")).toBeTruthy();
    await user.click(screen.getByText("collapse-across-threshold"));
    expect(queryByText("a0")).toBeNull();

    // Grow an UNRELATED project's session count past the threshold — same
    // "sessions changed under the same Sidebar instance" shape a live 4s
    // poll tick produces, not a fresh mount.
    sessions = [
      ...sessions,
      ...Array.from({ length: 25 }, (_, i) =>
        makeSession({ id: 77_300 + i, projectId: filler.id, command: `b${i}` }),
      ),
    ];
    rerender(
      <div className="sidebar-wrapper">
        <Sidebar {...NOOP_PROPS} />
      </div>,
    );

    // Now above the threshold — VirtualizedProjectTree is the active path.
    // The filler project's sessions (never manually touched, non-empty)
    // render normally, proving the virtualized list is genuinely active...
    expect(queryByText("b0")).toBeTruthy();
    // ...while the explicitly-collapsed project's sessions stay hidden,
    // proving the collapse survived the path switch rather than reverting.
    expect(queryByText("a0")).toBeNull();
    expect(queryByText("a1")).toBeNull();
    expect(queryByText("a2")).toBeNull();
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
      makeHost({
        id: "remote-1",
        name: "build-box",
        baseUrl: null,
        isLocal: false,
        hasToken: true,
        health: "online",
      }),
    ];
    sessions = Array.from({ length: 25 }, (_, i) =>
      makeSession({ id: 2000 + i, projectId: remoteProject.id, command: `session-${i}` }),
    );
    const { container } = renderSidebar();

    expect(container.querySelector(".project-host-badge")?.textContent).toBe("build-box");
  });

  // Hermes review, PR #583 (suggestion, declined — see the reply on that
  // thread): flagged the "empty" flat-row branch as unreachable, reasoning
  // that a zero-session project is always auto-collapsed before it. That's
  // only true absent an explicit override — a project the user has
  // manually EXPANDED (independent of its session count; ProjectHeader's
  // collapse toggle has no session-count gate) and which currently has zero
  // sessions reaches it, exactly mirroring the plain ProjectSection path's
  // own pre-existing "No sessions yet" note for the identical case. This
  // proves the branch live rather than asserting it in the abstract.
  it("reaches the empty-project row when a zero-session project is explicitly expanded", async () => {
    stubVirtualizerLayout();
    const emptyProject: Project = { ...PROJECT, id: 77_401, name: "empty-but-expanded" };
    const filler: Project = { ...PROJECT, id: 77_402, name: "filler" };
    projects = [emptyProject, filler];
    // filler alone pushes the total past VIRTUALIZE_SESSION_THRESHOLD so
    // this exercises VirtualizedProjectTree, not ProjectSection.
    sessions = Array.from({ length: 25 }, (_, i) =>
      makeSession({ id: 77_500 + i, projectId: filler.id, command: `f${i}` }),
    );
    const user = userEvent.setup();
    renderSidebar();

    // emptyProject has 0 sessions -> auto-collapsed by default; its header
    // still renders (a project is only ever hidden entirely by an active
    // filter, not by being empty).
    await user.click(screen.getByText("empty-but-expanded"));

    expect(screen.getByText("No sessions yet")).toBeTruthy();
  });
});

// P9 — Sidebar.tsx's "Delete project" (ProjectHeader) and "End this
// session" (SessionRow) handlers used to be `void deleteX(...).then(...)`
// with no `.catch` at all: a failure left the row sitting there with no
// explanation, indistinguishable from the click never registering, plus an
// unhandled rejection in the console. `deleteProject`/`deleteSession` are
// the module-level stable mocks this whole file's `storeState()` serves
// (defaulted to `mockResolvedValue(undefined)` at the top) —
// `mockRejectedValueOnce` here only affects this one call, so it doesn't
// leak into any other test's default resolved behavior.
describe("Sidebar P9 — inline error on a failed delete", () => {
  it("a failed 'Delete project' surfaces an inline error instead of doing nothing", async () => {
    deleteProject.mockRejectedValueOnce(new Error("Host is unreachable"));
    const user = userEvent.setup();
    renderSidebar();

    await user.click(screen.getByTitle("More…"));
    await user.click(await screen.findByText("Delete project"));
    // KebabMenu's own arm-then-confirm: first click arms (swaps the label
    // to armLabel), second click actually fires item.onClick().
    await user.click(await screen.findByText("Click again to delete"));

    expect(await screen.findByText(/unreachable/i)).toBeInTheDocument();
  });

  it("a failed 'End this session' surfaces an inline error instead of doing nothing", async () => {
    sessions = [makeSession({ id: 501, projectId: PROJECT.id, name: "doomed" })];
    deleteSession.mockRejectedValueOnce(new Error("Host is unreachable"));
    const user = userEvent.setup();
    renderSidebar();

    // confirmBeforeKill is false in this file's storeState() (see the top
    // of the file), so ConfirmButton fires onConfirm on the first click.
    await user.click(screen.getByTitle("End this session (the program will be terminated)"));

    expect(await screen.findByText(/unreachable/i)).toBeInTheDocument();
  });
});

describe("DiscoverProjects — a failed Add surfaces an inline error", () => {
  it("a rejected createProject shows an error next to the candidate row instead of an unhandled rejection", async () => {
    const { api } = await import("./api/index.js");
    vi.mocked(api.discoverProjects).mockResolvedValueOnce([
      { name: "widgets", cwd: "/repos/widgets", isGitRepo: true, isRegistered: false },
    ]);
    createProject.mockRejectedValueOnce(
      new ApiError("Directory /repos/widgets does not exist.", 400, "PROJECT_DIR_MISSING"),
    );
    const user = userEvent.setup();
    renderSidebar();

    await user.click(await screen.findByText("Discover projects"));
    await user.click(await screen.findByText("Add"));

    expect(await screen.findByText(/does not exist/i)).toBeInTheDocument();
    // Not marked as added on failure.
    expect(screen.getByText("Add")).toBeInTheDocument();
  });
});

describe("project-row New-session button (issue #730 — no launch from Task view)", () => {
  it("is enabled in the workspace view and opens the project launcher", async () => {
    viewMode = "list";
    const onOpenProjectLauncher = vi.fn();
    const user = userEvent.setup();
    renderSidebar({ onOpenProjectLauncher });

    const btn = screen.getByTitle("New session in project");
    expect(btn).not.toBeDisabled();
    await user.click(btn);
    expect(onOpenProjectLauncher).toHaveBeenCalledWith(PROJECT.id);
  });

  it("is disabled in the Task (Kanban) view and opens nothing", async () => {
    viewMode = "kanban";
    const onOpenProjectLauncher = vi.fn();
    const user = userEvent.setup();
    renderSidebar({ onOpenProjectLauncher });

    const btn = screen.getByTitle("New session (unavailable in Task view)");
    expect(btn).toBeDisabled();
    await user.click(btn);
    expect(onOpenProjectLauncher).not.toHaveBeenCalled();
  });
});
