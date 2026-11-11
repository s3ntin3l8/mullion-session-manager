// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GitHubPanel } from "./GitHubPanel.js";
import type { GitHubPRsStatus, GitHubStatus, ProjectReleaseStatus } from "./api/index.js";
import { jsonResponse } from "./test/jsonResponse.js";
import { useDashboardStore } from "./store/index.js";

// The Release section's own tests (#744, #2920), split out of
// GitHubPanel.test.tsx to keep that file under the line ceiling. The
// fixtures below are the small subset of that file's the Release section
// needs.
const RELEASE_NOT_CONFIGURED: ProjectReleaseStatus = {
  detection: { kind: "not-configured" },
  pr: null,
  conventionalTitlesWarning: false,
};

const STATUS: GitHubStatus = {
  repo: { owner: "acme", repo: "widgets", htmlUrl: "https://github.com/acme/widgets" },
  openIssues: 1,
  issuesHidden: false,
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

function issuesResponse(status: GitHubStatus) {
  return {
    issues: status.issues.map((i) => ({
      ...i,
      labels: [{ name: "bug", color: "d73a4a" }],
      assignees: [],
      commentCount: 0,
      milestone: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      taskStatus: null,
    })),
    page: 1,
    hasMore: false,
    labels: [{ name: "bug", color: "d73a4a" }],
    taskMasterEnabled: false,
    taskLabel: "mullion-task",
  };
}

describe("GitHubPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useDashboardStore.setState({
      prsByProject: {},
      githubOpenIssueByProject: {},
      githubIssueUiByProject: {},
      githubOpenPrByProject: {},
    });
  });

  describe("Release section (#744)", () => {
    const RELEASE_WORKFLOW = {
      id: 2,
      name: "Release Please",
      path: ".github/workflows/release-please.yml",
      dispatchable: true as boolean | null,
    };
    const RELEASE_NO_PR: ProjectReleaseStatus = {
      detection: { kind: "found", workflow: RELEASE_WORKFLOW },
      pr: null,
      conventionalTitlesWarning: false,
    };

    function releasePrFixture(
      overrides: Partial<NonNullable<ProjectReleaseStatus["pr"]>> = {},
    ): NonNullable<ProjectReleaseStatus["pr"]> {
      return {
        number: 12,
        htmlUrl: "https://github.com/acme/widgets/pull/12",
        title: "chore(main): release 0.2.46",
        headRef: "release-please--branches--main--components--widgets",
        headSha: "deadbeef",
        draft: false,
        mergeable: true,
        mergeableState: "clean",
        ciStatus: "success",
        heldRuns: 0,
        noRuns: false,
        ...overrides,
      };
    }

    function mockFetchRelease(opts: {
      release: ProjectReleaseStatus;
      prs?: GitHubPRsStatus | "fail";
      status?: GitHubStatus;
      run?: () => Response;
      approve?: () => Response;
      merge?: () => Response;
    }) {
      return vi.fn((url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url.endsWith("/github/prs")) {
          if (opts.prs === "fail") return Promise.resolve(jsonResponse(500, { error: "down" }));
          return Promise.resolve(jsonResponse(200, opts.prs ?? PRS_EMPTY));
        }
        if (url.endsWith("/release/run") && method === "POST") {
          return Promise.resolve((opts.run ?? (() => jsonResponse(200, { dispatched: true })))());
        }
        if (url.endsWith("/release/approve-runs") && method === "POST") {
          return Promise.resolve((opts.approve ?? (() => jsonResponse(200, { approved: 1 })))());
        }
        if (url.endsWith("/release/merge") && method === "POST") {
          return Promise.resolve((opts.merge ?? (() => jsonResponse(200, { merged: true })))());
        }
        if (url.endsWith("/release")) return Promise.resolve(jsonResponse(200, opts.release));
        if (url.includes("/github/issues")) {
          return Promise.resolve(jsonResponse(200, issuesResponse(STATUS)));
        }
        return Promise.resolve(jsonResponse(200, opts.status ?? STATUS));
      });
    }

    it("lists the release PR under Release only, not again under Pull requests", async () => {
      const release: ProjectReleaseStatus = {
        ...RELEASE_NO_PR,
        pr: releasePrFixture({ number: 42, title: "chore(main): release 0.2.46" }),
      };
      const prs: GitHubPRsStatus = {
        ...PRS_LOADED,
        prs: [{ ...PRS_LOADED.prs[0], title: "chore(main): release 0.2.46" }],
      };
      vi.stubGlobal("fetch", mockFetchRelease({ release, prs }));
      render(<GitHubPanel params={{ projectId: 20 }} />);
      await screen.findByText("chore(main): release 0.2.46");
      await screen.findByText("No open pull requests");
      expect(screen.getAllByText("chore(main): release 0.2.46")).toHaveLength(1);
    });

    it("keeps other PRs in the list next to the release PR", async () => {
      const release: ProjectReleaseStatus = {
        ...RELEASE_NO_PR,
        pr: releasePrFixture({ number: 12 }),
      };
      vi.stubGlobal("fetch", mockFetchRelease({ release, prs: PRS_LOADED }));
      render(<GitHubPanel params={{ projectId: 20 }} />);
      await screen.findByText("Fix attention race");
      expect(screen.getByText("chore(main): release 0.2.46")).toBeInTheDocument();
    });

    it("also hides the release PR from the fallback list when the PR poller has no data", async () => {
      const release: ProjectReleaseStatus = {
        ...RELEASE_NO_PR,
        pr: releasePrFixture({ number: 42, title: "Fix attention race" }),
      };
      vi.stubGlobal("fetch", mockFetchRelease({ release, prs: "fail" }));
      render(<GitHubPanel params={{ projectId: 20 }} />);
      await screen.findByText("Fix attention race");
      expect(screen.getAllByText("Fix attention race")).toHaveLength(1);
      // The fallback list itself is gone, not merely deduplicated.
      expect(screen.getByText("No open pull requests")).toBeInTheDocument();
    });

    it("disables Run, naming the workflow file, when it has no workflow_dispatch trigger", async () => {
      const release: ProjectReleaseStatus = {
        ...RELEASE_NO_PR,
        detection: {
          kind: "found",
          workflow: { ...RELEASE_WORKFLOW, dispatchable: false },
        },
      };
      vi.stubGlobal("fetch", mockFetchRelease({ release }));
      render(<GitHubPanel params={{ projectId: 20 }} />);
      const run = await screen.findByRole("button", { name: /Run/ });
      expect(run).toBeDisabled();
      expect(run).toHaveAttribute("title", expect.stringContaining("release-please.yml"));
      // Visible on screen too, since a disabled button shows no tooltip everywhere.
      expect(screen.getByText(/Run is unavailable/)).toBeInTheDocument();
    });

    it("keeps Run enabled when the workflow file couldn't be read (dispatchable: null)", async () => {
      const release: ProjectReleaseStatus = {
        ...RELEASE_NO_PR,
        detection: { kind: "found", workflow: { ...RELEASE_WORKFLOW, dispatchable: null } },
      };
      vi.stubGlobal("fetch", mockFetchRelease({ release }));
      render(<GitHubPanel params={{ projectId: 20 }} />);
      expect(await screen.findByRole("button", { name: /Run/ })).toBeEnabled();
    });

    it("opens the PR detail view when the release row is clicked, but not from its GitHub link", async () => {
      useDashboardStore.setState({ githubOpenPrByProject: {} });
      const release: ProjectReleaseStatus = { ...RELEASE_NO_PR, pr: releasePrFixture() };
      vi.stubGlobal("fetch", mockFetchRelease({ release }));
      render(<GitHubPanel params={{ projectId: 20 }} />);
      const link = await screen.findByRole("link", { name: "#12" });
      fireEvent.click(link);
      expect(useDashboardStore.getState().githubOpenPrByProject[20] ?? null).toBeNull();
      fireEvent.click(screen.getByText("chore(main): release 0.2.46"));
      expect(useDashboardStore.getState().githubOpenPrByProject[20]).toBe(12);
      useDashboardStore.setState({ githubOpenPrByProject: {} });
    });

    it("renders nothing when the repo has no release-please workflow", async () => {
      vi.stubGlobal("fetch", mockFetchRelease({ release: RELEASE_NOT_CONFIGURED }));
      render(<GitHubPanel params={{ projectId: 20 }} />);
      await screen.findByText("acme/widgets");
      expect(screen.queryByText("Release")).not.toBeInTheDocument();
    });

    // The branchdam-mobile incident's own shape: `detection.kind` is
    // "not-configured" (ReleaseSection itself renders nothing, per the test
    // above) AND the repo genuinely has release-please config committed with
    // conventionalCommitTitles off. conventionalTitlesWarning is a SIBLING
    // signal, not a variant of `detection` — this must render regardless of
    // ReleaseSection returning null.
    it("renders the Conventional Commits warning even when detection is not-configured", async () => {
      const release: ProjectReleaseStatus = {
        detection: { kind: "not-configured" },
        pr: null,
        conventionalTitlesWarning: true,
      };
      vi.stubGlobal("fetch", mockFetchRelease({ release }));
      render(<GitHubPanel params={{ projectId: 20 }} />);
      await screen.findByText("Release");
      expect(screen.getByText(/release-please configured/)).toBeInTheDocument();
    });

    it("does not render the warning when conventionalTitlesWarning is false", async () => {
      vi.stubGlobal("fetch", mockFetchRelease({ release: RELEASE_NOT_CONFIGURED }));
      render(<GitHubPanel params={{ projectId: 20 }} />);
      await screen.findByText("acme/widgets");
      expect(screen.queryByText(/release-please configured/)).not.toBeInTheDocument();
    });

    // Regression: a repo can have BOTH detection.kind === "found" (a real
    // workflow file detectReleaseWorkflow recognizes) AND
    // conventionalTitlesWarning true at once — 2 of the 14 release-please
    // repos surveyed for this feature name their workflow file
    // release-please.yml while ALSO committing release-please-config.json.
    // ReleaseSection renders its own "Release" header for "found"; the
    // warning must slot into that SAME section, not add a second one.
    it("renders exactly one Release header when detection is found and the warning also fires", async () => {
      const release: ProjectReleaseStatus = {
        ...RELEASE_NO_PR,
        conventionalTitlesWarning: true,
      };
      vi.stubGlobal("fetch", mockFetchRelease({ release }));
      render(<GitHubPanel params={{ projectId: 20 }} />);
      await screen.findByText("release-please configured", { exact: false });
      expect(screen.getAllByText("Release")).toHaveLength(1);
      expect(screen.getByText("No release PR open")).toBeInTheDocument();
    });

    // Regression: "not-configured" and "no-actions-scope" must NOT collapse
    // to the same "render nothing" outcome — that's the exact ambiguity
    // docs/github-integration.md already regrets for the CI dot ("no UI
    // signal distinguishing 'no workflows' from 'no permission'"). A repo
    // that DOES use release-please but has a scope-limited token should
    // say so, not look identical to one that simply doesn't use it.
    it("shows a note, not nothing, when the token can't check for a release-please workflow", async () => {
      const release: ProjectReleaseStatus = {
        detection: { kind: "no-actions-scope" },
        pr: null,
        conventionalTitlesWarning: false,
      };
      vi.stubGlobal("fetch", mockFetchRelease({ release }));
      render(<GitHubPanel params={{ projectId: 27 }} />);

      expect(await screen.findByText("Release")).toBeInTheDocument();
      expect(screen.getByText(/Actions: read/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Run/ })).not.toBeInTheDocument();
    });

    it("shows Run enabled and Merge disabled when no release PR is open", async () => {
      vi.stubGlobal("fetch", mockFetchRelease({ release: RELEASE_NO_PR }));
      render(<GitHubPanel params={{ projectId: 21 }} />);

      await screen.findByText("Release");
      expect(screen.getByText("No release PR open")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Run/ })).toBeEnabled();
      expect(screen.getByRole("button", { name: /Merge/ })).toBeDisabled();
    });

    it("disables Merge and names the mergeableState in its title when the PR isn't clean", async () => {
      const release: ProjectReleaseStatus = {
        detection: { kind: "found", workflow: RELEASE_WORKFLOW },
        pr: releasePrFixture({ mergeableState: "behind" }),
        conventionalTitlesWarning: false,
      };
      vi.stubGlobal("fetch", mockFetchRelease({ release }));
      render(<GitHubPanel params={{ projectId: 22 }} />);

      await screen.findByText("Release");
      const mergeButton = screen.getByRole("button", { name: /Merge/ });
      expect(mergeButton).toBeDisabled();
      expect(mergeButton.getAttribute("title")).toContain("behind");
    });

    it("enables Merge for a clean PR, and a successful merge re-fetches release status", async () => {
      const cleanRelease: ProjectReleaseStatus = {
        detection: { kind: "found", workflow: RELEASE_WORKFLOW },
        pr: releasePrFixture(),
        conventionalTitlesWarning: false,
      };
      const mergedRelease: ProjectReleaseStatus = {
        detection: { kind: "found", workflow: RELEASE_WORKFLOW },
        pr: null,
        conventionalTitlesWarning: false,
      };
      let releaseCallCount = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string, init?: RequestInit) => {
          const method = init?.method ?? "GET";
          if (url.endsWith("/github/prs")) return Promise.resolve(jsonResponse(200, PRS_EMPTY));
          if (url.endsWith("/release/merge") && method === "POST") {
            return Promise.resolve(jsonResponse(200, { merged: true }));
          }
          if (url.endsWith("/release")) {
            releaseCallCount++;
            return Promise.resolve(
              jsonResponse(200, releaseCallCount === 1 ? cleanRelease : mergedRelease),
            );
          }
          if (url.includes("/github/issues")) {
            return Promise.resolve(jsonResponse(200, issuesResponse(STATUS)));
          }
          return Promise.resolve(jsonResponse(200, STATUS));
        }),
      );
      const user = userEvent.setup();
      render(<GitHubPanel params={{ projectId: 23 }} />);

      const mergeButton = await screen.findByRole("button", { name: /Merge/ });
      expect(mergeButton).toBeEnabled();
      await user.click(mergeButton);

      expect(await screen.findByText("No release PR open")).toBeInTheDocument();
    });

    it("says so when Run was dispatched", async () => {
      vi.stubGlobal("fetch", mockFetchRelease({ release: RELEASE_NO_PR }));
      const user = userEvent.setup();
      render(<GitHubPanel params={{ projectId: 901 }} />);
      await user.click(await screen.findByRole("button", { name: /Run/ }));
      expect(await screen.findByText(/Release-please started/)).toBeInTheDocument();
    });

    it("shows Approve runs with the held count and approves on click", async () => {
      const approveSpy = vi.fn(() => jsonResponse(200, { approved: 2 }));
      const release: ProjectReleaseStatus = {
        ...RELEASE_NO_PR,
        pr: releasePrFixture({ heldRuns: 2, mergeableState: "blocked" }),
      };
      vi.stubGlobal("fetch", mockFetchRelease({ release, approve: approveSpy }));
      const user = userEvent.setup();
      render(<GitHubPanel params={{ projectId: 902 }} />);
      expect(
        await screen.findByText(/2 workflow runs are waiting for approval/),
      ).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Approve runs (2)" }));
      expect(approveSpy).toHaveBeenCalledTimes(1);
      expect(await screen.findByText(/Approved 2 workflow runs/)).toBeInTheDocument();
    });

    it("shows a refusal when approving is forbidden", async () => {
      const release: ProjectReleaseStatus = {
        ...RELEASE_NO_PR,
        pr: releasePrFixture({ heldRuns: 1 }),
      };
      vi.stubGlobal(
        "fetch",
        mockFetchRelease({
          release,
          approve: () => jsonResponse(200, { approved: 0, reason: "forbidden", detail: "x" }),
        }),
      );
      const user = userEvent.setup();
      render(<GitHubPanel params={{ projectId: 903 }} />);
      await user.click(await screen.findByRole("button", { name: "Approve runs (1)" }));
      expect(await screen.findByText(/needs Actions: write/)).toBeInTheDocument();
    });

    it("hides Approve runs when nothing is held, and explains a PR with no runs at all", async () => {
      const release: ProjectReleaseStatus = {
        ...RELEASE_NO_PR,
        pr: releasePrFixture({ noRuns: true }),
      };
      vi.stubGlobal("fetch", mockFetchRelease({ release }));
      render(<GitHubPanel params={{ projectId: 904 }} />);
      expect(await screen.findByText(/cannot trigger workflows/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Approve runs/ })).not.toBeInTheDocument();
    });

    it("clicking Run dispatches the workflow", async () => {
      const runSpy = vi.fn(() => jsonResponse(200, { dispatched: true }));
      vi.stubGlobal("fetch", mockFetchRelease({ release: RELEASE_NO_PR, run: runSpy }));
      const user = userEvent.setup();
      render(<GitHubPanel params={{ projectId: 24 }} />);

      const runButton = await screen.findByRole("button", { name: /Run/ });
      await user.click(runButton);

      expect(runSpy).toHaveBeenCalledTimes(1);
    });

    it("renders a refusal banner when Run is refused", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetchRelease({
          release: RELEASE_NO_PR,
          run: () => jsonResponse(200, { dispatched: false, reason: "no-dispatch-trigger" }),
        }),
      );
      const user = userEvent.setup();
      render(<GitHubPanel params={{ projectId: 25 }} />);

      const runButton = await screen.findByRole("button", { name: /Run/ });
      await user.click(runButton);

      expect(await screen.findByText(/doesn't accept manual runs yet/)).toBeInTheDocument();
    });

    describe("release status refetch after a refused Run", () => {
      async function clickRunAndCountReads(reason: string, banner: RegExp) {
        const fetchMock = mockFetchRelease({
          release: RELEASE_NO_PR,
          run: () => jsonResponse(200, { dispatched: false, reason }),
        });
        vi.stubGlobal("fetch", fetchMock);
        const releaseReads = () =>
          fetchMock.mock.calls.filter(
            ([url, init]) => url.endsWith("/release") && (init?.method ?? "GET") === "GET",
          ).length;
        const user = userEvent.setup();
        render(<GitHubPanel params={{ projectId: 25 }} />);
        const runButton = await screen.findByRole("button", { name: /Run/ });
        const before = releaseReads();
        await user.click(runButton);
        await screen.findByText(banner);
        // Give a (wrongly) triggered refetch time to land before counting.
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { before, after: releaseReads() };
      }

      it("refetches after a no-dispatch-trigger refusal", async () => {
        const { before, after } = await clickRunAndCountReads(
          "no-dispatch-trigger",
          /doesn't accept manual runs yet/,
        );
        expect(after).toBeGreaterThan(before);
      });

      it("does not refetch after a dispatch-failed refusal", async () => {
        const { before, after } = await clickRunAndCountReads(
          "dispatch-failed",
          /Failed to start a release run/,
        );
        expect(after).toBe(before);
      });
    });

    it("renders a refusal banner when Merge is refused", async () => {
      const release: ProjectReleaseStatus = {
        detection: { kind: "found", workflow: RELEASE_WORKFLOW },
        pr: releasePrFixture(),
        conventionalTitlesWarning: false,
      };
      vi.stubGlobal(
        "fetch",
        mockFetchRelease({
          release,
          merge: () => jsonResponse(200, { merged: false, reason: "dirty" }),
        }),
      );
      const user = userEvent.setup();
      render(<GitHubPanel params={{ projectId: 26 }} />);

      const mergeButton = await screen.findByRole("button", { name: /Merge/ });
      await user.click(mergeButton);

      expect(await screen.findByText(/merge conflict/)).toBeInTheDocument();
    });
  });
});
