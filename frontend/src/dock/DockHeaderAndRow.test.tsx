// @vitest-environment jsdom
// #3589 — the Dock's project header (one row, its host selector's tooltip),
// a row running on another host (its checkout, not this host's path), a
// running dev server's "Open in browser", and the browser toolbar's icon
// buttons. Through the real Dock and Dock view.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dock } from "../Dock.js";
import { DockSidebarView } from "../right-sidebar/DockSidebarView.js";
import type { RightSidebarActions } from "../right-sidebar/views.js";
import { useDashboardStore } from "../store/index.js";
import type { GitBranchesResult, Project, Session } from "../api/index.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { makeHost, makeProject, makeSession } from "../test/fixtures.js";
import * as dd from "../test/dropdown.js";
import { mockFetch } from "../test/mockFetch.js";
import { SERVER_INFO_FIXTURE } from "../test/serverInfoFixture.js";
import { resetStore } from "../test/resetStore.js";
import dockCss from "../styles/dock.css?raw";
import emptyStatesCss from "../styles/empty-states.css?raw";
import sidebarKitCss from "../styles/sidebar-kit.css?raw";

vi.mock("../TerminalPane.js", () => ({
  TerminalPane: ({ params }: { params: { sessionId: number } }) => (
    <div data-testid="terminal-pane" data-session-id={params.sessionId} />
  ),
}));

const MAC = makeHost({ id: "mac", name: "macbook", health: "online" });
const SPANNING = makeProject({
  id: 1,
  name: "aurora",
  cwd: "/home/x/aurora",
  hostCwds: { mac: "/Users/x/aurora" },
});
// The primary's clone sits on a detached HEAD: its option is labelled with
// its path, which is what a row running on the Mac used to show.
const DETACHED_REFS: GitBranchesResult = {
  branches: [
    { name: "main", isCurrent: false },
    { name: "feature-x", isCurrent: false },
  ],
  worktrees: [{ path: "/home/x/aurora", branch: null, isMain: true }],
  remoteBranches: [],
};

let controls: unknown[];
let previewsEnabled: boolean;
// The Browser quick pick's running entries (services/browser-destinations.ts).
let destinations: unknown[];
let destinationPreviewStatus: number;
let fetchMock: ReturnType<typeof mockFetch>["fetchMock"];

/** The body of the first `selector { … }` rule in a stylesheet. */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
}

function dockSession(over: Partial<Session>): Session {
  return makeSession({
    id: 7,
    projectId: 1,
    kind: "dock",
    status: "active",
    command: "make dev",
    ...over,
  } as Partial<Session>);
}

