// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GitHubPanel } from "./GitHubPanel.js";
import type { GitHubJob, GitHubLogResponse, GitHubPRsStatus, GitHubStatus } from "./api.js";
import { jsonResponse } from "./test/jsonResponse.js";

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
  prSummary: { total: 0, pass: 0, fail: 0, pending: 0, unknown: 0 },
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
  prSummary: { total: 1, pass: 1, fail: 0, pending: 0, unknown: 0 },
};

// Promise.withResolvers isn't in this project's configured TS lib target —
// a plain manual deferred instead, just for the tests below that need to
// assert a transient loading state before resolving it.
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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

// A PR whose one workflow run has a numeric /actions/runs/<id> URL — the
// shape WorkflowRunRow needs (runIdFromUrl) to render as expandable rather
// than a bare link, so its jobs/logs accordion (JobRow) is reachable.
const PRS_WITH_RUN: GitHubPRsStatus = {
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
      actionsRuns: [
        {
          name: "CI",
          status: "completed",
          conclusion: "success",
          htmlUrl: "https://github.com/acme/widgets/actions/runs/99",
          headSha: "abc123",
        },
      ],
    },
  ],
  prSummary: { total: 1, pass: 1, fail: 0, pending: 0, unknown: 0 },
};

const JOB: GitHubJob = {
  id: 7,
  name: "build",
  status: "completed",
  conclusion: "success",
  startedAt: null,
  completedAt: null,
  htmlUrl: "https://github.com/acme/widgets/actions/runs/99/job/7",
  steps: [],
};

function mockFetchWithAccordion(opts: {
  jobs?: GitHubJob[] | "error";
  log?: GitHubLogResponse | "error";
}) {
  return vi.fn((url: string) => {
    if (url.endsWith("/github/prs")) {
      return Promise.resolve(jsonResponse(200, PRS_WITH_RUN));
    }
    if (url.includes("/jobs/") && url.endsWith("/logs")) {
      if (opts.log === "error") return Promise.reject(new Error("log fetch failed"));
      return Promise.resolve(jsonResponse(200, opts.log));
    }
    if (url.endsWith("/jobs")) {
      if (opts.jobs === "error") return Promise.reject(new Error("jobs fetch failed"));
      return Promise.resolve(jsonResponse(200, opts.jobs));
    }
    return Promise.resolve(jsonResponse(200, STATUS));
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

  // Below: the PR card's own accordion (workflow runs -> jobs -> logs),
  // reachable only by expanding each level in turn — none of the tests
  // above click into it.

  it("shows 'No workflow runs for this PR' once a PR with none is expanded", async () => {
    vi.stubGlobal("fetch", mockFetch({ status: STATUS, prs: PRS_LOADED }));
    render(<GitHubPanel params={{ projectId: 7 }} />);

    const header = await screen.findByText("Fix attention race");
    await userEvent.click(header.closest("button")!);

    expect(await screen.findByText("No workflow runs for this PR")).toBeInTheDocument();
  });

  it("walks a PR's run through 'Loading jobs…' to the job list, then a job's log through 'Loading logs…' to its content", async () => {
    const jobsGate = deferred<GitHubJob[]>();
    const logGate = deferred<GitHubLogResponse>();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.endsWith("/github/prs")) return Promise.resolve(jsonResponse(200, PRS_WITH_RUN));
        if (url.includes("/jobs/") && url.endsWith("/logs")) {
          return logGate.promise.then((body) => jsonResponse(200, body));
        }
        if (url.endsWith("/jobs")) return jobsGate.promise.then((body) => jsonResponse(200, body));
        return Promise.resolve(jsonResponse(200, STATUS));
      }),
    );
    render(<GitHubPanel params={{ projectId: 8 }} />);

    const prHeader = await screen.findByText("Fix attention race");
    await userEvent.click(prHeader.closest("button")!);
    const runHeader = await screen.findByText("CI");
    await userEvent.click(runHeader.closest("button")!);

    expect(await screen.findByText("Loading jobs…")).toBeInTheDocument();
    jobsGate.resolve([JOB]);
    expect(await screen.findByText("build")).toBeInTheDocument();

    const jobHeader = screen.getByText("build");
    await userEvent.click(jobHeader.closest("button")!);
    expect(await screen.findByText("Loading logs…")).toBeInTheDocument();
    logGate.resolve({ log: "npm run build\n> done", job: JOB, truncated: false, lineCount: 2 });
    expect(await screen.findByText(/npm run build/)).toBeInTheDocument();
  });

  it("shows 'Failed to load jobs' when the jobs fetch rejects", async () => {
    vi.stubGlobal("fetch", mockFetchWithAccordion({ jobs: "error" }));
    render(<GitHubPanel params={{ projectId: 9 }} />);

    const prHeader = await screen.findByText("Fix attention race");
    await userEvent.click(prHeader.closest("button")!);
    const runHeader = await screen.findByText("CI");
    await userEvent.click(runHeader.closest("button")!);

    expect(await screen.findByText("Failed to load jobs")).toBeInTheDocument();
  });

  it("shows 'No log output' when a job's log is empty", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchWithAccordion({
        jobs: [JOB],
        log: { log: null, job: JOB, truncated: false, lineCount: 0 },
      }),
    );
    render(<GitHubPanel params={{ projectId: 10 }} />);

    const prHeader = await screen.findByText("Fix attention race");
    await userEvent.click(prHeader.closest("button")!);
    const runHeader = await screen.findByText("CI");
    await userEvent.click(runHeader.closest("button")!);
    const jobHeader = await screen.findByText("build");
    await userEvent.click(jobHeader.closest("button")!);

    expect(await screen.findByText("No log output")).toBeInTheDocument();
  });
});
