// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTreeUploads } from "./useTreeUploads.js";
import { api } from "../api/index.js";
import type * as ApiModule from "../api/index.js";

vi.mock("../api/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: { ...actual.api, uploadProjectFile: vi.fn() } };
});

const entry = (...names: string[]) => ({ entries: names.map((name) => ({ name })) });

function setup(over: Partial<Parameters<typeof useTreeUploads>[0]> = {}) {
  const props = {
    projectId: 4,
    sessionId: undefined as number | undefined,
    dirs: { "": entry("a.txt", "src"), src: entry("b.ts") },
    expanded: new Set(["", "src"]),
    selectedDir: "src",
    expandDir: vi.fn(),
    loadDir: vi.fn(),
    onTruncated: vi.fn(),
    ...over,
  };
  const hook = renderHook((p: typeof props) => useTreeUploads(p), { initialProps: props });
  return { props, hook };
}

const file = (name: string, rel?: string) => {
  const f = new File(["x"], name);
  if (rel) Object.defineProperty(f, "webkitRelativePath", { value: rel });
  return f;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.uploadProjectFile).mockResolvedValue({ path: "x", size: 1 });
});

describe("useTreeUploads", () => {
  it("uploads a picked file into the selected folder, resets the input, and re-lists", async () => {
    const { props, hook } = setup();
    const input = document.createElement("input");
    const f = file("n.txt");
    await act(async () => hook.result.current.pickFiles([f] as unknown as FileList, input));
    await vi.waitFor(() =>
      expect(api.uploadProjectFile).toHaveBeenCalledWith(4, "src/n.txt", f, expect.anything()),
    );
    await vi.waitFor(() => expect(props.expandDir).toHaveBeenCalledWith("src"));
    // every other open folder is re-listed too (a folder upload makes subfolders)
    expect(props.loadDir).toHaveBeenCalledWith("");
    expect(props.loadDir).not.toHaveBeenCalledWith("src");
    expect(input.value).toBe("");
  });

  it("an empty pick uploads nothing", async () => {
    const { hook } = setup();
    await act(async () =>
      hook.result.current.pickFiles([] as unknown as FileList, document.createElement("input")),
    );
    expect(api.uploadProjectFile).not.toHaveBeenCalled();
    await act(async () => hook.result.current.pickFiles(null, document.createElement("input")));
    expect(api.uploadProjectFile).not.toHaveBeenCalled();
  });

  it("a picked folder keeps its relative paths and asks for parent folders", async () => {
    const { hook } = setup({ selectedDir: "" });
    const f = file("deep.txt", "pics/2024/deep.txt");
    await act(async () =>
      hook.result.current.pickFiles([f] as unknown as FileList, document.createElement("input")),
    );
    await vi.waitFor(() =>
      expect(api.uploadProjectFile).toHaveBeenCalledWith(
        4,
        "pics/2024/deep.txt",
        f,
        expect.objectContaining({ mkdirs: true }),
      ),
    );
  });

  it("refuses a name the tree already lists, in the root and in a nested folder, without sending it", async () => {
    const { hook } = setup({ selectedDir: "" });
    await act(async () =>
      hook.result.current.onUpload(
        [
          { file: file("a.txt"), relativePath: "a.txt" }, // listed at the root
          { file: file("b.ts"), relativePath: "src/b.ts" }, // listed under src
          { file: file("new.ts"), relativePath: "src/new.ts" },
        ],
        "",
      ),
    );
    await vi.waitFor(() => expect(api.uploadProjectFile).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.uploadProjectFile).mock.calls[0]![1]).toBe("src/new.ts");
    expect(hook.result.current.uploads.errors.sort()).toEqual([
      "a.txt already exists",
      "src/b.ts already exists",
    ]);
  });

  it("does not re-list a tree that has been pointed at another project since the batch started", async () => {
    let finish!: () => void;
    vi.mocked(api.uploadProjectFile).mockImplementation(
      () => new Promise((resolve) => (finish = () => resolve({ path: "x", size: 1 }))),
    );
    const { props, hook } = setup({ selectedDir: "" });
    act(() => {
      void hook.result.current.uploads.upload([{ file: file("n.txt"), relativePath: "n.txt" }], "");
    });
    await vi.waitFor(() => expect(api.uploadProjectFile).toHaveBeenCalled());
    // the tree now shows another project (and its own folders)
    hook.rerender({ ...props, projectId: 5, expanded: new Set([""]) });
    await act(async () => finish());
    await new Promise((r) => setTimeout(r, 20));
    expect(props.expandDir).not.toHaveBeenCalled();
    expect(props.loadDir).not.toHaveBeenCalled();
  });

  it("does not re-list a tree that switched to another checkout either", async () => {
    let finish!: () => void;
    vi.mocked(api.uploadProjectFile).mockImplementation(
      () => new Promise((resolve) => (finish = () => resolve({ path: "x", size: 1 }))),
    );
    const { props, hook } = setup({ selectedDir: "", sessionId: 9 });
    act(() => {
      void hook.result.current.uploads.upload([{ file: file("n.txt"), relativePath: "n.txt" }], "");
    });
    await vi.waitFor(() => expect(api.uploadProjectFile).toHaveBeenCalled());
    hook.rerender({ ...props, sessionId: undefined });
    await act(async () => finish());
    await new Promise((r) => setTimeout(r, 20));
    expect(props.expandDir).not.toHaveBeenCalled();
  });

  it("passes the truncation notice through for the drop target", () => {
    const { props, hook } = setup();
    hook.result.current.onTruncated();
    expect(props.onTruncated).toHaveBeenCalled();
  });
});
