// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectSidebarView } from "./ProjectSidebarView.js";
import { useDashboardStore } from "../store/index.js";

vi.mock("../SkillsPanel.js", () => ({
  SkillsPanel: ({ params }: { params: { projectId: number } }) => (
    <div data-testid="skills-panel">{`skills:${params.projectId}`}</div>
  ),
}));

const actions = {
  onOpenGit: vi.fn(),
  onOpenFileEditor: vi.fn(),
  onOpenFile: vi.fn(),
  onOpenAgentRules: vi.fn(),
  onOpenProjectBriefing: vi.fn(),
  onOpenProjectSetup: vi.fn(),
  onOpenDockConfig: vi.fn(),
  onOpenSkills: vi.fn(),
  onOpenTasks: vi.fn(),
  onOpenDevice: vi.fn(),
  onOpenRailBrowser: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  useDashboardStore.setState({ projectSkillsRequest: null });
});

describe("ProjectSidebarView", () => {
  it.each([
    ["Agent Rules", "onOpenAgentRules"],
    ["Mullion Briefing", "onOpenProjectBriefing"],
    ["Scaffold Mullion", "onOpenProjectSetup"],
    ["Dock", "onOpenDockConfig"],
  ] as const)("%s row opens its editor for this project", async (title, key) => {
    const user = userEvent.setup();
    render(<ProjectSidebarView projectId={7} actions={actions} />);
    await user.click(screen.getByText(title));
    expect(actions[key]).toHaveBeenCalledWith(7);
  });

  it("Skills row drills in here, and Back returns to the list", async () => {
    const user = userEvent.setup();
    render(<ProjectSidebarView projectId={7} actions={actions} />);

    await user.click(screen.getByText("Skills"));

    expect(screen.getByTestId("skills-panel")).toHaveTextContent("skills:7");
    expect(screen.queryByText("Agent Rules")).toBeNull();
    // A list, not an editor: it never goes through the openers.
    expect(actions.onOpenSkills).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(screen.queryByTestId("skills-panel")).toBeNull();
    expect(screen.getByText("Agent Rules")).toBeInTheDocument();
  });

  it("the drill-in belongs to its project: switching project shows the list", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ProjectSidebarView projectId={7} actions={actions} />);
    await user.click(screen.getByText("Skills"));

    rerender(<ProjectSidebarView projectId={8} actions={actions} />);

    expect(screen.queryByTestId("skills-panel")).toBeNull();
  });

  it("opens Skills on the store's one-shot request (the palette's Project › Skills), then clears it", () => {
    render(<ProjectSidebarView projectId={7} actions={actions} />);

    act(() => useDashboardStore.setState({ projectSkillsRequest: { projectId: 7, nonce: 41 } }));

    expect(screen.getByTestId("skills-panel")).toHaveTextContent("skills:7");
    expect(useDashboardStore.getState().projectSkillsRequest).toBeNull();
  });

  it("ignores a Skills request for another project", () => {
    render(<ProjectSidebarView projectId={7} actions={actions} />);

    act(() => useDashboardStore.setState({ projectSkillsRequest: { projectId: 9, nonce: 42 } }));

    expect(screen.queryByTestId("skills-panel")).toBeNull();
    // Left for the view of the project it names.
    expect(useDashboardStore.getState().projectSkillsRequest).toEqual({ projectId: 9, nonce: 42 });
  });
});
