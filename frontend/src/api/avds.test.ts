import { describe, it, expect, vi, afterEach } from "vitest";
import { avdsApi } from "./avds.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// These two methods are thin wrappers around `request<T>` (which is
// thoroughly tested via the other API modules). We exercise them here
// purely to cover the two lines the coverage report flags as uncovered
// (listAvailableSystemImages, getLicenseStatus).

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

  it("getLicenseStatus fetches /api/sdk-licenses/status", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      type: "basic",
      json: () => Promise.resolve({ pending: false }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await avdsApi.getLicenseStatus();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sdk-licenses/status",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(result).toEqual({ pending: false });
  });
});
