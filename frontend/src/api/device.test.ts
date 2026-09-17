import { describe, it, expect, vi, afterEach } from "vitest";
import { jsonResponse } from "../test/jsonResponse.js";
import { devicesApi } from "./device.js";

describe("devicesApi", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("listDevices calls GET /api/devices", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, []));
    vi.stubGlobal("fetch", fetchMock);

    const result = await devicesApi.listDevices();
    expect(result).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith("/api/devices", expect.any(Object));
  });

  it("getDevice calls GET /api/devices/:id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await devicesApi.getDevice(1);
    expect(result).toEqual({ id: 1 });
    expect(fetchMock).toHaveBeenCalledWith("/api/devices/1", expect.any(Object));
  });

  it("createDevice calls POST /api/devices with body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { id: 1, avdName: "dev35" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await devicesApi.createDevice({ avdName: "dev35", name: "My Dev" });
    expect(result).toEqual({ id: 1, avdName: "dev35" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/devices",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ avdName: "dev35", name: "My Dev" }),
      }),
    );
  });

  it("terminateDevice calls DELETE /api/devices/:id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(204, null));
    vi.stubGlobal("fetch", fetchMock);

    await devicesApi.terminateDevice(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/devices/1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
