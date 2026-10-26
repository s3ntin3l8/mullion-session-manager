// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilesSidebarView } from "./FilesSidebarView.js";
import { api, ApiError } from "../api/index.js";
import type * as ApiModule from "../api/index.js";
import type { ProjectDirEntry } from "../api/index.js";

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
    expect(api.listProjectFiles).toHaveBeenCalledWith(4, "");
  });

  it("lazily loads a folder when expanded and collapses it again", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByText("src"));
    expect(await screen.findByText("index.ts")).toBeTruthy();
    expect(screen.getByText("…list truncated")).toBeTruthy();
    expect(api.listProjectFiles).toHaveBeenCalledWith(4, "src");
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
    expect(actions.onOpenFile).toHaveBeenCalledWith(4, "src/index.ts");
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
      expect(api.writeProjectFile).toHaveBeenCalledWith(4, "src/new.ts", "", { create: true }),
    );
    expect(api.listProjectFiles).toHaveBeenCalledWith(4, "src");
    expect(actions.onOpenFile).toHaveBeenCalledWith(4, "src/new.ts");
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
    await waitFor(() => expect(api.mkdirProjectDir).toHaveBeenCalledWith(4, "docs"));
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
    await waitFor(() => expect(actions.onOpenFile).toHaveBeenCalledWith(4, "x.ts"));
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
});
