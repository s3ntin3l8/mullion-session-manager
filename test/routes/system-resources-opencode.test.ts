import { describe, expect, it, vi } from "vitest";

const inspectOpencodeStorage = vi.fn(async (..._args: unknown[]) => ({ available: true }));
const pruneOpencodeStorage = vi.fn(async (..._args: unknown[]) => ({
  output: "Compacted opencode.db.",
  reclaimedBytes: 11,
}));
vi.mock("../../src/services/opencode-storage.js", () => ({
  inspectOpencodeStorage: (...args: unknown[]) => inspectOpencodeStorage(...args),
  pruneOpencodeStorage: (...args: unknown[]) => pruneOpencodeStorage(...args),
}));

import { buildTestApp } from "../helpers/app.js";

describe("/api/storage/opencode", () => {
  it("prunes with nothing a client can steer, and returns the result", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/storage/opencode/prune",
      payload: { path: "/etc/passwd", dbPath: "/etc/passwd" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ output: "Compacted opencode.db.", reclaimedBytes: 11 });
    expect(pruneOpencodeStorage).toHaveBeenLastCalledWith();
  });

  it("caches inspection across polls and refreshes after a prune", async () => {
    inspectOpencodeStorage.mockClear();
    const app = await buildTestApp();
    await app.inject({ method: "GET", url: "/api/storage/opencode" });
    await app.inject({ method: "GET", url: "/api/storage/opencode" });
    expect(inspectOpencodeStorage).toHaveBeenCalledTimes(1);
    await app.inject({ method: "POST", url: "/api/storage/opencode/prune" });
    await app.inject({ method: "GET", url: "/api/storage/opencode" });
    expect(inspectOpencodeStorage).toHaveBeenCalledTimes(2);
  });

  it("maps an in-progress prune to 409 and other failures to 500", async () => {
    const app = await buildTestApp();
    pruneOpencodeStorage.mockRejectedValueOnce(new Error("OPENCODE_PRUNE_IN_PROGRESS"));
    const conflict = await app.inject({ method: "POST", url: "/api/storage/opencode/prune" });
    expect(conflict.statusCode).toBe(409);
    pruneOpencodeStorage.mockRejectedValueOnce(new Error("disk on fire"));
    const failed = await app.inject({ method: "POST", url: "/api/storage/opencode/prune" });
    expect(failed.statusCode).toBe(500);
  });
});
