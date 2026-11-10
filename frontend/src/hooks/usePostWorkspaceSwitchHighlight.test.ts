// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { DockviewApi } from "dockview-react";
import type { LayoutContext } from "../lib/layoutTier.js";
import { makeProject, makeSession } from "../test/fixtures.js";
import { usePostWorkspaceSwitchHighlight } from "./usePostWorkspaceSwitchHighlight.js";
import type { UsePostWorkspaceSwitchHighlightParams } from "./usePostWorkspaceSwitchHighlight.js";

let highlightedPanelId: string | null = null;

function storeState() {
  return { highlightedPanelId };
}

vi.mock("../store/index.js", () => {
  const useDashboardStore = (selector?: (s: unknown) => unknown) => {
    const state = storeState();
    return selector ? selector(state) : state;
  };
  useDashboardStore.getState = storeState;
  return { useDashboardStore };
});

const layout: LayoutContext = { tier: "desktop", tabletPaneCap: 2 };

function fakePanel(id: string) {
  const setActive = vi.fn();
  return {
    id,
    setActive,
    api: {
      setActive,
      close: vi.fn(),
      location: { type: "grid" as const },
      updateParameters: vi.fn(),
    },
  };
}

function makeApi(panels: ReturnType<typeof fakePanel>[] = []) {
  return {
    panels,
    getPanel: (id: string) => panels.find((panel) => panel.id === id),
    addPanel: vi.fn((opts: { id: string }) => {
      const created = fakePanel(opts.id);
      panels.push(created);
      return created;
    }),
    maximizeGroup: vi.fn(),
  };
}

function renderHighlight(
  overrides: Partial<UsePostWorkspaceSwitchHighlightParams> & {
    api?: ReturnType<typeof makeApi> | null;
  } = {},
) {
  const { api: apiOverride, ...hookOverrides } = overrides;
  const api = apiOverride === undefined ? makeApi() : apiOverride;
  const lastHandledHighlightRef = hookOverrides.lastHandledHighlightRef ?? {
    current: null as string | null,
  };
  const initial: UsePostWorkspaceSwitchHighlightParams = {
    activeWorkspaceId: 1,
    sessions: [],
    layout,
    projects: [makeProject({ id: 1, name: "demo" })],
    lastHandledHighlightRef,
    ...hookOverrides,
    dockviewApi: api as unknown as DockviewApi | null,
  };
  const rendered = renderHook(
    (p: UsePostWorkspaceSwitchHighlightParams) => usePostWorkspaceSwitchHighlight(p),
    { initialProps: initial },
  );
  return { ...rendered, api, lastHandledHighlightRef };
}

beforeEach(() => {
  highlightedPanelId = null;
});

describe("usePostWorkspaceSwitchHighlight", () => {
  it("does nothing until a dockview api exists, and does not clear a handled id", () => {
    highlightedPanelId = "session-1";
    const lastHandledHighlightRef = { current: "keep" };
    renderHighlight({ api: null, lastHandledHighlightRef });
    expect(lastHandledHighlightRef.current).toBe("keep");
  });

  it("clears the handled id when the highlight goes away", () => {
    const lastHandledHighlightRef = { current: "session-1" };
    const { rerender, api } = renderHighlight({ lastHandledHighlightRef });
    expect(lastHandledHighlightRef.current).toBeNull();

    highlightedPanelId = "session-3";
    const panel = fakePanel("session-3");
    api!.panels.push(panel);
    rerender({
      dockviewApi: api as unknown as DockviewApi,
      activeWorkspaceId: 1,
      sessions: [],
      layout,
      projects: [makeProject({ id: 1, name: "demo" })],
      lastHandledHighlightRef,
    });
    expect(panel.setActive).toHaveBeenCalledTimes(1);
    expect(lastHandledHighlightRef.current).toBe("session-3");

    // Same highlight on a later sessions tick must not focus again.
    rerender({
      dockviewApi: api as unknown as DockviewApi,
      activeWorkspaceId: 1,
      sessions: [makeSession({ id: 3 })],
      layout,
      projects: [makeProject({ id: 1, name: "demo" })],
      lastHandledHighlightRef,
    });
    expect(panel.setActive).toHaveBeenCalledTimes(1);
  });

  it("ignores a highlight that is not a session panel", () => {
    highlightedPanelId = "timeline-4";
    const { api, lastHandledHighlightRef } = renderHighlight();
    expect(api!.addPanel).not.toHaveBeenCalled();
    expect(lastHandledHighlightRef.current).toBeNull();
  });

  it("waits for the session to load, then opens its terminal panel", () => {
    highlightedPanelId = "session-8";
    const session = makeSession({ id: 8, projectId: 1, lastTitle: "run" });
    const { rerender, api, lastHandledHighlightRef } = renderHighlight({ sessions: [] });
    expect(api!.addPanel).not.toHaveBeenCalled();
    expect(lastHandledHighlightRef.current).toBeNull();

    rerender({
      dockviewApi: api as unknown as DockviewApi,
      activeWorkspaceId: 1,
      sessions: [session],
      layout,
      projects: [makeProject({ id: 1, name: "demo" })],
      lastHandledHighlightRef,
    });
    expect(api!.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-8",
        component: "terminal",
        title: "run · demo",
        params: { sessionId: 8 },
      }),
    );
    expect(lastHandledHighlightRef.current).toBe("session-8");
  });

  it("focuses a different highlight after one was already handled", () => {
    highlightedPanelId = "session-1";
    const first = fakePanel("session-1");
    const second = fakePanel("session-2");
    const api = makeApi([first]);
    const { rerender, lastHandledHighlightRef } = renderHighlight({ api });
    expect(first.setActive).toHaveBeenCalledTimes(1);

    highlightedPanelId = "session-2";
    api.panels.push(second);
    rerender({
      dockviewApi: api as unknown as DockviewApi,
      activeWorkspaceId: 2,
      sessions: [],
      layout,
      projects: [],
      lastHandledHighlightRef,
    });
    expect(second.setActive).toHaveBeenCalledTimes(1);
    expect(lastHandledHighlightRef.current).toBe("session-2");
  });
});
