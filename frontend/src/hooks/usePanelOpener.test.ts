// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { SetStateAction } from "react";
import { usePanelOpener } from "./usePanelOpener.js";
import type { DockviewApi } from "dockview-react";
import { makeProject, makeSession, makeWorkspace } from "../test/fixtures.js";

// Same store-mock shape as useDockviewDrop.test.ts/useSessionDeepLink.test.ts —
// a `storeState()` factory serving `useDashboardStore.getState()`, the only
// call form this hook uses (triggerPanelHighlight/setActiveWorkspaceId/
// setViewMode).
const triggerPanelHighlight = vi.fn();
const setActiveWorkspaceId = vi.fn();
const setViewMode = vi.fn();

function storeState() {
  return { triggerPanelHighlight, setActiveWorkspaceId, setViewMode };
}

vi.mock("../store/index.js", () => {
  const useDashboardStore = (selector?: (s: unknown) => unknown) => {
    const state = storeState();
    return selector ? selector(state) : state;
  };
  useDashboardStore.getState = storeState;
  return { useDashboardStore };
});

// Mirrors panelUtils.test.ts's own mockDockviewApi/mockPanel — the shared
// openOrFocusProjectPanel/openSessionPanel/openTimelinePanel helpers this
// hook wires up are exercised for real (not mocked) here, since the point
// of these tests is proving the wiring/parameterization, not re-testing
// those helpers' own branching (already covered in panelUtils.test.ts).
function mockPanel(id: string, locationType: "grid" | "floating" = "grid", overrides = {}) {
  return {
    id,
    api: { setActive: vi.fn(), close: vi.fn(), location: { type: locationType } },
    ...overrides,
  } as unknown as ReturnType<DockviewApi["getPanel"]>;
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

const PROJECTS = [makeProject({ id: 1, name: "project-alpha" })];
const SESSION = makeSession({ id: 1, projectId: 1 });

let setSidebarOpen: ReturnType<typeof vi.fn<(value: SetStateAction<boolean>) => void>>;

beforeEach(() => {
  setSidebarOpen = vi.fn<(value: SetStateAction<boolean>) => void>();
  triggerPanelHighlight.mockClear();
  setActiveWorkspaceId.mockClear();
  setViewMode.mockClear();
});

interface SetupProps {
  dockviewApi: DockviewApi | null;
  isMobile: boolean;
  projects: typeof PROJECTS;
  workspaces: ReturnType<typeof makeWorkspace>[];
  activeWorkspaceId: number | null;
}

function setup(overrides: Partial<SetupProps> = {}) {
  const initialProps: SetupProps = {
    dockviewApi: null,
    isMobile: false,
    projects: PROJECTS,
    workspaces: [],
    activeWorkspaceId: 1,
    ...overrides,
  };
  return renderHook((props: SetupProps) => usePanelOpener({ ...props, setSidebarOpen }), {
    initialProps,
  });
}

describe("usePanelOpener — onOpenSession", () => {
  it("focuses an existing panel and highlights it, without a cross-workspace switch", () => {
    const api = mockDockviewApi();
    api.addPanel({ id: "session-1", component: "terminal", params: {} });
    const { result } = setup({ dockviewApi: api });

    result.current.onOpenSession(SESSION);

    expect(triggerPanelHighlight).toHaveBeenCalledWith("session-1");
    expect(setActiveWorkspaceId).not.toHaveBeenCalled();
    expect(setSidebarOpen).toHaveBeenCalledWith(false);
  });

  it("switches workspace and highlights (not opens locally) when the session's panel lives elsewhere", () => {
    const api = mockDockviewApi();
    const otherWorkspace = makeWorkspace({
      id: 2,
      layout: { sessionId: 1 } as Record<string, unknown>,
    });
    const { result } = setup({
      dockviewApi: api,
      workspaces: [makeWorkspace({ id: 1, layout: null }), otherWorkspace],
      activeWorkspaceId: 1,
    });

    result.current.onOpenSession(SESSION);

    expect(setActiveWorkspaceId).toHaveBeenCalledWith(2);
    expect(triggerPanelHighlight).toHaveBeenCalledWith("session-1");
    expect(api.addPanel).not.toHaveBeenCalled();
  });

  it("opens a new panel locally when no other workspace claims the session", () => {
    const api = mockDockviewApi();
    const { result } = setup({ dockviewApi: api, workspaces: [], activeWorkspaceId: 1 });

    result.current.onOpenSession(SESSION);

    expect(api.addPanel).toHaveBeenCalledWith(expect.objectContaining({ id: "session-1" }));
    expect(setActiveWorkspaceId).not.toHaveBeenCalled();
  });

  it("no-ops when dockviewApi is null", () => {
    const { result } = setup({ dockviewApi: null });
    expect(() => result.current.onOpenSession(SESSION)).not.toThrow();
    expect(setSidebarOpen).not.toHaveBeenCalled();
  });

  // Not a churn-regression guard by itself — usePanelOpener deliberately has
  // no `sessions` param at all (see UsePanelOpenerParams's own `workspaces`
  // doc comment), which is what actually makes onOpenSession's identity
  // immune to the 4s sessions poll tick useSessionDeepLink's effect
  // dependency array relies on. This just proves useCallback's own
  // memoization is wired up (unchanged references in -> unchanged reference
  // out), i.e. that nothing here accidentally rebuilds the callback (or a
  // config object it closes over) on every render.
  it("memoizes onOpenSession across a render with reference-identical inputs", () => {
    const api = mockDockviewApi();
    const workspaces = [makeWorkspace({ id: 1 })];
    const { result, rerender } = setup({ dockviewApi: api, workspaces, activeWorkspaceId: 1 });
    const first = result.current.onOpenSession;
    rerender({
      dockviewApi: api,
      isMobile: false,
      projects: PROJECTS,
      workspaces,
      activeWorkspaceId: 1,
    });
    expect(result.current.onOpenSession).toBe(first);
  });

  it("changes identity when a dependency (e.g. projects) changes — proving it isn't over-memoized", () => {
    const api = mockDockviewApi();
    const { result, rerender } = setup({ dockviewApi: api });
    const first = result.current.onOpenSession;
    rerender({
      dockviewApi: api,
      isMobile: false,
      projects: [makeProject({ id: 2, name: "other" })],
      workspaces: [],
      activeWorkspaceId: 1,
    });
    expect(result.current.onOpenSession).not.toBe(first);
  });
});

describe("usePanelOpener — onOpenSessionAsFloat", () => {
  it("always opens locally, even when the session's panel lives in a different workspace", () => {
    const api = mockDockviewApi();
    const otherWorkspace = makeWorkspace({
      id: 2,
      layout: { sessionId: 1 } as Record<string, unknown>,
    });
    const { result } = setup({
      dockviewApi: api,
      workspaces: [makeWorkspace({ id: 1, layout: null }), otherWorkspace],
      activeWorkspaceId: 1,
    });

    result.current.onOpenSessionAsFloat(SESSION);

    expect(setActiveWorkspaceId).not.toHaveBeenCalled();
    expect(triggerPanelHighlight).not.toHaveBeenCalled();
    expect(api.addPanel).toHaveBeenCalledWith(expect.objectContaining({ id: "session-1" }));
    expect(setSidebarOpen).toHaveBeenCalledWith(false);
  });

  it("no-ops when dockviewApi is null", () => {
    const { result } = setup({ dockviewApi: null });
    expect(() => result.current.onOpenSessionAsFloat(SESSION)).not.toThrow();
    expect(setSidebarOpen).not.toHaveBeenCalled();
  });
});

describe("usePanelOpener — onOpenTimeline", () => {
  it("opens the session's timeline panel", () => {
    const api = mockDockviewApi();
    const { result } = setup({ dockviewApi: api });

    result.current.onOpenTimeline(SESSION);

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "timeline-1", component: "timeline" }),
    );
    expect(setSidebarOpen).toHaveBeenCalledWith(false);
  });

  it("no-ops when dockviewApi is null", () => {
    const { result } = setup({ dockviewApi: null });
    expect(() => result.current.onOpenTimeline(SESSION)).not.toThrow();
    expect(setSidebarOpen).not.toHaveBeenCalled();
  });
});

