// @vitest-environment jsdom
// Dock's "Detected dev server on :PORT — use it?" row (issue #2080) — shown
// from the passive `detectedDevServerPort` on GET /api/projects when a dock
// control started a dev server and the project has no devServerUrl yet.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dock } from "../Dock.js";
import { useDashboardStore } from "../store/index.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { makeProject } from "../test/fixtures.js";
import { mockFetch } from "../test/mockFetch.js";
import { resetStore } from "../test/resetStore.js";

vi.mock("../TerminalPane.js", () => ({
  TerminalPane: () => <div data-testid="terminal-pane" />,
}));

const PROJECT = makeProject({ id: 1, name: "mullion", cwd: "/home/x/mullion" });

let dock: unknown[] = [];

describe("Dock — detected dev server row", () => {
  beforeEach(() => {
    localStorage.clear();
    dock = [];
    const { fetchMock } = mockFetch({
      "GET /api/projects/:id/dock": () => jsonResponse(200, dock),
      "GET /api/projects/:id/github": () => new Response(null, { status: 204 }),
      "GET /api/projects/:id/github/prs": () => new Response(null, { status: 204 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "ResizeObserver",
      vi.fn(function () {
        return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
      }),
    );
    resetStore({ projects: [PROJECT], sessions: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  function renderDock() {
    return render(
      <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
    );
  }

  it("offers the detected port and sets devServerUrl via updateProject on click", async () => {
    const updateProject = vi.fn().mockResolvedValue({ ok: true });
    useDashboardStore.setState({
      projects: [{ ...PROJECT, devServerUrl: null, detectedDevServerPort: "3200" }],
      updateProject,
    });
    const user = userEvent.setup();
    renderDock();

    await user.click(await screen.findByText("Detected dev server on :3200 — use it?"));

    expect(updateProject).toHaveBeenCalledWith(1, { devServerUrl: "3200" });
  });

  it("also shows when the group has configured controls", async () => {
    dock = [{ id: "dev", title: "Dev server", command: "make dev-web" }];
    useDashboardStore.setState({
      projects: [{ ...PROJECT, devServerUrl: null, detectedDevServerPort: "3200" }],
    });
    renderDock();

    expect(await screen.findByText("Dev server")).toBeInTheDocument();
    expect(screen.getByText("Detected dev server on :3200 — use it?")).toBeInTheDocument();
  });

  it("is hidden once the project has a devServerUrl", async () => {
    useDashboardStore.setState({
      projects: [{ ...PROJECT, devServerUrl: "3200", detectedDevServerPort: "3200" }],
    });
    renderDock();

    expect(await screen.findByText("3200")).toBeInTheDocument();
    expect(screen.queryByText(/Detected dev server/)).not.toBeInTheDocument();
  });

  it("is hidden when nothing was detected", async () => {
    renderDock();

    expect(await screen.findByText("No monitors configured")).toBeInTheDocument();
    expect(screen.queryByText(/Detected dev server/)).not.toBeInTheDocument();
  });
});
