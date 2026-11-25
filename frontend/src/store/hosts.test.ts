import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/index.js";
import { useDashboardStore } from "./index.js";

describe("hosts slice: pingHost (#3515)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("re-reads the host list after Test, so the row shows the health the server recorded", async () => {
    vi.spyOn(api, "pingHost").mockResolvedValue({ online: true });
    const host = { id: "mac", health: "online" } as never;
    const list = vi.spyOn(api, "listHosts").mockResolvedValue([host]);
    useDashboardStore.setState({ hosts: [] });

    await expect(useDashboardStore.getState().pingHost("mac")).resolves.toBe(true);

    expect(list).toHaveBeenCalledTimes(1);
    expect(useDashboardStore.getState().hosts).toEqual([host]);
  });

  it("still answers the Test result when the follow-up list fails", async () => {
    vi.spyOn(api, "pingHost").mockResolvedValue({ online: false });
    vi.spyOn(api, "listHosts").mockRejectedValue(new Error("down"));

    await expect(useDashboardStore.getState().pingHost("mac")).resolves.toBe(false);
  });
});
