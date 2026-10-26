// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  MAX_DROPPED_ENTRIES,
  collectDroppedTree,
  droppedFiles,
  itemsFromInput,
} from "./dropped-files.js";

const fileEntry = (name: string, file = new File(["x"], name)) => ({
  isFile: true,
  isDirectory: false,
  name,
  file: (ok: (f: File) => void) => ok(file),
});

// A directory whose readEntries hands out `batches` one call at a time, then [].
const dirEntry = (name: string, batches: unknown[][]) => ({
  isFile: false,
  isDirectory: true,
  name,
  createReader: () => {
    const queue = [...batches];
    return {
      readEntries: (ok: (e: unknown[]) => void) => {
        const batch = queue.shift() ?? [];
        queueMicrotask(() => ok(batch));
      },
    };
  },
});

const dt = (items: unknown[], files: File[] = []) =>
  ({
    items: items.map((entry) => ({
      kind: "file",
      getAsFile: () => files[0] ?? null,
      webkitGetAsEntry: () => entry,
    })),
    files,
  }) as unknown as DataTransfer;

describe("droppedFiles", () => {
  it("skips folders and counts them", () => {
    const a = new File(["a"], "a.txt");
    const data = {
      items: [
        { kind: "file", getAsFile: () => a, webkitGetAsEntry: () => ({ isDirectory: false }) },
        {
          kind: "file",
          getAsFile: () => new File([], "dir"),
          webkitGetAsEntry: () => ({ isDirectory: true }),
        },
        { kind: "string", getAsFile: () => null },
      ],
      files: [],
    } as unknown as DataTransfer;
    expect(droppedFiles(data)).toEqual({ files: [a], skipped: 1 });
  });

  it("falls back to dt.files without items", () => {
    const a = new File(["a"], "a.txt");
    const data = { items: [], files: [a] } as unknown as DataTransfer;
    expect(droppedFiles(data)).toEqual({ files: [a], skipped: 0 });
  });

  it("treats an empty untyped pseudo-file as a folder when entries are unavailable", () => {
    const data = {
      items: [{ kind: "file", getAsFile: () => new File([], "dir") }],
      files: [],
    } as unknown as DataTransfer;
    expect(droppedFiles(data)).toEqual({ files: [], skipped: 1 });
  });
});

describe("collectDroppedTree", () => {
  it("returns plain files under their own name", async () => {
    const { items, truncated } = await collectDroppedTree(dt([fileEntry("a.txt")]));
    expect(items.map((i) => i.relativePath)).toEqual(["a.txt"]);
    expect(truncated).toBe(false);
  });

  it("walks nested folders and reads every batch of a large folder", async () => {
    const tree = dirEntry("pics", [
      [fileEntry("one.png"), dirEntry("2024", [[fileEntry("two.png")]])],
      [fileEntry("three.png")], // a second readEntries batch
    ]);
    const { items } = await collectDroppedTree(dt([tree, fileEntry("loose.txt")]));
    expect(items.map((i) => i.relativePath).sort()).toEqual([
      "loose.txt",
      "pics/2024/two.png",
      "pics/one.png",
      "pics/three.png",
    ]);
  });

  it("keeps an empty folder out of the result (nothing to upload)", async () => {
    const { items } = await collectDroppedTree(dt([dirEntry("empty", [])]));
    expect(items).toEqual([]);
  });

  it("stops at the entry cap and says so", async () => {
    const many = Array.from({ length: MAX_DROPPED_ENTRIES + 10 }, (_, i) => fileEntry(`f${i}`));
    const { items, truncated } = await collectDroppedTree(dt([dirEntry("big", [many])]));
    expect(items.length).toBe(MAX_DROPPED_ENTRIES);
    expect(truncated).toBe(true);
  });

  it("falls back to dt.files when the browser has no entry API", async () => {
    const f = new File(["x"], "legacy.txt");
    const data = {
      items: [{ kind: "file", getAsFile: () => f }],
      files: [f],
    } as unknown as DataTransfer;
    const { items } = await collectDroppedTree(data);
    expect(items.map((i) => i.relativePath)).toEqual(["legacy.txt"]);
  });

  it("falls back to dt.files when there are no items at all", async () => {
    const f = new File(["x"], "bare.txt");
    const { items } = await collectDroppedTree({ files: [f] } as unknown as DataTransfer);
    expect(items.map((i) => i.relativePath)).toEqual(["bare.txt"]);
  });
});

describe("itemsFromInput", () => {
  it("uses webkitRelativePath when present, else the file name", () => {
    const a = new File(["x"], "a.txt");
    const b = new File(["y"], "b.txt");
    Object.defineProperty(b, "webkitRelativePath", { value: "dir/sub/b.txt" });
    expect(itemsFromInput([a, b]).map((i) => i.relativePath)).toEqual(["a.txt", "dir/sub/b.txt"]);
  });
});
