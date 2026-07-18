// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "./CommandPalette.js";
import { useDashboardStore } from "./store.js";
import type { Project } from "./api.js";

// Issue #27: the palette's "Integrations" section — a GitHub-panel shortcut
// for the current project plus a link into Settings -> Integrations.

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const PROJECT: Project = {
  id: 5,
  name: "tessera",
  cwd: "/home/x/tessera",
  hostId: "local",
  devServerUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("CommandPalette -> Integrations section", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(200, []))),
    );
    useDashboardStore.setState({ projects: [PROJECT], sessions: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens the GitHub panel for the current project", async () => {
    const onOpenGitHub = vi.fn();
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onLaunched={vi.fn()}
        onOpenGitHub={onOpenGitHub}
        onOpenBrowser={vi.fn()}
        onOpenUrlModal={vi.fn()}
        onOpenIntegrationsSettings={vi.fn()}
      />,
    );

    await user.click(await screen.findByText(/GitHub: tessera/));
    expect(onOpenGitHub).toHaveBeenCalledWith(PROJECT.id);
  });

  it("opens the browser preview panel for the current project", async () => {
    const onOpenBrowser = vi.fn();
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onLaunched={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenBrowser={onOpenBrowser}
        onOpenUrlModal={vi.fn()}
        onOpenIntegrationsSettings={vi.fn()}
      />,
    );

    await user.click(await screen.findByText(/Preview: tessera/));
    expect(onOpenBrowser).toHaveBeenCalledWith(PROJECT.id);
  });

  it("opens the URL modal (issue #28's general-purpose browser tile)", async () => {
    const onOpenUrlModal = vi.fn();
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onLaunched={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenUrlModal={onOpenUrlModal}
        onOpenIntegrationsSettings={vi.fn()}
      />,
    );

    await user.click(await screen.findByText("Open URL…"));
    expect(onOpenUrlModal).toHaveBeenCalled();
  });

  it("shows the Open URL row even in global scope (project-independent)", async () => {
    const onOpenUrlModal = vi.fn();
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="global"
        projectId={null}
        onClose={vi.fn()}
        onLaunched={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenUrlModal={onOpenUrlModal}
        onOpenIntegrationsSettings={vi.fn()}
      />,
    );

    await user.click(await screen.findByText("Open URL…"));
    expect(onOpenUrlModal).toHaveBeenCalled();
  });

  it("opens Settings -> Integrations", async () => {
    const onOpenIntegrationsSettings = vi.fn();
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onLaunched={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenUrlModal={vi.fn()}
        onOpenIntegrationsSettings={onOpenIntegrationsSettings}
      />,
    );

    await user.click(await screen.findByText("Manage integrations…"));
    expect(onOpenIntegrationsSettings).toHaveBeenCalled();
  });

  it("hides the Integrations section while mid-search", async () => {
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onLaunched={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenUrlModal={vi.fn()}
        onOpenIntegrationsSettings={vi.fn()}
      />,
    );

    await screen.findByText("Manage integrations…");
    await user.type(screen.getByPlaceholderText(/Launch a session/), "bash");
    expect(screen.queryByText("Manage integrations…")).not.toBeInTheDocument();
  });
});
