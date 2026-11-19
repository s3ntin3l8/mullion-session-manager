// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, useState } from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "../CommandPalette.js";
import { usePanelOpener } from "../hooks/usePanelOpener.js";
import { handleGlobalEscape } from "../panelUtils.js";
import { ProjectSidebarView } from "../right-sidebar/ProjectSidebarView.js";
import { useDashboardStore } from "../store/index.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { makeProject } from "../test/fixtures.js";
import { ProjectSettingsHost } from "./ProjectSettingsDialog.js";

// The editors stand in as a draft <input> that reports its dirty state the
// way AgentRulesPanel and ProjectBriefingPanel do, so the dialog's own draft
// protection is what is under test, not each editor's fetches.
function makeEditorStub(name: string) {
  return function EditorStub({
    params,
    onDirtyChange,
  }: {
    params: { projectId: number; view?: string };
    onDirtyChange?: (dirty: boolean) => void;
  }) {
    const [draft, setDraft] = useState("");
    useEffect(() => {
      onDirtyChange?.(draft !== "");
    }, [draft, onDirtyChange]);
    return (
      <div data-testid={`editor-${name}`}>
        <span>{`${name}:${params.projectId}${params.view ? `:${params.view}` : ""}`}</span>
        <input
          aria-label={`${name} draft`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      </div>
    );
  };
}
vi.mock("../AgentRulesPanel.js", () => ({ AgentRulesPanel: makeEditorStub("agent-rules") }));
vi.mock("../ProjectBriefingPanel.js", () => ({
  ProjectBriefingPanel: makeEditorStub("briefing"),
}));
vi.mock("../ProjectSetupPanel.js", () => ({ ProjectSetupPanel: makeEditorStub("scaffold") }));
vi.mock("../DockConfigPanel.js", () => ({ DockConfigPanel: makeEditorStub("dock") }));
vi.mock("../SkillsPanel.js", () => ({
  SkillsPanel: ({ params }: { params: { projectId: number } }) => (
    <div data-testid="skills-panel">{`skills:${params.projectId}`}</div>
  ),
}));

const PROJECTS = [makeProject({ id: 5, name: "mullion" }), makeProject({ id: 6, name: "other" })];

// The real openers (usePanelOpener) wired to the palette and the sidebar's
// Project view, exactly as App wires them, plus the dialog's host.
function Harness({ surface }: { surface: "palette" | "sidebar" }) {
  const o = usePanelOpener({
    dockviewApi: null,
    layout: { tier: "desktop" },
    projects: PROJECTS,
    workspaces: [],
    activeWorkspaceId: 1,
  });
  return (
    <>
      {surface === "palette" ? (
        <CommandPalette
          scope="project"
          projectId={5}
          onClose={vi.fn()}
          onOpenSession={vi.fn()}
          onOpenGitHub={vi.fn()}
          onOpenAgentRules={o.onOpenAgentRules}
          onOpenFileEditor={vi.fn()}
          onOpenExternalFile={vi.fn()}
          onOpenProjectBriefing={o.onOpenProjectBriefing}
          onOpenProjectSetup={o.onOpenProjectSetup}
          onOpenDockConfig={o.onOpenDockConfig}
          onOpenSkills={o.onOpenSkills}
          onOpenBrowser={vi.fn()}
          onOpenBlankBrowser={vi.fn()}
          onOpenSettingsSection={vi.fn()}
          onOpenTasks={vi.fn()}
          onOpenBrowserUrl={vi.fn()}
        />
      ) : (
        <ProjectSidebarView
          projectId={5}
          actions={{
            onOpenGit: vi.fn(),
            onOpenGitHub: vi.fn(),
            onOpenFileEditor: vi.fn(),
            onOpenFile: vi.fn(),
            onOpenAgentRules: o.onOpenAgentRules,
            onOpenProjectBriefing: o.onOpenProjectBriefing,
            onOpenProjectSetup: o.onOpenProjectSetup,
            onOpenDockConfig: o.onOpenDockConfig,
            onOpenSkills: o.onOpenSkills,
            onOpenTasks: vi.fn(),
            onOpenDevice: vi.fn(),
          }}
        />
      )}
      <ProjectSettingsHost />
    </>
  );
}

function dialog() {
  return screen.getByRole("dialog", { name: /Project settings/ });
}

function activeHeading() {
  return within(dialog()).getByRole("heading", { level: 2, name: /^(?!Project settings)/ });
}

function openFor(projectId: number, section: "agent-rules" | "briefing" | "scaffold" | "dock") {
  act(() => useDashboardStore.getState().openProjectSettings(projectId, section));
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(jsonResponse(200, []))),
  );
  useDashboardStore.setState({
    projects: PROJECTS,
    sessions: [],
    projectSettings: null,
    projectSettingsDirty: false,
    projectSettingsLeave: null,
    projectSkillsRequest: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Project settings openers (#3406)", () => {
  it.each([
    ["Agent Rules", "agent-rules"],
    ["Mullion Briefing", "briefing"],
    ["Scaffold Mullion", "scaffold"],
    ["Dock", "dock"],
  ] as const)("palette's Project › %s opens the dialog on that section", async (title, id) => {
    const user = userEvent.setup();
    render(<Harness surface="palette" />);

    await user.click(await screen.findByText(/Project: mullion/));
    await user.click(await screen.findByText(title));

    expect(dialog()).toHaveAccessibleName("Project settings — mullion");
    expect(activeHeading()).toHaveTextContent(title);
    expect(within(dialog()).getByTestId(`editor-${id}`)).toHaveTextContent(`${id}:5`);
  });

  it("palette's Project › Skills opens the sidebar's Project view on Skills, not the dialog", async () => {
    const user = userEvent.setup();
    render(<Harness surface="palette" />);

    await user.click(await screen.findByText(/Project: mullion/));
    await user.click(await screen.findByText("Skills"));

    const s = useDashboardStore.getState();
    expect(s.rightSidebarOpen).toBe(true);
    expect(s.rightSidebarView).toBe("project");
    expect(s.projectSkillsRequest).toMatchObject({ projectId: 5 });
    expect(screen.queryByRole("dialog", { name: /Project settings/ })).toBeNull();
  });

  it.each([
    ["Agent Rules", "agent-rules"],
    ["Mullion Briefing", "briefing"],
    ["Scaffold Mullion", "scaffold"],
    ["Dock", "dock"],
  ] as const)("the sidebar's %s row opens the dialog on that section", async (title, id) => {
    const user = userEvent.setup();
    render(<Harness surface="sidebar" />);

    await user.click(screen.getByText(title));

    expect(activeHeading()).toHaveTextContent(title);
    expect(within(dialog()).getByTestId(`editor-${id}`)).toBeVisible();
  });

  it("the sidebar's Skills row drills in rather than opening the dialog", async () => {
    const user = userEvent.setup();
    render(<Harness surface="sidebar" />);

    await user.click(screen.getByText("Skills"));

    expect(screen.getByTestId("skills-panel")).toHaveTextContent("skills:5");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Dock's configure affordance opens Dock on its Previews list", () => {
    render(<Harness surface="sidebar" />);
    act(() => useDashboardStore.getState().openProjectSettings(5, "dock", "previews"));
    expect(within(dialog()).getByTestId("editor-dock")).toHaveTextContent("dock:5:previews");
  });

  it("asking again for a section re-targets the open dialog", async () => {
    const user = userEvent.setup();
    render(<ProjectSettingsHost />);
    openFor(5, "dock");
    await user.click(within(dialog()).getByRole("button", { name: /Agent Rules/ }));
    expect(activeHeading()).toHaveTextContent("Agent Rules");

    openFor(5, "dock");

    expect(activeHeading()).toHaveTextContent("Dock");
  });
});

describe("Project settings draft protection (#3406)", () => {
  it("an unsaved draft survives switching sections", async () => {
    const user = userEvent.setup();
    render(<ProjectSettingsHost />);
    openFor(5, "agent-rules");

    await user.type(screen.getByLabelText("agent-rules draft"), "wip");
    await user.click(within(dialog()).getByRole("button", { name: /Mullion Briefing/ }));
    await user.type(screen.getByLabelText("briefing draft"), "more");
    expect(screen.getByTestId("editor-agent-rules")).not.toBeVisible();
    await user.click(within(dialog()).getByRole("button", { name: /Agent Rules/ }));

    expect(screen.getByLabelText("agent-rules draft")).toHaveValue("wip");
    expect(screen.getByLabelText("briefing draft")).toHaveValue("more");
  });

  it("closes at once with nothing unsaved", async () => {
    const user = userEvent.setup();
    render(<ProjectSettingsHost />);
    openFor(5, "agent-rules");

    await user.click(screen.getByRole("button", { name: "Close project settings" }));

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the close button asks first over an unsaved draft; Keep editing keeps it", async () => {
    const user = userEvent.setup();
    render(<ProjectSettingsHost />);
    openFor(5, "agent-rules");
    await user.type(screen.getByLabelText("agent-rules draft"), "wip");

    await user.click(screen.getByRole("button", { name: "Close project settings" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Unsaved changes in Agent Rules. Discard them and close?",
    );
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("agent-rules draft")).toHaveValue("wip");
  });

  it("Discard closes over the draft", async () => {
    const user = userEvent.setup();
    render(<ProjectSettingsHost />);
    openFor(5, "briefing");
    await user.type(screen.getByLabelText("briefing draft"), "wip");

    await user.click(screen.getByRole("button", { name: "Close project settings" }));
    await user.click(screen.getByRole("button", { name: "Discard" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useDashboardStore.getState().projectSettingsDirty).toBe(false);
  });

  it("Escape asks first over a draft, and a second Escape keeps editing", async () => {
    const user = userEvent.setup();
    render(<ProjectSettingsHost />);
    openFor(5, "agent-rules");
    await user.type(screen.getByLabelText("agent-rules draft"), "wip");
    const escape = () =>
      act(() =>
        handleGlobalEscape({
          clearPalette: vi.fn(),
          closeSettings: vi.fn(),
          closeProjectSettings: () => useDashboardStore.getState().requestCloseProjectSettings(),
        }),
      );

    escape();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    escape();

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("agent-rules draft")).toHaveValue("wip");
  });

  it("a backdrop click asks first over a draft", async () => {
    const user = userEvent.setup();
    const { container } = render(<ProjectSettingsHost />);
    openFor(5, "agent-rules");
    await user.type(screen.getByLabelText("agent-rules draft"), "wip");

    await user.click(container.querySelector(".settings-backdrop")!);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(dialog()).toBeInTheDocument();
  });

  it("opening another project over a draft asks first, then switches", async () => {
    const user = userEvent.setup();
    render(<ProjectSettingsHost />);
    openFor(5, "agent-rules");
    await user.type(screen.getByLabelText("agent-rules draft"), "wip");

    openFor(6, "dock");

    expect(screen.getByRole("alert")).toHaveTextContent("Discard them and switch project?");
    expect(dialog()).toHaveAccessibleName("Project settings — mullion");
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(dialog()).toHaveAccessibleName("Project settings — other");
    expect(screen.getByTestId("editor-dock")).toHaveTextContent("dock:6");
  });

  it("opening another project with nothing unsaved switches at once", () => {
    render(<ProjectSettingsHost />);
    openFor(5, "agent-rules");

    openFor(6, "briefing");

    expect(dialog()).toHaveAccessibleName("Project settings — other");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
