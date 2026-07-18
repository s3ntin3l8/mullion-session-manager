// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dock } from "./Dock.js";
import { useDashboardStore } from "./store.js";
import type { GitHubStatus, Project } from "./api.js";

// Mirrors Settings.hosts.test.tsx's fake-in-memory-backend pattern — a
// mocked global fetch driving the real request()/store wiring (issue #27).

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const PROJECT: Project = {
  id: 1,
  name: "tessera",
  cwd: "/home/x/tessera",
  hostId: "local",
  devServerUrl: null,
  detectedDevServerUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const STATUS: GitHubStatus = {
  repo: { owner: "acme", repo: "widgets", htmlUrl: "https://github.com/acme/widgets" },
  openIssues: 3,
  openPRs: 2,
  pulls: [],
  issues: [],
  actionsRuns: [],
  ciStatus: null,
};

describe("Dock GitHub widget", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let githubResponse: () => Response;

  beforeEach(() => {
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/projects/1/dock" && method === "GET") {
        return Promise.resolve(jsonResponse(200, []));
      }
      if (url === "/api/projects/1/github" && method === "GET") {
        return Promise.resolve(githubResponse());
      }
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    useDashboardStore.setState({ projects: [PROJECT], sessions: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders nothing when the endpoint 204s (no remote/no token configured)", async () => {
    githubResponse = () => new Response(null, { status: 204 });
    render(<Dock projectId={1} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/projects/1/github", expect.anything()),
    );
    expect(screen.queryByTitle(/Open GitHub panel/)).not.toBeInTheDocument();
  });

  it("shows the repo, issue count, and PR count once the status loads", async () => {
    githubResponse = () => jsonResponse(200, STATUS);
    render(<Dock projectId={1} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

    expect(await screen.findByText("acme/widgets")).toBeInTheDocument();
    expect(screen.getByText("3 issues")).toBeInTheDocument();
    expect(screen.getByText("2 PRs")).toBeInTheDocument();
  });

  it("opens the GitHub panel for the current project when clicked", async () => {
    githubResponse = () => jsonResponse(200, STATUS);
    const onOpenGitHub = vi.fn();
    const user = userEvent.setup();
    render(<Dock projectId={1} onOpenGitHub={onOpenGitHub} onOpenBrowser={vi.fn()} />);

    const row = await screen.findByText("acme/widgets");
    await user.click(row);

    expect(onOpenGitHub).toHaveBeenCalledWith(1);
  });

  it("shows a browser-preview row when the project has a devServerUrl, and opens it on click", async () => {
    githubResponse = () => new Response(null, { status: 204 });
    useDashboardStore.setState({ projects: [{ ...PROJECT, devServerUrl: "5173" }], sessions: [] });
    const onOpenBrowser = vi.fn();
    const user = userEvent.setup();
    render(<Dock projectId={1} onOpenGitHub={vi.fn()} onOpenBrowser={onOpenBrowser} />);

    const row = await screen.findByText("5173");
    await user.click(row);

    expect(onOpenBrowser).toHaveBeenCalledWith(1);
  });

  it("hides the browser-preview row when the project has no devServerUrl", async () => {
    githubResponse = () => new Response(null, { status: 204 });
    render(<Dock projectId={1} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/projects/1/github", expect.anything()),
    );
    expect(screen.queryByTitle(/Open browser preview/)).not.toBeInTheDocument();
  });

  it("shows no CI dot when ciStatus is null (Actions disabled/no runs)", async () => {
    githubResponse = () => jsonResponse(200, STATUS);
    render(<Dock projectId={1} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

    await screen.findByText("acme/widgets");
    expect(document.querySelector(".github-panel-ci-dot")).not.toBeInTheDocument();
  });

  it("shows a CI dot reflecting ciStatus once Actions data is present", async () => {
    githubResponse = () => jsonResponse(200, { ...STATUS, ciStatus: "failure" });
    render(<Dock projectId={1} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

    await screen.findByText("acme/widgets");
    const dot = document.querySelector(".github-panel-ci-dot");
    expect(dot).toBeInTheDocument();
    expect(dot).toHaveClass("bad");
    expect(dot).toHaveAttribute("title", "CI: failure");
  });
});
