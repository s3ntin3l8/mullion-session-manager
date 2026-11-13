// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as ApiModule from "../api/index.js";
import type { Task } from "../api/index.js";
import { makeProject, makeTask } from "../test/fixtures.js";
import { TaskAgents } from "./TaskAgents.js";

let settings: unknown;
const { updateTask, listProjectActions } = vi.hoisted(() => ({
  updateTask: vi.fn(async (..._a: unknown[]) => ({})),
  listProjectActions: vi.fn(async (_id: number) => [
    { id: "agent:claude", title: "Claude Code", kind: "agent" },
    { id: "agent:codex", title: "Codex", kind: "agent" },
  ]),
}));

vi.mock("../store/index.js", () => ({
  useDashboardStore: (selector: (s: unknown) => unknown) =>
    selector({
      settings,
      projects: [makeProject({ id: 1, defaultAgent: "claude", defaultReviewAgent: "codex" })],
      updateTask,
    }),
}));
vi.mock("../api/index.js", async () => {
  const actual = await vi.importActual<typeof ApiModule>("../api/index.js");
  return { ...actual, api: { ...actual.api, listProjectActions } };
});

const task = (o: Partial<Task>) => makeTask({ id: 1, projectId: 1, status: "backlog", ...o });

beforeEach(() => {
  settings = undefined;
  updateTask.mockClear();
  listProjectActions.mockClear();
});

describe("TaskAgents", () => {
  it("shows the effective worker and reviewer with where each comes from", () => {
    render(
      <TaskAgents
        task={task({ agent: "codex", modelOverride: "gpt-5", issueReviewAgent: "none" })}
      />,
    );
    expect(screen.getByText(/codex · gpt-5/)).toBeInTheDocument();
    expect(screen.getByText("(task)")).toBeInTheDocument();
    expect(screen.getByText(/none/)).toBeInTheDocument();
    expect(screen.getByText("(issue)")).toBeInTheDocument();
  });

  it("falls back to the project defaults and names Hermes", () => {
    const { rerender } = render(<TaskAgents task={task({})} />);
    expect(screen.getAllByText("(default)")).toHaveLength(2);
    expect(screen.getByText(/^codex/)).toBeInTheDocument();
    rerender(<TaskAgents task={task({ reviewAgent: "hermes" })} />);
    expect(screen.getByText(/Hermes/)).toBeInTheDocument();
  });

  it("keeps the dropdowns folded, and does not fetch launchers, until Edit", async () => {
    const user = userEvent.setup();
    render(<TaskAgents task={task({})} />);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(listProjectActions).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(await screen.findByRole("button", { name: "Done" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(listProjectActions).toHaveBeenCalledWith(1);
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("saves the agent and the review agent as task overrides", async () => {
    const user = userEvent.setup();
    render(<TaskAgents task={task({})} />);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findAllByRole("option", { name: "Claude Code" });
    const agent = screen.getByRole("combobox", { name: "Worker agent" });
    const review = screen.getByRole("combobox", { name: "Review agent" });
    await user.selectOptions(agent, "claude");
    expect(updateTask).toHaveBeenCalledWith(1, { agent: "claude" });
    await user.selectOptions(review, "none");
    expect(updateTask).toHaveBeenCalledWith(1, { reviewAgent: "none" });
  });

  it("groups the editor into Worker and Reviewer and hides the summary rows", async () => {
    const user = userEvent.setup();
    render(<TaskAgents task={task({})} />);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByText("Worker")).toBeInTheDocument();
    expect(screen.getByText("Reviewer")).toBeInTheDocument();
    expect(screen.queryByText("(default)")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Reviewer model" })).toBeInTheDocument();
  });

  it("moves keyboard focus into the editor on Edit and back to Edit on Done", async () => {
    const user = userEvent.setup();
    render(<TaskAgents task={task({})} />);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("combobox", { name: "Worker agent" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByRole("button", { name: "Edit" })).toHaveFocus();
  });

  it("keeps focus inside the panel when the task stops being editable mid-edit", async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(<TaskAgents task={task({})} />);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    rerender(<TaskAgents task={task({ status: "in_progress", agentCommand: "claude" })} />);
    expect(container.firstElementChild).toHaveFocus();
  });

  it("says Hermes picks its own model instead of a reviewer model field", async () => {
    const user = userEvent.setup();
    render(<TaskAgents task={task({ reviewAgent: "hermes" })} />);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByText("Hermes picks its own model.")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Reviewer model" })).toBeNull();
  });

  it("shows a failed save inline", async () => {
    updateTask.mockRejectedValueOnce(new Error("agent rejected"));
    const user = userEvent.setup();
    render(<TaskAgents task={task({})} />);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findAllByRole("option", { name: "Claude Code" });
    await user.selectOptions(screen.getAllByRole("combobox")[0], "claude");
    expect(await screen.findByText("agent rejected")).toBeInTheDocument();
  });

  it("is read-only once a worker has claimed the task", () => {
    render(
      <TaskAgents
        task={task({
          status: "ready",
          agentCommand: "claude --model x",
          modelOverride: "opus-4.1",
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByText(/Locked once a worker has claimed/)).toBeInTheDocument();
    expect(screen.getByText(/claude · opus-4.1/)).toBeInTheDocument();
  });

  it("does not print a stale reviewer model next to Hermes or none", () => {
    render(<TaskAgents task={task({ reviewAgent: "hermes", reviewerModel: "gpt-5" })} />);
    expect(screen.getByText(/Hermes/)).toBeInTheDocument();
    expect(screen.queryByText(/gpt-5/)).toBeNull();
  });

  it("marks only task-level overrides with the dot, and locks by status alone", () => {
    const { container, rerender } = render(<TaskAgents task={task({ agent: "codex" })} />);
    expect(container.querySelectorAll(".sb-ov-dot")).toHaveLength(1);
    rerender(<TaskAgents task={task({ status: "in_progress" })} />);
    expect(container.querySelectorAll(".sb-ov-dot")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("says so when the agent list cannot be loaded", async () => {
    listProjectActions.mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    render(<TaskAgents task={task({})} />);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(await screen.findByText(/Could not load agents: offline/)).toBeInTheDocument();
  });

  it.each(["backlog", "failed"] as const)("is editable while %s", (status) => {
    render(<TaskAgents task={task({ status })} />);
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });
});
