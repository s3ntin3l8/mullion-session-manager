// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useSyncExternalStore } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "./Sidebar.js";
import type { SidebarProps } from "./Sidebar.js";
import type * as ApiModule from "./api/index.js";
import type { Device, GitStatus, Host, Project, Session, Task } from "./api/index.js";
import { makeSession, makeProject } from "./test/fixtures.js";

// U3 (audit finding — "nothing degrades gracefully past ~20 sessions") —
// covers the sidebar's new search/chip filter, persisted project collapse
// state, and the above-threshold virtualized rendering path
// (VirtualizedProjectTree in Sidebar.tsx). Mirrors UnifiedBoard.test.tsx's
// own store-mock shape (a `storeState()` factory serving the call shapes
// the real zustand hook supports: no selector -> whole state, a selector ->
// selector(state), .getState() -> whole state, plus setState so a test can
// publish a host-health change) since Sidebar reads the store the same ways
// across its own body and the child components it mounts (ProjectHeader,
// SessionRow).
let workspaceCounter = 0;
let projects: Project[];
let sessions: Session[];
let hosts: Host[];
let devices: Device[];
let hideEndedSessions: boolean;
let showTaskSessions: boolean;
let tasks: Task[];
let viewMode: string;
let gitStatuses: Record<number, GitStatus | null>;
// The project list's three states — still loading, loaded-and-empty, and
// failed (audit finding 14).
let projectsLoaded: boolean;
let projectsError: string | null;
let activeWorkspaceId: number | null;
const setShowTaskSessions = vi.fn();
const refreshProjects = vi.fn().mockResolvedValue(undefined);
const refreshSessions = vi.fn().mockResolvedValue(undefined);
const refreshHosts = vi.fn().mockResolvedValue(undefined);
const refreshDevices = vi.fn().mockResolvedValue(undefined);
const refreshTasks = vi.fn().mockResolvedValue(undefined);
const refreshGitStatuses = vi.fn().mockResolvedValue(undefined);
const refreshGitRefs = vi.fn().mockResolvedValue(undefined);
const pullProjectGit = vi.fn().mockResolvedValue({ pulled: true });
const createProject = vi.fn().mockResolvedValue(undefined);
const deleteProject = vi.fn().mockResolvedValue(undefined);
const updateProject = vi.fn().mockResolvedValue(undefined);
const deleteSession = vi.fn().mockResolvedValue(undefined);
const renameSession = vi.fn().mockResolvedValue(undefined);
const subscribeToGitHubProject = vi.fn();
const unsubscribeFromGitHubProject = vi.fn();
const setViewMode = vi.fn();
// The app-wide failure channel (store/slices/toasts.ts) — the sidebar
// reports a failed rename through it.
const reportError = vi.fn();

function storeState() {
  return {
    projects,
    sessions,
    hosts,
    devices,
    refreshDevices,
    tasks,
    hideEndedSessions,
    showTaskSessions,
    setShowTaskSessions,
    settings: { sessions: { confirmBeforeKill: false }, projectRoots: [] },
    settingsLoaded: true,
    viewMode,
    setViewMode,
    theme: "dark",
    events: {},
    gitStatuses,
    sessionGitStatuses: {},
    gitDiffStats: {},
    gitBranchesByProject: {},
    prsByProject: {},
    renameSession,
    refreshProjects,
    refreshSessions,
    refreshHosts,
    refreshTasks,
    refreshGitStatuses,
    refreshGitRefs,
    pullProjectGit,
    createProject,
    deleteProject,
    updateProject,
    deleteSession,
    subscribeToGitHubProject,
    unsubscribeFromGitHubProject,
    mutedSessionIds: [],
    toggleSessionMute: vi.fn(),
    projectsLoaded,
    projectsError,
    activeWorkspaceId,
    reportError,
  };
}

// Issue #1892 — selectors read the module-level `let`s (so a test can still
// reassign `hosts` and rerender). setState patches `hosts` and bumps an
// epoch so a health update re-renders subscribers without a parent rerender.
// The snapshot is the epoch, a number: getSnapshot must stay referentially
// stable between updates, and several selectors here allocate.
let storeEpoch = 0;
const storeListeners = new Set<() => void>();

function subscribeStore(listener: () => void) {
  storeListeners.add(listener);
  return () => {
    storeListeners.delete(listener);
  };
}

function getStoreEpoch() {
  return storeEpoch;
}

vi.mock("./store/index.js", () => {
  const useDashboardStore = (selector?: (s: unknown) => unknown) => {
    useSyncExternalStore(subscribeStore, getStoreEpoch);
    const state = storeState();
    return selector ? selector(state) : state;
  };
  useDashboardStore.getState = storeState;
  useDashboardStore.setState = (
    partial:
      | Partial<ReturnType<typeof storeState>>
      | ((state: ReturnType<typeof storeState>) => Partial<ReturnType<typeof storeState>>),
  ) => {
    const patch = typeof partial === "function" ? partial(storeState()) : partial;
    if (patch.hosts !== undefined) hosts = patch.hosts;
    storeEpoch += 1;
    for (const listener of [...storeListeners]) listener();
  };
  return { useDashboardStore };
});

