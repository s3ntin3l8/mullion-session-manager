// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "./CommandPalette.js";
import { useDashboardStore } from "./store.js";
import type { Project } from "./api.js";

// Issue #27: the palette's "Integrations" section — a GitHub-panel shortcut
// for the current project plus a link into Settings -> Integrations.

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const PROJECT: Project = {
  id: 5,
  name: "mullion",
  cwd: "/home/x/mullion",
  hostId: "local",
  devServerUrl: null,
  detectedDevServerPort: null,
  currentBranch: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("CommandPalette -> Integrations section", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(200, []))),
    );
    useDashboardStore.setState({ projects: [PROJECT], sessions: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens the GitHub panel for the current project", async () => {
    const onOpenGitHub = vi.fn();
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onLaunched={vi.fn()}
        onOpenGitHub={onOpenGitHub}
        onOpenGit={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenIntegrationsSettings={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await user.click(await screen.findByText(/GitHub: mullion/));
    expect(onOpenGitHub).toHaveBeenCalledWith(PROJECT.id);
  });

  it("opens the git status panel for the current project (issue #76)", async () => {
    const onOpenGit = vi.fn();
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onLaunched={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenGit={onOpenGit}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenIntegrationsSettings={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await user.click(await screen.findByText(/Git: mullion/));
    expect(onOpenGit).toHaveBeenCalledWith(PROJECT.id);
  });

  it("opens the browser preview panel for the current project", async () => {
    const onOpenBrowser = vi.fn();
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onLaunched={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenGit={vi.fn()}
        onOpenBrowser={onOpenBrowser}
        onOpenBlankBrowser={vi.fn()}
        onOpenIntegrationsSettings={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await user.click(await screen.findByText(/Preview: mullion/));
    expect(onOpenBrowser).toHaveBeenCalledWith(PROJECT.id);
  });

  it("opens a blank browser tab, project-independent (issue #28's general-purpose browser tile)", async () => {
    const onOpenBlankBrowser = vi.fn();
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="global"
        projectId={null}
        onClose={vi.fn()}
        onLaunched={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenGit={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={onOpenBlankBrowser}
        onOpenIntegrationsSettings={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await user.click(await screen.findByText("New browser tab"));
    expect(onOpenBlankBrowser).toHaveBeenCalled();
  });

  it("opens Settings -> Integrations", async () => {
    const onOpenIntegrationsSettings = vi.fn();
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onLaunched={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenGit={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenIntegrationsSettings={onOpenIntegrationsSettings}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await user.click(await screen.findByText("Manage integrations…"));
    expect(onOpenIntegrationsSettings).toHaveBeenCalled();
  });

  it("hides the Integrations section while mid-search", async () => {
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onLaunched={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenGit={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenIntegrationsSettings={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await screen.findByText("Manage integrations…");
    await user.type(screen.getByPlaceholderText(/Launch a session/), "bash");
    expect(screen.queryByText("Manage integrations…")).not.toBeInTheDocument();
  });
});

// Issue #271, option 1 — the launcher's opt-in "isolate this session" toggle.
describe("CommandPalette -> worktree isolation toggle", () => {
  const LAUNCHER = { id: "agent:bash", kind: "shell" as const, title: "bash", command: "bash" };

  function mockFetch(opts: {
    branches?: () => Response | Promise<Response>;
    onCreateSession?: (body: unknown) => void;
  }) {
    return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/actions")) return Promise.resolve(jsonResponse(200, [LAUNCHER]));
      if (url.includes("/urls")) return Promise.resolve(jsonResponse(200, []));
      if (url.includes("/git-branches")) {
        return Promise.resolve(
          opts.branches ? opts.branches() : new Response(null, { status: 204 }),
        );
      }
      if (url.endsWith("/api/sessions") && init?.method === "POST") {
        opts.onCreateSession?.(JSON.parse(String(init.body)));
        return Promise.resolve(
          jsonResponse(201, {
            id: 1,
            projectId: PROJECT.id,
            command: "bash",
            cwd: null,
            status: "active",
          }),
        );
      }
      // createSession refreshes the session list afterward (store.ts) — an
      // empty list is fine, this test only cares about the POST body above.
      if (url.startsWith("/api/sessions")) return Promise.resolve(jsonResponse(200, []));
      return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
    });
  }

  beforeEach(() => {
    useDashboardStore.setState({ projects: [PROJECT], sessions: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is off by default and shows no base-ref picker", async () => {
    vi.stubGlobal("fetch", mockFetch({}));
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onLaunched={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenGit={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenIntegrationsSettings={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    const toggle = await screen.findByLabelText("Isolate in a new worktree");
    expect(toggle).not.toBeChecked();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("fetches branches and shows a base-ref picker once switched on", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        branches: () =>
          Promise.resolve(
            jsonResponse(200, {
              branches: [
                { name: "main", isCurrent: true },
                { name: "feature/x", isCurrent: false },
              ],
              worktrees: [],
              remoteBranches: ["origin/main"],
            }),
          ),
      }),
    );
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onLaunched={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenGit={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenIntegrationsSettings={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await user.click(await screen.findByLabelText("Isolate in a new worktree"));
    const select = await screen.findByRole("combobox");
    expect(select).toHaveDisplayValue("main");
    expect(screen.getByRole("option", { name: "feature/x" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "origin/main" })).toBeInTheDocument();
  });

  it("passes a worktree intent to session creation when the toggle is on", async () => {
    const onCreateSession = vi.fn();
    vi.stubGlobal(
      "fetch",
      mockFetch({
        branches: () =>
          Promise.resolve(
            jsonResponse(200, {
              branches: [{ name: "main", isCurrent: true }],
              worktrees: [],
              remoteBranches: [],
            }),
          ),
        onCreateSession,
      }),
    );
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onLaunched={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenGit={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenIntegrationsSettings={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await user.click(await screen.findByLabelText("Isolate in a new worktree"));
    await screen.findByRole("combobox");
    await user.click((await screen.findAllByText("bash"))[0]);

    expect(onCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ worktree: { baseRef: "main" } }),
    );
  });

  it("omits the worktree intent when the toggle is off", async () => {
    const onCreateSession = vi.fn();
    vi.stubGlobal("fetch", mockFetch({ onCreateSession }));
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onLaunched={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenGit={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenIntegrationsSettings={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await user.click((await screen.findAllByText("bash"))[0]);

    expect(onCreateSession).toHaveBeenCalled();
    expect(onCreateSession.mock.calls[0][0]).not.toHaveProperty("worktree");
  });
});
