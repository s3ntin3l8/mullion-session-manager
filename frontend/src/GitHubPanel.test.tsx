// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { GitHubPanel } from "./GitHubPanel.js";
import type { GitHubStatus } from "./api.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const STATUS: GitHubStatus = {
  repo: { owner: "acme", repo: "widgets", htmlUrl: "https://github.com/acme/widgets" },
  openIssues: 1,
  openPRs: 1,
  pulls: [
    {
      number: 42,
      title: "Fix attention race",
      htmlUrl: "https://github.com/acme/widgets/pull/42",
      author: "a",
    },
  ],
  issues: [
    {
      number: 27,
      title: "GitHub integration",
      htmlUrl: "https://github.com/acme/widgets/issues/27",
      author: "b",
    },
  ],
  actionsRuns: [],
  ciStatus: null,
};

describe("GitHubPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists pull requests and issues with titles and links once loaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(200, STATUS))),
    );
    render(<GitHubPanel params={{ projectId: 1 }} />);

    expect(await screen.findByText("acme/widgets")).toBeInTheDocument();

    const prLink = screen.getByRole("link", { name: /Fix attention race/ });
    expect(prLink).toHaveAttribute("href", "https://github.com/acme/widgets/pull/42");
    expect(screen.getByText("#42")).toBeInTheDocument();

    const issueLink = screen.getByRole("link", { name: /GitHub integration/ });
    expect(issueLink).toHaveAttribute("href", "https://github.com/acme/widgets/issues/27");
    expect(screen.getByText("#27")).toBeInTheDocument();

    expect(screen.getByText("Pull requests (1)")).toBeInTheDocument();
    expect(screen.getByText("Issues (1)")).toBeInTheDocument();
  });

  it("shows a not-applicable message on a 204 response, without listing anything", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
    );
    render(<GitHubPanel params={{ projectId: 2 }} />);

    expect(await screen.findByText(/No GitHub status available/)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("degrades to the not-applicable message on a fetch error too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))),
    );
    render(<GitHubPanel params={{ projectId: 3 }} />);

    expect(await screen.findByText(/No GitHub status available/)).toBeInTheDocument();
  });

  it("shows empty-section copy when a repo has no open PRs or issues", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(200, { ...STATUS, openPRs: 0, openIssues: 0, pulls: [], issues: [] }),
        ),
      ),
    );
    render(<GitHubPanel params={{ projectId: 4 }} />);

    expect(await screen.findByText("No open pull requests")).toBeInTheDocument();
    expect(screen.getByText("No open issues")).toBeInTheDocument();
  });

  it("omits the Actions section entirely when there are no runs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(200, STATUS))),
    );
    render(<GitHubPanel params={{ projectId: 5 }} />);

    await screen.findByText("acme/widgets");
    expect(screen.queryByText("Actions")).not.toBeInTheDocument();
  });

  it("lists the latest run per workflow with a link and status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(200, {
            ...STATUS,
            ciStatus: "failure",
            actionsRuns: [
              {
                name: "CI",
                status: "completed",
                conclusion: "failure",
                htmlUrl: "https://github.com/acme/widgets/actions/runs/1",
                headSha: "abc123",
              },
              {
                name: "Deploy",
                status: "in_progress",
                conclusion: null,
                htmlUrl: "https://github.com/acme/widgets/actions/runs/2",
                headSha: "def456",
              },
            ],
          }),
        ),
      ),
    );
    render(<GitHubPanel params={{ projectId: 6 }} />);

    expect(await screen.findByText("Actions")).toBeInTheDocument();
    const ciLink = screen.getByRole("link", { name: /CI/ });
    expect(ciLink).toHaveAttribute("href", "https://github.com/acme/widgets/actions/runs/1");
    expect(screen.getByText("failure")).toBeInTheDocument();

    const deployLink = screen.getByRole("link", { name: /Deploy/ });
    expect(deployLink).toHaveAttribute("href", "https://github.com/acme/widgets/actions/runs/2");
    expect(screen.getByText("in_progress")).toBeInTheDocument();
  });
});
