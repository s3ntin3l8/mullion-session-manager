import { describe, expect, it, vi } from "vitest";

const inspectTempStorage = vi.fn(async (..._args: unknown[]) => ({ available: true }));
const pruneTempStorage = vi.fn(async (_mode?: string) => ({ output: "", reclaimedBytes: 7 }));
vi.mock("../../src/services/temp-storage.js", () => ({
  inspectTempStorage: (...args: unknown[]) => inspectTempStorage(...args),
  pruneTempStorage: (mode?: string) => pruneTempStorage(mode),
}));

import { buildTestApp } from "../helpers/app.js";

describe("/api/storage/temp", () => {
  it("defaults to safe, passes aggressive, and rejects unknown modes", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "POST", url: "/api/storage/temp/prune" });
    expect(res.statusCode).toBe(200);
    expect(pruneTempStorage).toHaveBeenLastCalledWith("safe");
    await app.inject({
      method: "POST",
      url: "/api/storage/temp/prune",
      payload: { mode: "aggressive" },
    });
    expect(pruneTempStorage).toHaveBeenLastCalledWith("aggressive");
    const bad = await app.inject({
      method: "POST",
      url: "/api/storage/temp/prune",
      payload: { mode: "everything" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("caches inspection across polls and refreshes after a prune", async () => {
    inspectTempStorage.mockClear();
    const app = await buildTestApp();
    await app.inject({ method: "GET", url: "/api/storage/temp" });
    await app.inject({ method: "GET", url: "/api/storage/temp" });
    expect(inspectTempStorage).toHaveBeenCalledTimes(1);
    await app.inject({ method: "POST", url: "/api/storage/temp/prune" });
    await app.inject({ method: "GET", url: "/api/storage/temp" });
    expect(inspectTempStorage).toHaveBeenCalledTimes(2);
  });

  it("maps an in-progress prune to 409 and other failures to 500", async () => {
    const app = await buildTestApp();
    pruneTempStorage.mockRejectedValueOnce(new Error("TEMP_PRUNE_IN_PROGRESS"));
    const conflict = await app.inject({ method: "POST", url: "/api/storage/temp/prune" });
    expect(conflict.statusCode).toBe(409);
    pruneTempStorage.mockRejectedValueOnce(new Error("disk on fire"));
    const failed = await app.inject({ method: "POST", url: "/api/storage/temp/prune" });
    expect(failed.statusCode).toBe(500);
  });
});
