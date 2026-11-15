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

  // #3073 — the "⋯" opens a menu beside the row; the list stays behind it.
  const openMenu = async (user: ReturnType<typeof userEvent.setup>, label: string) => {
    const list = screen.getByRole("dialog", { name: "Workspaces" });
    await user.click(within(list).getByRole("button", { name: label }));
    return list;
  };

  it("opens a workspace's ⋯ as a menu beside the row and renames on the row", async () => {
    stubPxWidth(1000);
    const user = userEvent.setup();
    render(<App />);
    await user.click(chip());
    const list = await openMenu(user, "Manage Alpha");
    const menu = screen.getByRole("menu", { name: "Alpha actions" });
    // A popover of its own, not the list's content: the list is still there.
    expect(list).not.toContainElement(menu);
    expect(within(list).getByRole("button", { name: "Alpha" })).toBeInTheDocument();
    expect(within(list).getByRole("searchbox", { name: "Search workspaces" })).toBeInTheDocument();
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Rename", "Move up", "Move down", "Move to Infra", "Delete workspace"]);

    await user.click(within(menu).getByRole("menuitem", { name: "Rename" }));
    expect(screen.queryByRole("menu")).toBeNull();
    // On the row itself, in place of its name.
    const field = within(list).getByRole("textbox", { name: "Workspace name" });
    expect(field).toHaveFocus();
    expect(within(list).queryByRole("button", { name: "Alpha" })).toBeNull();
    await user.clear(field);
    await user.type(field, "Alpha two{Enter}");
    expect(actions.renameWorkspace).toHaveBeenCalledWith(1, "Alpha two");
    expect(within(list).getByRole("button", { name: "Manage Alpha" })).toHaveFocus();
    expect(screen.getByRole("dialog", { name: "Workspaces" })).toBeInTheDocument();

    // Escape cancels a rename without closing the picker.
    await openMenu(user, "Manage Alpha");
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    await user.keyboard("{Escape}");
    expect(within(list).queryByRole("textbox", { name: "Workspace name" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Workspaces" })).toBeInTheDocument();
    expect(actions.renameWorkspace).toHaveBeenCalledTimes(1);
  });

  it("moves a workspace up, down and into a group, focus following the row", async () => {
    stubPxWidth(1000);
    // Apply the order the way the store does, so a moved row re-renders.
    actions.reorderWorkspaces.mockImplementation(
      async (order: Array<{ id: number; groupId: number | null; position: number }>) => {
        useDashboardStore.setState({
          workspaces: useDashboardStore.getState().workspaces.map((w) => {
            const next = order.find((o) => o.id === w.id);
            return next ? { ...w, groupId: next.groupId, position: next.position } : w;
          }),
        });
      },
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(chip());
    const list = await openMenu(user, "Manage Alpha");
    const up = screen.getByRole("menuitem", { name: "Move up" });
    expect(up).toHaveAttribute("aria-disabled", "true");
    // Inert: nothing happens, and the menu stays.
    await user.click(up);
    expect(actions.reorderWorkspaces).not.toHaveBeenCalled();
    await user.click(screen.getByRole("menuitem", { name: "Move down" }));
    expect(actions.reorderWorkspaces).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        { id: 2, groupId: null, position: 0 },
        { id: 1, groupId: null, position: 1 },
      ]),
    );
    await waitFor(() =>
      expect(within(list).getByRole("button", { name: "Manage Alpha" })).toHaveFocus(),
    );

    await openMenu(user, "Manage Alpha");
    expect(screen.getByRole("menuitem", { name: "Move down" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(screen.getByRole("menuitem", { name: "Move to Infra" }));
    // To the end of the group it joins.
    expect(actions.reorderWorkspaces).toHaveBeenLastCalledWith(
      expect.arrayContaining([{ id: 1, groupId: 7, position: 1 }]),
    );
    // The row moved under Infra; its "⋯" still takes focus back.
    const infra = within(list).getByRole("group", { name: "Infra" });
    await waitFor(() =>
      expect(within(infra).getByRole("button", { name: "Manage Alpha" })).toHaveFocus(),
    );
    await openMenu(user, "Manage Alpha");
    expect(
      screen
        .getAllByRole("menuitem")
        .map((i) => i.textContent)
        .filter((t) => t?.startsWith("Move to")),
    ).toEqual(["Move to No group"]);
    await user.click(screen.getByRole("menuitem", { name: "Move to No group" }));
    expect(actions.reorderWorkspaces).toHaveBeenLastCalledWith(
      expect.arrayContaining([{ id: 1, groupId: null, position: 1 }]),
    );
  });

  it("deletes a workspace after a second confirming click", async () => {
    stubPxWidth(1000);
    const user = userEvent.setup();
    render(<App />);
    await user.click(chip());
    actions.deleteWorkspace.mockImplementation(async (id: number) => {
      useDashboardStore.setState({
        workspaces: useDashboardStore.getState().workspaces.filter((w) => w.id !== id),
      });
    });
    const list = await openMenu(user, "Manage Beta");
    await user.click(screen.getByRole("menuitem", { name: "Delete workspace" }));
    expect(actions.deleteWorkspace).not.toHaveBeenCalled();
    await user.click(screen.getByRole("menuitem", { name: /Click again to delete/ }));
    expect(actions.deleteWorkspace).toHaveBeenCalledWith(2);
    // Its "⋯" went with the workspace, so the search box.
    await waitFor(() =>
      expect(within(list).getByRole("searchbox", { name: "Search workspaces" })).toHaveFocus(),
    );
    expect(screen.getByRole("dialog", { name: "Workspaces" })).toBeInTheDocument();
  });

  it("closes the menu first, then the picker, on Escape and on an outside click", async () => {
    stubPxWidth(1000);
    const user = userEvent.setup();
    render(<App />);
    await user.click(chip());
    const list = await openMenu(user, "Manage Alpha");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Workspaces" })).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: "Manage Alpha" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Workspaces" })).toBeNull();

    await user.click(chip());
    await openMenu(user, "Manage group Infra");
    expect(screen.getByRole("menu", { name: "Infra actions" })).toBeInTheDocument();
    await user.click(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Workspaces" })).toBeInTheDocument();
    await user.click(document.body);
    expect(screen.queryByRole("dialog", { name: "Workspaces" })).toBeNull();
  });

  it("renames and deletes a group from its ⋯, and opens New group", async () => {
    stubPxWidth(1000);
    const user = userEvent.setup();
    render(<App />);
    await user.click(chip());
    let list = await openMenu(user, "Manage group Infra");
    expect(
      within(screen.getByRole("menu", { name: "Infra actions" }))
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Rename", "Delete group"]);
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    const field = within(list).getByRole("textbox", { name: "Group name" });
    await user.clear(field);
    await user.type(field, "Ops{Enter}");
    expect(actions.updateGroup).toHaveBeenCalledWith(7, { name: "Ops" });
    expect(within(list).getByRole("button", { name: "Manage group Infra" })).toHaveFocus();
    await openMenu(user, "Manage group Infra");
    await user.click(screen.getByRole("menuitem", { name: "Delete group" }));
    await user.click(screen.getByRole("menuitem", { name: /Click again to delete/ }));
    expect(actions.deleteGroup).toHaveBeenCalledWith(7);

    list = screen.getByRole("dialog", { name: "Workspaces" });
    await user.click(within(list).getByRole("button", { name: "New group" }));
    expect(screen.queryByRole("dialog", { name: "Workspaces" })).toBeNull();
    const modal = await screen.findByRole("dialog", { name: /group/i });
    expect(modal.closest(".cmux-root")).not.toBeNull();
    // The list that held "New group" is gone: closing the dialog returns
    // focus to the chip.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /group/i })).toBeNull());
    expect(chip()).toHaveFocus();
  });

  it("opens the actions as a sheet under a coarse pointer", async () => {
    stubPxWidth(834, true);
    const user = userEvent.setup();
    render(<App />);
    await user.click(chip());
    const sheet = screen.getByRole("dialog", { name: "Workspaces" });
    expect(sheet.querySelector(".rail-ws-list.touch")).not.toBeNull();
    const more = within(sheet).getByRole("button", { name: "Manage Beta" });
    expect(more).toHaveAttribute("aria-haspopup", "dialog");
    await user.click(more);
    const actionsSheet = screen.getByRole("dialog", { name: "Beta actions" });
    expect(actionsSheet).not.toBe(sheet);
    expect(within(actionsSheet).getByRole("menu", { name: "Beta actions" })).toBeInTheDocument();
    await user.click(within(actionsSheet).getByRole("menuitem", { name: "Delete workspace" }));
    expect(
      within(actionsSheet).getByRole("menuitem", { name: /Tap again to delete/ }),
    ).toBeInTheDocument();
    // Escape closes the actions only.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Beta actions" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "Workspaces" })).toBeInTheDocument();
  });
});

describe("App: projects in the launcher's Where row (#3048, #3071)", () => {
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

  // #3071 — "Add project…" is the dropdown's last entry; the form replaces
  // the launcher's body (no dialog over it) and hands back with the new
  // project selected and the dropdown focused.
  it("adds a project from the dropdown's Add project… and selects it", async () => {
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
    await user.selectOptions(
      within(launcher).getByRole("combobox", { name: "Project" }),
      "Add project…",
    );
    const form = within(launcher).getByRole("group", { name: "Add project" });
    expect(screen.queryByRole("dialog", { name: "Add project" })).toBeNull();
    const path = within(form).getByPlaceholderText("~/code/my-project");
    expect(path).toHaveFocus();
    await user.type(path, "/home/x/runway");
    await user.click(within(form).getByRole("button", { name: "Add project" }));
    await waitFor(() => expect(createProject).toHaveBeenCalled());
    expect(createProject.mock.calls[0][1]).toBe("/home/x/runway");
    const project = await within(launcher).findByRole("combobox", { name: "Project" });
    expect(project).toHaveValue("9");
    await waitFor(() => expect(project).toHaveFocus());
  });

  it("holds Back and Escape while the create is in flight", async () => {
    stubPxWidth(1000);
    stubFetch();
    const created = makeProject({ id: 9, name: "runway", cwd: "/home/x/runway" });
    let finish: (() => void) | null = null;
    const createProject = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => {
            useDashboardStore.setState({ projects: [MULLION, created] });
            resolve(created);
          };
        }),
    );
    useDashboardStore.setState({ createProject });
    const user = userEvent.setup();
    const launcher = await openLauncher();
    await user.selectOptions(
      within(launcher).getByRole("combobox", { name: "Project" }),
      "Add project…",
    );
    const form = within(launcher).getByRole("group", { name: "Add project" });
    await user.type(within(form).getByPlaceholderText("~/code/my-project"), "/home/x/runway");
    await user.click(within(form).getByRole("button", { name: "Add project" }));
    await waitFor(() => expect(createProject).toHaveBeenCalled());

    const back = within(form).getByRole("button", { name: "Back" });
    expect(back).toHaveAttribute("aria-disabled", "true");
    await user.click(back);
    await user.keyboard("{Escape}");
    expect(within(launcher).getByRole("group", { name: "Add project" })).toBeInTheDocument();

    await act(async () => finish!());
    await waitFor(() =>
      expect(within(launcher).getByRole("combobox", { name: "Project" })).toHaveValue("9"),
    );
  });

  it("adds a discovered repository from the Add project view and selects it", async () => {
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
    await user.click(within(launcher).getByRole("button", { name: "Manage mullion" }));
    await user.click(screen.getByRole("menuitem", { name: "Add project…" }));
    await user.click(await within(launcher).findByRole("button", { name: "Add" }));
    expect(createProject).toHaveBeenCalledWith("landing", "/home/x/landing", "local", undefined);
    await waitFor(() =>
      expect(within(launcher).getByRole("combobox", { name: "Project" })).toHaveValue("11"),
    );
  });

  it("edits the selected project from its ⋯ in place, and Escape goes back", async () => {
    stubPxWidth(1000);
    stubFetch();
    const updateProject = vi.fn().mockResolvedValue(undefined);
    useDashboardStore.setState({ updateProject });
    const user = userEvent.setup();
    const launcher = await openLauncher();
    await user.click(within(launcher).getByRole("button", { name: "Manage mullion" }));
    const menu = screen.getByRole("menu", { name: "mullion actions" });
    // Nothing to pull without a git status.
    expect(within(menu).getByRole("menuitem", { name: "Git pull" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(within(menu).getByRole("menuitem", { name: "Edit" }));
    // The focus is in the form: the path field.
    expect(within(launcher).getByRole("group", { name: "Edit project" })).toContainElement(
      document.activeElement as HTMLElement,
    );
    // Escape leaves the form, not the launcher.
    await user.keyboard("{Escape}");
    expect(within(launcher).queryByRole("group", { name: "Edit project" })).toBeNull();
    await waitFor(() =>
      expect(within(launcher).getByRole("button", { name: "Manage mullion" })).toHaveFocus(),
    );

    await user.click(within(launcher).getByRole("button", { name: "Manage mullion" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    const form = within(launcher).getByRole("group", { name: "Edit project" });
    const name = within(form).getByDisplayValue("mullion");
    await user.clear(name);
    await user.type(name, "mullion-core");
    await user.click(within(form).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateProject).toHaveBeenCalled());
    expect(updateProject.mock.calls[0][0]).toBe(5);
    expect(updateProject.mock.calls[0][1]).toMatchObject({ name: "mullion-core" });
    // Back in the launcher, which never closed.
    expect(await within(launcher).findByRole("combobox", { name: "Project" })).toHaveValue("5");
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
      toasts: [],
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
    const toasts = () => useDashboardStore.getState().toasts.map((t) => t.message);
    const user = userEvent.setup();
    const launcher = await openLauncher();
    await user.click(within(launcher).getByRole("button", { name: "Manage mullion" }));
    const pull = screen.getByRole("menuitem", { name: "Git pull" });
    expect(pull).toHaveAttribute("title", "Pull 2 commits from tracking branch");
    await user.click(pull);
    expect(pullProjectGit).toHaveBeenCalledWith(5);
    // The menu closed; the result is a toast, not a line that pushes the form.
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(toasts()).toContain("Pulled mullion."));
    await user.click(within(launcher).getByRole("button", { name: "Manage mullion" }));
    await user.click(screen.getByRole("menuitem", { name: "Git pull" }));
    await waitFor(() => expect(toasts().some((m) => /uncommitted changes/.test(m))).toBe(true));
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
    await user.click(screen.getByRole("menuitem", { name: "Delete project" }));
    expect(deleteProject).not.toHaveBeenCalled();
    await user.click(screen.getByRole("menuitem", { name: /Click again to delete/ }));
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
