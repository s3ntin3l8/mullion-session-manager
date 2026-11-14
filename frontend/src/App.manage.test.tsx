// @vitest-environment jsdom
// #3048 — with no left sidebar from 700 to 1099px, workspaces are managed in
// the rail's workspace picker and projects in the launcher's Where row. These
// drive both through App at 1000px, with the real rail section and launcher.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
// The mocks live in the shared harness; import it before App.
import { realHarness, setLayoutMode, stubPxWidth } from "./test/appHarness.js";
import { App } from "./App.js";
import { useDashboardStore } from "./store/index.js";
import { makeProject, makeWorkspace } from "./test/fixtures.js";
import type { Group, Project } from "./api/index.js";

const INFRA: Group = {
  id: 7,
  name: "Infra",
  color: "#4c8dff",
  collapsed: false,
  position: 0,
} as Group;

function stubFetch(discovered: unknown[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = String(url).startsWith("/api/projects/discover") ? discovered : [];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function storeActions() {
  return {
    refreshWorkspaces: vi.fn().mockResolvedValue(undefined),
    refreshGroups: vi.fn().mockResolvedValue(undefined),
    hydrateSettings: vi.fn(),
    startThemeWatch: vi.fn(() => () => {}),
    renameWorkspace: vi.fn().mockResolvedValue(undefined),
    deleteWorkspace: vi.fn().mockResolvedValue(undefined),
    reorderWorkspaces: vi.fn().mockResolvedValue(undefined),
    updateGroup: vi.fn().mockResolvedValue(undefined),
    deleteGroup: vi.fn().mockResolvedValue(undefined),
    createGroup: vi.fn().mockResolvedValue(INFRA),
  };
}

const chip = () => screen.getByRole("button", { name: /^Switch workspace/ });

describe("App: managing workspaces and projects without the sidebar (#3048)", () => {
  let actions: ReturnType<typeof storeActions>;
  beforeEach(() => {
    realHarness.real = true;
    actions = storeActions();
    useDashboardStore.setState({
      ...actions,
      viewMode: "list",
      workspaces: [
        makeWorkspace({ id: 1, name: "Alpha", groupId: null, position: 0 }),
        makeWorkspace({ id: 2, name: "Beta", groupId: null, position: 1 }),
        makeWorkspace({ id: 3, name: "Gamma", groupId: 7, position: 0 }),
      ],
      groups: [INFRA],
      activeWorkspaceId: 1,
    });
    setLayoutMode("auto");
    stubFetch();
  });
  afterEach(() => {
    realHarness.real = false;
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renames a workspace from the picker's ⋯, keeping a row's tap for switching", async () => {
    stubPxWidth(1000);
    const user = userEvent.setup();
    render(<App />);
    await user.click(chip());
    const list = screen.getByRole("dialog", { name: "Workspaces" });
    await user.click(within(list).getByRole("button", { name: "Manage Alpha" }));
    const manage = within(list).getByRole("group", { name: "Manage Alpha" });
    await user.click(within(manage).getByRole("button", { name: "Rename" }));
    const field = within(manage).getByRole("textbox", { name: "Workspace name" });
    await user.clear(field);
    await user.type(field, "Alpha two{Enter}");
    expect(actions.renameWorkspace).toHaveBeenCalledWith(1, "Alpha two");
    // Escape steps back to the list rather than closing it.
    await user.keyboard("{Escape}");
    expect(within(list).getByRole("button", { name: "Manage Alpha" })).toHaveFocus();
    expect(screen.getByRole("dialog", { name: "Workspaces" })).toBeInTheDocument();
  });

  it("moves a workspace up, down and into a group", async () => {
    stubPxWidth(1000);
    const user = userEvent.setup();
    render(<App />);
    await user.click(chip());
    const list = screen.getByRole("dialog", { name: "Workspaces" });
    await user.click(within(list).getByRole("button", { name: "Manage Alpha" }));
    const manage = within(list).getByRole("group", { name: "Manage Alpha" });
    expect(within(manage).getByText("1 of 2, no group")).toBeInTheDocument();
    expect(within(manage).getByRole("button", { name: "Move up" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    // Inert, not disabled: nothing happens, and focus is not dropped.
    await user.click(within(manage).getByRole("button", { name: "Move up" }));
    expect(actions.reorderWorkspaces).not.toHaveBeenCalled();
    await user.click(within(manage).getByRole("button", { name: "Move down" }));
    expect(actions.reorderWorkspaces).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        { id: 2, groupId: null, position: 0 },
        { id: 1, groupId: null, position: 1 },
      ]),
    );
    await user.click(within(manage).getByRole("button", { name: "Move to group" }));
    expect(within(manage).getByRole("button", { name: "No group" })).toBeDisabled();
    await user.click(within(manage).getByRole("button", { name: "Infra" }));
    // To the end of the group it joins.
    expect(actions.reorderWorkspaces).toHaveBeenLastCalledWith(
      expect.arrayContaining([{ id: 1, groupId: 7, position: 1 }]),
    );
    expect(within(manage).getByRole("button", { name: "Move up" })).toBeInTheDocument();
  });

  it("deletes a workspace after a second confirming tap", async () => {
    stubPxWidth(1000);
    const user = userEvent.setup();
    render(<App />);
    await user.click(chip());
    const list = screen.getByRole("dialog", { name: "Workspaces" });
    actions.deleteWorkspace.mockImplementation(async (id: number) => {
      useDashboardStore.setState({
        workspaces: useDashboardStore.getState().workspaces.filter((w) => w.id !== id),
      });
    });
    await user.click(within(list).getByRole("button", { name: "Manage Beta" }));
    const del = within(list).getByRole("button", { name: "Delete workspace" });
    await user.click(del);
    expect(actions.deleteWorkspace).not.toHaveBeenCalled();
    await user.click(within(list).getByRole("button", { name: /Click again to delete/ }));
    expect(actions.deleteWorkspace).toHaveBeenCalledWith(2);
    // Back on the list; its "⋯" went with the workspace, so the search box.
    await waitFor(() =>
      expect(within(list).getByRole("searchbox", { name: "Search workspaces" })).toHaveFocus(),
    );
  });

  it("goes back one step from a rename with the Back button", async () => {
    stubPxWidth(1000);
    const user = userEvent.setup();
    render(<App />);
    await user.click(chip());
    const list = screen.getByRole("dialog", { name: "Workspaces" });
    await user.click(within(list).getByRole("button", { name: "Manage Alpha" }));
    await user.click(within(list).getByRole("button", { name: "Rename" }));
    await user.click(within(list).getByRole("button", { name: "Back" }));
    // The actions again, not the list.
    expect(within(list).getByRole("button", { name: "Move to group" })).toBeInTheDocument();
    await user.click(within(list).getByRole("button", { name: "Back to workspaces" }));
    expect(within(list).getByRole("button", { name: "Manage Alpha" })).toHaveFocus();
  });

  it("renames and deletes a group, and opens New group", async () => {
    stubPxWidth(1000);
    const user = userEvent.setup();
    render(<App />);
    await user.click(chip());
    let list = screen.getByRole("dialog", { name: "Workspaces" });
    await user.click(within(list).getByRole("button", { name: "Manage group Infra" }));
    const manage = within(list).getByRole("group", { name: "Manage Infra" });
    await user.click(within(manage).getByRole("button", { name: "Rename" }));
    const field = within(manage).getByRole("textbox", { name: "Group name" });
    await user.clear(field);
    await user.type(field, "Ops{Enter}");
    expect(actions.updateGroup).toHaveBeenCalledWith(7, { name: "Ops" });
    await user.click(within(manage).getByRole("button", { name: "Delete group" }));
    await user.click(within(manage).getByRole("button", { name: /Click again to delete/ }));
    expect(actions.deleteGroup).toHaveBeenCalledWith(7);

    list = screen.getByRole("dialog", { name: "Workspaces" });
    await user.click(within(list).getByRole("button", { name: "New group" }));
    expect(screen.queryByRole("dialog", { name: "Workspaces" })).toBeNull();
    const modal = await screen.findByRole("dialog", { name: /group/i });
    expect(modal.closest(".cmux-root")).not.toBeNull();
  });

  it("offers the same management in the sheet under a coarse pointer", async () => {
    stubPxWidth(834, true);
    const user = userEvent.setup();
    render(<App />);
    await user.click(chip());
    const sheet = screen.getByRole("dialog", { name: "Workspaces" });
    expect(sheet.querySelector(".rail-ws-list.touch")).not.toBeNull();
    await user.click(within(sheet).getByRole("button", { name: "Manage Beta" }));
    await user.click(within(sheet).getByRole("button", { name: "Delete workspace" }));
    expect(within(sheet).getByRole("button", { name: /Tap again to delete/ })).toBeInTheDocument();
  });
});

describe("App: projects in the launcher's Where row (#3048)", () => {
  const MULLION: Project = makeProject({ id: 5, name: "mullion", cwd: "/home/x/mullion" });
  beforeEach(() => {
    realHarness.real = true;
    setLayoutMode("auto");
    useDashboardStore.setState({
      ...storeActions(),
      viewMode: "list",
      workspaces: [makeWorkspace({ id: 1, name: "Alpha" })],
      activeWorkspaceId: 1,
      projects: [MULLION],
      gitStatuses: {},
      refreshProjects: vi.fn().mockResolvedValue(undefined),
    });
  });
  afterEach(() => {
    realHarness.real = false;
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function openLauncher() {
    render(<App />);
    act(() => useDashboardStore.getState().openLauncher({ projectId: MULLION.id }));
    return screen.findByRole("dialog", { name: "New session" });
  }

  it("adds a project with the Add project dialog and selects it", async () => {
    stubPxWidth(1000);
    stubFetch();
    const created = makeProject({ id: 9, name: "runway", cwd: "/home/x/runway" });
    const createProject = vi.fn().mockImplementation(async () => {
      useDashboardStore.setState({ projects: [MULLION, created] });
      return created;
    });
    useDashboardStore.setState({ createProject });
    const user = userEvent.setup();
    const launcher = await openLauncher();
    await user.click(within(launcher).getByRole("button", { name: "Add project" }));
    await user.click(within(launcher).getByRole("button", { name: "New project…" }));
    const modal = await screen.findByRole("dialog", { name: "Add project" });
    await user.type(within(modal).getByPlaceholderText("~/code/my-project"), "/home/x/runway");
    await user.click(within(modal).getByRole("button", { name: "Add project" }));
    await waitFor(() => expect(createProject).toHaveBeenCalled());
    expect(createProject.mock.calls[0][1]).toBe("/home/x/runway");
    await waitFor(() =>
      expect(within(launcher).getByRole("combobox", { name: "Project" })).toHaveValue("9"),
    );
  });

  it("adds a discovered repository and selects it", async () => {
    stubPxWidth(1000);
    stubFetch([{ name: "landing", cwd: "/home/x/landing", isGitRepo: true, isRegistered: false }]);
    const created = makeProject({ id: 11, name: "landing", cwd: "/home/x/landing" });
    const createProject = vi.fn().mockImplementation(async () => {
      useDashboardStore.setState({ projects: [MULLION, created] });
      return created;
    });
    useDashboardStore.setState({ createProject });
    const user = userEvent.setup();
    const launcher = await openLauncher();
    await user.click(within(launcher).getByRole("button", { name: "Add project" }));
    await user.click(await within(launcher).findByRole("button", { name: "Add" }));
    expect(createProject).toHaveBeenCalledWith("landing", "/home/x/landing", "local", undefined);
    await waitFor(() =>
      expect(within(launcher).getByRole("combobox", { name: "Project" })).toHaveValue("11"),
    );
  });

  it("edits the selected project from its ⋯", async () => {
    stubPxWidth(1000);
    stubFetch();
    const updateProject = vi.fn().mockResolvedValue(undefined);
    useDashboardStore.setState({ updateProject });
    const user = userEvent.setup();
    const launcher = await openLauncher();
    await user.click(within(launcher).getByRole("button", { name: "Manage mullion" }));
    const panel = within(launcher).getByRole("group", { name: "Manage mullion" });
    // Nothing to pull without a git status.
    expect(within(panel).getByRole("button", { name: "Git pull" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(within(panel).getByRole("button", { name: "Edit" }));
    const modal = await screen.findByRole("dialog", { name: "Edit project" });
    const name = within(modal).getByDisplayValue("mullion");
    await user.clear(name);
    await user.type(name, "mullion-core");
    await user.click(within(modal).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateProject).toHaveBeenCalled());
    expect(updateProject.mock.calls[0][0]).toBe(5);
    expect(updateProject.mock.calls[0][1]).toMatchObject({ name: "mullion-core" });
    // The launcher is still open behind it.
    expect(screen.getByRole("dialog", { name: "New session" })).toBeInTheDocument();
  });

  it("pulls the selected project and says how it went", async () => {
    stubPxWidth(1000);
    stubFetch();
    const pullProjectGit = vi
      .fn()
      .mockResolvedValueOnce({ pulled: true })
      .mockResolvedValueOnce({ pulled: false, reason: "dirty-tree" });
    useDashboardStore.setState({
      pullProjectGit,
      refreshGitStatuses: vi.fn().mockResolvedValue(undefined),
      refreshGitRefs: vi.fn().mockResolvedValue(undefined),
      gitStatuses: {
        5: {
          branch: "main",
          files: [],
          isClean: true,
          hasConflicts: false,
          ahead: 0,
          behind: 2,
        } as never,
      },
    });
    const user = userEvent.setup();
    const launcher = await openLauncher();
    await user.click(within(launcher).getByRole("button", { name: "Manage mullion" }));
    const pull = within(launcher).getByRole("button", { name: "Git pull" });
    expect(pull).toHaveAttribute("title", "Pull 2 commits from tracking branch");
    await user.click(pull);
    expect(pullProjectGit).toHaveBeenCalledWith(5);
    expect(await within(launcher).findByRole("status")).toHaveTextContent("Pulled.");
    await user.click(within(launcher).getByRole("button", { name: "Git pull" }));
    await waitFor(() =>
      expect(within(launcher).getByRole("status")).toHaveTextContent(/uncommitted changes/),
    );
  });

  it("deletes the selected project after a confirming click and selects another", async () => {
    stubPxWidth(1000);
    stubFetch();
    const other = makeProject({ id: 6, name: "runway" });
    const deleteProject = vi.fn().mockImplementation(async () => {
      useDashboardStore.setState({ projects: [other] });
    });
    useDashboardStore.setState({ projects: [MULLION, other], deleteProject });
    const user = userEvent.setup();
    const launcher = await openLauncher();
    await user.click(within(launcher).getByRole("button", { name: "Manage mullion" }));
    await user.click(within(launcher).getByRole("button", { name: "Delete project" }));
    expect(deleteProject).not.toHaveBeenCalled();
    await user.click(within(launcher).getByRole("button", { name: /Click again to delete/ }));
    expect(deleteProject).toHaveBeenCalledWith(5);
    await waitFor(() =>
      expect(within(launcher).getByRole("combobox", { name: "Project" })).toHaveValue("6"),
    );
    // Focus lands on the next project's "⋯", not on <body>.
    await waitFor(() =>
      expect(within(launcher).getByRole("button", { name: "Manage runway" })).toHaveFocus(),
    );
  });
});
