// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectHubPanel } from "./ProjectHubPanel.js";
import { hubStubControl } from "./test/hubStubs.js";

vi.mock("./AgentRulesPanel.js", async () => ({
  AgentRulesPanel: (await import("./test/hubStubs.js")).makeHubStub("agent-rules"),
}));
vi.mock("./ProjectBriefingPanel.js", async () => ({
  ProjectBriefingPanel: (await import("./test/hubStubs.js")).makeHubStub("briefing"),
}));
vi.mock("./ProjectSetupPanel.js", async () => ({
  ProjectSetupPanel: (await import("./test/hubStubs.js")).makeHubStub("scaffold"),
}));
vi.mock("./DockConfigPanel.js", async () => ({
  DockConfigPanel: (await import("./test/hubStubs.js")).makeHubStub("dock"),
}));
vi.mock("./SkillsPanel.js", async () => ({
  SkillsPanel: (await import("./test/hubStubs.js")).makeHubStub("skills"),
}));

afterEach(() => {
  hubStubControl.crashSkills = false;
  vi.restoreAllMocks();
});

const tab = (name: string) => screen.getByRole("tab", { name });

describe("ProjectHubPanel", () => {
  it("renders the five tabs, defaults to Agent Rules, and only mounts visited tabs", () => {
    render(<ProjectHubPanel params={{ projectId: 3 }} />);

    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "Agent Rules",
      "Briefing",
      "Scaffold",
      "Dock",
      "Skills",
    ]);
    expect(tab("Agent Rules").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("agent-rules:3")).toBeTruthy();
    expect(screen.queryByTestId("stub-skills")).toBeNull();
  });

  it("opens on the tab named in params", () => {
    render(<ProjectHubPanel params={{ projectId: 3, tab: "dock" }} />);
    expect(tab("Dock").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("dock:3")).toBeTruthy();
  });

  it("switches tabs on click, hides the others, and reports the choice", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    render(<ProjectHubPanel params={{ projectId: 3 }} onTabChange={onTabChange} />);

    await user.click(tab("Skills"));

    expect(onTabChange).toHaveBeenCalledWith("skills");
    expect(tab("Skills").getAttribute("aria-selected")).toBe("true");
    expect(tab("Agent Rules").getAttribute("aria-selected")).toBe("false");
    expect(
      screen.getByTestId("stub-skills").closest("[role=tabpanel]")?.hasAttribute("hidden"),
    ).toBe(false);
    expect(
      screen.getByTestId("stub-agent-rules").closest("[role=tabpanel]")?.hasAttribute("hidden"),
    ).toBe(true);
  });

  it("keeps an unsaved draft alive across a tab switch and back", async () => {
    const user = userEvent.setup();
    render(<ProjectHubPanel params={{ projectId: 3 }} />);

    await user.type(screen.getByLabelText("agent-rules draft"), "half-written rule");
    await user.click(tab("Dock"));
    await user.click(tab("Agent Rules"));

    expect((screen.getByLabelText("agent-rules draft") as HTMLInputElement).value).toBe(
      "half-written rule",
    );
  });

  it("follows a new rev to params.tab, but not a changed tab with the same rev", () => {
    const { rerender } = render(<ProjectHubPanel params={{ projectId: 3, tab: "dock", rev: 1 }} />);
    expect(tab("Dock").getAttribute("aria-selected")).toBe("true");

    rerender(<ProjectHubPanel params={{ projectId: 3, tab: "skills", rev: 1 }} />);
    expect(tab("Dock").getAttribute("aria-selected")).toBe("true");

    rerender(<ProjectHubPanel params={{ projectId: 3, tab: "skills", rev: 2 }} />);
    expect(tab("Skills").getAttribute("aria-selected")).toBe("true");
  });

  it("a new rev without a tab leaves the current tab alone", () => {
    const { rerender } = render(<ProjectHubPanel params={{ projectId: 3, tab: "dock", rev: 1 }} />);
    rerender(<ProjectHubPanel params={{ projectId: 3, rev: 2 }} />);
    expect(tab("Dock").getAttribute("aria-selected")).toBe("true");
  });

  it("isolates a crashing tab — the others keep working", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    render(<ProjectHubPanel params={{ projectId: 3 }} />);
    hubStubControl.crashSkills = true;

    await user.click(tab("Skills"));
    expect(screen.queryByTestId("stub-skills")).toBeNull();

    await user.click(tab("Agent Rules"));
    expect(screen.getByTestId("stub-agent-rules")).toBeTruthy();
    expect(tab("Skills")).toBeTruthy();
  });
});
