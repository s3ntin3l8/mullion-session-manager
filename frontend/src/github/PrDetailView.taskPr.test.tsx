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

  describe("the shared task strip", () => {
    it("shows the strip once, with the task's actions, and no second action block", async () => {
      stub(PR);
      seed("reviewing");
      render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
      const strip = await screen.findByRole("region", { name: "Task" });
      expect(within(strip).getByTestId("task-status-block")).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: "Approve task" })).toHaveLength(1);
      expect(within(strip).getByRole("button", { name: "Approve task" })).toBeInTheDocument();
      // The rest of the PR view is untouched: status, the Mullion card, the pinned area.
      expect(screen.getByRole("region", { name: "Mullion" })).toBeInTheDocument();
      expect(screen.getByText("Checks")).toBeInTheDocument();
    });

    it("keeps every action the PR view offered reachable from the strip", async () => {
      stub(PR);
      seed("reviewing", [], {
        lastReviewVerdict: "inconclusive",
        reviewSessionId: 9,
        reviewFindingsIngestedSessionId: 9,
      });
      useDashboardStore.setState({ taskMasterEnabled: true });
      render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
      const strip = await screen.findByRole("region", { name: "Task" });
      expect(within(strip).getByRole("button", { name: "Approve task" })).toBeInTheDocument();
      await userEvent.click(within(strip).getByRole("button", { name: "More task actions" }));
      for (const name of ["Re-review", "Reject", "Give up"]) {
        expect(within(strip).getByRole("button", { name })).toBeInTheDocument();
      }
    });

    it("has no strip on a PR that no task owns", async () => {
      stub(PR);
      useDashboardStore.setState({ projects: [makeProject({ id: 1 })], tasks: [] });
      render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
      await screen.findByRole("region", { name: "Mullion" });
      expect(screen.queryByRole("region", { name: "Task" })).toBeNull();
      expect(screen.queryByTestId("task-status-block")).toBeNull();
    });

    it("opens the task in the Tasks view, and Back from it returns here", async () => {
      stub(PR);
      seed("in_progress");
      const onBack = vi.fn();
      render(<PrDetailView projectId={1} number={12} onBack={onBack} />);
      const strip = await screen.findByRole("region", { name: "Task" });
      await userEvent.click(within(strip).getByRole("button", { name: "Open task →" }));
      const s = useDashboardStore.getState();
      expect(s.selectedTaskId).toBe(5);
      expect(s.rightSidebarView).toBe("tasks");
      expect(s.sidebarBack).toEqual({
        to: { kind: "task", taskId: 5 },
        back: { kind: "pr", projectId: 1, number: 12 },
      });
    });

    it("sends its own Back to the task it was opened from", async () => {
      stub(PR);
      seed("in_progress");
      const onBack = vi.fn();
      const openRightSidebarTask = vi.fn();
      useDashboardStore.setState({
        openRightSidebarTask,
        sidebarBack: {
          to: { kind: "pr", projectId: 1, number: 12 },
          back: { kind: "task", taskId: 5 },
        },
      });
      render(<PrDetailView projectId={1} number={12} onBack={onBack} />);
      await screen.findByRole("region", { name: "Task" });
      await userEvent.click(screen.getByRole("button", { name: "Back" }));
      expect(openRightSidebarTask).toHaveBeenCalledWith(5);
      expect(onBack).not.toHaveBeenCalled();
    });
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
