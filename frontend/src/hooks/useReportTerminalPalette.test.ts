// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useReportTerminalPalette } from "./useReportTerminalPalette.js";
import { settingsApi } from "../api/settings.js";
import { buildXtermTheme } from "../terminalTheme.js";

vi.mock("../api/settings.js", () => ({
  settingsApi: { putTerminalPalette: vi.fn(() => Promise.resolve()) },
}));

describe("useReportTerminalPalette", () => {
  beforeEach(() => vi.mocked(settingsApi.putTerminalPalette).mockReset().mockResolvedValue());
  afterEach(() => vi.useRealTimers());

  it("does nothing before settings have loaded", () => {
    renderHook(() =>
      useReportTerminalPalette({ settingsLoaded: false, colorScheme: "mullion", theme: "light" }),
    );
    expect(settingsApi.putTerminalPalette).not.toHaveBeenCalled();
  });

  it("reports the resolved palette once settings are loaded", () => {
    renderHook(() =>
      useReportTerminalPalette({ settingsLoaded: true, colorScheme: "mullion", theme: "light" }),
    );
    const t = buildXtermTheme("mullion", "light");
    expect(settingsApi.putTerminalPalette).toHaveBeenCalledTimes(1);
    expect(settingsApi.putTerminalPalette).toHaveBeenCalledWith({
      foreground: t.foreground,
      background: t.background,
      cursor: t.cursor,
    });
  });

  it("re-reports when the theme changes, and swallows a failed request", () => {
    vi.mocked(settingsApi.putTerminalPalette).mockRejectedValueOnce(new Error("offline"));
    const { rerender } = renderHook(
      (p: { theme: "dark" | "light" }) =>
        useReportTerminalPalette({ settingsLoaded: true, colorScheme: "mullion", theme: p.theme }),
      { initialProps: { theme: "light" as "dark" | "light" } },
    );
    rerender({ theme: "dark" });
    expect(settingsApi.putTerminalPalette).toHaveBeenCalledTimes(2);
    const last = vi.mocked(settingsApi.putTerminalPalette).mock.calls[1]![0];
    expect(last.background).toBe(buildXtermTheme("mullion", "dark").background);
  });

  it("retries a failed report with backoff, then stops after the last delay", async () => {
    vi.useFakeTimers();
    const put = vi.mocked(settingsApi.putTerminalPalette);
    for (let n = 0; n < 4; n++) put.mockRejectedValueOnce(new Error("offline"));
    renderHook(() =>
      useReportTerminalPalette({ settingsLoaded: true, colorScheme: "mullion", theme: "light" }),
    );
    expect(settingsApi.putTerminalPalette).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(settingsApi.putTerminalPalette).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(settingsApi.putTerminalPalette).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(settingsApi.putTerminalPalette).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(settingsApi.putTerminalPalette).toHaveBeenCalledTimes(4);
  });

  it("stops retrying once the hook unmounts", async () => {
    vi.useFakeTimers();
    vi.mocked(settingsApi.putTerminalPalette).mockRejectedValueOnce(new Error("offline"));
    const { unmount } = renderHook(() =>
      useReportTerminalPalette({ settingsLoaded: true, colorScheme: "mullion", theme: "light" }),
    );
    await vi.advanceTimersByTimeAsync(0);
    unmount();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(settingsApi.putTerminalPalette).toHaveBeenCalledTimes(1);
  });
});
