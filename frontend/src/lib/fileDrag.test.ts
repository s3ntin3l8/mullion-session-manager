import { describe, it, expect, afterEach } from "vitest";
import {
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
});
