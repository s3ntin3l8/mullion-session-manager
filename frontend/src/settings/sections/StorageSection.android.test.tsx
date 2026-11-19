// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api, type AndroidImagesStatus } from "../../api/index.js";
import { StorageSection } from "./StorageSection.js";
import { useDashboardStore } from "../../store/index.js";
import { DEFAULT_SETTINGS } from "../../api/settings.js";

const GIB = 1024 ** 3;
const SPARE = "system-images;android-37.2;google_apis_ps16k;x86_64";

function ready<T>(data: T) {
  return { state: "ready" as const, measuredAt: new Date().toISOString(), durationMs: 1, ...data };
}

function setup(android: AndroidImagesStatus, optIns: string[] = []) {
  useDashboardStore.setState({
    settings: { ...DEFAULT_SETTINGS, diskCleanup: { cacheDirs: [], optIns } },
    settingsLoaded: true,
  });
  const empty = ready({ available: false });
  for (const name of [
    "getDockerStorage",
    "getCacheStorage",
    "getOpencodeStorage",
    "getDevWorktrees",
    "getSpaceReport",
    "getTempStorage",
  ] as const) {
    vi.spyOn(api, name).mockResolvedValue(empty as never);
  }
  vi.spyOn(api, "getAndroidImages").mockResolvedValue(ready(android) as never);
  vi.spyOn(api, "getCleanupStatus").mockResolvedValue({ state: "idle" });
  vi.spyOn(api, "getOrphanRemoval").mockResolvedValue({ job: { state: "idle" }, recoveries: [] });
  vi.spyOn(api, "getSystemStats").mockResolvedValue({
    sampledAt: "2026-09-13T12:00:00.000Z",
    cpu: { logicalCores: 8, loadAverage1m: 1 },
    memory: { totalBytes: GIB, freeBytes: GIB },
    filesystems: [],
  });
  return vi
    .spyOn(api, "startCleanup")
    .mockResolvedValue({ state: "running", mode: "aggressive", steps: [] } as never);
}

afterEach(() => vi.restoreAllMocks());

describe("StorageSection Android system images opt-in", () => {
  it("lists each image with its size and the warning, and persists the id", async () => {
    setup({
      available: true,
      images: [{ packagePath: SPARE, bytes: 8 * GIB }],
      reclaimableBytes: 8 * GIB,
    });
    const update = vi.spyOn(useDashboardStore.getState(), "updateSettings");
    useDashboardStore.setState({ updateSettings: update });
    render(<StorageSection />);
    const toggle = await screen.findByLabelText("Also remove unused Android system images");
    expect(screen.getByText(SPARE)).toBeTruthy();
    expect(screen.getByTestId("android-images-list").textContent).toContain("8.0 GiB");
    expect(
      screen.getByText(/Removed with sdkmanager; using one of these again means/),
    ).toBeTruthy();
    fireEvent.click(toggle);
    expect(update).toHaveBeenLastCalledWith({
      diskCleanup: { cacheDirs: [], optIns: ["android-system-images"] },
    });
  });

  it("sends the saved opt-in with an aggressive cleanup and shows its tier row", async () => {
    const start = setup(
      { available: true, images: [{ packagePath: SPARE, bytes: GIB }], reclaimableBytes: GIB },
      ["android-system-images"],
    );
    render(<StorageSection />);
    await screen.findByLabelText("Also remove unused Android system images");
    await screen.findAllByText("Android system images");
    fireEvent.click(screen.getByText("Aggressive cleanup…"));
    fireEvent.click(await screen.findByText("Confirm aggressive cleanup"));
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith("aggressive", [], ["android-system-images"]),
    );
  });

  it("hides the toggle when unavailable and not opted in; explains when opted in", async () => {
    setup({
      available: false,
      images: [],
      reclaimableBytes: 0,
      error: "sdkmanager is not configured",
    });
    const { unmount } = render(<StorageSection />);
    await waitFor(() => expect(api.getAndroidImages).toHaveBeenCalled());
    await screen.findByText("Aggressive cleanup…");
    expect(screen.queryByLabelText("Also remove unused Android system images")).toBeNull();
    unmount();
    vi.restoreAllMocks();
    setup(
      { available: false, images: [], reclaimableBytes: 0, error: "sdkmanager is not configured" },
      ["android-system-images"],
    );
    render(<StorageSection />);
    expect(
      await screen.findByText(/Nothing will be removed: sdkmanager is not configured/),
    ).toBeTruthy();
  });
});
