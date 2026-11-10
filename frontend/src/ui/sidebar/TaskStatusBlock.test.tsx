// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskStatusBlock } from "./TaskStatusBlock.js";
import { makeTask } from "../../test/fixtures.js";

describe("TaskStatusBlock slots", () => {
  it("renders the status without an actions row when neither slot is given", () => {
    const { container } = render(<TaskStatusBlock task={makeTask({ status: "in_progress" })} />);
    expect(screen.getByTestId("task-status-block")).toBeInTheDocument();
    expect(container.querySelector(".sb-taskstatus-actions")).toBeNull();
  });

  it("renders the caller's actions inside the block", () => {
    render(
      <TaskStatusBlock
        task={makeTask({ status: "reviewing" })}
        actions={<button type="button">Approve task</button>}
      />,
    );
    const block = screen.getByTestId("task-status-block");
    expect(block).toContainElement(screen.getByRole("button", { name: "Approve task" }));
  });

  it("offers Open task → only when asked to, and calls back", async () => {
    const onOpenTask = vi.fn();
    const { rerender } = render(<TaskStatusBlock task={makeTask({ status: "ready" })} />);
    expect(screen.queryByRole("button", { name: "Open task →" })).toBeNull();
    rerender(<TaskStatusBlock task={makeTask({ status: "ready" })} onOpenTask={onOpenTask} />);
    await userEvent.click(screen.getByRole("button", { name: "Open task →" }));
    expect(onOpenTask).toHaveBeenCalledTimes(1);
  });
});
