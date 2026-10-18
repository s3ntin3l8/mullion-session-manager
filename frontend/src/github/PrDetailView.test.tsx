// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

describe("PrDetailView", () => {
  afterEach(() => vi.unstubAllGlobals());

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

  it("shows an error and a back button when the PR cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(404, { message: "gone" })));
    const onBack = vi.fn();
    render(<PrDetailView projectId={1} number={99} onBack={onBack} />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "← Back" }));
    expect(onBack).toHaveBeenCalled();
  });
});
