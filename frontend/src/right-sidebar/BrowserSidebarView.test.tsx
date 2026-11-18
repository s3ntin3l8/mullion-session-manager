// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserSidebarView } from "./BrowserSidebarView.js";
import { RightSidebar } from "./RightSidebar.js";
import type { RightSidebarActions } from "./views.js";
import { useDashboardStore } from "../store/index.js";
import type { Session } from "../api/index.js";
import { DEFAULT_SETTINGS } from "../api/index.js";
import type { LayoutTier } from "../lib/layoutTier.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { makeProject, makeSession } from "../test/fixtures.js";
import { mockFetch } from "../test/mockFetch.js";
import { resetStore } from "../test/resetStore.js";
import { SERVER_INFO_FIXTURE } from "../test/serverInfoFixture.js";

// Both engines are stand-ins: BrowserPane is the real browser client (its own
// tests cover it), and mounting it is what launches a session's browser.
// The preview stand-in writes an address back the way BrowserPanel does, so
// a test can see where that address is kept.
vi.mock("../BrowserPane.js", () => ({
  BrowserPane: ({
    params,
    toolbarStart,
  }: {
    params: { sessionId: number };
    toolbarStart?: ReactNode;
  }) => (
    <div data-testid="browser-pane" data-session-id={params.sessionId}>
      <div className="browser-panel-toolbar">{toolbarStart}</div>
    </div>
  ),
}));
vi.mock("../BrowserPanel.js", () => ({
  BrowserPanel: ({
    params,
    api,
    toolbarStart,
  }: {
    params: Record<string, unknown>;
    api?: { updateParameters: (p: object) => void };
    toolbarStart?: ReactNode;
  }) => (
    <div data-testid="preview" data-params={JSON.stringify(params)}>
      <div className="browser-panel-toolbar">
        {toolbarStart}
        <button
          type="button"
          onClick={() => api?.updateParameters({ ...params, url: "http://localhost:5173/typed" })}
        >
          Go somewhere
        </button>
      </div>
    </div>
  ),
}));

const actions = {} as RightSidebarActions;
const session = (id: number, over: Partial<Session> = {}) =>
  makeSession({ id, projectId: 1, name: `agent ${id}`, nameLocked: true, ...over });

