import { describe, it, expect, vi, afterEach } from "vitest";
import { avdsApi } from "./avds.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// listAvailableSystemImages is a thin wrapper around `request<T>` (thoroughly
// tested via the other API modules). We exercise it here purely to cover the
// one line the coverage report flags as uncovered.

describe("avdsApi", () => {
  it("listAvailableSystemImages fetches /api/system-images/available", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      type: "basic",
      json: () => Promise.resolve({ systemImages: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await avdsApi.listAvailableSystemImages();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/system-images/available",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(result).toEqual({ systemImages: [] });
  });
});
