import { describe, expect, it, vi } from "vitest";

const inspectDockerStorage = vi.fn(async (..._args: unknown[]) => ({ available: true }));
const pruneDockerStorage = vi.fn(async (_mode?: string) => ({ output: "", reclaimedBytes: 5 }));
vi.mock("../../src/services/docker-storage.js", () => ({
  inspectDockerStorage: (...args: unknown[]) => inspectDockerStorage(...args),
  pruneDockerStorage: (mode?: string) => pruneDockerStorage(mode),
}));

import { buildTestApp } from "../helpers/app.js";

describe("GET /api/storage/docker", () => {
  it("caches the Docker inspection across polls", async () => {
    inspectDockerStorage.mockClear();
    const app = await buildTestApp();
    await app.inject({ method: "GET", url: "/api/storage/docker" });
    await app.inject({ method: "GET", url: "/api/storage/docker" });
    expect(inspectDockerStorage).toHaveBeenCalledTimes(1);
    await app.inject({ method: "GET", url: "/api/storage/docker?refresh=1" });
    expect(inspectDockerStorage).toHaveBeenCalledTimes(2);
  });
});
