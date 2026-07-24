// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TasksSection } from "./Sidebar.js";
import type { Task } from "./api.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    projectId: 1,
    projectName: "demo",
    issueNumber: 42,
    title: "Fix the thing",
    body: "details",
    htmlUrl: "https://github.com/o/r/issues/42",
    status: "pending",
    sessionId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    claimedAt: null,
    ...overrides,
  };
}

describe("TasksSection", () => {
  it("renders nothing when there are no pending tasks", () => {
    const { container } = render(<TasksSection tasks={[]} onClaim={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when every task is already claimed", () => {
    const { container } = render(
      <TasksSection tasks={[makeTask({ status: "claimed" })]} onClaim={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("lists only pending tasks, with title, project, and issue number", () => {
    render(
      <TasksSection
        tasks={[makeTask({ id: 1, status: "pending" }), makeTask({ id: 2, status: "claimed" })]}
        onClaim={vi.fn()}
      />,
    );
    expect(screen.getByText("Fix the thing")).toBeInTheDocument();
    expect(screen.getByText("demo · #42")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Claim" })).toHaveLength(1);
  });

  it("calls onClaim with the task when Claim is clicked", async () => {
    const onClaim = vi.fn().mockResolvedValue(undefined);
    const task = makeTask();
    const user = userEvent.setup();
    render(<TasksSection tasks={[task]} onClaim={onClaim} />);

    await user.click(screen.getByRole("button", { name: "Claim" }));
    expect(onClaim).toHaveBeenCalledWith(task);
  });

  it("disables the button and shows Claiming… while the claim is in flight", async () => {
    let resolveClaim: () => void = () => {};
    const onClaim = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveClaim = resolve;
        }),
    );
    const user = userEvent.setup();
    render(<TasksSection tasks={[makeTask()]} onClaim={onClaim} />);

    await user.click(screen.getByRole("button", { name: "Claim" }));
    const button = screen.getByRole("button", { name: "Claiming…" });
    expect(button).toBeDisabled();

    resolveClaim();
    await screen.findByRole("button", { name: "Claim" });
  });

  it("shows an inline error when the claim fails", async () => {
    const onClaim = vi.fn().mockRejectedValue(new Error("nope"));
    const user = userEvent.setup();
    render(<TasksSection tasks={[makeTask()]} onClaim={onClaim} />);

    await user.click(screen.getByRole("button", { name: "Claim" }));
    expect(await screen.findByText("Failed to claim — try again")).toBeInTheDocument();
  });
});
