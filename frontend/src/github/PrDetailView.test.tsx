// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { __resetGithubCacheForTests } from "../store/githubCacheReset.js";
import { PrDetailView } from "./PrDetailView.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { useDashboardStore } from "../store/index.js";
import type { GitHubPrDetail } from "../api/types.js";

const PR: GitHubPrDetail = {
  number: 12,
  title: "Add thing",
  htmlUrl: "https://github.com/a/b/pull/12",
  state: "OPEN",
  isDraft: false,
  author: "me",
  bodyHtml: "<p>desc</p>",
  baseBranch: "main",
  headBranch: "feat-thing",
  headSha: "abc",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  additions: 10,
  deletions: 2,
  changedFiles: 1,
  commitCount: 1,
  commits: [{ oid: "commit-1", headline: "feat: thing", author: "Me", committedDate: "t" }],
  files: [{ filename: "src/a.ts", status: "modified", additions: 10, deletions: 2 }],
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  requestedReviewers: [],
  reviewers: [{ login: "bob", state: "APPROVED" }],
  reviews: [
    {
      author: "bob",
      state: "APPROVED",
      bodyHtml: "<p>lgtm</p>",
      createdAt: "2026-01-02T00:00:00Z",
    },
  ],
  threads: [
    {
      isResolved: false,
      isOutdated: false,
      path: "src/a.ts",
      line: 4,
      comments: [
        { author: "bob", bodyHtml: "<p>guard null</p>", createdAt: "2026-01-02T00:00:00Z" },
      ],
    },
    {
      isResolved: true,
      isOutdated: false,
      path: "src/b.ts",
      line: 1,
      comments: [{ author: "bob", bodyHtml: "<p>old nit</p>", createdAt: "2026-01-02T00:00:00Z" }],
    },
  ],
  comments: [{ author: "carol", bodyHtml: "<p>nice</p>", createdAt: "2026-01-03T00:00:00Z" }],
  ciStatus: "success",
  ciKnown: true,
  actionsRuns: [
    {
      name: "CI",
      status: "completed",
      conclusion: "success",
      htmlUrl: "https://github.com/a/b/actions/runs/1",
      headSha: "abc",
    },
  ],
  prPhase: "ready_to_merge",
};

