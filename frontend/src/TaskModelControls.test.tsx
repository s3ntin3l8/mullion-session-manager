// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { AppSettings, Task } from "./api/index.js";
import type * as ApiModule from "./api/index.js";

const fetchers = vi.hoisted(() => ({
  opencode: vi.fn(),
  codex: vi.fn(),
  agy: vi.fn(),
  mcode: vi.fn(),
}));
vi.mock("./api/index.js", async (orig) => {
  const actual = await orig<typeof ApiModule>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listOpenCodeModels: (...a: unknown[]) => fetchers.opencode(...a),
      listCodexModels: (...a: unknown[]) => fetchers.codex(...a),
      listAgyModels: (...a: unknown[]) => fetchers.agy(...a),
      listMcodeModels: (...a: unknown[]) => fetchers.mcode(...a),
    },
  };
});

import { TaskModelControls } from "./TaskModelControls.js";
import { resolvedDefaultModel } from "./lib/taskModelDefault.js";

const settings = {
  claudeCode: { defaultModel: "opus", reviewerModel: null, smallModel: "claude-haiku-5-5" },
  codex: { defaultModel: "gpt-5", reviewerModel: null },
  agy: { defaultModel: null, reviewerModel: null },
  mcode: { defaultModel: null, reviewerModel: null },
  opencode: {
    implementerModel: "openrouter/foo",
    reviewerModel: null,
    defaultSmallModel: null,
  },
} as unknown as AppSettings;

function task(over: Partial<Task> = {}): Task {
  return { id: 1, body: null, modelOverride: null, ...over } as Task;
}

function renderControls(
  props: Partial<React.ComponentProps<typeof TaskModelControls>> & { t?: Partial<Task> },
) {
  const onUpdate = vi.fn().mockResolvedValue(undefined);
  render(
    <TaskModelControls
      task={task(props.t)}
      workerAgent="claude"
      reviewerAgent={null}
      settings={settings}
      onUpdate={onUpdate}
      {...props}
    />,
  );
  return onUpdate;
}

beforeEach(() => {
  fetchers.opencode.mockResolvedValue(["openrouter/foo", "openrouter/bar", "anthropic/claude-x"]);
  fetchers.codex.mockResolvedValue(["gpt-5", "gpt-5-mini"]);
  fetchers.agy.mockResolvedValue(["gemini-3"]);
  fetchers.mcode.mockResolvedValue(["minimax/m3"]);
});
afterEach(cleanup);

describe("TaskModelControls", () => {
  it("opencode shows a provider dropdown, then a model list filtered by it", async () => {
    const onUpdate = renderControls({ workerAgent: "opencode" });
    const provider = await screen.findByLabelText("Model provider");
    expect(screen.queryByLabelText("Model model")).toBeNull();
    await waitFor(() => expect(screen.getByText("anthropic")).toBeTruthy());
    fireEvent.change(provider, { target: { value: "openrouter" } });
    const model = await screen.findByLabelText("Model model");
    expect(Array.from(model.querySelectorAll("option")).map((o) => o.value)).toEqual([
      "",
      "openrouter/foo",
      "openrouter/bar",
    ]);
    fireEvent.change(model, { target: { value: "openrouter/bar" } });
    expect(onUpdate).toHaveBeenCalledWith({ model: "openrouter/bar" });
  });

  it("opencode's provider default clears the choice and is labelled with the resolved value", async () => {
    const onUpdate = renderControls({
      workerAgent: "opencode",
      t: { modelOverride: "openrouter/bar" },
    });
    const provider = await screen.findByLabelText("Model provider");
    expect(screen.getByText("Default (openrouter/foo)")).toBeTruthy();
    expect((provider as HTMLSelectElement).value).toBe("openrouter");
    fireEvent.change(provider, { target: { value: "" } });
    expect(onUpdate).toHaveBeenCalledWith({ model: null });
  });

  it.each([
    ["codex", "gpt-5-mini", "Default (gpt-5)"],
    ["agy", "gemini-3", "Default"],
    ["mcode", "minimax/m3", "Default"],
  ])("%s has no provider step, only a model dropdown", async (agent, model, label) => {
    const onUpdate = renderControls({ workerAgent: agent });
    const select = await screen.findByLabelText("Model model");
    expect(screen.queryByLabelText("Model provider")).toBeNull();
    expect(screen.getByText(label)).toBeTruthy();
    await screen.findByText(model);
    fireEvent.change(select, { target: { value: model } });
    expect(onUpdate).toHaveBeenCalledWith({ model });
  });

  it("claude offers Custom… and a small-model control; codex has no small model", async () => {
    renderControls({ workerAgent: "claude" });
    expect(await screen.findByLabelText("Small model model")).toBeTruthy();
    expect(screen.getAllByText("Custom…", { selector: "option" }).length).toBeGreaterThan(0);
    cleanup();
    renderControls({ workerAgent: "codex" });
    await screen.findByLabelText("Model model");
    expect(screen.queryByLabelText("Small model model")).toBeNull();
  });

  it("shows the reviewer model only for a CLI review agent", async () => {
    renderControls({ workerAgent: "claude", reviewerAgent: "codex" });
    expect(await screen.findByLabelText("Reviewer model model")).toBeTruthy();
    cleanup();
    renderControls({ workerAgent: "claude", reviewerAgent: null });
    await screen.findByLabelText("Model model");
    expect(screen.queryByLabelText("Reviewer model model")).toBeNull();
  });

  it("renders nothing for an agent with no model concept", () => {
    renderControls({ workerAgent: "gemini" });
    expect(screen.queryByLabelText("Model model")).toBeNull();
  });

  it("surfaces a refused save", async () => {
    const onUpdate = vi.fn().mockRejectedValue(new Error("model must be provider/model"));
    render(
      <TaskModelControls
        task={task()}
        workerAgent="codex"
        reviewerAgent={null}
        settings={settings}
        onUpdate={onUpdate}
      />,
    );
    const select = await screen.findByLabelText("Model model");
    await screen.findByText("gpt-5-mini");
    fireEvent.change(select, { target: { value: "gpt-5-mini" } });
    expect(await screen.findByText("model must be provider/model")).toBeTruthy();
  });
});

describe("resolvedDefaultModel", () => {
  it("prefers the issue-body directive over the install default", () => {
    expect(resolvedDefaultModel("codex", "implementer", "Model: gpt-9", settings)).toBe("gpt-9");
    expect(
      resolvedDefaultModel("codex", "reviewer", "Reviewer-Model: r1\nModel: m", settings),
    ).toBe("r1");
    expect(resolvedDefaultModel("claude-code", "small", "SmallModel: s", settings)).toBe("s");
  });
  it("falls back to install-wide defaults per role", () => {
    expect(resolvedDefaultModel("claude-code", "small", null, settings)).toBe("claude-haiku-5-5");
    expect(resolvedDefaultModel("opencode", "implementer", null, settings)).toBe("openrouter/foo");
    expect(resolvedDefaultModel("opencode", "reviewer", null, settings)).toBeNull();
    expect(resolvedDefaultModel("codex", "reviewer", null, settings)).toBe("gpt-5");
    expect(resolvedDefaultModel("codex", "small", null, settings)).toBeNull();
    expect(resolvedDefaultModel("codex", "implementer", null, null)).toBeNull();
  });
});
