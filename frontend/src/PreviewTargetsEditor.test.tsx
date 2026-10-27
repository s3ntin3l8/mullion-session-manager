// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "./api/index.js";
import type { ProjectPreviewConfig } from "./api/index.js";
import { PreviewTargetsEditor } from "./PreviewTargetsEditor.js";
import { DockConfigPanel } from "./DockConfigPanel.js";
import { ProjectPreviewMenu, ProjectPreviewPicker } from "./ProjectPreviewMenu.js";
import { useDashboardStore } from "./store/index.js";
import { makeProject } from "./test/fixtures.js";
import { resetStore } from "./test/resetStore.js";

const initial: ProjectPreviewConfig = {
  devServerUrl: "3005",
  targets: [
    {
      id: "web",
      name: "Docker web",
      destination: "http://192.168.1.2:8080/",
      connectionOrigin: "primary",
    },
  ],
};
describe("project preview configuration", () => {
  beforeEach(() => {
    resetStore({
      projects: [makeProject({ id: 1, devServerUrl: "3005", detectedDevServerPort: "5173" })],
    });
    vi.spyOn(api, "getProjectPreviewTargets").mockImplementation(async () =>
      structuredClone(initial),
    );
    vi.spyOn(api, "saveProjectPreviewTargets").mockImplementation(async (_id, config) =>
      structuredClone(config),
    );
    vi.spyOn(api, "getProjectDockConfig").mockResolvedValue({
      controls: [{ id: "dev", title: "Dev server", command: "make dev" }],
      invalid: false,
      reason: null,
      isSymlink: false,
    });
    vi.spyOn(api, "listProjectActions").mockResolvedValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  it("saves independent names, destinations and origins and updates the menu cache", async () => {
    const user = userEvent.setup();
    render(<PreviewTargetsEditor projectId={1} />);
    await screen.findByLabelText("Dev server destination");
    await user.click(screen.getByRole("button", { name: "Add preview target" }));
    await user.type(screen.getByLabelText("Target 2 name"), "API docs");
    await user.type(screen.getByLabelText("Target 2 destination"), "https://api.example.test/docs");
    expect(screen.getByLabelText("Target 2 connection origin")).toHaveValue("project");
    await user.click(screen.getByRole("button", { name: "Save previews" }));
    await waitFor(() =>
      expect(api.saveProjectPreviewTargets).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          targets: [
            initial.targets[0],
            expect.objectContaining({ name: "API docs", connectionOrigin: "project" }),
          ],
        }),
      ),
    );
    await waitFor(() =>
      expect(useDashboardStore.getState().projectPreviewConfigs[1].targets).toHaveLength(2),
    );
  });

  it("offers detected ports without overwriting a configured value, and saves an explicit clear", async () => {
    const user = userEvent.setup();
    render(<PreviewTargetsEditor projectId={1} />);
    const field = await screen.findByLabelText("Dev server destination");
    expect(field).toHaveValue("3005");
    await user.click(screen.getByRole("button", { name: /Detected dev server/ }));
    expect(field).toHaveValue("5173");
    expect(screen.queryByRole("button", { name: /Detected dev server/ })).toBeNull();
    await user.clear(field);
    await user.click(screen.getByRole("button", { name: "Save previews" }));
    expect(api.saveProjectPreviewTargets).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ devServerUrl: null }),
    );
  });

  it("preserves preview and monitor drafts when switching between them", async () => {
    const user = userEvent.setup();
    render(<DockConfigPanel params={{ projectId: 1 }} />);
    await user.click(await screen.findByRole("button", { name: "Dev server" }));
    const command = screen.getByDisplayValue("make dev");
    await user.clear(command);
    await user.type(command, "npm run dev");
    await user.click(screen.getByRole("tab", { name: "Previews" }));
    const field = await screen.findByLabelText("Dev server destination");
    await user.clear(field);
    await user.type(field, "4000");
    await user.click(screen.getByRole("tab", { name: "Monitors" }));
    expect(screen.getByDisplayValue("npm run dev")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Previews" }));
    expect(field).toHaveValue("4000");
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(field).toHaveValue("3005");
    expect(api.saveProjectPreviewTargets).not.toHaveBeenCalled();
  });

  it("keeps a failed save editable and removes only the selected target", async () => {
    vi.mocked(api.saveProjectPreviewTargets).mockRejectedValue(new Error("Host unavailable"));
    const user = userEvent.setup();
    render(<PreviewTargetsEditor projectId={1} />);
    await user.click(await screen.findByRole("button", { name: "Remove target" }));
    await user.click(screen.getByRole("button", { name: "Save previews" }));
    expect(await screen.findByText("Host unavailable")).toBeInTheDocument();
    expect(api.saveProjectPreviewTargets).toHaveBeenCalledWith(1, {
      devServerUrl: "3005",
      targets: [],
    });
    expect(screen.getByRole("button", { name: "Save previews" })).toBeEnabled();
  });

  it("registers and opens the named choice and offers management in the Dock menu", async () => {
    vi.spyOn(api, "createTargetPreview").mockResolvedValue({
      kind: "target",
      targetId: "web",
      projectId: 1,
      slug: "named-web",
      externalUrl: null,
      createdAt: "2026-01-01",
    });
    const user = userEvent.setup();
    const manage = vi.fn();
    render(
      <ProjectPreviewMenu
        projectId={1}
        onOpenDefault={vi.fn()}
        onManage={manage}
        onBlank={vi.fn()}
      />,
    );
    await waitFor(() => expect(useDashboardStore.getState().projectPreviewConfigs[1]).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await user.click(screen.getByRole("menuitem", { name: /Docker web/ }));
    await waitFor(() =>
      expect(useDashboardStore.getState().openPreviewRequest).toMatchObject({
        slug: "named-web",
        targetName: "Docker web",
        branch: null,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await user.click(screen.getByRole("menuitem", { name: "Manage previews…" }));
    expect(manage).toHaveBeenCalledTimes(1);
  });

  it("offers the same default, named and blank choices without a Dock", async () => {
    const open = vi.fn();
    const blank = vi.fn();
    const manage = vi.fn();
    const user = userEvent.setup();
    useDashboardStore.getState().requestPreviewPicker(1);
    render(<ProjectPreviewPicker onOpenDefault={open} onBlank={blank} onManage={manage} />);
    await user.click(await screen.findByRole("button", { name: /Dev server — 3005/ }));
    expect(open).toHaveBeenCalledWith(1);
    expect(useDashboardStore.getState().previewPickerProjectId).toBeNull();
  });

  it("updates the default menu choice when a detected port is accepted", async () => {
    vi.mocked(api.getProjectPreviewTargets).mockResolvedValue({ devServerUrl: null, targets: [] });
    useDashboardStore.setState({ projects: [makeProject({ id: 1, devServerUrl: null })] });
    const user = userEvent.setup();
    const open = vi.fn();
    render(<ProjectPreviewMenu projectId={1} onOpenDefault={open} onManage={vi.fn()} />);
    await waitFor(() => expect(useDashboardStore.getState().projectPreviewConfigs[1]).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(
      screen.getByRole("menuitem", { name: "No preview targets configured" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    useDashboardStore.setState({ projects: [makeProject({ id: 1, devServerUrl: "5173" })] });
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await user.click(screen.getByRole("menuitem", { name: "Dev server — 5173" }));
    expect(open).toHaveBeenCalledTimes(1);
  });
});
