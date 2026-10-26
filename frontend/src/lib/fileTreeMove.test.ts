import { describe, it, expect } from "vitest";
import { baseName, checkMove, joinRel, parentOf } from "./fileTreeMove.js";

const tree = { projectId: 1, sessionId: null };
const drag = (path: string, over = {}) => ({ projectId: 1, sessionId: null, path, ...over });

describe("path helpers", () => {
  it("parentOf / baseName / joinRel", () => {
    expect(parentOf("a/b/c.ts")).toBe("a/b");
    expect(parentOf("c.ts")).toBe("");
    expect(baseName("a/b/c.ts")).toBe("c.ts");
    expect(baseName("c.ts")).toBe("c.ts");
    expect(joinRel("", "x")).toBe("x");
    expect(joinRel("a", "x")).toBe("a/x");
  });
});

describe("checkMove", () => {
  it("moves a file into another folder, or to the root", () => {
    expect(checkMove(drag("a.ts"), tree, "src")).toEqual({ ok: true, to: "src/a.ts" });
    expect(checkMove(drag("src/a.ts"), tree, "")).toEqual({ ok: true, to: "a.ts" });
    expect(checkMove(drag("src/a.ts"), tree, "lib/deep")).toEqual({
      ok: true,
      to: "lib/deep/a.ts",
    });
  });
  it("moves a folder with its name", () => {
    expect(checkMove(drag("src/ui"), tree, "lib")).toEqual({ ok: true, to: "lib/ui" });
  });
  it("refuses a drop into the folder it is already in", () => {
    expect(checkMove(drag("src/a.ts"), tree, "src")).toMatchObject({ ok: false });
    expect(checkMove(drag("a.ts"), tree, "")).toMatchObject({ ok: false });
  });
  it("refuses a folder into itself or a descendant, but not a sibling with the same prefix", () => {
    expect(checkMove(drag("src"), tree, "src")).toMatchObject({ ok: false });
    expect(checkMove(drag("src"), tree, "src/deep")).toMatchObject({ ok: false });
    expect(checkMove(drag("src"), tree, "src2")).toEqual({ ok: true, to: "src2/src" });
  });
  it("refuses the root", () => {
    expect(checkMove(drag(""), tree, "src")).toMatchObject({ ok: false });
  });
  it("refuses another project's or another checkout's file", () => {
    expect(checkMove(drag("a.ts", { projectId: 2 }), tree, "src")).toMatchObject({ ok: false });
    expect(checkMove(drag("a.ts", { sessionId: 5 }), tree, "src")).toMatchObject({ ok: false });
    expect(
      checkMove(drag("a.ts", { sessionId: 5 }), { projectId: 1, sessionId: 5 }, "src"),
    ).toEqual({ ok: true, to: "src/a.ts" });
  });
});
