// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { __resetGithubCacheForTests } from "../store/githubCacheReset.js";
import { PrDetailView } from "./PrDetailView.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { useDashboardStore } from "../store/index.js";
import type { GitHubPrDetail, ReviewSummary } from "../api/types.js";
import { makeProject, makeSession, makeTask } from "../test/fixtures.js";

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

const summaryOf = (over: Partial<ReviewSummary>): ReviewSummary => ({
  decision: null,
  approved: [],
  changesRequested: [],
  commented: [],
  requested: [],
  relay: null,
  unresolvedThreads: 0,
  latest: [],
  ...over,
});

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
function stubReview(state: unknown, detail: GitHubPrDetail = PR) {
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
    return Promise.resolve(jsonResponse(200, detail));
  });
}

describe("PrDetailView", () => {
  afterEach(() => vi.unstubAllGlobals());

  // The review relay's state for the PR (issue #1630).
  it("shows that a review was requested while it has not landed", async () => {
    vi.stubGlobal("fetch", stubReview({ state: "requested", runId: "run_1", status: "running" }));
    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    expect(await screen.findByText(/review requested — /)).toBeInTheDocument();
  });

  it("shows the landed review, with its verdict and what the bot said", async () => {
    vi.stubGlobal(
      "fetch",
      stubReview(
        {
          state: "landed",
          verdict: "CHANGES_REQUESTED",
          author: "hermes[bot]",
          body: "## Review\n\n**Verdict:** REQUEST_CHANGES",
          htmlUrl: "https://github.com/a/b/pull/12#pullrequestreview-1",
        },
        {
          ...PR,
          reviewDecision: null,
          reviewers: [{ login: "hermes[bot]", state: "CHANGES_REQUESTED" }],
          reviewSummary: summaryOf({ changesRequested: ["hermes[bot]"] }),
        },
      ),
    );
    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    expect(await screen.findByText(/Changes requested by hermes\[bot\]/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Reviews/ }));
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
      if (/\/github\/prs\/12$/.test(String(url))) {
        return Promise.resolve(
          jsonResponse(200, {
            ...PR,
            reviewSummary: summaryOf({ decision: "APPROVED", approved: ["hermes[bot]"] }),
          }),
        );
      }
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

  it("counts a COMMENTED-only bot review instead of saying `No reviews yet`", async () => {
    stub({
      ...PR,
      reviewDecision: null,
      reviewers: [{ login: "hermes", state: "COMMENTED" }],
      reviewSummary: summaryOf({
        decision: "COMMENTED",
        commented: ["hermes"],
        unresolvedThreads: 2,
      }),
    });
    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    expect(await screen.findByText("Commented by hermes · 2 open")).toBeInTheDocument();
    expect(screen.queryByText(/No reviews yet/)).toBeNull();
  });

  it("falls back to the lean reviewer list when the server sent no summary", async () => {
    stub({ ...PR, reviewSummary: undefined, reviewDecision: null, reviewers: [] });
    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    expect(await screen.findByText("No reviews yet")).toBeInTheDocument();
  });

  it("shows the relay inside the Reviews row, without a block of its own", async () => {
    stub({
      ...PR,
      reviewSummary: summaryOf({
        decision: "COMMENTED",
        commented: ["hermes"],
        relay: {
          state: "landed",
          reviewer: "hermes[bot]",
          url: "https://github.com/a/b/pull/12#r",
        },
      }),
    });
    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: /Reviews/ }));
    expect(screen.getByText(/Review relay · hermes\[bot\]/)).toBeInTheDocument();
    expect(screen.queryByText("Review", { selector: ".github-panel-section-title" })).toBeNull();
  });

  it("shows nothing when no relay run is known for the PR", async () => {
    vi.stubGlobal("fetch", stubReview({ state: "none" }));
    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    expect(await screen.findByText(/Add thing/)).toBeInTheDocument();
    expect(screen.queryByText(/A review was requested/)).toBeNull();
    expect(screen.queryByText(/Review posted/)).toBeNull();
  });

  it("shows status rows, changes, and the conversation with open threads first", async () => {
    stub(PR, (url) => (url.endsWith("/jobs") ? jsonResponse(200, []) : null));
    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);

    expect(await screen.findByText(/Add thing/)).toBeInTheDocument();
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
    await userEvent.click(await screen.findByRole("button", { name: "Re-review" }));
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
    await userEvent.click(await screen.findByRole("button", { name: "Re-review" }));
    expect(await screen.findByText("Re-review requested")).toBeInTheDocument();

    unmount();

    stub(PR, (url) =>
      url.endsWith("/re-review") ? jsonResponse(409, { message: "wait 60s" }) : null,
    );
    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Re-review" }));
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
    await userEvent.click(await screen.findByRole("button", { name: "Open session" }));
    await waitFor(() => expect(requestOpenSession).toHaveBeenCalledWith(7));
    expect(createSession).toHaveBeenCalledWith(1, "claude", {
      worktree: { branch: "feat-thing" },
      seedPrompt: "Fix the threads",
    });
  });

  it("re-fetches on Refresh", async () => {
    const fn = stub(PR);
    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    await screen.findByText(/Add thing/);
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
      await screen.findByText(/Add thing/);
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
    __resetGithubCacheForTests();

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
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalled();
  });

  describe("status-first layout (epic #1965, B4)", () => {
    const latest = (over: Partial<ReviewSummary["latest"][number]> = {}) => ({
      author: "hermes[bot]",
      isBot: true,
      state: "COMMENTED",
      body: "Looks right overall.",
      submittedAt: "2026-01-02T00:00:00Z",
      reviewedSha: "abc1234",
      stale: false,
      ...over,
    });

    it("puts the PR's own open-on-GitHub icon in the header", async () => {
      stub(PR);
      render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
      const link = await screen.findByRole("link", { name: "Open PR #12 on GitHub" });
      expect(link).toHaveAttribute("href", "https://github.com/a/b/pull/12");
    });

    it("pins the latest review under Status, marks it pinned above in the timeline", async () => {
      stub({
        ...PR,
        reviews: [
          {
            author: "hermes[bot]",
            state: "COMMENTED",
            bodyHtml: "<p>Looks right overall.</p>",
            createdAt: "2026-01-02T00:00:00Z",
          },
        ],
        reviewSummary: summaryOf({ unresolvedThreads: 2, latest: [latest()] }),
      });
      render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
      const pin = await screen.findByRole("region", { name: "Latest review by hermes[bot]" });
      expect(pin).toHaveTextContent("Looks right overall.");
      expect(pin).toHaveTextContent("Commented");
      expect(pin).toHaveTextContent("2 unresolved");
      expect(pin.textContent).not.toMatch(/stale/);
      // Not repeated as a full card in the conversation.
      expect(screen.getByText("pinned above")).toBeInTheDocument();
      expect(screen.getAllByText("Looks right overall.")).toHaveLength(1);
    });

    it("marks a review stale once the head moved past the commit it reviewed", async () => {
      stub({
        ...PR,
        commits: [
          { oid: "abc1234ffff", headline: "a", author: null, committedDate: "t" },
          { oid: "def", headline: "b", author: null, committedDate: "t" },
          { oid: "ghi", headline: "c", author: null, committedDate: "t" },
        ],
        reviewSummary: summaryOf({ latest: [latest({ stale: true })] }),
      });
      render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
      const pin = await screen.findByRole("region", { name: /Latest review/ });
      expect(pin).toHaveTextContent("stale · on abc1234, head +2");
    });

    it("says stale without a distance when the reviewed commit is unknown", async () => {
      stub({
        ...PR,
        reviewSummary: summaryOf({ latest: [latest({ stale: true, reviewedSha: "" })] }),
      });
      render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
      const pin = await screen.findByRole("region", { name: /Latest review/ });
      expect(pin).toHaveTextContent("stale");
      expect(pin.textContent).not.toMatch(/head \+/);
    });

    it("clamps a long review body and expands it", async () => {
      const body = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
      stub({ ...PR, reviewSummary: summaryOf({ latest: [latest({ body })] }) });
      render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
      const pin = await screen.findByRole("region", { name: /Latest review/ });
      expect(pin.querySelector(".pr-pin-body--clamp")).not.toBeNull();
      await userEvent.click(within(pin).getByRole("button", { name: "Read more" }));
      expect(pin.querySelector(".pr-pin-body--clamp")).toBeNull();
      await userEvent.click(within(pin).getByRole("button", { name: "Show less" }));
      expect(pin.querySelector(".pr-pin-body--clamp")).not.toBeNull();
    });

    it("pins the relay's landed review when the summary carries none yet", async () => {
      vi.stubGlobal(
        "fetch",
        stubReview({
          state: "landed",
          verdict: "CHANGES_REQUESTED",
          author: "hermes[bot]",
          body: "Please fix the retry loop.",
        }),
      );
      render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
      const pin = await screen.findByRole("region", { name: "Latest review by hermes[bot]" });
      expect(pin).toHaveTextContent("Changes requested");
      expect(pin).toHaveTextContent("Please fix the retry loop.");
    });

    it("re-reviews and hands off from the pinned card", async () => {
      stub({ ...PR, reviewSummary: summaryOf({ latest: [latest()] }) }, (url) =>
        url.endsWith("/re-review")
          ? jsonResponse(200, { status: "dispatched", runId: "r", replayed: false })
          : null,
      );
      render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
      const pin = await screen.findByRole("region", { name: /Latest review/ });
      await userEvent.click(within(pin).getByRole("button", { name: "Re-review" }));
      expect(await screen.findByText("Re-review requested")).toBeInTheDocument();
      expect(within(pin).getByRole("button", { name: "Hand off comments" })).toBeInTheDocument();
    });

    it("stops a running relay review from the pinned card and the Mullion card", async () => {
      const stopped = vi.fn();
      stub({ ...PR, reviewSummary: summaryOf({ latest: [latest()] }) }, (url, init) => {
        if (url.endsWith("/api/reviews/run_9/stop") && init?.method === "POST") {
          stopped();
          return jsonResponse(200, { runId: "run_9", status: "stopped" });
        }
        return null;
      });
      useDashboardStore.setState({
        prsByProject: {
          1: {
            prs: [
              {
                number: 12,
                title: "Add thing",
                htmlUrl: "u",
                author: "me",
                headSha: "abc",
                headBranch: "feat-thing",
                baseBranch: "main",
                ciStatus: "success",
                actionsRuns: [],
                relayReview: { state: "requested", runId: "run_9", status: "running" },
              },
            ],
            prSummary: { total: 1, pass: 1, fail: 0, pending: 0, unknown: 0 },
          },
        },
      });
      render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
      const mullion = await screen.findByRole("region", { name: "Mullion" });
      expect(mullion).toHaveTextContent("review run · running");
      expect(within(mullion).getByRole("button", { name: "Stop" })).toBeInTheDocument();
      const pin = screen.getByRole("region", { name: /Latest review/ });
      await userEvent.click(within(pin).getByRole("button", { name: "Stop review" }));
      await waitFor(() => expect(stopped).toHaveBeenCalled());
      expect(await screen.findByText("Review stopped")).toBeInTheDocument();
      useDashboardStore.setState({ prsByProject: {} });
    });

    it("offers Open existing session when a session already works the PR", async () => {
      stub(PR);
      const requestOpenSession = vi.fn();
      useDashboardStore.setState({
        requestOpenSession,
        projects: [makeProject({ id: 1 })],
        sessions: [
          makeSession({ id: 31, projectId: 1, name: "thing worker", liveBranch: "feat-thing" }),
        ],
        tasks: [makeTask({ id: 5, projectId: 1, branchName: "feat-thing", status: "in_progress" })],
        prsByProject: {
          1: {
            prs: [
              {
                number: 12,
                title: "Add thing",
                htmlUrl: "u",
                author: "me",
                headSha: "abc",
                headBranch: "feat-thing",
                baseBranch: "main",
                ciStatus: "success",
                actionsRuns: [],
              },
            ],
            prSummary: { total: 1, pass: 1, fail: 0, pending: 0, unknown: 0 },
          },
        },
        events: {
          31: [
            {
              seq: 1,
              sessionId: 31,
              kind: "pr_ci_failed",
              ts: Date.now() - 60_000,
              payload: { number: 12, title: "Add thing" },
            },
            {
              seq: 2,
              sessionId: 31,
              kind: "pr_ci_failed",
              ts: Date.now(),
              payload: { number: 99, title: "Other PR" },
            },
          ],
        } as never,
      });
      render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
      const btn = await screen.findByRole("button", { name: "Open existing session" });
      expect(screen.queryByRole("button", { name: "Open session" })).toBeNull();
      // The Mullion card: session pill, task chip, the PR's own recent events only.
      const mullion = screen.getByRole("region", { name: "Mullion" });
      expect(within(mullion).getByRole("button", { name: /thing worker/ })).toBeInTheDocument();
      expect(mullion).toHaveTextContent("task #5 · in_progress");
      const events = within(mullion).getByRole("list", { name: "Recent PR events" });
      expect(events).toHaveTextContent("#12: CI failed");
      expect(events).not.toHaveTextContent("#99");
      await userEvent.click(btn);
      expect(requestOpenSession).toHaveBeenCalledWith(31);
      useDashboardStore.setState({
        projects: [],
        sessions: [],
        tasks: [],
        prsByProject: {},
        events: {},
      });
    });

    it.each([
      ["reviewing", "Approve task", "approveTask", "Task #5 approved"],
      ["failed", "Retry task", "retryTask", "Task #5 retried"],
    ] as const)(
      "offers %s tasks their Task Master action from the Mullion card",
      async (status, label, action, notice) => {
        stub(PR);
        const fn = vi.fn().mockResolvedValue({});
        useDashboardStore.setState({
          [action]: fn,
          projects: [makeProject({ id: 1 })],
          tasks: [makeTask({ id: 5, projectId: 1, branchName: "feat-thing", status })],
          prsByProject: {
            1: {
              prs: [
                {
                  number: 12,
                  title: "Add thing",
                  htmlUrl: "u",
                  author: "me",
                  headSha: "abc",
                  headBranch: "feat-thing",
                  baseBranch: "main",
                  ciStatus: "success",
                  actionsRuns: [],
                },
              ],
              prSummary: { total: 1, pass: 1, fail: 0, pending: 0, unknown: 0 },
            },
          },
        });
        render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
        await userEvent.click(await screen.findByRole("button", { name: label }));
        expect(await screen.findByText(notice)).toBeInTheDocument();
        expect(fn).toHaveBeenCalledWith(5);
        useDashboardStore.setState({ projects: [], tasks: [], prsByProject: {} });
      },
    );

    // #2019 — a linked session held at Mullion's review gate: badge plus
    // Approve/Deny in the Mullion card, through POST /api/sessions/:id/review-gate.
    describe("review gate", () => {
      const gatedState = (refreshSessions = vi.fn().mockResolvedValue(undefined)) => ({
        refreshSessions,
        projects: [makeProject({ id: 1 })],
        sessions: [
          makeSession({
            id: 31,
            projectId: 1,
            name: "thing worker",
            liveBranch: "feat-thing",
            sessionStatus: "awaiting_review_gate" as const,
            gatePrompt: "Push to origin?",
          }),
        ],
        prsByProject: {
          1: {
            prs: [
              {
                number: 12,
                title: "Add thing",
                htmlUrl: "u",
                author: "me",
                headSha: "abc",
                headBranch: "feat-thing",
                baseBranch: "main",
                ciStatus: "success" as const,
                actionsRuns: [],
              },
            ],
            prSummary: { total: 1, pass: 1, fail: 0, pending: 0, unknown: 0 },
          },
        },
      });
      const gateCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
        fetchMock.mock.calls.filter(([url]) => String(url).includes("/review-gate"));
      afterEach(() => useDashboardStore.setState({ projects: [], sessions: [], prsByProject: {} }));

      it("badges the card and approves the gate", async () => {
        const fetchMock = stub(PR, (url) =>
          url.includes("/review-gate") ? new Response(null, { status: 204 }) : null,
        );
        const refreshSessions = vi.fn().mockResolvedValue(undefined);
        useDashboardStore.setState(gatedState(refreshSessions));
        render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
        const mullion = await screen.findByRole("region", { name: "Mullion" });
        expect(within(mullion).getByText("review gate").title).toContain(
          "thing worker: Push to origin?",
        );
        await userEvent.click(within(mullion).getByRole("button", { name: "Approve" }));
        await waitFor(() => expect(refreshSessions).toHaveBeenCalled());
        const [[url, init]] = gateCalls(fetchMock);
        expect(String(url)).toContain("/api/sessions/31/review-gate");
        expect(JSON.parse(String(init?.body))).toMatchObject({ decision: "approved" });
        expect(within(mullion).queryByRole("alert")).toBeNull();
      });

      it("treats a 409 (nothing pending any more) as a refresh, not an error", async () => {
        const fetchMock = stub(PR, (url) =>
          url.includes("/review-gate") ? jsonResponse(409, { message: "No pending gate" }) : null,
        );
        const refreshSessions = vi.fn().mockResolvedValue(undefined);
        useDashboardStore.setState(gatedState(refreshSessions));
        render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
        const mullion = await screen.findByRole("region", { name: "Mullion" });
        await userEvent.click(within(mullion).getByRole("button", { name: "Deny" }));
        await waitFor(() => expect(refreshSessions).toHaveBeenCalled());
        expect(JSON.parse(String(gateCalls(fetchMock)[0][1]?.body))).toMatchObject({
          decision: "denied",
        });
        expect(within(mullion).queryByRole("alert")).toBeNull();
      });

      it("shows any other failure", async () => {
        stub(PR, (url) =>
          url.includes("/review-gate") ? jsonResponse(500, { message: "boom" }) : null,
        );
        useDashboardStore.setState(gatedState());
        render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
        const mullion = await screen.findByRole("region", { name: "Mullion" });
        await userEvent.click(within(mullion).getByRole("button", { name: "Approve" }));
        expect(await within(mullion).findByRole("alert")).toHaveTextContent("boom");
      });
    });

    it("shows nothing-linked copy when no session, task or run is linked", async () => {
      stub(PR);
      render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
      expect(
        await screen.findByText(/No session, task or review run linked yet/),
      ).toBeInTheDocument();
    });

    it("lists non-Actions checks under Other checks in the Checks row", async () => {
      stub(
        {
          ...PR,
          prPhase: "ci_failing",
          otherChecks: [
            { name: "codecov/patch", state: "failure", url: "https://c/x", source: "status" },
            { name: "lint-bot", state: "success", url: null, source: "check_run" },
          ],
          checksTruncated: true,
        },
        (url) => (url.endsWith("/jobs") ? jsonResponse(200, []) : null),
      );
      render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
      expect(await screen.findByText("1 failing")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: /Checks/ }));
      const drill = screen.getByRole("region", { name: "Checks" });
      expect(within(drill).getByText("Other checks")).toBeInTheDocument();
      expect(within(drill).getByRole("link", { name: /codecov\/patch/ })).toHaveAttribute(
        "href",
        "https://c/x",
      );
      expect(within(drill).getByText("lint-bot")).toBeInTheDocument();
      expect(within(drill).getByText("More checks exist than are shown")).toBeInTheDocument();
    });

    it("offers the fix for what blocks the merge, in the Merge row", async () => {
      stub({ ...PR, prPhase: "ci_failing" }, (url) =>
        url.endsWith("/jobs") ? jsonResponse(200, []) : null,
      );
      const { unmount } = render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
      await userEvent.click(await screen.findByRole("button", { name: /Merge/ }));
      await userEvent.click(screen.getByRole("button", { name: "Show failing checks" }));
      expect(screen.getByRole("region", { name: "Checks" })).toBeInTheDocument();
      unmount();
      __resetGithubCacheForTests();

      stub({ ...PR, prPhase: "review_pending" });
      render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
      await userEvent.click(await screen.findByRole("button", { name: /Merge/ }));
      expect(screen.getByRole("button", { name: "Request re-review" })).toBeInTheDocument();
    });

    it("lists a comment-only reviewer in the Reviews drilldown, not 'No reviewers'", async () => {
      stub({
        ...PR,
        reviewDecision: null,
        reviewers: [],
        reviewSummary: summaryOf({ commented: ["hermes-bot"] }),
      });
      render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
      await userEvent.click(await screen.findByRole("button", { name: /Reviews/ }));
      const drill = screen.getByRole("region", { name: "Reviews" });
      expect(within(drill).getByText("hermes-bot")).toBeInTheDocument();
      expect(within(drill).queryByText("No reviewers")).toBeNull();
    });

    it("says reviews and conversation are unavailable on a partial detail", async () => {
      stub({ ...PR, partial: true });
      render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
      expect(await screen.findByText(/unavailable right now/)).toBeInTheDocument();
    });
  });
});
