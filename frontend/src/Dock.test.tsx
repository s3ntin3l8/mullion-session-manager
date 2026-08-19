// @vitest-environment jsdom
// Dock's own column-list orchestration — split (PR 28, Wave 5 of
// .claude/plans/can-we-do-a-warm-cocke.md) alongside dock/*.tsx. This file
// keeps every test that exercises Dock's OWN state rather than a single
// monitor's presentation: the derived + manually-pinned column set, and the
// dock's own collapse toggle. Per-region tests live in
// dock/DockGithubRow.test.tsx and dock/DockMonitor.test.tsx — see each
// file's own header comment.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dock } from "./Dock.js";
import { useDashboardStore } from "./store/index.js";
import { jsonResponse } from "./test/jsonResponse.js";
import { makeProject } from "./test/fixtures.js";
import { mockFetch } from "./test/mockFetch.js";
import { resetStore } from "./test/resetStore.js";

// xterm.js's Terminal.open() reaches for browser APIs jsdom doesn't
// implement (e.g. matchMedia on the owner window) — TerminalPane itself is
// covered elsewhere; here we only need to know DockColumn decided to mount
// it (i.e. a monitor is "running"), not exercise the real terminal.
vi.mock("./TerminalPane.js", () => ({
  TerminalPane: ({ params }: { params: { sessionId: number } }) => (
    <div data-testid="terminal-pane" data-session-id={params.sessionId} />
  ),
}));

// Mirrors Settings.hosts.test.tsx's fake-in-memory-backend pattern — a
// mocked global fetch driving the real request()/store wiring (issue #27).

const PROJECT = makeProject({ id: 1, name: "mullion", cwd: "/home/x/mullion" });

const PROJECT_2 = makeProject({ id: 2, name: "widgets", cwd: "/home/x/widgets" });

// Per-project fixtures the fetch mock below serves, keyed by project id —
// defaults to an empty dock + a 204 (no GitHub integration) for any id not
// explicitly listed, so multi-column tests don't need to stub every id.
let dockByProject: Record<number, unknown> = {};

describe("Dock", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    dockByProject = {};
    ({ fetchMock } = mockFetch({
      "GET /api/projects/:id/github/prs": () => jsonResponse(204),
      "GET /api/projects/:id/dock": ({ params }) =>
        jsonResponse(200, dockByProject[Number(params.id)] ?? []),
      "GET /api/projects/:id/github": () => jsonResponse(204),
    }));
    vi.stubGlobal("fetch", fetchMock);
    resetStore({ projects: [PROJECT], sessions: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  describe("columns", () => {
    it("renders one column per workspace project", async () => {
      useDashboardStore.setState({ projects: [PROJECT, PROJECT_2], sessions: [] });
      render(<Dock workspaceProjectIds={[1, 2]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      expect(await screen.findByText("mullion")).toBeInTheDocument();
      expect(await screen.findByText("widgets")).toBeInTheDocument();
      expect(document.querySelectorAll(".dock-column")).toHaveLength(2);
    });

    it("shows the empty-workspace placeholder when no projects are tiled", () => {
      render(<Dock workspaceProjectIds={[]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      expect(screen.getByText("No projects tiled in this workspace yet")).toBeInTheDocument();
      expect(document.querySelectorAll(".dock-column")).toHaveLength(0);
    });

    it("still shows a column (with its empty-monitors placeholder) for a project with no dock.json", async () => {
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      expect(await screen.findByText("mullion")).toBeInTheDocument();
      expect(screen.getByText("No monitors configured for this project")).toBeInTheDocument();
    });

    it("adds a manual project column via the add-column select and persists it", async () => {
      useDashboardStore.setState({ projects: [PROJECT, PROJECT_2], sessions: [] });
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      expect(await screen.findByText("mullion")).toBeInTheDocument();
      expect(
        screen.queryByText("widgets", { selector: ".dock-column-name" }),
      ).not.toBeInTheDocument();

      const wrapper = document.querySelector(".dock-add-select") as HTMLElement;
      await user.click(wrapper.querySelector(".custom-select-trigger")!);
      await user.click(screen.getByText("widgets"));

      expect(
        await screen.findByText("widgets", { selector: ".dock-column-name" }),
      ).toBeInTheDocument();
      expect(localStorage.getItem("crs.dockManualProjects")).toBe("[2]");
    });

    it("dedupes a manually-added project that also enters the workspace, dropping its remove button", async () => {
      localStorage.setItem("crs.dockManualProjects", "[2]");
      useDashboardStore.setState({ projects: [PROJECT, PROJECT_2], sessions: [] });
      render(<Dock workspaceProjectIds={[1, 2]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("widgets", { selector: ".dock-column-name" });
      expect(document.querySelectorAll(".dock-column")).toHaveLength(2);
      expect(document.querySelector(".dock-column-remove")).not.toBeInTheDocument();
    });

    it("removes a manual-only column when its remove button is clicked", async () => {
      localStorage.setItem("crs.dockManualProjects", "[2]");
      useDashboardStore.setState({ projects: [PROJECT, PROJECT_2], sessions: [] });
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("widgets", { selector: ".dock-column-name" });
      const removeBtn = document.querySelector(".dock-column-remove") as HTMLButtonElement;
      await user.click(removeBtn);

      await waitFor(() =>
        expect(
          screen.queryByText("widgets", { selector: ".dock-column-name" }),
        ).not.toBeInTheDocument(),
      );
      expect(localStorage.getItem("crs.dockManualProjects")).toBe("[]");
    });

    // Bug fix (independent review, tablet tier plan PR 4) — tablet.css's own
    // `.dock { display: none }` under `(pointer: coarse)` only hid this
    // element visually; DockColumn (and therefore DockMonitor's own
    // TerminalPane, which registers with terminalInputRegistry on mount
    // regardless of CSS visibility) still mounted underneath it. Proves the
    // real fix: DockColumn never mounts at all under a coarse pointer, so
    // it never gets the chance to register.
    it("does not mount any DockColumn under a coarse pointer, even though the outer element still renders", async () => {
      vi.stubGlobal(
        "matchMedia",
        vi.fn((query: string) => ({
          matches: query === "(pointer: coarse)",
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        })),
      );
      useDashboardStore.setState({ projects: [PROJECT, PROJECT_2], sessions: [] });
      render(<Dock workspaceProjectIds={[1, 2]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      expect(document.querySelector(".dock")).toBeInTheDocument();
      expect(document.querySelectorAll(".dock-column")).toHaveLength(0);
      expect(screen.queryByText("mullion")).not.toBeInTheDocument();
    });
  });

  describe("collapse", () => {
    it("hides the resize handle and columns while collapsed, and persists the flag", async () => {
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      expect(document.querySelector(".dock-resize-handle")).toBeInTheDocument();

      await user.click(screen.getByTitle("Collapse dock"));

      expect(document.querySelector(".dock-resize-handle")).not.toBeInTheDocument();
      expect(document.querySelector(".dock-columns")).not.toBeInTheDocument();
      expect(localStorage.getItem("crs.dockCollapsed")).toBe("1");
    });
  });
});