// SourceControlSection has its own store surface (activePanelId,
// fetchProjectGit, a module-level setState call) unrelated to anything this
// file tests — stubbed away rather than grown into the mock above, same
// "stub the unrelated child" pattern Dock.test.tsx uses for TerminalPane and
// UnifiedBoard.test.tsx uses for TaskDetail.
vi.mock("./SourceControlSection.js", () => ({
  SourceControlSection: () => <div data-testid="source-control" />,
}));

// DiscoverProjects (inline in Sidebar.tsx, not separately mockable) calls
// api.discoverProjects on mount — overridden to resolve empty rather than
// hitting a real fetch() jsdom can't serve.
vi.mock("./api/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: {
      ...actual.api,
      discoverProjects: vi.fn().mockResolvedValue([]),
      attachHostCheckout: vi.fn(),
    },
  };
});

const PROJECT: Project = makeProject();

const NOOP_PROPS = {
  onOpenSession: vi.fn(),
  onOpenSessionAsFloat: vi.fn(),
  onSessionEnded: vi.fn(),
  onOpenProjectLauncher: vi.fn(),
  onOpenSettingsProjects: vi.fn(),
  onOpenGit: vi.fn(),
  onOpenProjectSetup: vi.fn(),
  showSourceControl: false,
};

// App.tsx always renders <Sidebar> as the sole child of `.sidebar-wrapper`
// (the actual `overflow-y: auto` scroll container) — VirtualizedProjectTree
// locates it via `closest(".sidebar-wrapper")` rather than a threaded ref
// (see its own comment in Sidebar.tsx), so tests reproduce that same
// wrapping to match. Harmless for the below-threshold tests, which never
// mount VirtualizedProjectTree at all.
function renderSidebar(
  props: Partial<typeof NOOP_PROPS> &
    Partial<Pick<SidebarProps, "workspaceProjectIds" | "openSessionIds">> = {},
) {
  return render(
    <div className="sidebar-wrapper">
      <Sidebar {...NOOP_PROPS} {...props} />
    </div>,
  );
}

// jsdom never lays out CSS, so every element reports 0 for every dimension
// by default — @tanstack/virtual-core reads two DIFFERENT properties for the
// two things it measures (see node_modules/@tanstack/virtual-core):
//
//   - the scroll container's own visible height (the viewport): `getRect()`
//     reads `clientWidth`/`clientHeight`. That changed in virtual-core 3.19.6
//     — upstream TanStack/virtual#1326 ("measure the visible scroll
//     viewport"), which stopped borders and scrollbars from inflating the
//     viewport and so obscuring end-aligned items. It is a deliberate
//     correctness fix, not a regression, and 3.19.7 does not revert it.
//   - each row's measured size: `measureElement()` still reads
//     `offsetHeight` when the ResizeObserver hands it no `borderBoxSize`
//     (which it never does here — the observer below is a no-op stub).
//
// Without this, the container's computed viewport height is 0 and
// getVirtualItems() never returns anything, so every "renders a row"
// assertion would fail for a reason that has nothing to do with this
// component's own logic. Only the tests that push the session count above
// VIRTUALIZE_SESSION_THRESHOLD and so actually mount
// VirtualizedProjectTree need this.
function stubVirtualizerLayout() {
  const stubHeight = function (this: HTMLElement) {
    return this.classList.contains("sidebar-wrapper") ? 600 : 50;
  };
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: stubHeight,
  });
  // The viewport (see the comment above) — same per-element heights.
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: stubHeight,
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 400,
  });
  vi.stubGlobal(
    "ResizeObserver",
    vi.fn(function () {
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    }),
  );
}

