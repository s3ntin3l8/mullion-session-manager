// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectSidebarView } from "./ProjectSidebarView.js";

const actions = {
  onOpenGit: vi.fn(),
  onOpenGitHub: vi.fn(),
  onOpenFileEditor: vi.fn(),
  onOpenFile: vi.fn(),
  onOpenAgentRules: vi.fn(),
  onOpenProjectBriefing: vi.fn(),
  onOpenProjectSetup: vi.fn(),
  onOpenDockConfig: vi.fn(),
  onOpenSkills: vi.fn(),
};

describe("ProjectSidebarView", () => {
  it.each([
    ["Agent Rules", "onOpenAgentRules"],
    ["Mullion Briefing", "onOpenProjectBriefing"],
    ["Scaffold Mullion", "onOpenProjectSetup"],
    ["Dock", "onOpenDockConfig"],
    ["Skills", "onOpenSkills"],
  ] as const)("%s row opens its panel for this project", async (title, key) => {
    const user = userEvent.setup();
    render(<ProjectSidebarView projectId={7} actions={actions} />);
    await user.click(screen.getByText(title));
    expect(actions[key]).toHaveBeenCalledWith(7);
  });
});
