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
  it("caches inspection across polls, and re-measures on refresh", async () => {
    inspectOpencodeStorage.mockClear();
    const app = await buildTestApp();
    await app.inject({ method: "GET", url: "/api/storage/opencode" });
    await app.inject({ method: "GET", url: "/api/storage/opencode" });
    expect(inspectOpencodeStorage).toHaveBeenCalledTimes(1);
    await app.inject({ method: "GET", url: "/api/storage/opencode?refresh=1" });
    expect(inspectOpencodeStorage).toHaveBeenCalledTimes(2);
  });
});