const switchGroup = () => screen.getByRole("radiogroup", { name: "Browser mode" });
const previewRadio = () => within(switchGroup()).getByRole("radio", { name: "Preview" });
const agentRadio = () => within(switchGroup()).getByRole("radio", { name: /Agent's browser/ });
const previewParams = () =>
  JSON.parse(screen.getByTestId("preview").getAttribute("data-params")!) as Record<string, unknown>;
const visiblePreview = () => screen.getByTestId("preview").closest(".browser-host-body")!;

describe("BrowserSidebarView", () => {
  let bindings: Record<number, unknown[]>;
  let failProbe: boolean;
  let probes: number[];
  let browserEnabled: boolean;

  beforeEach(() => {
    bindings = {};
    failProbe = false;
    probes = [];
    browserEnabled = true;
    const { fetchMock } = mockFetch({
      "GET /api/sessions/:id/browser": ({ params }) => {
        const id = Number(params.id);
        probes.push(id);
        if (failProbe) return jsonResponse(500, { message: "boom" });
        return jsonResponse(200, bindings[id] ?? []);
      },
      "GET /api/server-info": () =>
        jsonResponse(200, {
          ...SERVER_INFO_FIXTURE,
          features: { ...SERVER_INFO_FIXTURE.features, browser: browserEnabled },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);
    resetStore({
      projects: [makeProject({ id: 1, name: "aurora" }), makeProject({ id: 2, name: "other" })],
      sessions: [session(5), session(6), session(9, { projectId: 2 })],
      activePanelId: null,
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const renderView = (projectId = 1) =>
    render(<BrowserSidebarView projectId={projectId} actions={actions} />);

  describe("Agent's browser follows the rail's session (#3012)", () => {
    it("opens in Agent's browser the first time", () => {
      renderView();
      expect(agentRadio()).toHaveAttribute("aria-checked", "true");
    });

    it("says so when no session of the project is in focus, and Preview still works", async () => {
      renderView();
      expect(screen.getByText(/No session in focus/)).toBeInTheDocument();
      expect(screen.queryByTestId("browser-pane")).toBeNull();
      await userEvent.click(previewRadio());
      expect(previewParams()).toEqual({ projectId: 1 });
      expect(visiblePreview()).not.toHaveAttribute("hidden");
      // The way back names why there is nothing to show.
      expect(agentRadio()).toHaveAttribute("aria-disabled", "true");
      expect(agentRadio()).toHaveAttribute("title", expect.stringMatching(/No session in focus/));
    });

    it("shows the focused session's browser when it has one", async () => {
      bindings[5] = [{ sessionId: 5 }];
      useDashboardStore.setState({ activePanelId: "session-5" });
      renderView();
      expect(await screen.findByTestId("browser-pane")).toHaveAttribute("data-session-id", "5");
      expect(agentRadio()).toHaveTextContent("Agent's browser · agent 5");
    });

    it("does not open a browser just because a session is focused", async () => {
      useDashboardStore.setState({ activePanelId: "session-5" });
      renderView();
      expect(await screen.findByText("agent 5 has no browser yet.")).toBeInTheDocument();
      expect(screen.queryByTestId("browser-pane")).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "Open browser" }));
      expect(screen.getByTestId("browser-pane")).toHaveAttribute("data-session-id", "5");
    });

    it("offers to open one when the probe fails", async () => {
      failProbe = true;
      useDashboardStore.setState({ activePanelId: "session-5" });
      renderView();
      expect(await screen.findByRole("button", { name: "Open browser" })).toBeInTheDocument();
    });

    it("follows the focused session and keeps the last one while a non-session pane has focus", async () => {
      bindings[5] = [{}];
      bindings[6] = [{}];
      useDashboardStore.setState({ activePanelId: "session-5" });
      renderView();
      expect(await screen.findByTestId("browser-pane")).toHaveAttribute("data-session-id", "5");
      act(() => useDashboardStore.setState({ activePanelId: "browserPane-6" }));
      expect(await screen.findByTestId("browser-pane")).toHaveAttribute("data-session-id", "6");
      act(() => useDashboardStore.setState({ activePanelId: "settings" }));
      expect(screen.getByTestId("browser-pane")).toHaveAttribute("data-session-id", "6");
    });

    it("ignores a session of another project and dock monitors", () => {
      useDashboardStore.setState({ activePanelId: "session-9" });
      const { unmount } = renderView();
      expect(screen.getByText(/No session in focus/)).toBeInTheDocument();
      unmount();
      useDashboardStore.setState({
        sessions: [session(5, { kind: "dock" })],
        activePanelId: "session-5",
      });
      renderView();
      expect(screen.getByText(/No session in focus/)).toBeInTheDocument();
      expect(probes).toEqual([]);
    });
  });

  describe("Preview (#3372)", () => {
    it("opens on the target an entry point asked for", () => {
      act(() =>
        useDashboardStore
          .getState()
          .openRailBrowserPreview({ projectId: 1, previewSlug: "s1", targetName: "web" }, 1),
      );
      renderView();
      expect(previewRadio()).toHaveAttribute("aria-checked", "true");
      expect(previewParams()).toEqual({ projectId: 1, previewSlug: "s1", targetName: "web" });
      expect(screen.queryByTestId("browser-pane")).toBeNull();
    });

    it("loads a new target while it is open", () => {
      act(() => useDashboardStore.getState().openRailBrowserPreview(null, 1));
      renderView();
      expect(previewParams()).toEqual({ projectId: 1 });
      act(() =>
        useDashboardStore.getState().openRailBrowserPreview({ projectId: 1, previewSlug: "s2" }, 1),
      );
      expect(previewParams()).toEqual({ projectId: 1, previewSlug: "s2" });
    });

    it("gives way to the project's own preview when the rail moves to another project", () => {
      act(() =>
        useDashboardStore.getState().openRailBrowserPreview({ projectId: 1, previewSlug: "s1" }, 1),
      );
      const { rerender } = renderView();
      rerender(<BrowserSidebarView projectId={2} actions={actions} />);
      expect(previewParams()).toEqual({ projectId: 2 });
    });

    it("keeps a blank or external address whatever project the rail shows", () => {
      act(() => useDashboardStore.getState().openRailBrowserPreview({ kind: "external" }));
      const { rerender } = renderView();
      rerender(<BrowserSidebarView projectId={2} actions={actions} />);
      expect(previewParams()).toEqual({ kind: "external" });
    });

    it("keeps the address the preview writes back", async () => {
      act(() => useDashboardStore.getState().openRailBrowserPreview(null, 1));
      const { unmount } = renderView();
      await userEvent.click(screen.getByRole("button", { name: "Go somewhere" }));
      unmount();
      renderView();
      expect(previewParams()).toEqual({ projectId: 1, url: "http://localhost:5173/typed" });
    });

    it("is Preview only, with no switch, without BROWSER_ENABLED", async () => {
      browserEnabled = false;
      renderView();
      expect(await screen.findByTestId("preview")).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByRole("radiogroup")).toBeNull());
      expect(visiblePreview()).not.toHaveAttribute("hidden");
      expect(probes).toEqual([]);
    });
  });

  describe("the mode it was last in (#3372)", () => {
    it("reopens in the mode the switch left it in", async () => {
      useDashboardStore.setState({ activePanelId: "session-5" });
      const { unmount } = renderView();
      await userEvent.click(previewRadio());
      unmount();
      renderView();
      expect(previewRadio()).toHaveAttribute("aria-checked", "true");
      await userEvent.click(agentRadio());
      expect(useDashboardStore.getState().railBrowser.mode).toBe("agent");
    });

    it("the palette's agent's browser entry opens it in Agent's browser", () => {
      act(() => useDashboardStore.getState().openRailBrowserPreview(null, 1));
      act(() => useDashboardStore.getState().openRailBrowserAgent(1));
      const s = useDashboardStore.getState();
      expect(s.railBrowser.mode).toBe("agent");
      expect(s.rightSidebarOpen).toBe(true);
      expect(s.rightSidebarView).toBe("browser");
      expect(s.rightSidebarProjectRequest?.projectId).toBe(1);
    });
  });
});

// Crossing 1100px (#3372): the view closes from 1100px, as it always did, but
// its mode and address are the store's, so the next open below 1100px finds
// them. Driven through the real panel and a real band change.
describe("BrowserSidebarView across 1100px", () => {
  const setLayoutMode = (layoutMode: "auto" | LayoutTier) =>
    useDashboardStore.setState({ settings: { ...DEFAULT_SETTINGS, layoutMode } });

  beforeEach(() => {
    localStorage.clear();
    const { fetchMock } = mockFetch({
      "GET /api/sessions/:id/browser": () => jsonResponse(200, []),
      "GET /api/server-info": () => jsonResponse(200, SERVER_INFO_FIXTURE),
    });
    vi.stubGlobal("fetch", fetchMock);
    resetStore({
      projects: [makeProject({ id: 1, name: "aurora" })],
      sessions: [session(5)],
      activePanelId: "session-5",
      followedProjectId: 1,
      rightSidebarView: "git",
      rightSidebarOpen: false,
    });
    setLayoutMode("tablet");
  });
  afterEach(() => vi.unstubAllGlobals());

  const renderSidebar = () => {
    const ui = (tier: LayoutTier) => (
      <RightSidebar
        tier={tier}
        actions={{ onOpenGit: vi.fn() } as unknown as RightSidebarActions}
      />
    );
    const result = render(ui("tablet"));
    return {
      cross: (tier: LayoutTier) => {
        act(() => setLayoutMode(tier));
        result.rerender(ui(tier));
      },
    };
  };

  it("keeps Preview and its address, crossing up and back down", async () => {
    const { cross } = renderSidebar();
    act(() =>
      useDashboardStore.getState().openRailBrowserPreview({ projectId: 1, previewSlug: "s1" }, 1),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Go somewhere" }));

    cross("desktop");
    await waitFor(() => expect(useDashboardStore.getState().rightSidebarOpen).toBe(false));
    expect(screen.queryByTestId("preview")).toBeNull();

    cross("tablet");
    act(() => useDashboardStore.getState().toggleRightSidebarView("browser"));
    expect(previewRadio()).toHaveAttribute("aria-checked", "true");
    expect(previewParams()).toEqual({
      projectId: 1,
      previewSlug: "s1",
      url: "http://localhost:5173/typed",
    });
  });

  it("keeps Agent's browser, crossing up and back down", async () => {
    const { cross } = renderSidebar();
    act(() => useDashboardStore.getState().openRailBrowserPreview(null, 1));
    await userEvent.click(agentRadio());
    expect(await screen.findByText("agent 5 has no browser yet.")).toBeInTheDocument();

    cross("desktop");
    await waitFor(() => expect(useDashboardStore.getState().rightSidebarOpen).toBe(false));

    cross("tablet");
    act(() => useDashboardStore.getState().toggleRightSidebarView("browser"));
    expect(agentRadio()).toHaveAttribute("aria-checked", "true");
    expect(await screen.findByText("agent 5 has no browser yet.")).toBeInTheDocument();
  });
});
