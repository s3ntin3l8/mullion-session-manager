// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskActions } from "./TaskActions.js";
import { useDashboardStore } from "./store/index.js";
import { makeTask } from "./test/fixtures.js";

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
