import { describe, expect, it, vi } from "vitest";

const pruneDockerStorage = vi.fn(async (_mode?: string) => ({ output: "", reclaimedBytes: 5 }));
vi.mock("../../src/services/docker-storage.js", () => ({
  inspectDockerStorage: vi.fn(),
  pruneDockerStorage: (mode?: string) => pruneDockerStorage(mode),
}));

import { buildTestApp } from "../helpers/app.js";

describe("POST /api/storage/docker/prune", () => {
  it("defaults to safe mode with no body", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "POST", url: "/api/storage/docker/prune" });
    expect(res.statusCode).toBe(200);
    expect(pruneDockerStorage).toHaveBeenLastCalledWith("safe");
    expect(res.json()).toEqual({ output: "", reclaimedBytes: 5 });
  });

  it("passes the aggressive mode through and rejects unknown modes", async () => {
    const app = await buildTestApp();
    const ok = await app.inject({
      method: "POST",
      url: "/api/storage/docker/prune",
      payload: { mode: "aggressive" },
    });
    expect(ok.statusCode).toBe(200);
    expect(pruneDockerStorage).toHaveBeenLastCalledWith("aggressive");
    const bad = await app.inject({
      method: "POST",
      url: "/api/storage/docker/prune",
      payload: { mode: "volumes" },
    });
    expect(bad.statusCode).toBe(400);
  });
});
