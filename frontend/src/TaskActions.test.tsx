// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskActions } from "./TaskActions.js";
import { useDashboardStore } from "./store/index.js";
import { makeTask } from "./test/fixtures.js";
import { ApiError } from "./api/client.js";

const rejectTask = vi.fn();
const giveUpTask = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  useDashboardStore.setState({ taskMasterEnabled: true, rejectTask, giveUpTask, tasks: [] });
});

describe("TaskActions on a reviewing task", () => {
  it("explains what Approve, Reject and Give up do in their tooltips", () => {
    render(<TaskActions task={makeTask({ id: 1, status: "reviewing" })} />);
    expect(screen.getByRole("button", { name: "Approve task" })).toHaveAttribute(
      "title",
      expect.stringContaining("open the pull request"),
    );
    expect(screen.getByRole("button", { name: "Reject" })).toHaveAttribute(
      "title",
      expect.stringContaining("Send your feedback to the task's agent"),
    );
    expect(screen.getByRole("button", { name: "Give up" })).toHaveAttribute(
      "title",
      expect.stringContaining("marked Failed"),
    );
  });

  it("repeats what Reject will do, and asks for feedback for the agent, in its confirm step", async () => {
    const user = userEvent.setup();
    render(<TaskActions task={makeTask({ id: 1, status: "reviewing" })} />);
    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(screen.getByText(/keeps working on the same branch/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Feedback for the agent (optional)")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("Feedback for the agent (optional)"), "fix X");
    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(rejectTask).toHaveBeenCalledWith(1, "fix X");
  });

  it("repeats what Give up will do, and that it can be retried, in its confirm step", async () => {
    const user = userEvent.setup();
    render(<TaskActions task={makeTask({ id: 1, status: "reviewing" })} />);
    await user.click(screen.getByRole("button", { name: "Give up" }));
    expect(screen.getByText(/You can Retry it later/)).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Why give up? (optional, posted to the issue)"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
  });
});

describe("TaskActions' Re-review on a reviewing task", () => {
  const reviewed = (lastReviewVerdict: string | null) =>
    makeTask({
      id: 1,
      status: "reviewing",
      lastReviewVerdict,
      reviewSessionId: 5,
      reviewFindingsIngestedSessionId: 5,
    });

  it.each(["inconclusive", "changes-requested", "approved-with-suggestions", "clean"])(
    "is offered for a finished %s review, with a tooltip that says it sends nothing to the agent",
    (verdict) => {
      render(<TaskActions task={reviewed(verdict)} />);
      expect(screen.getByRole("button", { name: "Re-review" })).toHaveAttribute(
        "title",
        expect.stringContaining("without sending anything to the agent"),
      );
    },
  );

  it("is not offered for a task that has not been reviewed", () => {
    render(<TaskActions task={reviewed(null)} />);
    expect(screen.queryByRole("button", { name: "Re-review" })).not.toBeInTheDocument();
  });
});

describe("TaskActions' Archive", () => {
  const archiveTask = vi.fn();
  beforeEach(() => useDashboardStore.setState({ archiveTask }));

  it("sits in the single action block of a done task without a PR", async () => {
    const user = userEvent.setup();
    archiveTask.mockResolvedValue(undefined);
    const { container } = render(<TaskActions task={makeTask({ id: 7, status: "done" })} />);
    expect(container.querySelectorAll(".task-detail-actions")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Archive" }));
    expect(archiveTask).toHaveBeenCalledWith(7);
  });

  it("shares the merge block of a done task with a linked PR (one actions block)", () => {
    const { container } = render(
      <TaskActions
        task={makeTask({
          id: 8,
          status: "done",
          prNumber: 5,
          mergedAt: "2026-11-16T10:00:00.000Z",
        })}
      />,
    );
    expect(container.querySelectorAll(".task-detail-actions")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
  });

  it("closes the overflow menu once an archive succeeds", async () => {
    const user = userEvent.setup();
    archiveTask.mockResolvedValue(undefined);
    render(<TaskActions task={makeTask({ id: 10, status: "failed" })} overflow />);
    await user.click(screen.getByRole("button", { name: "More task actions" }));
    await user.click(screen.getByRole("button", { name: "Archive" }));
    expect(archiveTask).toHaveBeenCalledWith(10);
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
  });

  it("keeps the overflow menu open so a failed archive shows its error", async () => {
    const user = userEvent.setup();
    archiveTask.mockRejectedValue(new Error("boom"));
    render(<TaskActions task={makeTask({ id: 9, status: "failed" })} overflow />);
    await user.click(screen.getByRole("button", { name: "More task actions" }));
    await user.click(screen.getByRole("button", { name: "Archive" }));
    expect(archiveTask).toHaveBeenCalledWith(9);
    expect(await screen.findByText(/Failed to update archive state/)).toBeInTheDocument();
  });
});

// Issue #3194 — a retry waiting for its original host: the operator's way out
// is "Start fresh" (abandon the preserved branch — it stays on that host —
// and run the task from scratch).
describe("TaskActions' Start fresh on a waiting retry", () => {
  const startFreshTask = vi.fn();

  beforeEach(() => {
    startFreshTask.mockReset();
    useDashboardStore.setState({ startFreshTask });
  });

  it("offers it, saying that the commits stay on the host it waits for", () => {
    render(<TaskActions task={makeTask({ id: 7, status: "claimed", retryHostId: "macbook" })} />);
    expect(screen.getByRole("button", { name: "Start fresh" })).toBeInTheDocument();
    expect(screen.getByText(/commits stay there/)).toBeInTheDocument();
  });

  it("starts the task fresh when clicked", async () => {
    const user = userEvent.setup();
    startFreshTask.mockResolvedValue(undefined);
    render(<TaskActions task={makeTask({ id: 7, status: "claimed", retryHostId: "macbook" })} />);
    await user.click(screen.getByRole("button", { name: "Start fresh" }));
    expect(startFreshTask).toHaveBeenCalledWith(7);
  });

  it("is not offered for a task that is not waiting for a host", () => {
    render(<TaskActions task={makeTask({ id: 7, status: "claimed" })} />);
    expect(screen.queryByRole("button", { name: "Start fresh" })).toBeNull();
  });

  it("reports the API's own reason and re-enables the button", async () => {
    const user = userEvent.setup();
    startFreshTask.mockRejectedValueOnce(new ApiError("This task is not waiting for a host", 409));
    render(<TaskActions task={makeTask({ id: 7, status: "claimed", retryHostId: "macbook" })} />);
    await user.click(screen.getByRole("button", { name: "Start fresh" }));
    expect(await screen.findByText(/not waiting for a host/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start fresh" })).not.toBeDisabled();
  });

  it("falls back to a generic message when the failure is not an API error", async () => {
    const user = userEvent.setup();
    startFreshTask.mockRejectedValueOnce(new Error("network down"));
    render(<TaskActions task={makeTask({ id: 7, status: "claimed", retryHostId: "macbook" })} />);
    await user.click(screen.getByRole("button", { name: "Start fresh" }));
    expect(await screen.findByText("Failed to start the task fresh")).toBeInTheDocument();
  });
});

// A task from an issue Mullion's own bot filed: Approve and Dismiss replace
// "Move to Ready", and Approve sends the text the screen showed.
describe("TaskActions on a proposal", () => {
  const approveProposal = vi.fn();
  const dismissProposal = vi.fn();
  const proposal = makeTask({
    id: 4,
    status: "backlog",
    proposalState: "proposed",
    title: "fix(x): later",
    body: "do it",
  });

  beforeEach(() => {
    approveProposal.mockReset();
    dismissProposal.mockReset();
    useDashboardStore.setState({ approveProposal, dismissProposal });
  });

  it("offers Approve and Dismiss instead of Move to Ready", () => {
    render(<TaskActions task={proposal} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move to Ready" })).toBeNull();
  });

  it("approves with the title and body on screen", async () => {
    const user = userEvent.setup();
    approveProposal.mockResolvedValue(undefined);
    render(<TaskActions task={proposal} />);
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(approveProposal).toHaveBeenCalledWith(4, { title: "fix(x): later", body: "do it" });
  });

  it("dismisses", async () => {
    const user = userEvent.setup();
    dismissProposal.mockResolvedValue(undefined);
    render(<TaskActions task={proposal} />);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismissProposal).toHaveBeenCalledWith(4);
  });

  it("shows the server's reason when the issue changed", async () => {
    const user = userEvent.setup();
    approveProposal.mockRejectedValueOnce(
      new ApiError("The issue changed since you opened it", 409),
    );
    render(<TaskActions task={proposal} />);
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/issue changed/)).toBeInTheDocument();
  });
});
