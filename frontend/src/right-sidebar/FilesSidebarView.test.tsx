// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilesSidebarView } from "./FilesSidebarView.js";
import { api, ApiError } from "../api/index.js";
import type * as ApiModule from "../api/index.js";
import type { ProjectDirEntry } from "../api/index.js";
import { makeProject, makeSession } from "../test/fixtures.js";
import { resetStore } from "../test/resetStore.js";
import { useDashboardStore } from "../store/index.js";
import { setFileDirty } from "../lib/dirtyFiles.js";
import { subscribeFilePathGone, type FilePathGone } from "../lib/filePathEvents.js";
import { activeFileDrag, endFileDrag } from "../lib/fileDrag.js";

vi.mock("../api/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listProjectFiles: vi.fn(),
      writeProjectFile: vi.fn(),
      mkdirProjectDir: vi.fn(),
      uploadProjectFile: vi.fn(),
      renameProjectPath: vi.fn(),
      deleteProjectPath: vi.fn(),
    },
  };
});

const actions = {
  onOpenGit: vi.fn(),
  onOpenGitHub: vi.fn(),
  onOpenFileEditor: vi.fn(),
  onOpenFile: vi.fn(),
  onOpenAgentRules: vi.fn(),
  onOpenProjectBriefing: vi.fn(),
  onOpenProjectSetup: vi.fn(),
  onOpenDockConfig: vi.fn(),
  onOpenSkills: vi.fn(),
};

const entry = (name: string, kind: ProjectDirEntry["kind"], over = {}): ProjectDirEntry => ({
  name,
  kind,
  size: 0,
  ...over,
});

const LISTINGS: Record<string, ProjectDirEntry[]> = {
  "": [
    entry("src", "dir"),
    entry("node_modules", "dir"),
    entry(".git", "dir"),
    entry("README.md", "file"),
    entry("escape", "symlink", { targetKind: "outside" }),
  ],
  src: [entry("index.ts", "file")],
};

beforeEach(() => {
  vi.mocked(api.listProjectFiles).mockImplementation(async (_id, path = "") => ({
    path,
    entries: LISTINGS[path] ?? [],
    truncated: path === "src",
  }));
});

afterEach(() => {
  vi.clearAllMocks();
});

const renderView = () => render(<FilesSidebarView projectId={4} actions={actions} />);

