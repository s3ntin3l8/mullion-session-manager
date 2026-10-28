// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useReportTerminalPalette } from "./useReportTerminalPalette.js";
import { settingsApi } from "../api/settings.js";
import { buildXtermTheme } from "../terminalTheme.js";

vi.mock("../api/settings.js", () => ({
  settingsApi: { putTerminalPalette: vi.fn(() => Promise.resolve()) },
}));

describe("useReportTerminalPalette", () => {
  beforeEach(() => vi.mocked(settingsApi.putTerminalPalette).mockClear());

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
});
