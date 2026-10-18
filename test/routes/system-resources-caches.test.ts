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
  it("caches inspection across polls, and re-measures on refresh", async () => {
    inspectCacheStorage.mockClear();
    const app = await buildTestApp();
    await app.inject({ method: "GET", url: "/api/storage/caches" });
    await app.inject({ method: "GET", url: "/api/storage/caches" });
    expect(inspectCacheStorage).toHaveBeenCalledTimes(1);
    await app.inject({ method: "GET", url: "/api/storage/caches?refresh=1" });
    expect(inspectCacheStorage).toHaveBeenCalledTimes(2);
  });
});