describe("FilesSidebarView", () => {
  it("lists the root and hides noise directories", async () => {
    renderView();
    expect(await screen.findByText("README.md")).toBeTruthy();
    expect(screen.getByText("src")).toBeTruthy();
    expect(screen.queryByText("node_modules")).toBeNull();
    expect(screen.queryByText(".git")).toBeNull();
    expect(api.listProjectFiles).toHaveBeenCalledWith(4, "", undefined);
  });

  it("lazily loads a folder when expanded and collapses it again", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByText("src"));
    expect(await screen.findByText("index.ts")).toBeTruthy();
    expect(screen.getByText("…list truncated")).toBeTruthy();
    expect(api.listProjectFiles).toHaveBeenCalledWith(4, "src", undefined);
    await user.click(screen.getByText("src"));
    expect(screen.queryByText("index.ts")).toBeNull();
    // Re-expanding reuses the loaded listing.
    await user.click(screen.getByText("src"));
    expect(await screen.findByText("index.ts")).toBeTruthy();
    expect(api.listProjectFiles).toHaveBeenCalledTimes(2);
  });

  it("opens a clicked file via onOpenFile with its project-relative path", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByText("src"));
    await user.click(await screen.findByText("index.ts"));
    expect(actions.onOpenFile).toHaveBeenCalledWith(4, "src/index.ts", undefined);
  });

  it("disables a symlink that points outside the project", async () => {
    renderView();
    const row = (await screen.findByText("escape")).closest("button");
    expect(row?.disabled).toBe(true);
  });

  it("refresh re-lists open folders and the panel button calls the opener", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByText("src"));
    await screen.findByText("index.ts");
    vi.mocked(api.listProjectFiles).mockClear();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(api.listProjectFiles).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Open file browser panel" }));
    expect(actions.onOpenFileEditor).toHaveBeenCalledWith(4);
  });

  it("New file creates in the selected folder, reloads it and opens the file", async () => {
    vi.mocked(api.writeProjectFile).mockResolvedValue({ size: 0, mtimeMs: 1 });
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByText("src"));
    await screen.findByText("index.ts");
    vi.mocked(api.listProjectFiles).mockClear();

    await user.click(screen.getByRole("button", { name: "New file in src" }));
    await user.type(screen.getByPlaceholderText("New file in src"), "new.ts{Enter}");

    await waitFor(() =>
      expect(api.writeProjectFile).toHaveBeenCalledWith(
        4,
        "src/new.ts",
        "",
        { create: true },
        undefined,
      ),
    );
    expect(api.listProjectFiles).toHaveBeenCalledWith(4, "src", undefined);
    expect(actions.onOpenFile).toHaveBeenCalledWith(4, "src/new.ts", undefined);
  });

  it("New folder creates in the root by default; Escape cancels; '/' is rejected", async () => {
    vi.mocked(api.mkdirProjectDir).mockResolvedValue(undefined as never);
    const user = userEvent.setup();
    renderView();
    await screen.findByText("README.md");

    await user.click(screen.getByRole("button", { name: "New folder in project root" }));
    await user.type(screen.getByPlaceholderText("New folder in /"), "a/b{Enter}");
    expect(await screen.findByText("A name can't contain '/'")).toBeTruthy();
    expect(api.mkdirProjectDir).not.toHaveBeenCalled();

    await user.clear(screen.getByPlaceholderText("New folder in /"));
    await user.type(screen.getByPlaceholderText("New folder in /"), "docs{Enter}");
    await waitFor(() => expect(api.mkdirProjectDir).toHaveBeenCalledWith(4, "docs", undefined));
    expect(actions.onOpenFile).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "New file in project root" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByPlaceholderText("New file in /")).toBeNull();
  });

  it("ignores a second Enter while a create is in flight", async () => {
    let finish: (v: { size: number; mtimeMs: number }) => void = () => {};
    vi.mocked(api.writeProjectFile).mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const user = userEvent.setup();
    renderView();
    await screen.findByText("README.md");
    await user.click(screen.getByRole("button", { name: "New file in project root" }));
    await user.type(screen.getByPlaceholderText("New file in /"), "x.ts{Enter}{Enter}");
    expect(api.writeProjectFile).toHaveBeenCalledTimes(1);
    finish({ size: 0, mtimeMs: 1 });
    await waitFor(() => expect(actions.onOpenFile).toHaveBeenCalledWith(4, "x.ts", undefined));
  });

  it("clicking a file moves the create target to that file's folder", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByText("src"));
    await user.click(await screen.findByText("index.ts"));
    expect(screen.getByRole("button", { name: "New file in src" })).toBeTruthy();
    await user.click(screen.getByText("README.md"));
    expect(screen.getByRole("button", { name: "New file in project root" })).toBeTruthy();
  });

  it("surfaces a create failure", async () => {
    vi.mocked(api.writeProjectFile).mockRejectedValue(new ApiError("Already exists", 409));
    const user = userEvent.setup();
    renderView();
    await screen.findByText("README.md");
    await user.click(screen.getByRole("button", { name: "New file in project root" }));
    await user.type(screen.getByPlaceholderText("New file in /"), "README.md{Enter}");
    expect(await screen.findByText("Already exists")).toBeTruthy();
  });

  it("drops a listing that resolves after the followed project changed", async () => {
    let resolveOld: (v: {
      path: string;
      entries: ProjectDirEntry[];
      truncated: boolean;
    }) => void = () => {};
    vi.mocked(api.listProjectFiles).mockImplementation((id) =>
      id === 4
        ? new Promise((r) => {
            resolveOld = r;
          })
        : Promise.resolve({ path: "", entries: [entry("new.md", "file")], truncated: false }),
    );
    const { rerender } = renderView();
    rerender(<FilesSidebarView projectId={5} actions={actions} />);
    expect(await screen.findByText("new.md")).toBeTruthy();

    resolveOld({ path: "", entries: [entry("stale.md", "file")], truncated: false });
    await Promise.resolve();

    expect(screen.queryByText("stale.md")).toBeNull();
    expect(screen.getByText("new.md")).toBeTruthy();
  });

  it("shows the API error message when listing fails", async () => {
    vi.mocked(api.listProjectFiles).mockRejectedValue(new ApiError("Nope", 403));
    renderView();
    expect(await screen.findByText("Nope")).toBeTruthy();
  });

  describe("upload", () => {
    const fileEntry = (name: string, file: File) => ({
      isFile: true,
      isDirectory: false,
      name,
      file: (cb: (f: File) => void) => cb(file),
    });
    const dropOf = (entries: unknown[], files: File[] = []) => ({
      dataTransfer: {
        types: ["Files"],
        files,
        items: entries.map((entry) => ({
          kind: "file",
          getAsFile: () => files[0] ?? null,
          webkitGetAsEntry: () => entry,
        })),
        dropEffect: "none",
      },
    });

    beforeEach(() => {
      vi.mocked(api.uploadProjectFile).mockResolvedValue({ path: "x", size: 1 });
    });

    it("uploads picked files into the project root and re-lists it", async () => {
      const user = userEvent.setup();
      renderView();
      await screen.findByText("README.md");
      const file = new File(["hi"], "notes.txt", { type: "text/plain" });
      await user.upload(screen.getByLabelText("Upload files"), file);
      await waitFor(() =>
        expect(api.uploadProjectFile).toHaveBeenCalledWith(
          4,
          "notes.txt",
          file,
          expect.objectContaining({ mkdirs: false }),
        ),
      );
      // listing refreshed after the batch
      await waitFor(() =>
        expect(vi.mocked(api.listProjectFiles).mock.calls.length).toBeGreaterThan(1),
      );
    });

    it("uploads into the folder last clicked", async () => {
      const user = userEvent.setup();
      renderView();
      await user.click(await screen.findByText("src"));
      const file = new File(["x"], "a.ts");
      await user.upload(screen.getByLabelText("Upload files"), file);
      await waitFor(() =>
        expect(api.uploadProjectFile).toHaveBeenCalledWith(4, "src/a.ts", file, expect.anything()),
      );
    });

    it("sends a picked folder's files with their relative paths and mkdirs", async () => {
      const user = userEvent.setup();
      renderView();
      await screen.findByText("README.md");
      const file = new File(["x"], "deep.txt");
      Object.defineProperty(file, "webkitRelativePath", { value: "pics/2024/deep.txt" });
      await user.upload(screen.getByLabelText("Upload folder"), file);
      await waitFor(() =>
        expect(api.uploadProjectFile).toHaveBeenCalledWith(
          4,
          "pics/2024/deep.txt",
          file,
          expect.objectContaining({ mkdirs: true }),
        ),
      );
    });

    it("shows 'already exists' for a refused name and keeps going", async () => {
      vi.mocked(api.uploadProjectFile).mockImplementation(async (_id, path) => {
        if (path === "a.txt") throw new ApiError("exists", 409, "conflict");
        return { path, size: 1 };
      });
      const user = userEvent.setup();
      renderView();
      await screen.findByText("README.md");
      const a = new File(["1"], "a.txt");
      const b = new File(["2"], "b.txt");
      await user.upload(screen.getByLabelText("Upload files"), [a, b]);
      expect(await screen.findByText("a.txt already exists")).toBeTruthy();
      expect(api.uploadProjectFile).toHaveBeenCalledWith(4, "b.txt", b, expect.anything());
    });

    it("uploads a file dropped on a folder row into that folder", async () => {
      renderView();
      const row = (await screen.findByText("src")).closest("button") as HTMLElement;
      const file = new File(["d"], "d.txt");
      fireEvent.dragOver(row, dropOf([fileEntry("d.txt", file)], [file]));
      expect(row.className).toContain("file-drop-target");
      fireEvent.drop(row, dropOf([fileEntry("d.txt", file)], [file]));
      await waitFor(() =>
        expect(api.uploadProjectFile).toHaveBeenCalledWith(4, "src/d.txt", file, expect.anything()),
      );
      expect(row.className).not.toContain("file-drop-target");
    });

    it("uploads a dropped folder tree under the drop target", async () => {
      renderView();
      await screen.findByText("README.md");
      const inner = new File(["i"], "inner.txt");
      const dirEntry = {
        isFile: false,
        isDirectory: true,
        name: "assets",
        createReader: () => {
          let served = false;
          return {
            readEntries: (cb: (e: unknown[]) => void) => {
              const batch = served ? [] : [fileEntry("inner.txt", inner)];
              served = true;
              // like the real API, answer asynchronously
              queueMicrotask(() => cb(batch));
            },
          };
        },
      };
      const root = document.querySelector(".files-sidebar-view") as HTMLElement;
      fireEvent.drop(root, dropOf([dirEntry]));
      await waitFor(() =>
        expect(api.uploadProjectFile).toHaveBeenCalledWith(
          4,
          "assets/inner.txt",
          inner,
          expect.objectContaining({ mkdirs: true }),
        ),
      );
    });

    it("ignores drags that carry no files", async () => {
      renderView();
      const row = (await screen.findByText("src")).closest("button") as HTMLElement;
      fireEvent.drop(row, { dataTransfer: { types: ["text/plain"], items: [], files: [] } });
      expect(api.uploadProjectFile).not.toHaveBeenCalled();
    });
  });

  // ---- the followed session's checkout, the row menu, and drag ----------------

  const fakeDt = () => {
    const data = new Map<string, string>();
    return {
      setData: (k: string, v: string) => void data.set(k, v),
      getData: (k: string) => data.get(k) ?? "",
      get types() {
        return [...data.keys()];
      },
      dropEffect: "none",
      effectAllowed: "all",
      items: [],
      files: [],
    };
  };
  const rowOf = (name: string) =>
    screen.getByText(name).closest(".file-editor-rowwrap") as HTMLElement;
  const menuOf = (name: string) =>
    within(rowOf(name)).getByRole("button", { name: `Actions for ${name}` });

  describe("worktree session checkout", () => {
    beforeEach(() => {
      resetStore({
        projects: [makeProject({ id: 4, cwd: "/work/app" })],
        sessions: [
          makeSession({ id: 9, projectId: 4, cwd: "/work/app/.mullion-worktrees/feat-x" }),
        ],
      });
    });

    it("lists the session's checkout, labels it, and opens files in it", async () => {
      const user = userEvent.setup();
      render(<FilesSidebarView projectId={4} checkoutSessionId={9} actions={actions} />);
      await screen.findByText("README.md");
      expect(api.listProjectFiles).toHaveBeenCalledWith(4, "", 9);
      expect(screen.getByText("Worktree: feat-x")).toBeTruthy();
      await user.click(screen.getByText("README.md"));
      expect(actions.onOpenFile).toHaveBeenCalledWith(4, "README.md", 9);
    });

    it("flips to the project root and back", async () => {
      const user = userEvent.setup();
      render(<FilesSidebarView projectId={4} checkoutSessionId={9} actions={actions} />);
      await screen.findByText("README.md");
      await user.click(screen.getByRole("button", { name: "Show project root" }));
      await waitFor(() => expect(api.listProjectFiles).toHaveBeenLastCalledWith(4, "", undefined));
      expect(screen.getByText("Project root")).toBeTruthy();
      await user.click(screen.getByRole("button", { name: "Show worktree" }));
      await waitFor(() => expect(api.listProjectFiles).toHaveBeenLastCalledWith(4, "", 9));
    });

    it("falls back to the project root, and says so, when the backend refuses the worktree", async () => {
      vi.mocked(api.listProjectFiles).mockImplementation(async (_id, path = "", sid) => {
        if (sid !== undefined) throw new ApiError("outside the project", 400);
        return { path, entries: LISTINGS[path] ?? [], truncated: false };
      });
      render(<FilesSidebarView projectId={4} checkoutSessionId={9} actions={actions} />);
      expect(await screen.findByText("README.md")).toBeTruthy();
      expect(screen.getByText(/this worktree can't be browsed here/)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Show worktree" })).toBeNull();
    });

    it("forgets the override when a different session is followed", async () => {
      const user = userEvent.setup();
      const { rerender } = render(
        <FilesSidebarView projectId={4} checkoutSessionId={9} actions={actions} />,
      );
      await screen.findByText("README.md");
      await user.click(screen.getByRole("button", { name: "Show project root" }));
      rerender(<FilesSidebarView projectId={4} checkoutSessionId={10} actions={actions} />);
      await waitFor(() => expect(api.listProjectFiles).toHaveBeenLastCalledWith(4, "", 10));
    });

    it("shows no chip for a session in the project's own checkout", async () => {
      render(<FilesSidebarView projectId={4} checkoutSessionId={null} actions={actions} />);
      await screen.findByText("README.md");
      expect(screen.queryByText(/Worktree:/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Show project root" })).toBeNull();
    });
  });

  describe("row menu", () => {
    beforeEach(() => {
      resetStore({ projects: [makeProject({ id: 4, cwd: "/work/app" })], sessions: [] });
      vi.mocked(api.renameProjectPath).mockResolvedValue({ path: "x" });
      vi.mocked(api.deleteProjectPath).mockResolvedValue({ path: "x" });
    });

    it("offers file actions: open, download, copy paths, rename, delete", async () => {
      const user = userEvent.setup();
      renderView();
      await screen.findByText("README.md");
      await user.click(menuOf("README.md"));
      const items = screen.getAllByRole("menuitem").map((i) => i.textContent);
      expect(items).toEqual([
        "Open",
        "Download",
        "Copy relative path",
        "Copy absolute path",
        "Rename",
        "Delete",
      ]);
      await user.click(screen.getByRole("menuitem", { name: "Open" }));
      expect(actions.onOpenFile).toHaveBeenCalledWith(4, "README.md", undefined);
    });

    it("offers folder actions", async () => {
      const user = userEvent.setup();
      renderView();
      await screen.findByText("src");
      await user.click(menuOf("src"));
      expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
        "Upload files here",
        "Upload a folder here",
        "New file here",
        "New folder here",
        "Copy relative path",
        "Copy absolute path",
        "Rename",
        "Delete",
      ]);
    });

    it("copies the relative and the absolute path, with a toast", async () => {
      const user = userEvent.setup(); // installs its own clipboard stub: replace it after
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true,
      });
      renderView();
      await user.click(await screen.findByText("src"));
      await user.click(await screen.findByText("index.ts"));
      await user.click(menuOf("index.ts"));
      await user.click(screen.getByRole("menuitem", { name: "Copy relative path" }));
      expect(writeText).toHaveBeenLastCalledWith("src/index.ts");
      await user.click(menuOf("index.ts"));
      await user.click(screen.getByRole("menuitem", { name: "Copy absolute path" }));
      expect(writeText).toHaveBeenLastCalledWith("/work/app/src/index.ts");
      expect(useDashboardStore.getState().toasts.some((t) => t.message === "Path copied")).toBe(
        true,
      );
    });

    it("reports a clipboard that refuses", async () => {
      const user = userEvent.setup();
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
        configurable: true,
      });
      renderView();
      await screen.findByText("README.md");
      await user.click(menuOf("README.md"));
      await user.click(screen.getByRole("menuitem", { name: "Copy relative path" }));
      expect(await screen.findByText("Couldn't copy to the clipboard")).toBeTruthy();
    });

    it("right-click opens the same menu", async () => {
      renderView();
      await screen.findByText("README.md");
      fireEvent.contextMenu(rowOf("README.md"));
      expect(await screen.findByRole("menuitem", { name: "Download" })).toBeTruthy();
    });

    it("downloads through a temporary link to the download URL", async () => {
      const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
      const user = userEvent.setup();
      renderView();
      await screen.findByText("README.md");
      await user.click(menuOf("README.md"));
      await user.click(screen.getByRole("menuitem", { name: "Download" }));
      expect(click).toHaveBeenCalledTimes(1);
      expect(click.mock.instances[0]).toHaveProperty(
        "href",
        expect.stringContaining("/api/projects/4/files/download?path=README.md"),
      );
      click.mockRestore();
    });

    it("renames inline, then announces the old path as gone", async () => {
      const gone: FilePathGone[] = [];
      const off = subscribeFilePathGone((e) => gone.push(e));
      const user = userEvent.setup();
      renderView();
      await screen.findByText("README.md");
      await user.click(menuOf("README.md"));
      await user.click(screen.getByRole("menuitem", { name: "Rename" }));
      const input = screen.getByRole("textbox", { name: "Rename README.md" });
      await user.clear(input);
      await user.type(input, "NOTES.md{Enter}");
      await waitFor(() =>
        expect(api.renameProjectPath).toHaveBeenCalledWith(4, "README.md", "NOTES.md", undefined),
      );
      expect(gone).toEqual([{ projectId: 4, sessionId: undefined, path: "README.md" }]);
      off();
    });

    it("shows a rename clash and keeps going; Escape cancels", async () => {
      vi.mocked(api.renameProjectPath).mockRejectedValueOnce(new ApiError("x", 409, "conflict"));
      const user = userEvent.setup();
      renderView();
      await screen.findByText("README.md");
      await user.click(menuOf("README.md"));
      await user.click(screen.getByRole("menuitem", { name: "Rename" }));
      const input = screen.getByRole("textbox", { name: "Rename README.md" });
      await user.clear(input);
      await user.type(input, "src{Enter}");
      expect(await screen.findByText("src already exists in the project root")).toBeTruthy();
      await user.click(menuOf("README.md"));
      await user.click(screen.getByRole("menuitem", { name: "Rename" }));
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("textbox", { name: "Rename README.md" })).toBeNull();
    });

    it("deletes after a second click and announces the path gone", async () => {
      const gone: FilePathGone[] = [];
      const off = subscribeFilePathGone((e) => gone.push(e));
      const user = userEvent.setup();
      renderView();
      await screen.findByText("README.md");
      await user.click(menuOf("README.md"));
      await user.click(screen.getByRole("menuitem", { name: "Delete" }));
      expect(api.deleteProjectPath).not.toHaveBeenCalled();
      await user.click(screen.getByRole("menuitem", { name: /Click again to delete/ }));
      await waitFor(() =>
        expect(api.deleteProjectPath).toHaveBeenCalledWith(4, "README.md", undefined),
      );
      expect(gone).toEqual([{ projectId: 4, sessionId: undefined, path: "README.md" }]);
      off();
    });

    it("explains a folder that can't be deleted", async () => {
      vi.mocked(api.deleteProjectPath).mockRejectedValueOnce(new ApiError("x", 409, "not_empty"));
      const user = userEvent.setup();
      renderView();
      await screen.findByText("src");
      await user.click(menuOf("src"));
      await user.click(screen.getByRole("menuitem", { name: "Delete" }));
      await user.click(screen.getByRole("menuitem", { name: /Click again to delete/ }));
      expect(
        await screen.findByText("src isn't empty — only empty folders can be deleted"),
      ).toBeTruthy();
    });

    it("refuses rename/delete of a file with unsaved edits in an editor", async () => {
      setFileDirty(4, undefined, "README.md", true);
      const user = userEvent.setup();
      renderView();
      await screen.findByText("README.md");
      await user.click(menuOf("README.md"));
      expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      await user.click(screen.getByRole("menuitem", { name: "Delete" }));
      expect(api.deleteProjectPath).not.toHaveBeenCalled();
      act(() => setFileDirty(4, undefined, "README.md", false));
    });

    it("'New file here' creates inside that folder", async () => {
      vi.mocked(api.writeProjectFile).mockResolvedValue({ size: 0, mtimeMs: 1 });
      const user = userEvent.setup();
      renderView();
      await screen.findByText("src");
      await user.click(menuOf("src"));
      await user.click(screen.getByRole("menuitem", { name: "New file here" }));
      await user.type(screen.getByPlaceholderText("New file in src"), "z.ts{Enter}");
      await waitFor(() =>
        expect(api.writeProjectFile).toHaveBeenCalledWith(
          4,
          "src/z.ts",
          "",
          { create: true },
          undefined,
        ),
      );
    });

    it("'Upload files here' targets that folder", async () => {
      vi.mocked(api.uploadProjectFile).mockResolvedValue({ path: "x", size: 1 });
      const user = userEvent.setup();
      renderView();
      await screen.findByText("src");
      const input = screen.getByLabelText("Upload files") as HTMLInputElement;
      vi.spyOn(input, "click").mockImplementation(() => {});
      await user.click(menuOf("src"));
      await user.click(screen.getByRole("menuitem", { name: "Upload files here" }));
      const f = new File(["x"], "n.txt");
      await user.upload(input, f);
      await waitFor(() =>
        expect(api.uploadProjectFile).toHaveBeenCalledWith(4, "src/n.txt", f, expect.anything()),
      );
    });
  });

  describe("drag a row", () => {
    beforeEach(() => {
      resetStore({ projects: [makeProject({ id: 4, cwd: "/work/app" })], sessions: [] });
      vi.mocked(api.renameProjectPath).mockResolvedValue({ path: "x" });
    });
    afterEach(() => endFileDrag());

    it("carries a payload a terminal can resolve", async () => {
      renderView();
      await screen.findByText("README.md");
      const dt = fakeDt();
      fireEvent.dragStart(rowOf("README.md"), { dataTransfer: dt });
      expect(JSON.parse(dt.getData("application/x-mullion-file"))).toEqual({
        projectId: 4,
        sessionId: null,
        path: "README.md",
        kind: "file",
        rootCwd: "/work/app",
      });
      expect(dt.getData("text/plain")).toBe("README.md");
    });

    it("rows are not draggable while the project's directory is unknown", async () => {
      resetStore({ projects: [], sessions: [] });
      renderView();
      await screen.findByText("README.md");
      expect(rowOf("README.md").getAttribute("draggable")).toBe("false");
      fireEvent.dragStart(rowOf("README.md"), { dataTransfer: fakeDt() });
      expect(activeFileDrag()).toBeNull();
    });

    it("does not drag a symlink that leads outside the project", async () => {
      renderView();
      await screen.findByText("escape");
      expect(rowOf("escape").getAttribute("draggable")).toBe("false");
    });

    it("moves a file into a folder it is dropped on", async () => {
      const gone: FilePathGone[] = [];
      const off = subscribeFilePathGone((e) => gone.push(e));
      renderView();
      await screen.findByText("README.md");
      const dt = fakeDt();
      fireEvent.dragStart(rowOf("README.md"), { dataTransfer: dt });
      fireEvent.dragOver(rowOf("src"), { dataTransfer: dt });
      expect(rowOf("src").querySelector(".file-drop-target")).toBeTruthy();
      fireEvent.drop(rowOf("src"), { dataTransfer: dt });
      await waitFor(() =>
        expect(api.renameProjectPath).toHaveBeenCalledWith(
          4,
          "README.md",
          "src/README.md",
          undefined,
        ),
      );
      expect(gone[0]).toMatchObject({ path: "README.md" });
      off();
    });

    it("moves a nested file to the root when dropped on the background", async () => {
      const user = userEvent.setup();
      renderView();
      await user.click(await screen.findByText("src"));
      await screen.findByText("index.ts");
      const dt = fakeDt();
      fireEvent.dragStart(rowOf("index.ts"), { dataTransfer: dt });
      const root = document.querySelector(".files-sidebar-view") as HTMLElement;
      fireEvent.dragOver(root, { dataTransfer: dt });
      fireEvent.drop(root, { dataTransfer: dt });
      await waitFor(() =>
        expect(api.renameProjectPath).toHaveBeenCalledWith(
          4,
          "src/index.ts",
          "index.ts",
          undefined,
        ),
      );
    });

    it("refuses a drop into the folder it is already in, and onto the wrong checkout", async () => {
      const user = userEvent.setup();
      renderView();
      await user.click(await screen.findByText("src"));
      await screen.findByText("index.ts");
      const dt = fakeDt();
      fireEvent.dragStart(rowOf("index.ts"), { dataTransfer: dt });
      fireEvent.dragOver(rowOf("src"), { dataTransfer: dt });
      expect(rowOf("src").querySelector(".file-drop-target")).toBeNull();
      fireEvent.drop(rowOf("src"), { dataTransfer: dt });
      expect(api.renameProjectPath).not.toHaveBeenCalled();
      // a payload from another project's tree is not ours to move
      const foreign = fakeDt();
      foreign.setData(
        "application/x-mullion-file",
        JSON.stringify({ projectId: 99, sessionId: null, path: "x", kind: "file", rootCwd: "/o" }),
      );
      fireEvent.drop(rowOf("src"), { dataTransfer: foreign });
      expect(api.renameProjectPath).not.toHaveBeenCalled();
    });

    it("refuses to move a file with unsaved edits", async () => {
      setFileDirty(4, undefined, "README.md", true);
      renderView();
      await screen.findByText("README.md");
      const dt = fakeDt();
      fireEvent.dragStart(rowOf("README.md"), { dataTransfer: dt });
      fireEvent.dragOver(rowOf("src"), { dataTransfer: dt });
      fireEvent.drop(rowOf("src"), { dataTransfer: dt });
      expect(api.renameProjectPath).not.toHaveBeenCalled();
      act(() => setFileDirty(4, undefined, "README.md", false));
    });

    it("shows a move clash from the server", async () => {
      vi.mocked(api.renameProjectPath).mockRejectedValueOnce(new ApiError("x", 409, "conflict"));
      renderView();
      await screen.findByText("README.md");
      const dt = fakeDt();
      fireEvent.dragStart(rowOf("README.md"), { dataTransfer: dt });
      fireEvent.drop(rowOf("src"), { dataTransfer: dt });
      expect(await screen.findByText("README.md already exists in src")).toBeTruthy();
    });

    it("opens a closed folder a drag rests on", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        renderView();
        await screen.findByText("README.md");
        const dt = fakeDt();
        fireEvent.dragStart(rowOf("README.md"), { dataTransfer: dt });
        fireEvent.dragOver(rowOf("src"), { dataTransfer: dt });
        expect(screen.queryByText("index.ts")).toBeNull();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(700);
        });
        expect(await screen.findByText("index.ts")).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("git status in the tree", () => {
    const status = (files: { path: string; status: "M" | "A" | "D" | "U" | "?" }[]) => ({
      branch: "main",
      hash: null,
      ahead: 0,
      behind: 0,
      files,
      isClean: files.length === 0,
      hasConflicts: files.some((f) => f.status === "U"),
    });

    it("badges changed files and the folders above them, and leaves clean rows plain", async () => {
      resetStore({
        projects: [makeProject({ id: 4, cwd: "/work/app" })],
        sessions: [],
        gitStatuses: {
          4: status([
            { path: "src/index.ts", status: "M" },
            { path: "README.md", status: "?" },
          ]),
        },
      });
      const user = userEvent.setup();
      renderView();
      await user.click(await screen.findByText("src"));
      await screen.findByText("index.ts");
      expect(within(rowOf("src")).getByRole("img", { name: "Contains changes" })).toBeTruthy();
      expect(within(rowOf("index.ts")).getByRole("img", { name: "Modified" })).toBeTruthy();
      expect(within(rowOf("README.md")).getByRole("img", { name: "Untracked" })).toBeTruthy();
      expect(within(rowOf("escape")).queryByRole("img")).toBeNull();
    });

    it("uses the worktree session's own status for a worktree tree", async () => {
      resetStore({
        projects: [makeProject({ id: 4, cwd: "/work/app" })],
        sessions: [makeSession({ id: 9, projectId: 4, cwd: "/work/app/.mullion-worktrees/feat" })],
        gitStatuses: { 4: status([{ path: "README.md", status: "M" }]) },
        sessionGitStatuses: { 9: status([{ path: "README.md", status: "A" }]) },
      });
      render(<FilesSidebarView projectId={4} checkoutSessionId={9} actions={actions} />);
      await screen.findByText("README.md");
      expect(within(rowOf("README.md")).getByRole("img", { name: "Added" })).toBeTruthy();
    });

    it("asks for fresh statuses after the tree changes the working tree", async () => {
      const refresh = vi.fn().mockResolvedValue(undefined);
      resetStore({
        projects: [makeProject({ id: 4, cwd: "/work/app" })],
        sessions: [],
        refreshGitStatuses: refresh,
      });
      vi.mocked(api.renameProjectPath).mockResolvedValue({ path: "x" });
      vi.mocked(api.deleteProjectPath).mockResolvedValue({ path: "x" });
      vi.mocked(api.writeProjectFile).mockResolvedValue({ size: 0, mtimeMs: 1 });
      const user = userEvent.setup();
      renderView();
      await screen.findByText("README.md");
      // delete
      await user.click(menuOf("README.md"));
      await user.click(screen.getByRole("menuitem", { name: "Delete" }));
      await user.click(screen.getByRole("menuitem", { name: /Click again to delete/ }));
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
      // create
      await user.click(screen.getByRole("button", { name: "New file in project root" }));
      await user.type(screen.getByPlaceholderText("New file in /"), "z.ts{Enter}");
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
      // upload
      vi.mocked(api.uploadProjectFile).mockResolvedValue({ path: "x", size: 1 });
      await user.upload(screen.getByLabelText("Upload files"), new File(["x"], "up.txt"));
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(3));
    });
  });
});
