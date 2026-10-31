// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PrDetailView } from "./PrDetailView.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { useDashboardStore } from "../store/index.js";
import { makeProject, makeSession, makeTask } from "../test/fixtures.js";
import { PR, stub, summaryOf } from "./prDetailTestKit.js";

// A task PR's action bar and pinned review: which session ▶ opens, and where
// the pinned review's comments go. The handoff step itself is covered in
// PrDetailView.test.tsx.
describe("a task PR", () => {
  const seed = (status: string, sessions: ReturnType<typeof makeSession>[] = [], over = {}) =>
    useDashboardStore.setState({
      projects: [makeProject({ id: 1 })],
      sessions,
      tasks: [
        makeTask({
          id: 5,
          projectId: 1,
          branchName: "feat-thing",
          status,
          ...over,
        } as never),
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
              ciStatus: "success",
              actionsRuns: [],
            },
          ],
          prSummary: { total: 1, pass: 1, fail: 0, pending: 0, unknown: 0 },
        },
      },
    });
  const handoffStub = (fetchFn: (url: string) => Response | null) => (url: string) =>
    url.endsWith("/handoff")
      ? jsonResponse(200, { prompt: "Fix the threads", branch: "feat-thing" })
      : fetchFn(url);

  afterEach(() => {
    vi.unstubAllGlobals();
    useDashboardStore.setState({ projects: [], tasks: [], sessions: [], prsByProject: {} });
  });

  it("opens the task's worker, not another live session on the branch, from the action bar", async () => {
    stub(PR);
    const requestOpenSession = vi.fn();
    // 30 is the reviewer, alive and first on the branch; 31 is the worker.
    seed(
      "reviewing",
      [
        makeSession({ id: 30, projectId: 1, liveBranch: "feat-thing" }),
        makeSession({ id: 31, projectId: 1, liveBranch: "feat-thing" }),
      ],
      { sessionId: 31, reviewSessionId: 30 },
    );
    useDashboardStore.setState({ requestOpenSession });
    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    const icon = await screen.findByRole("button", { name: "Open worker session" });
    await userEvent.click(icon);
    expect(requestOpenSession).toHaveBeenCalledWith(31);
  });

  describe("the pinned review's comments button", () => {
    const pinned = (over: object = {}) => ({
      ...PR,
      reviewSummary: summaryOf({
        latest: [
          {
            author: "mullion-reviewer",
            isBot: true,
            state: "CHANGES_REQUESTED",
            body: "Please fix the retry loop.",
            submittedAt: "2026-01-02T00:00:00Z",
            reviewedSha: "abc",
            stale: false,
          },
        ],
      }),
      ...over,
    });

    it("sends a reviewing task's comments to its worker instead of starting a session", async () => {
      stub(
        pinned(),
        handoffStub(() => null),
      );
      const rejectTask = vi.fn().mockResolvedValue({});
      const createSession = vi.fn();
      seed("reviewing");
      useDashboardStore.setState({ rejectTask, createSession });
      render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
      const pin = await screen.findByRole("region", { name: /Latest review/ });
      expect(within(pin).queryByRole("button", { name: "Hand off comments" })).toBeNull();
      await userEvent.click(within(pin).getByRole("button", { name: "Send to worker" }));
      expect(await screen.findByText("Task #5 sent back to its worker")).toBeInTheDocument();
      expect(rejectTask).toHaveBeenCalledWith(5, "Fix the threads");
      expect(createSession).not.toHaveBeenCalled();
    });

    it("offers neither button on a task PR that is not in review", async () => {
      stub(
        pinned(),
        handoffStub(() => null),
      );
      seed("in_progress");
      render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
      const pin = await screen.findByRole("region", { name: /Latest review/ });
      expect(within(pin).queryByRole("button", { name: "Hand off comments" })).toBeNull();
      expect(within(pin).queryByRole("button", { name: "Send to worker" })).toBeNull();
    });
  });
});