function stub(pr: GitHubPrDetail, extra?: (url: string, init?: RequestInit) => Response | null) {
  const fn = vi.fn((url: string, init?: RequestInit) => {
    const custom = extra?.(url, init);
    if (custom) return Promise.resolve(custom);
    return Promise.resolve(jsonResponse(200, pr));
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

// The review relay's state for the PR (issue #1630) — its own endpoint, so
// it needs its own stub. `states` may hold one state for every PR, or one
// per PR number (so a test can tell two PRs apart).
function stubReview(state: unknown) {
  const byPr =
    typeof state === "object" && state !== null && !("state" in state)
      ? (state as Record<string, unknown>)
      : null;
  return vi.fn((url: string, _init?: RequestInit) => {
    const match = /\/github\/prs\/(\d+)\/review/.exec(String(url));
    if (match) {
      const per = byPr ? byPr[match[1]] : state;
      return Promise.resolve(jsonResponse(200, per));
    }
    return Promise.resolve(jsonResponse(200, PR));
  });
}

describe("PrDetailView", () => {
  afterEach(() => vi.unstubAllGlobals());

  // The review relay's state for the PR (issue #1630).
  it("shows that a review was requested while it has not landed", async () => {
    vi.stubGlobal("fetch", stubReview({ state: "requested", runId: "run_1", status: "running" }));
    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    expect(await screen.findByText(/A review was requested/)).toBeInTheDocument();
  });

  it("shows the landed review, with its verdict and what the bot said", async () => {
    vi.stubGlobal(
      "fetch",
      stubReview({
        state: "landed",
        verdict: "CHANGES_REQUESTED",
        author: "hermes[bot]",
        body: "## Review\n\n**Verdict:** REQUEST_CHANGES",
        htmlUrl: "https://github.com/a/b/pull/12#pullrequestreview-1",
      }),
    );
    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    expect(await screen.findByText(/Changes requested by hermes\[bot\]/)).toBeInTheDocument();
    expect(screen.getByText(/Verdict/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "open on GitHub" })).toBeInTheDocument();
  });

  it.each([
    ["not_found", /the review run is no longer known to the relay/],
    ["unknown", /the relay could not read the review run/],
  ])("does not claim a %s review is still waiting", async (status, expected) => {
    vi.stubGlobal("fetch", stubReview({ state: "requested", runId: "run_1", status }));
    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(screen.queryByText(/waiting for the review bot/)).toBeNull();
  });

  it("does not claim a failed review is still waiting", async () => {
    vi.stubGlobal("fetch", stubReview({ state: "requested", runId: "run_1", status: "failed" }));
    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    expect(await screen.findByText(/the review did not finish/)).toBeInTheDocument();
    expect(screen.queryByText(/waiting for the review bot/)).toBeNull();
  });

  it("does not claim a review with no status at all is still waiting", async () => {
    // No status means the run-status read failed — the panel must not turn
    // that silence into "the review bot is on it".
    vi.stubGlobal("fetch", stubReview({ state: "requested", runId: "run_1" }));
    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    expect(await screen.findByText(/the relay could not read the review run/)).toBeInTheDocument();
    expect(screen.queryByText(/waiting for the review bot/)).toBeNull();
  });

  it("does not claim a review is still waiting when the landed lookup failed", async () => {
    // The review may well have landed — the lookup that would have said so
    // failed, which is not the same as "nothing landed".
    vi.stubGlobal(
      "fetch",
      stubReview({ state: "requested", runId: "run_1", status: "running", landedChecked: false }),
    );
    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    expect(
      await screen.findByText(/the review could not be confirmed on the pull request/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/waiting for the review bot/)).toBeNull();
  });

  it("does not claim a finished review posted nothing when the landed lookup failed", async () => {
    // The run completed, but the lookup that would have said whether the bot
    // posted anything failed — so "the review finished without posting" would
    // be a claim made from no data.
    vi.stubGlobal(
      "fetch",
      stubReview({ state: "requested", runId: "run_1", status: "completed", landedChecked: false }),
    );
    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    expect(
      await screen.findByText(/the review could not be confirmed on the pull request/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/the review finished without posting/)).toBeNull();
  });

  it("does not show one PR's review under another PR's header", async () => {
    // PR 12 has a landed review; PR 13's review never arrives — so the
    // assertion below is about the previous PR's verdict lingering, not about
    // a payload that eventually shows up.
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (String(url).includes("/github/prs/12/review")) {
        return Promise.resolve(
          jsonResponse(200, {
            state: "landed",
            verdict: "APPROVED",
            author: "hermes[bot]",
            body: "## Review",
          }),
        );
      }
      if (String(url).includes("/github/prs/13/review")) {
        return new Promise<Response>(() => undefined); // never settles
      }
      return Promise.resolve(jsonResponse(200, PR));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    expect(await screen.findByText(/Approved by hermes\[bot\]/)).toBeInTheDocument();
    // Another PR: the previous PR's verdict must not linger, even before
    // the new PR's own state arrives.
    rerender(<PrDetailView projectId={1} number={13} onBack={vi.fn()} />);
    expect(screen.queryByText(/Approved by hermes\[bot\]/)).toBeNull();
  });

  it("shows nothing when no relay run is known for the PR", async () => {
    vi.stubGlobal("fetch", stubReview({ state: "none" }));
    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    expect(await screen.findByText("Add thing")).toBeInTheDocument();
    expect(screen.queryByText(/A review was requested/)).toBeNull();
    expect(screen.queryByText(/Review posted/)).toBeNull();
  });

  it("shows status rows, changes, and the conversation with open threads first", async () => {
    stub(PR);
    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);

    expect(await screen.findByText("Add thing")).toBeInTheDocument();
    expect(screen.getByText("Approved by bob")).toBeInTheDocument();
    expect(screen.getByText("All checks have passed")).toBeInTheDocument();
    expect(screen.getByText("Ready to merge (squash)")).toBeInTheDocument();
    expect(screen.getByText("Unresolved threads (1)")).toBeInTheDocument();
    expect(screen.getByText("guard null")).toBeInTheDocument();
    expect(screen.getByText("Resolved threads (1)")).toBeInTheDocument();
    expect(screen.getByText("nice")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /1 files changed/ }));
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    expect(screen.queryByText(/Showing the first/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "1 commit" }));
    expect(screen.getByText("feat: thing")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Reviews/ }));
    expect(screen.getByText("approved")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Checks/ }));
    expect(screen.getByRole("link", { name: /CI/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Read more" }));
    expect(screen.getByRole("button", { name: "Show less" })).toBeInTheDocument();
  });

  it("describes blocked states: changes requested, conflicts, failing checks, pending review", async () => {
    stub({
      ...PR,
      prPhase: "changes_requested",
      reviewDecision: "CHANGES_REQUESTED",
      reviewers: [{ login: "bob", state: "CHANGES_REQUESTED" }],
      actionsRuns: [
        { ...PR.actionsRuns[0], conclusion: "failure" },
        {
          ...PR.actionsRuns[0],
          htmlUrl: "https://x/runs/2",
          status: "in_progress",
          conclusion: null,
        },
      ],
    });
    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    expect(await screen.findByText("Changes requested by bob")).toBeInTheDocument();
    expect(screen.getByText("1 failing, 1 in progress")).toBeInTheDocument();
    expect(screen.getByText("Blocked: changes requested")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Squash and merge/ })).toBeDisabled();
  });

  it("covers conflicts, awaiting review, draft and merged summaries", async () => {
    stub({
      ...PR,
      prPhase: "conflicts",
      reviewDecision: null,
      reviewers: [],
      requestedReviewers: ["alice"],
      actionsRuns: [],
    });
    const { unmount } = render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    expect(await screen.findByText("Conflicts with the base branch")).toBeInTheDocument();
    expect(screen.getByText("Awaiting review from alice")).toBeInTheDocument();
    expect(screen.getByText("No checks reported")).toBeInTheDocument();
    unmount();
    // The cache would (correctly) serve the first PR for the same key.
    __resetGithubCacheForTests();

    stub({
      ...PR,
      state: "MERGED",
      isDraft: true,
      reviewDecision: "REVIEW_REQUIRED",
      reviewers: [],
    });
    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    expect(await screen.findByText("Merged")).toBeInTheDocument();
    expect(screen.getByText("draft")).toBeInTheDocument();
    expect(screen.getByText("Review required")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Squash and merge/ })).toBeNull();
  });

  it("squash-merges after the confirm click, pinned to the head sha", async () => {
    const fn = stub(PR, (url) =>
      url.endsWith("/merge") ? jsonResponse(200, { merged: true, sha: "m" }) : null,
    );
    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    const btn = await screen.findByRole("button", { name: /Squash and merge/ });
    await userEvent.click(btn);
    await userEvent.click(screen.getByRole("button", { name: /Confirm merge/ }));
    expect(await screen.findByText("Merged (squash)")).toBeInTheDocument();
    const call = fn.mock.calls.find(([u]) => String(u).endsWith("/merge"))!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({ headSha: "abc" });
  });

  it("says when the re-review's in-flight marker could not be written (#1790)", async () => {
    stub(PR, (url) =>
      url.endsWith("/re-review")
        ? jsonResponse(200, {
            status: "dispatched",
            runId: "r",
            replayed: false,
            marker: {
              written: false,
              reason: "permission-not-granted",
              message: "no Checks grant",
            },
          })
        : null,
    );
    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Request re-review" }));
    expect(
      await screen.findByText(
        "Re-review requested — in-flight marker not written: no Checks grant",
      ),
    ).toBeInTheDocument();
  });

  it("requests a re-review and surfaces a refusal", async () => {
    stub(PR, (url) =>
      url.endsWith("/re-review")
        ? jsonResponse(200, { status: "dispatched", runId: "r", replayed: false })
        : null,
    );
    const { unmount } = render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Request re-review" }));
    expect(await screen.findByText("Re-review requested")).toBeInTheDocument();

    unmount();

    stub(PR, (url) =>
      url.endsWith("/re-review") ? jsonResponse(409, { message: "wait 60s" }) : null,
    );
    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Request re-review" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("hands off to a new session on the PR branch with the generated prompt", async () => {
    stub(PR, (url) => {
      if (url.endsWith("/handoff")) {
        return jsonResponse(200, { prompt: "Fix the threads", branch: "feat-thing" });
      }
      if (url.endsWith("/actions")) {
        return jsonResponse(200, [{ id: "agent:claude", command: "claude" }]);
      }
      return null;
    });
    const createSession = vi.fn().mockResolvedValue({ id: 7 });
    const requestOpenSession = vi.fn();
    useDashboardStore.setState({ createSession, requestOpenSession });

    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Hand off to session" }));
    await waitFor(() => expect(requestOpenSession).toHaveBeenCalledWith(7));
    expect(createSession).toHaveBeenCalledWith(1, "claude", {
      worktree: { branch: "feat-thing" },
      seedPrompt: "Fix the threads",
    });
  });

  it("re-fetches on Refresh", async () => {
    const fn = stub(PR);
    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    await screen.findByText("Add thing");
    const prFetches = () => fn.mock.calls.filter((c) => String(c[0]).endsWith("/prs/12")).length;
    expect(prFetches()).toBe(1);

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(prFetches()).toBe(2));
  });

  it("says the file list is unavailable (not partial) when it failed to load", async () => {
    stub({ ...PR, files: [], changedFiles: 4 });
    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: /4 files changed/ }));
    expect(screen.getByText("File list unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/Showing the first/)).toBeNull();
  });

  it("says when the file list is partial", async () => {
    stub({ ...PR, changedFiles: 250 });
    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: /250 files changed/ }));
    expect(screen.getByText("Showing the first 1 of 250 files")).toBeInTheDocument();
  });

  it("polls while visible and skips ticks while the tab is hidden", async () => {
    const fn = stub(PR);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
      await screen.findByText("Add thing");
      const prFetches = () => fn.mock.calls.filter((c) => String(c[0]).endsWith("/prs/12")).length;
      expect(prFetches()).toBe(1);

      await vi.advanceTimersByTimeAsync(30_000);
      await waitFor(() => expect(prFetches()).toBe(2));

      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(prFetches()).toBe(2);
      visibility.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says checks are unknown (not absent) when the poller has no CI answer", async () => {
    stub({ ...PR, ciStatus: null, ciKnown: false, actionsRuns: [], prPhase: "unknown" });
    const { unmount } = render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    expect(await screen.findByText("Checks unknown")).toBeInTheDocument();
    unmount();

    // The poller did fetch the head runs and found none: that is an answer.
    stub({ ...PR, ciStatus: null, ciKnown: true, actionsRuns: [] });
    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    expect(await screen.findByText("No checks reported")).toBeInTheDocument();
  });

  it("shows an error and a back button when the PR cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(404, { message: "gone" })));
    const onBack = vi.fn();
    render(<PrDetailView projectId={1} number={99} onBack={onBack} />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "← Back" }));
    expect(onBack).toHaveBeenCalled();
  });
});