// One test per project-scoped panel kind — proves the config table
// (usePanelOpener.ts's GITHUB_CONFIG/GIT_CONFIG/etc.) reaches
// openOrFocusProjectPanel correctly. The open-or-focus/float-if-tiled
// branching itself is panelUtils.test.ts's concern (openOrFocusProjectPanel
// is exercised for real, not mocked, here).
describe("usePanelOpener — project-scoped panel kinds", () => {
  it.each([
    ["onOpenGitHub", "github", "GitHub: project-alpha"],
    ["onOpenGit", "git", "Git: project-alpha"],
    ["onOpenAgentRules", "agent-rules", "Agent Rules: project-alpha"],
    ["onOpenDockConfig", "dock-config", "Dock: project-alpha"],
    ["onOpenSkills", "skills", "Skills: project-alpha"],
    ["onOpenBrowser", "browser", "Preview: project-alpha"],
  ] as const)("%s opens a %s-<projectId> panel titled %s", (fnName, kind, title) => {
    const api = mockDockviewApi();
    const { result } = setup({ dockviewApi: api });

    (result.current[fnName] as (projectId: number) => void)(1);

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `${kind}-1`,
        component: kind,
        title,
        params: { projectId: 1 },
      }),
    );
    expect(setSidebarOpen).toHaveBeenCalledWith(false);
  });

  it("onOpenBrowser omits desktop positioning even with a tiled panel present (pre-existing asymmetry, deliberately preserved)", () => {
    const api = mockDockviewApi();
    api.addPanel({ id: "session-1", component: "terminal", params: {} }); // tiled
    const { result } = setup({ dockviewApi: api });

    result.current.onOpenBrowser(1);

    const browserCall = (api.addPanel as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0].id === "browser-1",
    )![0];
    expect(browserCall).not.toHaveProperty("floating");
    expect(browserCall).not.toHaveProperty("position");
  });

  it("every other panel kind DOES apply desktop positioning with a tiled panel present", () => {
    const api = mockDockviewApi();
    api.addPanel({ id: "session-1", component: "terminal", params: {} }); // tiled
    const { result } = setup({ dockviewApi: api });

    result.current.onOpenGitHub(1);

    const githubCall = (api.addPanel as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0].id === "github-1",
    )![0];
    expect(githubCall).toHaveProperty("floating", true);
  });

  it.each([
    "onOpenGitHub",
    "onOpenGit",
    "onOpenAgentRules",
    "onOpenDockConfig",
    "onOpenSkills",
    "onOpenBrowser",
  ] as const)("%s no-ops when dockviewApi is null", (fnName) => {
    const { result } = setup({ dockviewApi: null });
    expect(() => (result.current[fnName] as (projectId: number) => void)(1)).not.toThrow();
    expect(setSidebarOpen).not.toHaveBeenCalled();
  });
});

