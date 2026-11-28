// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useSyncExternalStore } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "./Sidebar.js";
import type { SidebarProps } from "./Sidebar.js";
import type * as ApiModule from "./api/index.js";
import type { Device, GitStatus, Host, Project, Session, Task } from "./api/index.js";
import { makeProject } from "./test/fixtures.js";

// #3537 — projects pinned to a workspace, in the sidebar tree and its
// project menu. Split from Sidebar.test.tsx (its size ceiling); the store
// mock below is that file's. Mirrors UnifiedBoard.test.tsx's
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
// #3537 — the workspaces' own project pins.
let workspaces: { id: number; pinnedProjectIds: number[] }[];
const setWorkspacePinnedProjects = vi.fn(async (id: number, ids: number[]) => {
  workspaces = workspaces.map((w) => (w.id === id ? { ...w, pinnedProjectIds: ids } : w));
  storeEpoch += 1;
  for (const listener of [...storeListeners]) listener();
});
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
    workspaces,
    setWorkspacePinnedProjects,
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
  workspaces = [];
  setWorkspacePinnedProjects.mockClear();
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

describe("workspace pins (#3537)", () => {
  const scopedNames = () =>
    [...document.querySelectorAll(".project-row-name")]
      .filter((el) => !el.closest(".sidebar-other-projects"))
      .map((el) => el.textContent);
  const rerenderWith = (view: ReturnType<typeof renderSidebar>, ids: number[] | null) =>
    view.rerender(
      <div className="sidebar-wrapper">
        <Sidebar {...NOOP_PROPS} workspaceProjectIds={ids} />
      </div>,
    );
  beforeEach(() => {
    projects = [
      makeProject({ id: 1, name: "alpha" }),
      makeProject({ id: 2, name: "beta" }),
      makeProject({ id: 3, name: "gamma" }),
    ];
  });

  it("lists a pinned project with nothing tiled, after the tiled ones, with a pin marker", () => {
    workspaces = [{ id: activeWorkspaceId!, pinnedProjectIds: [3] }];
    renderSidebar({ workspaceProjectIds: [1] });

    expect(scopedNames()).toEqual(["alpha", "gamma"]);
    const gammaRow = screen.getByText("gamma").closest(".project-row") as HTMLElement;
    expect(within(gammaRow).getByLabelText("Pinned to this workspace")).toBeInTheDocument();
    const alphaRow = screen.getByText("alpha").closest(".project-row") as HTMLElement;
    expect(within(alphaRow).queryByLabelText("Pinned to this workspace")).toBeNull();
  });

  it("shows the pinned projects instead of an empty tree when nothing is tiled", () => {
    workspaces = [{ id: activeWorkspaceId!, pinnedProjectIds: [2] }];
    renderSidebar({ workspaceProjectIds: [] });

    expect(scopedNames()).toEqual(["beta"]);
    // Not an empty workspace any more, so the section keeps its default.
    expect(screen.getByRole("button", { name: /Other projects/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("does not list the pin in another workspace", () => {
    const pinnedIn = activeWorkspaceId!;
    workspaces = [
      { id: pinnedIn, pinnedProjectIds: [2] },
      { id: pinnedIn + 1000, pinnedProjectIds: [] },
    ];
    const view = renderSidebar({ workspaceProjectIds: [1] });
    expect(scopedNames()).toEqual(["alpha", "beta"]);

    activeWorkspaceId = pinnedIn + 1000;
    rerenderWith(view, [1]);
    expect(scopedNames()).toEqual(["alpha"]);
  });

  it("pins and unpins from the project menu", async () => {
    workspaces = [{ id: activeWorkspaceId!, pinnedProjectIds: [] }];
    const user = userEvent.setup();
    renderSidebar({ workspaceProjectIds: [1] });

    const alphaRow = screen.getByText("alpha").closest(".project-row") as HTMLElement;
    await user.click(within(alphaRow).getByTitle("More…"));
    await user.click(await screen.findByText("Pin to this workspace"));
    expect(setWorkspacePinnedProjects).toHaveBeenLastCalledWith(activeWorkspaceId, [1]);
    expect(await within(alphaRow).findByLabelText("Pinned to this workspace")).toBeInTheDocument();

    await user.click(within(alphaRow).getByTitle("More…"));
    await user.click(await screen.findByText("Unpin from this workspace"));
    expect(setWorkspacePinnedProjects).toHaveBeenLastCalledWith(activeWorkspaceId, []);
  });

  it("pins a project from the Other projects section", async () => {
    workspaces = [{ id: activeWorkspaceId!, pinnedProjectIds: [] }];
    const user = userEvent.setup();
    renderSidebar({ workspaceProjectIds: [1] });
    await user.click(screen.getByRole("button", { name: /Other projects/ }));

    const betaRow = screen.getByText("beta").closest(".project-row") as HTMLElement;
    await user.click(within(betaRow).getByTitle("More…"));
    await user.click(await screen.findByText("Pin to this workspace"));
    expect(setWorkspacePinnedProjects).toHaveBeenLastCalledWith(activeWorkspaceId, [2]);
    expect(scopedNames()).toEqual(["alpha", "beta"]);
  });

  it("reports a failed pin from Other projects, whose row moves away", async () => {
    workspaces = [{ id: activeWorkspaceId!, pinnedProjectIds: [] }];
    setWorkspacePinnedProjects.mockImplementationOnce(async (id: number, ids: number[]) => {
      // Optimistic move into the tree, then the server refuses.
      workspaces = workspaces.map((w) => (w.id === id ? { ...w, pinnedProjectIds: ids } : w));
      throw new Error("Workspace is gone");
    });
    const user = userEvent.setup();
    renderSidebar({ workspaceProjectIds: [1] });
    await user.click(screen.getByRole("button", { name: /Other projects/ }));

    const betaRow = screen.getByText("beta").closest(".project-row") as HTMLElement;
    await user.click(within(betaRow).getByTitle("More…"));
    await user.click(await screen.findByText("Pin to this workspace"));
    await waitFor(() =>
      expect(reportError).toHaveBeenCalledWith(
        "Could not update the workspace pin",
        "Workspace is gone",
      ),
    );
  });

  it("offers no pin when the tree is not workspace-scoped (phone)", async () => {
    workspaces = [{ id: activeWorkspaceId!, pinnedProjectIds: [1] }];
    const user = userEvent.setup();
    projects = [makeProject({ id: 1, name: "alpha" })];
    renderSidebar({ workspaceProjectIds: null });

    expect(screen.queryByLabelText("Pinned to this workspace")).toBeNull();
    await user.click(screen.getByTitle("More…"));
    await screen.findByText("Edit");
    expect(screen.queryByText(/to this workspace|from this workspace/)).toBeNull();
  });
});