describe("Dock header and rows (#3589)", () => {
  let createSession: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<Session>>>;
  let deleteSession: ReturnType<typeof vi.fn<(id: number) => Promise<void>>>;

  const seed = (opts: { project?: Project; sessions?: Session[] } = {}) => {
    resetStore({
      projects: [opts.project ?? SPANNING],
      sessions: opts.sessions ?? [],
      hosts: [MAC],
    });
    useDashboardStore.setState({
      createSession,
      deleteSession,
      sessionsLoaded: true,
      gitBranchesByProject: { 1: DETACHED_REFS },
    });
  };

  beforeEach(() => {
    localStorage.clear();
    controls = [{ id: "dev", title: "Dev server", command: "make dev" }];
    previewsEnabled = true;
    destinations = [];
    destinationPreviewStatus = 200;
    const { fetchMock: mocked } = mockFetch({
      "GET /api/projects/:id/browser-destinations": () =>
        jsonResponse(200, { destinations, runningNote: null }),
      "POST /api/projects/:id/browser-destinations/preview": () =>
        destinationPreviewStatus === 200
          ? jsonResponse(200, { slug: "dev-3000", label: "Dev server" })
          : jsonResponse(destinationPreviewStatus, { error: "Previews are off" }),
      "GET /api/server-info": () => jsonResponse(200, { ...SERVER_INFO_FIXTURE, previewsEnabled }),
      "GET /api/projects/:id/dock": () => jsonResponse(200, controls),
      "GET /api/projects/:id/github": () => jsonResponse(204),
      "GET /api/projects/:id/github/prs": () => jsonResponse(204),
    });
    fetchMock = mocked;
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "ResizeObserver",
      vi.fn(function () {
        return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
      }),
    );
    createSession = vi
      .fn<(...args: unknown[]) => Promise<Session>>()
      .mockResolvedValue(makeSession({ id: 42, projectId: 1, kind: "dock" }));
    deleteSession = vi.fn<(id: number) => Promise<void>>().mockResolvedValue(undefined);
    seed();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const renderDock = (
    onOpenBrowser = vi.fn(),
    onOpenBrowserUrl?: (projectId: number, url: string, label: string) => void,
  ) =>
    render(
      <Dock
        workspaceProjectIds={[1]}
        onOpenGitHub={vi.fn()}
        onOpenBrowser={onOpenBrowser}
        onOpenBrowserUrl={onOpenBrowserUrl}
      />,
    );
  const picker = () => screen.getByRole("combobox", { name: /^Run dock controls on host/ });

  describe("the project header", () => {
    it("holds the host selector and Preview side by side on the header's one row", async () => {
      renderDock();
      await screen.findByText("Dev server");
      const header = document.querySelector(".dock-group-header") as HTMLElement;
      const tools = within(header)
        .getByRole("combobox", {
          name: /^Run dock controls on host/,
        })
        .closest(".dock-group-tools") as HTMLElement;
      expect(tools).not.toBeNull();
      expect(within(tools).getByRole("button", { name: "Preview" })).toBeInTheDocument();
      expect(within(header).getByText("Run on")).toBeInTheDocument();
      // The selector and Preview are one unit that never shrinks or splits:
      // beside the name, or together on the next line of a narrow rail.
      expect(ruleBody(dockCss, ".dock-group-tools")).toMatch(/flex: 0 0 auto/);
      expect(ruleBody(dockCss, ".dock-group-tools")).not.toMatch(/flex-wrap/); // rule asserted above
      expect(ruleBody(dockCss, ".dock-group-tools .dock-host-picker")).toMatch(/flex: 0 0 auto/);
      // The GitHub glance takes only the room left on the name's line, so it
      // never forces a line of its own.
      expect(ruleBody(dockCss, ".dock-group-header .dock-github-row")).toMatch(/flex: 1 1 0/);
      // The note that used to span a whole line inside the header is gone from
      // it. Anchored on the rule's own padding first: `ruleBody` is "" for a
      // missing rule, which a negative assertion alone would let pass.
      expect(ruleBody(dockCss, ".dock-host-picker-hint")).toMatch(/padding:/);
      expect(ruleBody(dockCss, ".dock-host-picker-hint")).not.toMatch(/flex-basis/);
    });

    it("keeps the same label while a control runs", async () => {
      seed({ sessions: [dockSession({ hostId: "mac", resolvedHostId: "mac" })] });
      renderDock();
      expect(await screen.findByText("on macbook")).toBeInTheDocument();
      expect(picker()).toBeDisabled();
      expect(dd.dropdownValue(picker())).toBe("mac");
      expect(screen.getByText("Run on")).toBeInTheDocument();
      expect(screen.queryByText(/Running on|Next start on/)).toBeNull();
    });

    it("puts the previews-off note under the header, not in it", async () => {
      previewsEnabled = false;
      renderDock();
      await screen.findByText("Dev server");
      dd.pickDropdownOption(picker(), "mac");
      const note = await screen.findByRole("note");
      expect(note).toHaveTextContent(/PREVIEW_BASE_HOST/);
      expect(note.closest(".dock-group-header")).toBeNull();
      expect(note.closest(".dock-group")).not.toBeNull();
    });

    it("shows the host selector's tooltip through the shared portaled bubble", async () => {
      renderDock();
      await screen.findByText("Dev server");
      const wrapper = document.querySelector(".dock-host-picker") as HTMLElement;
      // No native title anywhere in the selector: the bubble replaces it.
      expect(wrapper.hasAttribute("title")).toBe(false);
      expect(wrapper.querySelector("[title]")).toBeNull();
      await userEvent.hover(wrapper);
      const tooltip = await screen.findByRole("tooltip");
      expect(tooltip).toHaveTextContent(/next Start runs/);
      // On document.body, outside the Dock and its overflow.
      expect(tooltip.parentElement).toBe(document.body);
      expect(tooltip.closest(".dock-group")).toBeNull();
      await userEvent.unhover(wrapper);
      await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
      // A sentence-long reason wraps inside the bubble instead of running
      // past its edge.
      expect(ruleBody(sidebarKitCss, ".sb-tooltip")).toMatch(/white-space: normal/);
    });
  });

  describe("a row running on another host", () => {
    const worktreeField = () => screen.getByRole("button", { name: "Dev server worktree" });

    it("shows that host's path, never this host's", async () => {
      seed({
        sessions: [dockSession({ hostId: "mac", resolvedHostId: "mac", cwd: "/Users/x/aurora" })],
      });
      renderDock();
      await screen.findByText("on macbook");
      expect(worktreeField()).toHaveTextContent("/Users/x/aurora");
      expect(worktreeField()).not.toHaveTextContent("/home/x");
    });

    it("falls back to that host's checkout root when the session has no directory", async () => {
      seed({ sessions: [dockSession({ hostId: "mac", resolvedHostId: "mac", cwd: null })] });
      renderDock();
      await screen.findByText("on macbook");
      expect(worktreeField()).toHaveTextContent("/Users/x/aurora");
    });

    it("does not relaunch when its own remote checkout is picked again", async () => {
      seed({
        sessions: [dockSession({ hostId: "mac", resolvedHostId: "mac", cwd: "/Users/x/aurora" })],
      });
      renderDock();
      await screen.findByText("on macbook");
      await userEvent.click(worktreeField());
      await userEvent.click(await screen.findByRole("option", { name: "/Users/x/aurora" }));
      expect(deleteSession).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
    });

    it("keeps showing a branch by its name", async () => {
      useDashboardStore.setState({
        dockControlWorktrees: { "1": { dev: "branch:feature-x" } },
      });
      seed({
        sessions: [
          dockSession({
            hostId: "mac",
            resolvedHostId: "mac",
            cwd: "/Users/x/aurora/.mullion-worktrees/dock-preview-feature-x",
            previewBranch: "feature-x",
          }),
        ],
      });
      renderDock();
      await screen.findByText("on macbook");
      expect(worktreeField()).toHaveTextContent("feature-x (preview)");
    });

    it("leaves a row running on this host as it was", async () => {
      seed({ sessions: [dockSession({ resolvedHostId: "local", cwd: "/home/x/aurora" })] });
      renderDock();
      await screen.findByText("on this server");
      expect(worktreeField()).toHaveTextContent("/home/x/aurora");
    });
  });

  describe("Open in browser", () => {
    const devProject = (over: Partial<Project> = {}) =>
      makeProject({ ...SPANNING, devServerUrl: "http://localhost:5173", ...over });
    const openButton = () => screen.queryByRole("button", { name: "Open Dev server in browser" });

    it("opens a running dev server through the Preview menu's own action", async () => {
      controls = [{ id: "dev", title: "Dev server", command: "make dev", port: 5173 }];
      seed({
        project: devProject(),
        sessions: [dockSession({ hostId: "mac", resolvedHostId: "mac" })],
      });
      const onOpenBrowser = vi.fn();
      renderDock(onOpenBrowser);
      await screen.findByText("on macbook");
      await userEvent.click(openButton()!);
      expect(onOpenBrowser).toHaveBeenCalledWith(1);
      // A click on the button is not a click on the row.
      expect(createSession).not.toHaveBeenCalled();
    });

    it("uses the port detected on the project for its only command", async () => {
      seed({
        project: devProject({ devServerUrl: "5173", detectedDevServerPort: "5173" }),
        sessions: [dockSession({ resolvedHostId: "local" })],
      });
      renderDock();
      await screen.findByText("on this server");
      expect(openButton()).not.toBeNull();
    });

    it("is not offered while stopped, or on a port that is not the dev server's", async () => {
      controls = [{ id: "dev", title: "Dev server", command: "make dev", port: 5173 }];
      seed({ project: devProject() });
      const { unmount } = renderDock();
      await screen.findByText("Dev server");
      expect(openButton()).toBeNull();
      unmount();

      controls = [{ id: "dev", title: "Dev server", command: "make dev", port: 9000 }];
      seed({ project: devProject(), sessions: [dockSession({ resolvedHostId: "local" })] });
      renderDock();
      await screen.findByText("on this server");
      expect(openButton()).toBeNull();
    });

    it("opens the port detected in a run's output, as the quick pick does", async () => {
      // Not the dev server's port: found in the command's output instead.
      destinations = [
        {
          key: "dock:7",
          group: "running",
          kind: "dock",
          label: "Dev server",
          detail: "Dock · port 3000",
          address: "http://localhost:3000/",
          hostId: "local",
          previewSlug: null,
          targetId: null,
        },
      ];
      seed({ project: devProject(), sessions: [dockSession({ resolvedHostId: "local" })] });
      const onOpenBrowser = vi.fn();
      renderDock(onOpenBrowser);
      await screen.findByText("on this server");
      await userEvent.click(
        await screen.findByRole("button", { name: "Open Dev server in browser" }),
      );
      await waitFor(() =>
        expect(useDashboardStore.getState().openPreviewRequest).toEqual(
          expect.objectContaining({
            projectId: 1,
            slug: "dev-3000",
            branch: null,
            targetName: "Dev server",
          }),
        ),
      );
      expect(onOpenBrowser).not.toHaveBeenCalled();
    });

    it("reports a detected port's preview that cannot open", async () => {
      destinations = [
        {
          key: "dock:7",
          group: "running",
          kind: "dock",
          label: "Dev server",
          detail: null,
          address: null,
          hostId: "local",
          previewSlug: null,
          targetId: null,
        },
      ];
      destinationPreviewStatus = 409;
      seed({ project: devProject(), sessions: [dockSession({ resolvedHostId: "local" })] });
      renderDock();
      await userEvent.click(
        await screen.findByRole("button", { name: "Open Dev server in browser" }),
      );
      await waitFor(() =>
        expect(useDashboardStore.getState().toasts.map((t) => t.message)).toEqual([
          expect.stringMatching(/^Could not open preview/),
        ]),
      );
    });

    const DETECTED_3000 = {
      key: "dock:7",
      group: "running",
      kind: "dock",
      label: "Dev server",
      detail: "Dock · port 3000",
      address: "http://localhost:3000/",
      hostId: "local",
      previewSlug: null,
      targetId: null,
    };

    it("opens a detected port's address itself when previews are off", async () => {
      destinations = [DETECTED_3000];
      // 409: no PREVIEW_BASE_HOST, as the quick pick handles it.
      destinationPreviewStatus = 409;
      seed({ project: devProject(), sessions: [dockSession({ resolvedHostId: "local" })] });
      const onOpenBrowserUrl = vi.fn();
      renderDock(vi.fn(), onOpenBrowserUrl);
      await userEvent.click(
        await screen.findByRole("button", { name: "Open Dev server in browser" }),
      );
      await waitFor(() =>
        expect(onOpenBrowserUrl).toHaveBeenCalledWith(1, "http://localhost:3000/", "Dev server"),
      );
      expect(useDashboardStore.getState().toasts).toEqual([]);
    });

    it("polls the detected ports once per project for every surface showing it", async () => {
      destinations = [DETECTED_3000];
      seed({ project: devProject(), sessions: [dockSession({ resolvedHostId: "local" })] });
      const destinationCalls = () =>
        fetchMock.mock.calls.filter(([url]) => String(url).includes("/browser-destinations"))
          .length;
      renderDock();
      render(
        <DockSidebarView
          projectId={1}
          actions={{ onOpenDockConfig: vi.fn() } as unknown as RightSidebarActions}
        />,
      );
      await waitFor(() =>
        expect(
          screen.getAllByRole("button", { name: /Open (Dev server )?in browser/ }),
        ).toHaveLength(2),
      );
      expect(destinationCalls()).toBe(1);
    });

    it("opens a detected port's address in the rail when previews are off, from the Dock view", async () => {
      destinations = [DETECTED_3000];
      destinationPreviewStatus = 409;
      seed({ project: devProject(), sessions: [dockSession({ resolvedHostId: "local" })] });
      const openRailBrowserPreview = vi.fn();
      useDashboardStore.setState({ openRailBrowserPreview });
      render(
        <DockSidebarView
          projectId={1}
          actions={{ onOpenDockConfig: vi.fn() } as unknown as RightSidebarActions}
        />,
      );
      await userEvent.click(
        await screen.findByRole("button", { name: "Dev server, running on this server" }),
      );
      const group = screen.getByRole("group", { name: "Dev server actions" });
      await userEvent.click(await within(group).findByRole("button", { name: "Open in browser" }));
      await waitFor(() =>
        expect(openRailBrowserPreview).toHaveBeenCalledWith(
          { kind: "external", url: "http://localhost:3000/", projectId: 1 },
          1,
        ),
      );
    });

    it("opens the rail's Browser view from the Dock view", async () => {
      controls = [{ id: "dev", title: "Dev server", command: "make dev", port: 5173 }];
      seed({ project: devProject(), sessions: [dockSession({ resolvedHostId: "local" })] });
      const openRailBrowserPreview = vi.fn();
      useDashboardStore.setState({ openRailBrowserPreview });
      render(
        <DockSidebarView
          projectId={1}
          actions={{ onOpenDockConfig: vi.fn() } as unknown as RightSidebarActions}
        />,
      );
      await userEvent.click(
        await screen.findByRole("button", { name: "Dev server, running on this server" }),
      );
      const group = screen.getByRole("group", { name: "Dev server actions" });
      await userEvent.click(within(group).getByRole("button", { name: "Open in browser" }));
      expect(openRailBrowserPreview).toHaveBeenCalledWith(null, 1);
    });
  });

  it("gives the browser toolbar's icon buttons no padding to squeeze their icon", () => {
    // A 22px button under the global `button { padding: 5px 10px }` left its
    // 13px icon 2px wide: an empty grey dot.
    const body = ruleBody(emptyStatesCss, ".browser-panel-reload");
    expect(body).toMatch(/width: 22px/);
    expect(body).toMatch(/padding: 0;/);
  });
});