describe("usePanelOpener — onOpenTasks", () => {
  it("switches the view mode to kanban and never touches dockviewApi", () => {
    const { result } = setup({ dockviewApi: null });

    result.current.onOpenTasks();

    expect(setViewMode).toHaveBeenCalledWith("kanban");
    expect(setSidebarOpen).toHaveBeenCalledWith(false);
  });
});

describe("usePanelOpener — onOpenBrowserUrl", () => {
  it("always creates a fresh external browser panel, never open-or-focus", () => {
    const api = mockDockviewApi();
    const { result } = setup({ dockviewApi: api });

    result.current.onOpenBrowserUrl(1, "https://example.com", "Example");
    result.current.onOpenBrowserUrl(1, "https://example.com", "Example");

    expect(api.addPanel).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = (api.addPanel as ReturnType<typeof vi.fn>).mock.calls;
    expect(firstCall[0].id).not.toBe(secondCall[0].id);
    expect(firstCall[0]).toEqual(
      expect.objectContaining({
        component: "browser",
        title: "Example",
        params: { kind: "external", url: "https://example.com", projectId: 1 },
      }),
    );
    expect(String(firstCall[0].id)).toMatch(/^browser-url-1-/);
  });

  it("no-ops when dockviewApi is null", () => {
    const { result } = setup({ dockviewApi: null });
    expect(() =>
      result.current.onOpenBrowserUrl(1, "https://example.com", "Example"),
    ).not.toThrow();
  });

  it("maximizes the group on mobile", () => {
    const api = mockDockviewApi();
    const { result } = setup({ dockviewApi: api, isMobile: true });

    result.current.onOpenBrowserUrl(1, "https://example.com", "Example");

    expect(api.maximizeGroup).toHaveBeenCalledTimes(1);
  });
});

describe("usePanelOpener — onOpenBlankBrowser", () => {
  it("always creates a fresh empty external browser panel, never open-or-focus", () => {
    const api = mockDockviewApi();
    const { result } = setup({ dockviewApi: api });

    result.current.onOpenBlankBrowser();
    result.current.onOpenBlankBrowser();

    expect(api.addPanel).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = (api.addPanel as ReturnType<typeof vi.fn>).mock.calls;
    expect(firstCall[0].id).not.toBe(secondCall[0].id);
    expect(firstCall[0]).toEqual(
      expect.objectContaining({
        component: "browser",
        title: "Preview",
        params: { kind: "external" },
      }),
    );
    expect(String(firstCall[0].id)).toMatch(/^browser-ext-/);
  });

  it("maximizes the group on mobile", () => {
    const api = mockDockviewApi();
    const { result } = setup({ dockviewApi: api, isMobile: true });

    result.current.onOpenBlankBrowser();

    expect(api.maximizeGroup).toHaveBeenCalledTimes(1);
  });

  it("no-ops when dockviewApi is null", () => {
    const { result } = setup({ dockviewApi: null });
    expect(() => result.current.onOpenBlankBrowser()).not.toThrow();
    expect(setSidebarOpen).not.toHaveBeenCalled();
  });
});
