// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import {
  FILE_DRAGGING_CLASS,
  FILE_DRAG_MIME,
  activeFileDrag,
  endFileDrag,
  hasFileDrag,
  readFileDrag,
  startFileDrag,
  type FileDragPayload,
} from "./fileDrag.js";

const payload: FileDragPayload = {
  projectId: 3,
  sessionId: null,
  path: "src/a.ts",
  kind: "file",
  rootCwd: "/work/app",
};

const fakeDt = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    setData: (k: string, v: string) => void data.set(k, v),
    getData: (k: string) => data.get(k) ?? "",
    get types() {
      return [...data.keys()];
    },
    effectAllowed: "none",
  } as unknown as DataTransfer;
};

afterEach(() => endFileDrag());

describe("fileDrag", () => {
  it("starting a drag records it, writes the payload and a plain-text fallback", () => {
    const dt = fakeDt();
    startFileDrag(dt, payload);
    expect(activeFileDrag()).toEqual(payload);
    expect(hasFileDrag(dt)).toBe(true);
    expect(readFileDrag(dt)).toEqual(payload);
    expect(dt.getData("text/plain")).toBe("src/a.ts");
    expect(dt.effectAllowed).toBe("copyMove");
    endFileDrag();
    expect(activeFileDrag()).toBeNull();
  });

  it("round-trips a worktree session id", () => {
    const dt = fakeDt();
    startFileDrag(dt, { ...payload, sessionId: 9 });
    expect(readFileDrag(dt)?.sessionId).toBe(9);
  });

  it("recognises only its own drag type", () => {
    expect(hasFileDrag(fakeDt({ "text/plain": "x" }))).toBe(false);
    expect(hasFileDrag(fakeDt({ Files: "" }))).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["not json", "{"],
    ["wrong shape", JSON.stringify({ projectId: "3", path: "a" })],
    ["bad kind", JSON.stringify({ ...payload, kind: "symlink" })],
    ["bad session", JSON.stringify({ ...payload, sessionId: "9" })],
    ["no root", JSON.stringify({ ...payload, rootCwd: undefined })],
  ])("rejects a malformed payload (%s)", (_name, raw) => {
    expect(readFileDrag(fakeDt({ [FILE_DRAG_MIME]: raw }))).toBeNull();
  });

  describe("the body marker that lets a drop through the sidebar's scrim", () => {
    const marked = () => document.body.classList.contains(FILE_DRAGGING_CLASS);

    it("is set while a row is dragged and cleared when it ends", () => {
      expect(marked()).toBe(false);
      startFileDrag(fakeDt(), payload);
      expect(marked()).toBe(true);
      endFileDrag();
      expect(marked()).toBe(false);
    });

    it.each(["dragend", "drop", "pointerdown"])(
      "is also cleared by a window %s, so a vanished source can't leave it stuck",
      (type) => {
        startFileDrag(fakeDt(), payload);
        window.dispatchEvent(new Event(type));
        expect(marked()).toBe(false);
        expect(activeFileDrag()).toBeNull();
      },
    );

    it("stops listening once cleared, and a second drag starts clean", () => {
      startFileDrag(fakeDt(), payload);
      endFileDrag();
      startFileDrag(fakeDt(), payload); // re-arms (replaces any earlier watcher)
      expect(marked()).toBe(true);
      window.dispatchEvent(new Event("drop"));
      expect(marked()).toBe(false);
      window.dispatchEvent(new Event("drop")); // nothing left to remove
      expect(marked()).toBe(false);
    });
  });
});
