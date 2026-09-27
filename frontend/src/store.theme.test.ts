// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useDashboardStore } from "./store/index.js";
import { DEFAULT_SETTINGS } from "./api/index.js";
import { jsonResponse } from "./test/jsonResponse.js";

// Issue #1432 — the old toggleTheme cycled the *resolved* theme (always
// dark or light) dark<->light, so once a user picked "System" in Settings,
// the toolbar's quick toggle could only ever knock them off it, never back
// onto it. cycleTheme instead cycles the *preference* itself
// (dark -> light -> system -> dark), same fake-in-memory-backend pattern as
// Settings.terminalVoice.test.tsx.
describe("store.cycleTheme", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/settings" && method === "PATCH") {
        return Promise.resolve(jsonResponse(200, DEFAULT_SETTINGS));
      }
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    useDashboardStore.setState({
      settings: { ...DEFAULT_SETTINGS, theme: "dark" },
      settingsLoaded: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("cycles dark -> light -> system -> dark, never skipping system", () => {
    const { cycleTheme } = useDashboardStore.getState();

    cycleTheme();
    expect(useDashboardStore.getState().settings.theme).toBe("light");

    cycleTheme();
    expect(useDashboardStore.getState().settings.theme).toBe("system");

    cycleTheme();
    expect(useDashboardStore.getState().settings.theme).toBe("dark");
  });

  it("PATCHes each step to the server, debounced", async () => {
    useDashboardStore.getState().cycleTheme();

    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ theme: "light" }),
        }),
      ),
    );
  });

  it("round-trips out of system back to dark", () => {
    useDashboardStore.setState({ settings: { ...DEFAULT_SETTINGS, theme: "system" } });
    useDashboardStore.getState().cycleTheme();
    expect(useDashboardStore.getState().settings.theme).toBe("dark");
  });
});
