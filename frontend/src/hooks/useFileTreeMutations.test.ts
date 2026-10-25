// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useFileTreeMutations } from "./useFileTreeMutations.js";
import { api, ApiError } from "../api/index.js";
import type * as ApiModule from "../api/index.js";

vi.mock("../api/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: { ...actual.api, renameProjectPath: vi.fn(), deleteProjectPath: vi.fn() },
  };
});

const onChanged = vi.fn();
const setup = (sessionId?: number) =>
  renderHook(() => useFileTreeMutations({ projectId: 4, sessionId, onChanged })).result.current;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.renameProjectPath).mockResolvedValue({ path: "x" });
  vi.mocked(api.deleteProjectPath).mockResolvedValue({ path: "x" });
});

describe("useFileTreeMutations", () => {
  describe("rename", () => {
    it("renames within the same folder, passing the session, and re-lists the parent", async () => {
      const m = setup(9);
      expect(await m.rename("src/a.ts", " b.ts ")).toEqual({ ok: true, to: "src/b.ts" });
      expect(api.renameProjectPath).toHaveBeenCalledWith(4, "src/a.ts", "src/b.ts", 9);
      expect(onChanged).toHaveBeenCalledWith(["src"]);
    });
    it("renames a root entry", async () => {
      expect(await setup().rename("a.ts", "b.ts")).toEqual({ ok: true, to: "b.ts" });
      expect(onChanged).toHaveBeenCalledWith([""]);
    });
    it("treats an empty or unchanged name as a silent no-op", async () => {
      expect(await setup().rename("src/a.ts", "  ")).toEqual({ ok: false, error: "" });
      expect(await setup().rename("src/a.ts", "a.ts")).toEqual({ ok: false, error: "" });
      expect(api.renameProjectPath).not.toHaveBeenCalled();
    });
    it("refuses a path as the new name", async () => {
      expect(await setup().rename("a.ts", "x/y.ts")).toEqual({
        ok: false,
        error: "Enter a name, not a path.",
      });
      expect(api.renameProjectPath).not.toHaveBeenCalled();
    });
    it("explains a clash and surfaces other server messages", async () => {
      vi.mocked(api.renameProjectPath).mockRejectedValueOnce(new ApiError("x", 409, "conflict"));
      expect(await setup().rename("src/a.ts", "b.ts")).toEqual({
        ok: false,
        error: "b.ts already exists in src",
      });
      vi.mocked(api.renameProjectPath).mockRejectedValueOnce(new ApiError("Nope", 403));
      expect(await setup().rename("a.ts", "b.ts")).toEqual({ ok: false, error: "Nope" });
      vi.mocked(api.renameProjectPath).mockRejectedValueOnce(new Error("net"));
      expect(await setup().rename("a.ts", "b.ts")).toEqual({
        ok: false,
        error: "Failed to rename",
      });
      expect(onChanged).not.toHaveBeenCalled();
    });
  });

  describe("move", () => {
    it("moves into a folder and re-lists both the source and target folders", async () => {
      expect(await setup().move("src/a.ts", "lib")).toEqual({ ok: true, to: "lib/a.ts" });
      expect(api.renameProjectPath).toHaveBeenCalledWith(4, "src/a.ts", "lib/a.ts", undefined);
      expect(onChanged).toHaveBeenCalledWith(["src", "lib"]);
    });
    it("moves to the root", async () => {
      expect(await setup().move("src/a.ts", "")).toEqual({ ok: true, to: "a.ts" });
      expect(onChanged).toHaveBeenCalledWith(["src", ""]);
    });
    it("re-lists a shared parent once", async () => {
      await setup().move("a.ts", "");
      expect(onChanged).toHaveBeenCalledWith([""]);
    });
    it("names the destination on a clash", async () => {
      vi.mocked(api.renameProjectPath).mockRejectedValueOnce(new ApiError("x", 409, "conflict"));
      expect(await setup().move("src/a.ts", "lib")).toEqual({
        ok: false,
        error: "a.ts already exists in lib",
      });
      vi.mocked(api.renameProjectPath).mockRejectedValueOnce(new ApiError("x", 409, "conflict"));
      expect(await setup().move("src/a.ts", "")).toEqual({
        ok: false,
        error: "a.ts already exists in the project root",
      });
      vi.mocked(api.renameProjectPath).mockRejectedValueOnce("boom");
      expect(await setup().move("src/a.ts", "lib")).toEqual({ ok: false, error: "Failed to move" });
    });
  });

  describe("remove", () => {
    it("deletes and re-lists the parent", async () => {
      expect(await setup(2).remove("src/a.ts")).toEqual({ ok: true });
      expect(api.deleteProjectPath).toHaveBeenCalledWith(4, "src/a.ts", 2);
      expect(onChanged).toHaveBeenCalledWith(["src"]);
    });
    it("explains a non-empty folder and other failures", async () => {
      vi.mocked(api.deleteProjectPath).mockRejectedValueOnce(new ApiError("x", 409, "not_empty"));
      expect(await setup().remove("src")).toEqual({
        ok: false,
        error: "src isn't empty — only empty folders can be deleted",
      });
      vi.mocked(api.deleteProjectPath).mockRejectedValueOnce("boom");
      expect(await setup().remove("src")).toEqual({ ok: false, error: "Failed to delete" });
    });
  });
});
