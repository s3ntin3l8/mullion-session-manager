// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { GitHubPanel } from "./GitHubPanel.js";
import type { GitHubPRsStatus, GitHubStatus } from "./api.js";

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

const PRS_EMPTY: GitHubPRsStatus = {
  prs: [],
  prSummary: { total: 0, pass: 0, fail: 0, pending: 0 },
};

const PRS_LOADED: GitHubPRsStatus = {
  prs: [
    {
      number: 42,
      title: "Fix attention race",
      htmlUrl: "https://github.com/acme/widgets/pull/42",
      author: "a",
      headSha: "abc123",
      headBranch: "fix-attention",
      baseBranch: "main",
      ciStatus: "success",
      actionsRuns: [],
    },
  ],
  prSummary: { total: 1, pass: 1, fail: 0, pending: 0 },
};

function mockFetch(
  status: { status: GitHubStatus } | { status: GitHubStatus; prs: GitHubPRsStatus },
) {
  return vi.fn((url: string) => {
    if (url.endsWith("/github/prs")) {
      const p = "prs" in status ? status.prs : PRS_EMPTY;
      return Promise.resolve(jsonResponse(200, p));
    }
    return Promise.resolve(jsonResponse(200, status.status));
  });
}

describe("GitHubPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists pull requests and issues with titles and links once loaded", async () => {
    vi.stubGlobal("fetch", mockFetch({ status: STATUS, prs: PRS_LOADED }));
    render(<GitHubPanel params={{ projectId: 1 }} />);

    expect(await screen.findByText("acme/widgets")).toBeInTheDocument();

    const prLink = screen.getByRole("link", { name: "#42" });
    expect(prLink).toHaveAttribute("href", "https://github.com/acme/widgets/pull/42");

    const issueLink = screen.getByRole("link", { name: /GitHub integration/ });
    expect(issueLink).toHaveAttribute("href", "https://github.com/acme/widgets/issues/27");
    expect(screen.getByText("#27")).toBeInTheDocument();

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
      mockFetch({
        status: { ...STATUS, openPRs: 0, openIssues: 0, pulls: [], issues: [] },
        prs: PRS_EMPTY,
      }),
    );
    render(<GitHubPanel params={{ projectId: 4 }} />);

    expect(await screen.findByText("Pull requests (0)")).toBeInTheDocument();
    expect(screen.getByText("No open issues")).toBeInTheDocument();
  });

  it("omits the Actions section entirely when there are no runs", async () => {
    vi.stubGlobal("fetch", mockFetch({ status: STATUS, prs: PRS_LOADED }));
    render(<GitHubPanel params={{ projectId: 5 }} />);

    await screen.findByText("acme/widgets");
    expect(screen.queryByText("Default branch CI")).not.toBeInTheDocument();
  });

  it("lists the latest run per workflow with a link and status", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        status: {
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
        },
        prs: PRS_EMPTY,
      }),
    );
    render(<GitHubPanel params={{ projectId: 6 }} />);

    expect(await screen.findByText("Default branch CI")).toBeInTheDocument();
    const ciLink = screen.getByRole("link", { name: /CI/ });
    expect(ciLink).toHaveAttribute("href", "https://github.com/acme/widgets/actions/runs/1");
    expect(screen.getByText("failure")).toBeInTheDocument();

    const deployLink = screen.getByRole("link", { name: /Deploy/ });
    expect(deployLink).toHaveAttribute("href", "https://github.com/acme/widgets/actions/runs/2");
    expect(screen.getByText("in_progress")).toBeInTheDocument();
  });
});
