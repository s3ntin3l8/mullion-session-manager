import { describe, it, expect, vi } from "vitest";
import { emitFilePathGone, subscribeFilePathGone } from "./filePathEvents.js";

describe("filePathEvents", () => {
  it("delivers to every subscriber until it unsubscribes", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeFilePathGone(a);
    const offB = subscribeFilePathGone(b);
    const e = { projectId: 1, sessionId: undefined, path: "x.ts" };
    emitFilePathGone(e);
    expect(a).toHaveBeenCalledWith(e);
    expect(b).toHaveBeenCalledWith(e);
    offA();
    emitFilePathGone(e);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    offB();
  });
});
