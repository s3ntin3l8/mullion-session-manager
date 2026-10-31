// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskDetail } from "./TaskDetail.js";
import { makeTask } from "./test/fixtures.js";
import type * as ApiModule from "./api/index.js";
import type { Task } from "./api/index.js";

// The Agent / Review agent dropdowns show the effective choice in the
// backend's resolution order: task value, issue-body directive, project default.
let tasks: Task[];
const updateTask = vi.fn(async (id: number, patch: Partial<Task>) => {
  tasks = tasks.map((t) => (t.id === id ? { ...t, ...patch } : t));
  return tasks[0];
});
let rerender: () => void;

vi.mock("./store/index.js", () => ({
  useDashboardStore: (selector?: (s: unknown) => unknown) => {
    const state = {
      settings: undefined,
      tasks,
      sessions: [],
      hosts: [],
      projects: [],
      events: {},
      taskMasterEnabled: true,
      taskMasterEnv: null,
      prsByProject: {},
      updateTask,
      refreshTasks: vi.fn(async () => {}),
      openRightSidebarPr: vi.fn(),
      requestOpenSession: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
  eventKey: (sessionId: number, seq: number) => `${sessionId}:${seq}`,
}));

vi.mock("./api/index.js", async () => {
  const actual = await vi.importActual<typeof ApiModule>("./api/index.js");
  return {
    ...actual,
    api: {
      ...actual.api,
      listProjectActions: vi.fn(async () => [
        { id: "agent:claude", title: "Claude Code", kind: "agent" },
        { id: "agent:codex", title: "Codex", kind: "agent" },
      ]),
    },
  };
});

async function renderTask(overrides: Partial<Task>) {
  tasks = [makeTask({ id: 1, status: "backlog", ...overrides })];
  const ui = () => <TaskDetail params={{ taskId: 1 }} onOpenSession={vi.fn()} />;
  const r = render(ui());
  // A fresh element each time: re-rendering the same element object bails out.
  rerender = () => r.rerender(ui());
  await screen.findAllByRole("option", { name: "Claude Code" });
  return screen.getAllByRole("combobox");
}

describe("TaskDetail agent dropdowns and issue directives", () => {
  beforeEach(() => updateTask.mockClear());

  it("shows the issue directive when the task has no value of its own", async () => {
    const [agent, review] = await renderTask({ issueAgent: "codex", issueReviewAgent: "claude" });
    expect(agent).toHaveDisplayValue("codex (from issue)");
    expect(review).toHaveDisplayValue("claude (from issue)");
  });

  it("labels ReviewAgent: none as disabled", async () => {
    const [, review] = await renderTask({ issueReviewAgent: "none" });
    expect(review).toHaveDisplayValue("None (disabled) (from issue)");
  });

  it("lets a task value win over the directive, and clearing it restores the directive", async () => {
    const user = userEvent.setup();
    const [agent] = await renderTask({ agent: "claude", issueAgent: "codex" });
    expect(agent).toHaveValue("claude");
    await user.selectOptions(agent, "");
    expect(updateTask).toHaveBeenCalledWith(1, { agent: null });
    rerender();
    expect(screen.getAllByRole("combobox")[0]).toHaveDisplayValue("codex (from issue)");
  });

  it("writes the task field when picking a value over the directive", async () => {
    const user = userEvent.setup();
    const [, review] = await renderTask({ issueReviewAgent: "claude" });
    await user.selectOptions(review, "none");
    expect(updateTask).toHaveBeenCalledWith(1, { reviewAgent: "none" });
  });

  it("labels a usable directive hermes from the server value", async () => {
    const [, review] = await renderTask({ issueReviewAgent: "hermes" });
    expect(review).toHaveDisplayValue("hermes (from issue)");
  });

  it("falls back to the project default when there is no usable directive", async () => {
    const [agent, review] = await renderTask({ issueAgent: null, issueReviewAgent: null });
    expect(agent).toHaveDisplayValue("Project default (claude)");
    expect(review).toHaveDisplayValue("Project default (None)");
  });
});
