// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { IDockviewPanelProps } from "dockview-react";
import { components } from "./registry.js";

vi.mock("../AgentRulesPanel.js", async () => ({
  AgentRulesPanel: (await import("../test/hubStubs.js")).makeHubStub("agent-rules"),
}));
vi.mock("../ProjectBriefingPanel.js", async () => ({
  ProjectBriefingPanel: (await import("../test/hubStubs.js")).makeHubStub("briefing"),
}));
vi.mock("../ProjectSetupPanel.js", async () => ({
  ProjectSetupPanel: (await import("../test/hubStubs.js")).makeHubStub("scaffold"),
}));
vi.mock("../DockConfigPanel.js", async () => ({
  DockConfigPanel: (await import("../test/hubStubs.js")).makeHubStub("dock"),
}));
vi.mock("../SkillsPanel.js", async () => ({
  SkillsPanel: (await import("../test/hubStubs.js")).makeHubStub("skills"),
}));

function props<P extends { [k: string]: unknown }>(params: P, api: object = {}) {
  return { params, api, containerApi: {} } as unknown as IDockviewPanelProps<P>;
}

describe("project-hub registration", () => {
  it("registers project-hub and keeps every legacy per-project kind registered", () => {
    // A saved layout naming an unregistered kind makes fromJSON wipe the whole
    // layout, so these keys must never disappear.
    for (const kind of [
      "project-hub",
      "agent-rules",
      "project-briefing",
      "project-setup",
      "dock-config",
      "skills",
    ]) {
      expect(components).toHaveProperty(kind);
    }
  });

  it.each([
    ["agent-rules", "Agent Rules"],
    ["project-briefing", "Briefing"],
    ["project-setup", "Scaffold"],
    ["dock-config", "Dock"],
    ["skills", "Skills"],
  ] as const)("a restored legacy %s panel renders the hub on the %s tab", (kind, label) => {
    const Legacy = components[kind] as React.ComponentType<
      IDockviewPanelProps<{ projectId: number }>
    >;
    render(<Legacy {...props({ projectId: 4 })} />);

    expect(screen.getByRole("tab", { name: label }).getAttribute("aria-selected")).toBe("true");
  });

  it("the project-hub panel persists a tab click into its dockview params", async () => {
    const user = userEvent.setup();
    const updateParameters = vi.fn();
    const Hub = components["project-hub"] as React.ComponentType<
      IDockviewPanelProps<{ projectId: number }>
    >;
    render(<Hub {...props({ projectId: 4 }, { updateParameters })} />);

    await user.click(screen.getByRole("tab", { name: "Dock" }));

    expect(updateParameters).toHaveBeenCalledWith({ projectId: 4, tab: "dock" });
  });
});
