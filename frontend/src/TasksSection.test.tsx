// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

  it("tracks two concurrent claims independently (Hermes review, PR #281)", async () => {
    const resolvers: Record<number, () => void> = {};
    const onClaim = vi.fn(
      (task: Task) =>
        new Promise<void>((resolve) => {
          resolvers[task.id] = resolve;
        }),
    );
    const user = userEvent.setup();
    render(
      <TasksSection
        tasks={[makeTask({ id: 1, issueNumber: 1 }), makeTask({ id: 2, issueNumber: 2 })]}
        onClaim={onClaim}
      />,
    );

    // Stable references across re-renders (React keeps the same DOM node
    // per list item's `key`) — needed since after task 1 resolves, both
    // buttons briefly read "Claim" again and an index-based re-query would
    // click task 1 a second time instead of task 2.
    const [button1, button2] = screen.getAllByRole("button", { name: "Claim" });

    await user.click(button1);
    expect(screen.getAllByRole("button", { name: "Claiming…" })).toHaveLength(1);
    expect(button2).toHaveTextContent("Claim");
    expect(button2).not.toBeDisabled();

    // Task 1 resolves first — its own "Claiming…" clears, but task 2 (not
    // yet clicked) must still show a plain, enabled "Claim" button, not be
    // affected by task 1's unrelated settle.
    await waitFor(() => expect(button1).toHaveTextContent("Claim"));

    await user.click(button2);
    expect(button2).toHaveTextContent("Claiming…");

    resolvers[2]();
    await waitFor(() => expect(button2).toHaveTextContent("Claim"));
  });

  it("shows an inline error when the claim fails", async () => {
    const onClaim = vi.fn().mockRejectedValue(new Error("nope"));
    const user = userEvent.setup();
    render(<TasksSection tasks={[makeTask()]} onClaim={onClaim} />);

    await user.click(screen.getByRole("button", { name: "Claim" }));
    expect(await screen.findByText("Failed to claim — try again")).toBeInTheDocument();
  });
});
