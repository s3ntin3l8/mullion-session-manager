// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserSidebarView } from "./BrowserSidebarView.js";
import type { RightSidebarActions } from "./views.js";
import { useDashboardStore } from "../store/index.js";
import type { Session } from "../api/index.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { makeProject, makeSession } from "../test/fixtures.js";
import { mockFetch } from "../test/mockFetch.js";
import { resetStore } from "../test/resetStore.js";

// BrowserPane is the real browser client (its own tests cover it); here it is
// a stand-in, because mounting it is what launches a session's browser.
vi.mock("../BrowserPane.js", () => ({
  BrowserPane: ({ params }: { params: { sessionId: number } }) => (
    <div data-testid="browser-pane" data-session-id={params.sessionId} />
  ),
}));

const actions = {} as RightSidebarActions;
const session = (id: number, over: Partial<Session> = {}) =>
  makeSession({ id, projectId: 1, name: `agent ${id}`, nameLocked: true, ...over });

describe("BrowserSidebarView (#3012)", () => {
  let bindings: Record<number, unknown[]>;
  let failProbe: boolean;
  let probes: number[];

  beforeEach(() => {
    bindings = {};
    failProbe = false;
    probes = [];
    const { fetchMock } = mockFetch({
      "GET /api/sessions/:id/browser": ({ params }) => {
        const id = Number(params.id);
        probes.push(id);
        if (failProbe) return jsonResponse(500, { message: "boom" });
        return jsonResponse(200, bindings[id] ?? []);
      },
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

  it("says so when no session of the project is in focus", () => {
    renderView();
    expect(screen.getByText(/No session in focus/)).toBeInTheDocument();
    expect(screen.queryByTestId("browser-pane")).toBeNull();
  });

  it("shows the focused session's browser when it has one", async () => {
    bindings[5] = [{ sessionId: 5 }];
    useDashboardStore.setState({ activePanelId: "session-5" });
    renderView();
    expect(await screen.findByTestId("browser-pane")).toHaveAttribute("data-session-id", "5");
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

  it("keeps the last eligible session while another project's session has focus", async () => {
    bindings[5] = [{}];
    useDashboardStore.setState({ activePanelId: "session-5" });
    renderView();
    expect(await screen.findByTestId("browser-pane")).toHaveAttribute("data-session-id", "5");
    act(() => useDashboardStore.setState({ activePanelId: "session-9" }));
    expect(screen.getByTestId("browser-pane")).toHaveAttribute("data-session-id", "5");
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
