// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DuplicateProjectsBanner } from "./DuplicateProjectsBanner.js";
import { useDashboardStore } from "../../store/index.js";
import { api, ApiError } from "../../api/index.js";
import type { DuplicateGroup } from "../../api/index.js";
import type * as ApiModule from "../../api/index.js";

vi.mock("../../api/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: { ...actual.api, getProjectDuplicates: vi.fn(), mergeProject: vi.fn() },
  };
});

const counts = { tasks: 5, liveTasks: 1, sessions: 3, runningSessions: 2, previews: 1 };
const group: DuplicateGroup = {
  origin: "github.com/acme/app",
  survivor: { id: 19, name: "app", hostId: "local", cwd: "/a", createdAt: "2024-01-01" },
  duplicates: [
    {
      id: 30,
      name: "app-mac",
      hostId: "mac",
      cwd: "/m",
      createdAt: "2025-01-01",
      counts,
      refusal: null,
    },
  ],
};

describe("DuplicateProjectsBanner", () => {
  const refreshProjects = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    refreshProjects.mockClear();
    vi.mocked(api.getProjectDuplicates)
      .mockReset()
      .mockResolvedValue({ groups: [group] });
    vi.mocked(api.mergeProject).mockReset();
    useDashboardStore.setState({
      refreshProjects,
      hosts: [{ id: "mac", name: "macbook" }] as never,
    });
  });

  async function check() {
    const user = userEvent.setup();
    render(<DuplicateProjectsBanner />);
    // Loads on mount; wait for the first answer so Check is enabled again.
    await waitFor(() => expect(screen.getByRole("button", { name: "Check" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Check" }));
    return user;
  }

  function open() {
    render(<DuplicateProjectsBanner />);
    return userEvent.setup();
  }

  it("lists duplicates on mount without a click, using the cached read", async () => {
    render(<DuplicateProjectsBanner />);
    expect(await screen.findByTestId("duplicate-projects")).toBeInTheDocument();
    expect(api.getProjectDuplicates).toHaveBeenCalledWith();
  });

  it("names each project's host in the row, the button and the confirm", async () => {
    const user = userEvent.setup();
    render(<DuplicateProjectsBanner />);
    expect(
      await screen.findByText("#30 · macbook · /m → #19 · this machine · /a"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Merge into #19 (this machine)" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("#30 app-mac (macbook)");
    expect(dialog).toHaveTextContent("#19 app (this machine)");
    expect(dialog).toHaveTextContent("deletes #30 (macbook)");
    expect(dialog).toHaveTextContent("“Also lives on” checkout of #19");
    expect(dialog).toHaveTextContent("cannot be undone");
  });

  it("re-reads the counts when the confirm opens", async () => {
    const user = open();
    await user.click(await screen.findByRole("button", { name: "Merge into #19 (this machine)" }));
    await waitFor(() =>
      expect(api.getProjectDuplicates).toHaveBeenLastCalledWith({ refresh: true }),
    );
  });

  it("falls back to the host id when the host is unknown", async () => {
    useDashboardStore.setState({ hosts: [] });
    render(<DuplicateProjectsBanner />);
    expect(await screen.findByText("#30 · mac · /m → #19 · this machine · /a")).toBeInTheDocument();
  });

  it("Check forces a fresh read", async () => {
    vi.mocked(api.getProjectDuplicates).mockResolvedValue({ groups: [] });
    await check();
    expect(api.getProjectDuplicates).toHaveBeenLastCalledWith({ refresh: true });
  });

  it("says so when there are none", async () => {
    vi.mocked(api.getProjectDuplicates).mockResolvedValue({ groups: [] });
    await check();
    expect(await screen.findByText("No duplicates found")).toBeInTheDocument();
  });

  it("says so when the lookup fails", async () => {
    vi.mocked(api.getProjectDuplicates).mockRejectedValue(new Error("down"));
    await check();
    expect(await screen.findByText("Check failed")).toBeInTheDocument();
  });

  it("counts what moves in the confirm, merges, and refreshes the project list", async () => {
    vi.mocked(api.mergeProject).mockResolvedValue({ survivor: {} as never, counts });
    const user = open();
    await user.click(await screen.findByRole("button", { name: "Merge into #19 (this machine)" }));

    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("5 tasks (1 live), 2 active sessions, 1 preview");

    vi.mocked(api.getProjectDuplicates).mockResolvedValue({ groups: [] });
    await user.click(screen.getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(api.mergeProject).toHaveBeenCalledWith(30, 19));
    await waitFor(() => expect(refreshProjects).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("duplicate-projects")).toBeNull());
    expect(await screen.findByText("No duplicates found")).toBeInTheDocument();
  });

  it("shows the server's message when the merge is refused", async () => {
    vi.mocked(api.mergeProject).mockRejectedValue(new ApiError("Stop one first.", 409));
    const user = open();
    await user.click(await screen.findByRole("button", { name: "Merge into #19 (this machine)" }));
    await user.click(screen.getByRole("button", { name: "Merge" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Stop one first.");
    expect(refreshProjects).not.toHaveBeenCalled();
  });

  it("cancel closes the confirm without merging", async () => {
    const user = open();
    await user.click(await screen.findByRole("button", { name: "Merge into #19 (this machine)" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(api.mergeProject).not.toHaveBeenCalled();
  });

  it("disables a refused entry and shows why", async () => {
    vi.mocked(api.getProjectDuplicates).mockResolvedValue({
      groups: [
        {
          ...group,
          duplicates: [
            {
              ...group.duplicates[0],
              refusal: { code: "SAME_HOST", message: "Both projects live on the same host." },
            },
          ],
        },
      ],
    });
    open();
    expect(await screen.findByText("Both projects live on the same host.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge into #19 (this machine)" })).toBeDisabled();
  });
});
