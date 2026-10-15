import { describe, expect, it, vi } from "vitest";
import type * as CacheStorage from "../../src/services/cache-storage.js";

const inspectCacheStorage = vi.fn(async (..._args: unknown[]) => ({ available: true, caches: [] }));
const pruneCacheStorage = vi.fn(async (_ids?: readonly string[]) => ({
  output: "",
  reclaimedBytes: 9,
}));
vi.mock("../../src/services/cache-storage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof CacheStorage>()),
  inspectCacheStorage: (...args: unknown[]) => inspectCacheStorage(...args),
  pruneCacheStorage: (ids?: readonly string[]) => pruneCacheStorage(ids),
}));

import { buildTestApp } from "../helpers/app.js";

describe("/api/storage/caches", () => {
  it("prunes exactly the caches saved in settings and ignores any request body", async () => {
    const app = await buildTestApp();
    await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { diskCleanup: { cacheDirs: ["pip", "../../etc", "go-build"] } },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/storage/caches/prune",
      payload: { cacheDirs: ["huggingface"] },
    });
    expect(res.statusCode).toBe(200);
    expect(pruneCacheStorage).toHaveBeenLastCalledWith(["pip", "go-build"]);
    expect(res.json()).toEqual({ output: "", reclaimedBytes: 9 });
  });

  it("prunes nothing when nothing is opted in", async () => {
    const app = await buildTestApp();
    // The test DB is shared across tests in this file, so reset explicitly.
    await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { diskCleanup: { cacheDirs: [] } },
    });
    await app.inject({ method: "POST", url: "/api/storage/caches/prune" });
    expect(pruneCacheStorage).toHaveBeenLastCalledWith([]);
  });

  it("caches inspection across polls and refreshes it after a prune", async () => {
    inspectCacheStorage.mockClear();
    const app = await buildTestApp();
    await app.inject({ method: "GET", url: "/api/storage/caches" });
    await app.inject({ method: "GET", url: "/api/storage/caches" });
    expect(inspectCacheStorage).toHaveBeenCalledTimes(1);
    await app.inject({ method: "POST", url: "/api/storage/caches/prune" });
    await app.inject({ method: "GET", url: "/api/storage/caches" });
    expect(inspectCacheStorage).toHaveBeenCalledTimes(2);
  });

  it("maps an in-progress prune to 409 and other failures to 500", async () => {
    const app = await buildTestApp();
    pruneCacheStorage.mockRejectedValueOnce(new Error("CACHE_PRUNE_IN_PROGRESS"));
    expect(
      (await app.inject({ method: "POST", url: "/api/storage/caches/prune" })).statusCode,
    ).toBe(409);
    pruneCacheStorage.mockRejectedValueOnce(new Error("boom"));
    expect(
      (await app.inject({ method: "POST", url: "/api/storage/caches/prune" })).statusCode,
    ).toBe(500);
  });
});
