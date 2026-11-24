// @vitest-environment jsdom
// Issue #1264 — the rail and pane dividers are focusable window splitters.
// Split out of DockMonitor.test.tsx (its line-count ceiling is a ratchet).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dock } from "../Dock.js";
import { useDashboardStore } from "../store/index.js";
import { makeProject, makeSession } from "../test/fixtures.js";
import { mockFetch } from "../test/mockFetch.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { resetStore } from "../test/resetStore.js";

vi.mock("../TerminalPane.js", () => ({
  TerminalPane: ({ params }: { params: { sessionId: number } }) => (
    <div data-testid="terminal-pane" data-session-id={params.sessionId} />
  ),
}));

const PROJECT = makeProject({ id: 1, name: "mullion", cwd: "/home/x/mullion" });
// Same 1100px "both panes fit" width DockMonitor.test.tsx's #1244 suite uses:
// paneAreaWidth 808, legal primary-pane px band [364, 444], default 404.
const TWO_PANE_WIDTH = 1100;

let resizeCallbacks: Array<(entries: Array<{ contentRect: { width: number } }>) => void> = [];

describe("dock divider keyboard resizing (issue #1264)", () => {
  beforeEach(() => {
    localStorage.clear();
    resizeCallbacks = [];
    const { fetchMock } = mockFetch({
      "GET /api/projects/:id/github/prs": () => jsonResponse(204),
      "GET /api/projects/:id/dock": () =>
        jsonResponse(200, [
          { id: "dev", title: "Dev server", command: "npm run dev" },
          { id: "worker", title: "Worker", command: "npm run worker" },
        ]),
      "GET /api/projects/:id/github": () => jsonResponse(204),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "ResizeObserver",
      vi.fn(function (cb: (entries: Array<{ contentRect: { width: number } }>) => void) {
        resizeCallbacks.push(cb);
        return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
      }),
    );
    resetStore({ projects: [PROJECT], sessions: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("moves and persists both dividers by keyboard, within the drag's own bounds", async () => {
    useDashboardStore.setState({
      projects: [PROJECT],
      sessions: [
        makeSession({ id: 10, command: "npm run dev", kind: "dock", status: "active" }),
        makeSession({ id: 20, command: "npm run worker", kind: "dock", status: "active" }),
      ],
      sessionsLoaded: true,
      activeWorkspaceId: 5,
    });
    const user = userEvent.setup();
    render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
    act(() => {
      for (const cb of resizeCallbacks) cb([{ contentRect: { width: TWO_PANE_WIDTH } }]);
    });
    await screen.findByTestId("terminal-pane");
    await user.click(screen.getByText("pin"));
    expect(await screen.findAllByTestId("terminal-pane")).toHaveLength(2);

    const pane = () => document.querySelector(".dock-pane-divider") as HTMLElement;
    const primary = () => document.querySelectorAll(".dock-log-pane")[0] as HTMLElement;
    expect(pane().getAttribute("tabindex")).toBe("0");
    expect(pane().getAttribute("aria-label")).toBeTruthy();
    expect(pane().getAttribute("aria-valuemin")).toBe("364");
    expect(pane().getAttribute("aria-valuemax")).toBe("444");
    expect(pane().getAttribute("aria-valuenow")).toBe("404");

    fireEvent.keyDown(pane(), { key: "ArrowRight" });
    expect(primary().style.flex).toBe("0 0 420px");
    expect(pane().getAttribute("aria-valuenow")).toBe("420");
    const stored = JSON.parse(localStorage.getItem("crs.dockPaneSplitRatio") ?? "{}");
    expect(stored["5"]).toBeCloseTo(420 / 808);
    fireEvent.keyDown(pane(), { key: "End" });
    expect(primary().style.flex).toBe("0 0 444px");
    fireEvent.keyDown(pane(), { key: "Home" });
    expect(primary().style.flex).toBe("0 0 364px");

    const rail = document.querySelector(".dock-rail-divider") as HTMLElement;
    expect(rail.getAttribute("tabindex")).toBe("0");
    expect(rail.getAttribute("aria-label")).toBe("Resize rail");
    expect(rail.getAttribute("aria-valuemin")).toBe("216");
    fireEvent.keyDown(rail, { key: "Home" });
    expect(localStorage.getItem("crs.dockRailWidth")).toBe("216");
  });

  it("moves and persists the dock-height handle by keyboard (#3451)", () => {
    // jsdom has no layout: give the dock a 600px region so the drag's own max
    // (region - 160px grid floor = 440) leaves room above the 240px default.
    const clientHeight = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(600);
    try {
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
      const handle = () => document.querySelector(".dock-resize-handle") as HTMLElement;
      const dock = () => document.querySelector(".dock") as HTMLElement;
      expect(handle().getAttribute("role")).toBe("separator");
      expect(handle().getAttribute("aria-orientation")).toBe("horizontal");
      expect(handle().getAttribute("aria-label")).toBeTruthy();
      expect(handle().getAttribute("tabindex")).toBe("0");
      expect(handle().getAttribute("aria-valuemin")).toBe("120");
      expect(handle().getAttribute("aria-valuemax")).toBe("440");

      fireEvent.keyDown(handle(), { key: "Home" });
      expect(dock().style.height).toBe("120px");
      expect(localStorage.getItem("crs.dockHeight")).toBe("120");
      expect(handle().getAttribute("aria-valuenow")).toBe("120");
      // Inverted axis: ArrowUp grows the dock, ArrowDown shrinks it.
      fireEvent.keyDown(handle(), { key: "ArrowUp" });
      expect(dock().style.height).toBe("136px");
      expect(localStorage.getItem("crs.dockHeight")).toBe("136");
      fireEvent.keyDown(handle(), { key: "ArrowDown" });
      expect(dock().style.height).toBe("120px");
      fireEvent.keyDown(handle(), { key: "End" });
      expect(dock().style.height).toBe("440px");
      expect(localStorage.getItem("crs.dockHeight")).toBe("440");
    } finally {
      clientHeight.mockRestore();
    }
  });
});
