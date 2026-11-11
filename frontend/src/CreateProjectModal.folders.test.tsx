// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateProjectModal } from "./CreateProjectModal.js";
import { useDashboardStore } from "./store/index.js";
import { DEFAULT_SETTINGS } from "./api/index.js";
import { api } from "./api/index.js";
import { makeHost } from "./test/fixtures.js";
import type * as ApiModule from "./api/index.js";

vi.mock("./api/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listDirectories: vi.fn(),
      listProjectActions: vi.fn(),
      recheckReleasePlease: vi.fn(),
      getPlacementPreview: vi.fn(),
      previewPlacement: vi.fn(),
      getHostSuggestions: vi.fn(),
      listProjects: vi.fn(),
      getProject: vi.fn(),
      attachHostCheckout: vi.fn(),
    },
  };
});

// Both dropdowns share the same detected-launcher options, so a page-wide
// role/label query is ambiguous — scope to the specific field's own <select>
// via its field-label span, same .closest()+querySelector precedent
// Settings.sessions.test.tsx already uses for disambiguating repeated rows.
function fieldSelect(labelText: string): HTMLSelectElement {
  return screen
    .getByText(labelText, { selector: ".create-modal-field-label" })
    .closest(".create-modal-field")!
    .querySelector("select")!;
}

beforeEach(() => {
  vi.mocked(api.listDirectories).mockReset();
  vi.mocked(api.listProjectActions).mockReset();
  vi.mocked(api.getPlacementPreview).mockReset();
  vi.mocked(api.previewPlacement).mockReset();
  vi.mocked(api.getHostSuggestions).mockReset();
  vi.mocked(api.listProjects).mockReset();
  vi.mocked(api.getProject).mockReset();
  // Default answers, so a test that renders the modal without caring about
  // one of these fetches still has a promise to await (the hook calls
  // .then() on whatever the fetcher returns).
  vi.mocked(api.listProjectActions).mockResolvedValue([]);
  vi.mocked(api.getHostSuggestions).mockResolvedValue({ hosts: [] });
  vi.mocked(api.listProjects).mockResolvedValue([]);
  const preview = {
    placement: "auto" as const,
    hostId: "local",
    reason: "the only eligible host",
    considered: [],
    excluded: [],
    fellBack: false,
  };
  vi.mocked(api.getPlacementPreview).mockResolvedValue(preview);
  vi.mocked(api.previewPlacement).mockResolvedValue(preview);
});

describe("CreateProjectModal folder picker", () => {
  it.each([
    { roots: ["/configured"], expected: "/configured" },
    { roots: [], expected: "~" },
  ])("falls back to $expected when the path field is empty", async ({ roots, expected }) => {
    const previous = useDashboardStore.getState().settings;
    useDashboardStore.setState({ settings: { ...DEFAULT_SETTINGS, projectRoots: roots } });
    vi.mocked(api.listDirectories).mockResolvedValue({
      path: "/resolved",
      parent: "/",
      directories: [],
      truncated: true,
    });
    try {
      const user = userEvent.setup();
      render(<CreateProjectModal onClose={vi.fn()} onCreate={vi.fn()} />);
      await user.click(screen.getByRole("button", { name: "Browse…" }));
      expect(api.listDirectories).toHaveBeenCalledWith(expected, { hidden: false });
      expect(await screen.findByText(/too large to show every entry/)).toBeVisible();
    } finally {
      useDashboardStore.setState({ settings: previous });
    }
  });

  it("opens Browse with a pre-filled path, descends, navigates up and selects a folder", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listDirectories).mockImplementation(async (path) => ({
      path,
      parent: path === "/projects" ? "/" : "/projects",
      directories: path === "/projects" ? [{ name: "my-repo", path: "/projects/my-repo" }] : [],
      truncated: false,
    }));
    render(<CreateProjectModal initialPath="/projects" onClose={vi.fn()} onCreate={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Browse…" }));
    expect(await screen.findByRole("region", { name: "Choose repository folder" })).toBeVisible();
    expect(api.listDirectories).toHaveBeenCalledWith("/projects", { hidden: false });
    await user.click(await screen.findByRole("button", { name: "my-repo/" }));
    await screen.findByText("No subfolders.");
    expect(screen.getByRole("button", { name: /Up one folder/ })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: /Up one folder/ }));
    await user.click(await screen.findByRole("button", { name: "my-repo/" }));
    await screen.findByText("No subfolders.");
    await user.click(screen.getByRole("button", { name: "Select this folder" }));
    expect(screen.getByPlaceholderText("~/code/my-project")).toHaveValue("/projects/my-repo");
    expect(screen.getByPlaceholderText("my-repo")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("my-repo"), "custom-name");
    expect(screen.getByPlaceholderText("~/code/my-project")).toHaveValue("/projects/my-repo");
    expect(
      screen.queryByRole("region", { name: "Choose repository folder" }),
    ).not.toBeInTheDocument();
  });

  it("disables Browse when a remote host is selected", async () => {
    const user = userEvent.setup();
    render(
      <CreateProjectModal
        hosts={[makeHost({ id: "remote", name: "Remote", isLocal: false })]}
        onClose={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    await user.selectOptions(fieldSelect("Host"), "remote");
    expect(screen.getByRole("button", { name: "Browse…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Browse…" })).toHaveAttribute(
      "title",
      expect.stringContaining("remote hosts"),
    );
    expect(api.listDirectories).not.toHaveBeenCalled();
  });

  it("keeps the picker closed after switching away from the local host and back", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listDirectories).mockResolvedValue({
      path: "/projects",
      parent: "/",
      directories: [],
      truncated: false,
    });
    render(
      <CreateProjectModal
        hosts={[makeHost({ id: "remote", name: "Remote", isLocal: false })]}
        onClose={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Browse…" }));
    await screen.findByRole("button", { name: "Select this folder" });
    await user.selectOptions(fieldSelect("Host"), "remote");
    await user.selectOptions(fieldSelect("Host"), "local");
    expect(screen.getByRole("button", { name: "Browse…" })).toBeEnabled();
    expect(
      screen.queryByRole("region", { name: "Choose repository folder" }),
    ).not.toBeInTheDocument();
  });

  it.each(["", "/missing"])("shows listing errors for start path %s", async (initialPath) => {
    const user = userEvent.setup();
    vi.mocked(api.listDirectories).mockRejectedValue(new Error("Folder is unreadable"));
    render(<CreateProjectModal initialPath={initialPath} onClose={vi.fn()} onCreate={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Browse…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Folder is unreadable");
    expect(screen.queryByRole("button", { name: "Select this folder" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close picker" }));
    expect(screen.getByPlaceholderText("~/code/my-project")).toHaveFocus();
    expect(
      screen.queryByRole("region", { name: "Choose repository folder" }),
    ).not.toBeInTheDocument();
  });
});
