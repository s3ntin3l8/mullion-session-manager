// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PrDetailView } from "./PrDetailView.js";
import { useDashboardStore } from "../store/index.js";
import { PR, stub } from "./prDetailTestKit.js";
import { makeProject, makeTask } from "../test/fixtures.js";

// A task PR's status strip: the task's own actions, now shared with the GitHub
// sidebar's strip (epic #2847), split out of PrDetailView.test.tsx.
describe("PrDetailView task actions", () => {
  afterEach(() => vi.unstubAllGlobals());

  describe("task actions", () => {
    const prState = {
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
    };
    const setup = (
      overrides: Parameters<typeof makeTask>[0],
      actions: Record<string, unknown> = {},
      taskMasterEnabled = true,
    ) => {
      stub(PR);
      useDashboardStore.setState({
        taskMasterEnabled,
        ...actions,
        projects: [makeProject({ id: 1 })],
        tasks: [makeTask({ id: 5, projectId: 1, branchName: "feat-thing", ...overrides })],
        prsByProject: prState,
      } as never);
      render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
      return screen.findByRole("region", { name: "Task" });
    };
    // Everything but the primary action sits behind the strip's `⋯` menu.
    const openMenu = (card: HTMLElement) =>
      userEvent.click(within(card).getByRole("button", { name: "More task actions" }));
    afterEach(() => {
      useDashboardStore.setState({ projects: [], tasks: [], prsByProject: {} });
    });

    it.each([
      ["reviewing", "Approve task", "approveTask"],
      ["failed", "Retry", "retryTask"],
    ] as const)("%s: %s calls the store action", async (status, label, action) => {
      const fn = vi.fn().mockResolvedValue({});
      const card = await setup({ status }, { [action]: fn });
      await userEvent.click(within(card).getByRole("button", { name: label }));
      // #3011 — Approve from the sidebar sits behind a confirm step: the
      // first press arms it, the second approves.
      if (action === "approveTask") {
        expect(fn).not.toHaveBeenCalled();
        await userEvent.click(within(card).getByRole("button", { name: /Confirm approve/ }));
      }
      expect(fn).toHaveBeenCalledWith(5);
    });

    it.each([
      ["Reject", "rejectTask"],
      ["Give up", "giveUpTask"],
    ] as const)(
      "reviewing: %s takes a reason then calls the store action",
      async (label, action) => {
        const fn = vi.fn().mockResolvedValue({});
        const card = await setup({ status: "reviewing" }, { [action]: fn });
        await openMenu(card);
        await userEvent.click(within(card).getByRole("button", { name: label }));
        await userEvent.type(within(card).getByRole("textbox"), "nope");
        await userEvent.click(within(card).getByRole("button", { name: label }));
        expect(fn).toHaveBeenCalledWith(5, "nope");
      },
    );

    it("reviewing: offers Re-review only for an inconclusive, ingested review", async () => {
      const reReviewTask = vi.fn().mockResolvedValue({});
      const card = await setup(
        {
          status: "reviewing",
          lastReviewVerdict: "inconclusive",
          reviewSessionId: 9,
          reviewFindingsIngestedSessionId: 9,
        },
        { reReviewTask },
      );
      await openMenu(card);
      await userEvent.click(within(card).getByRole("button", { name: "Re-review" }));
      expect(reReviewTask).toHaveBeenCalledWith(5);
    });

    it("reviewing: hides Re-review without an inconclusive verdict", async () => {
      const card = await setup({ status: "reviewing" });
      await openMenu(card);
      expect(within(card).queryByRole("button", { name: "Re-review" })).toBeNull();
    });

    it("done with a PR: Merge now, then shows pending and the merge error", async () => {
      const mergeTask = vi.fn().mockResolvedValue({});
      const task = { status: "done", prNumber: 12, prUrl: "u" } as const;
      const card = await setup(task, { mergeTask });
      await userEvent.click(within(card).getByRole("button", { name: "Merge now" }));
      expect(mergeTask).toHaveBeenCalledWith(5);
      act(() =>
        useDashboardStore.setState({
          tasks: [
            makeTask({
              id: 5,
              projectId: 1,
              branchName: "feat-thing",
              ...task,
              mergeRequestedAt: "2026-01-01T00:00:00Z",
            }),
          ],
        }),
      );
      expect(within(card).getByRole("button", { name: "Retry merge" })).toBeEnabled();
      expect(within(card).getByText(/Merge pending/)).toBeInTheDocument();
      act(() =>
        useDashboardStore.setState({
          tasks: [
            makeTask({
              id: 5,
              projectId: 1,
              branchName: "feat-thing",
              ...task,
              mergeRequestedAt: "2026-01-01T00:00:00Z",
              mergeError: "PR is blocked",
            }),
          ],
        }),
      );
      expect(within(card).getByText("PR is blocked")).toBeInTheDocument();
    });

    it("done with a PR: disables merge when Task Master is off", async () => {
      const card = await setup({ status: "done", prNumber: 12, prUrl: "u" }, {}, false);
      expect(within(card).getByRole("button", { name: "Merge now" })).toBeDisabled();
    });
  });

  it("offers workflow-held tasks the task link instead of task approval, then restores approval", async () => {
    stub(PR);
    const openRightSidebarTask = vi.fn();
    const task = makeTask({
      id: 5,
      projectId: 1,
      branchName: "feat-thing",
      status: "reviewing",
      workflowChange: JSON.stringify({
        sha: "a".repeat(40),
        files: [".github/workflows/ci.yml"],
      }),
    });
    useDashboardStore.setState({
      openRightSidebarTask,
      taskMasterEnabled: true,
      projects: [makeProject({ id: 1 })],
      tasks: [task],
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
    const mullion = await screen.findByRole("region", { name: "Mullion" });
    const strip = await screen.findByRole("region", { name: "Task" });
    expect(within(strip).queryByRole("button", { name: "Approve task" })).toBeNull();
    expect(within(mullion).getByText("Needs workflow approval — open task")).toBeInTheDocument();
    await userEvent.click(within(strip).getByRole("button", { name: "Open task →" }));
    expect(openRightSidebarTask).toHaveBeenCalledWith(5, {
      kind: "pr",
      projectId: 1,
      number: 12,
    });
    act(() => useDashboardStore.setState({ tasks: [{ ...task, workflowChange: null }] }));
    expect(within(strip).getByRole("button", { name: "Approve task" })).toBeEnabled();
    expect(within(mullion).queryByText("Needs workflow approval — open task")).toBeNull();
    useDashboardStore.setState({ projects: [], tasks: [], prsByProject: {} });
  });
});
