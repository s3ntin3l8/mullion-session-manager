// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useSyncExternalStore } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
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

// #3456 — a child spawned into another project than its coordinator's stays
// in its own project's tree and carries a "spawned by" marker back to it.
// The coordinator's own row title, not the copy of it inside a child's marker.
const coordinatorTitle = () =>
  screen.queryAllByText("coordinator agent").find((el) => !el.closest(".session-spawned-by"));

describe.each([
  ["below the virtualization threshold", 0],
  ["above the virtualization threshold", 25],
])("Sidebar cross-project spawned-by marker (#3456), %s", (_label, fillerCount) => {
  beforeEach(() => {
    if (fillerCount > 0) stubVirtualizerLayout();
    // Own project ids per case: the collapse state is module-level.
    const base = fillerCount > 0 ? 830 : 810;
    projects = [
      makeProject({ id: base, name: "coord-proj" }),
      makeProject({ id: base + 1, name: "worker-proj" }),
      makeProject({ id: base + 2, name: "filler-proj" }),
    ];
    sessions = [
      makeSession({ id: base * 10, projectId: base, command: "coordinator agent" }),
      makeSession({
        id: base * 10 + 1,
        projectId: base + 1,
        command: "spawned worker",
        parentSessionId: base * 10,
      }),
      ...Array.from({ length: fillerCount }, (_, i) =>
        makeSession({ id: base * 10 + 100 + i, projectId: base + 2, command: `filler-${i}` }),
      ),
    ];
  });

  it("marks the child in its own project, at depth 0, and badges the coordinator", () => {
    renderSidebar();
    const child = screen.getByText("spawned worker").closest(".session-item") as HTMLElement;
    expect(child.style.getPropertyValue("--session-depth")).toBe("");
    expect(
      within(child).getByRole("button", { name: /spawned by coordinator agent · coord-proj/ }),
    ).toBeInTheDocument();
    const parent = coordinatorTitle()!.closest(".session-item") as HTMLElement;
    expect(within(parent).getByText("+1 in other projects")).toHaveAttribute(
      "title",
      "In worker-proj",
    );
    expect(within(parent).queryByRole("button", { name: /spawned by/ })).toBeNull();
  });

  it("opens the coordinator from the marker without opening the child, expanding a collapsed project", async () => {
    const onOpenSession = vi.fn();
    const user = userEvent.setup();
    renderSidebar({ onOpenSession });
    await user.click(screen.getByText("coord-proj"));
    expect(coordinatorTitle()).toBeUndefined();
    await user.click(screen.getByRole("button", { name: /spawned by coordinator agent/ }));
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(onOpenSession.mock.calls[0][0].command).toBe("coordinator agent");
    await waitFor(() => expect(coordinatorTitle()).toBeDefined());
  });

  it("shows plain text with no link once the coordinator is killed", () => {
    sessions = sessions.map((s) =>
      s.command === "coordinator agent" ? { ...s, status: "killed" } : s,
    );
    renderSidebar();
    expect(screen.getByText("spawned by a removed session").tagName).toBe("SPAN");
    expect(screen.queryByRole("button", { name: /spawned by/ })).toBeNull();
  });
});

// #3062 — with many projects the tree virtualizes on project count, and the
// coordinator's row can be far outside the mounted window: the marker asks
// the virtualizer to scroll there, so the row mounts instead of the scroll
// being skipped.
describe("Sidebar spawned-by marker, coordinator outside the virtualized window (#3062)", () => {
  it("scrolls the virtualizer to the coordinator's row and mounts it", async () => {
    stubVirtualizerLayout();
    // jsdom does no scrolling: let the scroll container take the offset the
    // virtualizer asks for and announce it, as a browser would.
    const scrollTo = vi.fn(function (this: HTMLElement, opts?: ScrollToOptions) {
      Object.defineProperty(this, "scrollTop", { configurable: true, value: opts?.top ?? 0 });
      this.dispatchEvent(new Event("scroll"));
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      writable: true,
      value: scrollTo,
    });
    // The scrollable extent the virtualizer clamps its target to.
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 10_000,
    });
    const base = 870;
    projects = Array.from({ length: 60 }, (_, i) =>
      makeProject({ id: base * 100 + i, name: `p-${i}` }),
    );
    const workerProject = projects[0];
    const coordProject = projects[59];
    sessions = [
      makeSession({ id: base * 1000, projectId: coordProject.id, command: "coordinator agent" }),
      makeSession({
        id: base * 1000 + 1,
        projectId: workerProject.id,
        command: "spawned worker",
        parentSessionId: base * 1000,
      }),
    ];
    const onOpenSession = vi.fn();
    const user = userEvent.setup();
    const { container } = renderSidebar({ onOpenSession });
    expect(container.querySelector("[data-index]")).not.toBeNull();
    expect(coordinatorTitle()).toBeUndefined();
    await user.click(screen.getByRole("button", { name: /spawned by coordinator agent/ }));
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(coordinatorTitle()).toBeDefined());
    expect(scrollTo).toHaveBeenCalled();
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    delete (HTMLElement.prototype as { scrollHeight?: unknown }).scrollHeight;
  });
});