beforeEach(() => {
  storeListeners.clear();
  projects = [PROJECT];
  sessions = [];
  hosts = [];
  devices = [];
  tasks = [];
  hideEndedSessions = false;
  showTaskSessions = false;
  viewMode = "list";
  gitStatuses = {};
  projectsLoaded = true;
  projectsError = null;
  // A fresh workspace per test: the Other-projects open state is kept per
  // workspace for the page's lifetime.
  activeWorkspaceId = ++workspaceCounter;
  reportError.mockClear();
  renameSession.mockReset();
  renameSession.mockResolvedValue(undefined);
  setViewMode.mockClear();
  refreshGitStatuses.mockClear();
  refreshGitRefs.mockClear();
  pullProjectGit.mockClear();
  pullProjectGit.mockResolvedValue({ pulled: true });
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// jsdom doesn't implement DataTransfer — the same minimal stub Sidebar.test.tsx uses.
function createDataTransfer(): DataTransfer {
  const map = new Map<string, string>();
  return {
    setData(type: string, val: string) {
      map.set(type, val);
    },
    getData(type: string) {
      return map.get(type) ?? "";
    },
  } as unknown as DataTransfer;
}

// #3062 — the tree virtualizes on project count too: every listed project
// mounts a ProjectHeader (store subscriptions, ⋯ menu), so many projects with
// few sessions used to mount every header at once.
describe("Sidebar virtualization on project count (#3062)", () => {
  beforeEach(() => {
    stubVirtualizerLayout();
  });
  // Own ids per test: the collapse state is module-level.
  let nextBase = 50_000;
  const manyProjects = (count: number) => {
    const base = (nextBase += 1_000);
    return Array.from({ length: count }, (_, i) =>
      makeProject({ id: base + i, name: `proj-${base + i}` }),
    );
  };
  const virtualized = (container: HTMLElement) => container.querySelector("[data-index]") !== null;

  it("mounts a window of the expanded Other projects, not 200 headers (200 projects, 5 sessions)", async () => {
    projects = manyProjects(200);
    const tiled = projects[0];
    sessions = Array.from({ length: 5 }, (_, i) =>
      makeSession({ id: tiled.id * 10 + i, projectId: tiled.id, command: `s${i}` }),
    );
    const user = userEvent.setup();
    const { container } = renderSidebar({ workspaceProjectIds: [tiled.id] });
    expect(virtualized(container)).toBe(true);
    const toggle = screen.getByRole("button", { name: /Other projects/ });
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    // The model holds all 199, the DOM only the rows in range (+ overscan).
    const mounted = container.querySelectorAll(".project-row").length;
    expect(mounted).toBeGreaterThan(1);
    expect(mounted).toBeLessThan(40);
    // The section header still counts all of them.
    expect(within(toggle).getByText("199")).toBeInTheDocument();
  });

  it("virtualizes an unscoped tree of many projects with few sessions", () => {
    projects = manyProjects(200);
    sessions = [makeSession({ id: 9_999_001, projectId: projects[0].id, command: "only one" })];
    const { container } = renderSidebar();
    expect(virtualized(container)).toBe(true);
    expect(container.querySelectorAll(".project-row").length).toBeLessThan(40);
    expect(screen.getByText("only one")).toBeInTheDocument();
  });

  it("stays on the plain path at or under the threshold (30 projects)", () => {
    projects = manyProjects(30);
    const { container } = renderSidebar();
    expect(virtualized(container)).toBe(false);
    expect(container.querySelectorAll(".project-row").length).toBe(30);
  });

  it("does not swap paths when Other projects opens or the filter is typed in", async () => {
    // 5 tiled + 30 others: over the project threshold whatever is open.
    projects = manyProjects(35);
    const user = userEvent.setup();
    const { container } = renderSidebar({
      workspaceProjectIds: projects.slice(0, 5).map((p) => p.id),
    });
    expect(virtualized(container)).toBe(true);
    await user.click(screen.getByRole("button", { name: /Other projects/ }));
    expect(virtualized(container)).toBe(true);
    await user.type(screen.getByLabelText("Filter sessions"), "zzz");
    // The filter hides Other projects; the strategy holds.
    expect(screen.getByText("No sessions match")).toBeInTheDocument();
  });

  it("keyboard: the collapse toggle keeps focus and flips; Enter on a row opens it", async () => {
    projects = manyProjects(40);
    const target = projects[0];
    sessions = [makeSession({ id: target.id * 10, projectId: target.id, command: "kb row" })];
    const onOpenSession = vi.fn();
    const user = userEvent.setup();
    const { container } = renderSidebar({ onOpenSession });
    expect(virtualized(container)).toBe(true);

    const open = screen.getByRole("button", { name: /Open session kb row/ });
    open.focus();
    await user.keyboard("{Enter}");
    expect(onOpenSession).toHaveBeenCalledTimes(1);

    const toggle = screen.getByRole("button", { name: target.name });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    toggle.focus();
    await user.keyboard("{Enter}");
    // Same DOM node (stable row key), still focused, now collapsed.
    expect(document.activeElement).toBe(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("kb row")).toBeNull();
    expect(JSON.parse(localStorage.getItem("crs.projectCollapsed")!)).toMatchObject({
      [target.id]: true,
    });
    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("kb row")).toBeInTheDocument();
  });

  it("drag: a session row on this path still carries its session id", () => {
    projects = manyProjects(40);
    sessions = [
      makeSession({ id: projects[0].id * 10, projectId: projects[0].id, command: "drag me" }),
    ];
    const { container } = renderSidebar();
    expect(virtualized(container)).toBe(true);
    const row = screen.getByText("drag me").closest(".session-item")!;
    const dataTransfer = createDataTransfer();
    const dragStart = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(dragStart, "dataTransfer", { value: dataTransfer });
    row.dispatchEvent(dragStart);
    expect(dataTransfer.getData("application/x-mullion-session")).toBe(String(projects[0].id * 10));
  });
});
