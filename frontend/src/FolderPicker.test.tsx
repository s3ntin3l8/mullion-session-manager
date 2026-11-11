// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FolderPicker } from "./FolderPicker.js";
import { api } from "./api/index.js";
import type { DirectoryListing } from "./api/fs.js";

vi.mock("./api/index.js", () => ({ api: { listDirectories: vi.fn() } }));

beforeEach(() => {
  vi.mocked(api.listDirectories).mockReset();
});

describe("FolderPicker", () => {
  it("hides dot folders until requested and keeps that choice while navigating", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listDirectories).mockImplementation(async (path, opts) => ({
      path,
      parent: null,
      directories: opts?.hidden ? [{ name: ".config", path: `${path}/.config` }] : [],
      truncated: false,
    }));
    render(<FolderPicker initialPath="/home" onSelect={vi.fn()} onClose={vi.fn()} />);
    await screen.findByText("No subfolders.");
    expect(screen.queryByRole("button", { name: ".config/" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Show hidden folders" }));
    await user.click(await screen.findByRole("button", { name: ".config/" }));
    expect(await screen.findByRole("button", { name: ".config/" })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Show hidden folders" })).toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "Show hidden folders" }));
    await screen.findByText("No subfolders.");
    expect(screen.queryByRole("button", { name: ".config/" })).not.toBeInTheDocument();
    expect(api.listDirectories).toHaveBeenCalledWith("/home", { hidden: true });
  });

  it.each([true, false])(
    "focuses a useful destination after keyboard navigation (has rows: %s)",
    async (hasRows) => {
      const user = userEvent.setup();
      vi.mocked(api.listDirectories).mockImplementation(async (path) => ({
        path,
        parent: null,
        directories:
          path === "/home"
            ? [{ name: "repo", path: "/home/repo" }]
            : hasRows
              ? [{ name: "child", path: "/home/repo/child" }]
              : [],
        truncated: false,
      }));
      render(<FolderPicker initialPath="/home" onSelect={vi.fn()} onClose={vi.fn()} />);
      await screen.findByRole("button", { name: "repo/" });
      expect(screen.getByRole("button", { name: "Close picker" })).toHaveFocus();
      await user.tab();
      await user.tab();
      expect(screen.getByRole("button", { name: "repo/" })).toHaveFocus();
      await user.keyboard("{Enter}");
      const destination = await screen.findByRole("button", {
        name: hasRows ? "child/" : "Select this folder",
      });
      expect(destination).toHaveFocus();
    },
  );

  it("does not steal focus if the user moves while the next folder loads", async () => {
    const user = userEvent.setup();
    let resolveListing!: (listing: DirectoryListing) => void;
    vi.mocked(api.listDirectories)
      .mockResolvedValueOnce({
        path: "/home",
        parent: null,
        directories: [{ name: "repo", path: "/home/repo" }],
        truncated: false,
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveListing = resolve;
          }),
      );
    render(<FolderPicker initialPath="/home" onSelect={vi.fn()} onClose={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "repo/" }));
    await user.tab();
    const toggle = screen.getByRole("checkbox", { name: "Show hidden folders" });
    expect(toggle).toHaveFocus();
    await act(async () =>
      resolveListing({ path: "/home/repo", parent: null, directories: [], truncated: false }),
    );
    expect(toggle).toHaveFocus();
  });
});
