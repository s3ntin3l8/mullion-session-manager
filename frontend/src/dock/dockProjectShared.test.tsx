// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import { Dock } from "../Dock.js";
import { DockSidebarView } from "../right-sidebar/DockSidebarView.js";
import type { RightSidebarActions } from "../right-sidebar/views.js";
import { useDashboardStore } from "../store/index.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { makeProject } from "../test/fixtures.js";
import { mockFetch } from "../test/mockFetch.js";
import { resetStore } from "../test/resetStore.js";
import { DOCKER_POLL_INTERVAL_MS } from "./dockProjectShared.js";

// #3036 — the bottom Dock's DockProjectGroup and the right sidebar's Dock
// view, mounted together for one project, share one poll of its dock list.

vi.mock("../TerminalPane.js", () => ({
  TerminalPane: () => <div data-testid="terminal-pane" />,
}));

const PROJECT = makeProject({ id: 1, name: "aurora-web", cwd: "/home/x/aurora" });
const actions = { onOpenDockConfig: vi.fn() } as unknown as RightSidebarActions;

const service = (state: string) => ({
  id: "docker:aurora-dev:api",
  title: "api",
  command: "docker compose logs -f api",
  source: "docker",
  docker: {
    composeProject: "aurora-dev",
    service: "api",
    containerName: "aurora-dev-api-1",
    state,
    status: state,
    imageRef: "ghcr.io/x/api:1.4.2",
    imageId: "sha256:aaa",
    buildable: false,
    pullable: true,
  },
});

let controls: unknown[];
let fetchMock: ReturnType<typeof vi.fn>;

const dockFetches = () =>
  fetchMock.mock.calls.filter(([url, init]) => {
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    return method === "GET" && /\/api\/projects\/1\/dock$/.test(String(url));
  }).length;

// Lets the fetch promises and the state they set settle.
const flush = () => act(async () => {});

const tick = () =>
  act(async () => {
    vi.advanceTimersByTime(DOCKER_POLL_INTERVAL_MS);
  });

describe("one shared dock poll per project (#3036)", () => {
  beforeEach(() => {
    // Only the interval is faked: promises, and the timeouts the components
    // use, run as usual.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    localStorage.clear();
    controls = [service("running")];
    ({ fetchMock } = mockFetch({
      "GET /api/projects/:id/dock": () => jsonResponse(200, controls),
      "GET /api/projects/:id/github": () => jsonResponse(204),
      "GET /api/projects/:id/github/prs": () => jsonResponse(204),
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "ResizeObserver",
      vi.fn(function () {
        return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
      }),
    );
    resetStore({ projects: [PROJECT], sessions: [] });
    useDashboardStore.setState({ sessionsLoaded: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const renderBoth = () =>
    render(
      <>
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />
        <DockSidebarView projectId={1} actions={actions} />
      </>,
    );

  it("fetches once per interval with the bottom Dock and the Dock view both mounted", async () => {
    renderBoth();
    await flush();
    expect(dockFetches()).toBe(1);
    await tick();
    expect(dockFetches()).toBe(2);
    await tick();
    expect(dockFetches()).toBe(3);
  });

  it("shows both surfaces the same state after each fetch", async () => {
    renderBoth();
    await flush();
    const view = screen.getByRole("region", { name: "Stack aurora-dev" });
    expect(within(view).getByRole("button", { name: /^api, running/ })).toBeInTheDocument();
    controls = [service("exited")];
    await tick();
    expect(within(view).getByRole("button", { name: /^api, exited/ })).toBeInTheDocument();
    // The bottom Dock's row shows the same state from the same fetch.
    expect(dockFetches()).toBe(2);
    expect(document.querySelector(".dock")?.textContent).toMatch(/exited/i);
  });

  it("re-fetches once for every surface when the dock config changes", async () => {
    renderBoth();
    await flush();
    expect(dockFetches()).toBe(1);
    act(() => {
      useDashboardStore.setState((s) => ({
        dockConfigRefreshTrigger: s.dockConfigRefreshTrigger + 1,
      }));
    });
    await flush();
    expect(dockFetches()).toBe(2);
  });

  it("keeps polling while one surface is mounted and stops when the last one leaves", async () => {
    const view = render(<DockSidebarView projectId={1} actions={actions} />);
    const dock = render(
      <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
    );
    await flush();
    expect(dockFetches()).toBe(1);
    view.unmount();
    await tick();
    expect(dockFetches()).toBe(2);
    dock.unmount();
    await tick();
    expect(dockFetches()).toBe(2);
  });
});
