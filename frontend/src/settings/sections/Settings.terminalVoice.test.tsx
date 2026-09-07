// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "../../Settings.js";
import { useDashboardStore } from "../../store/index.js";
import { DEFAULT_SETTINGS } from "../../api/index.js";
import { jsonResponse } from "../../test/jsonResponse.js";

// Model: Settings.notifications.test.tsx's fake-in-memory-backend pattern —
// renders the real Settings modal (TerminalSection reads settings/
// updateSettings straight off the store, same as every other section) with
// initialSection="terminal", and asserts both the immediate optimistic
// store write and the debounced PATCH body.
describe("Settings -> Terminal -> Voice dictation", () => {
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
    useDashboardStore.setState({ settings: DEFAULT_SETTINGS, settingsLoaded: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the voice dictation toggles and language dropdown with their current values", async () => {
    render(<Settings onClose={vi.fn()} initialSection="terminal" />);

    await screen.findByText("Voice dictation");
    expect(screen.getByText("Enable dictation")).toBeInTheDocument();
    expect(screen.getByText("Dictation hotkey")).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveValue("");
  });

  it("toggling 'Enable dictation' off patches terminal.voice.enabled and PATCHes it, debounced", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="terminal" />);

    const toggle = await screen.findByRole("button", { name: "Enable dictation" });
    await user.click(toggle);

    expect(useDashboardStore.getState().settings.terminal.voice.enabled).toBe(false);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ terminal: { voice: { enabled: false } } }),
        }),
      ),
    );
  });

  it("toggling the hotkey off leaves 'Enable dictation' untouched", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="terminal" />);

    const toggle = await screen.findByRole("button", { name: "Dictation hotkey" });
    await user.click(toggle);

    const voice = useDashboardStore.getState().settings.terminal.voice;
    expect(voice.hotkeyEnabled).toBe(false);
    expect(voice.enabled).toBe(true);

    // Waited out (not fire-and-forget) so this test's debounced PATCH
    // flushes and clears the store slice's own module-scoped
    // pendingPatch/patchTimer before the next test runs — updateSettings()
    // (store/slices/ui.ts) merges an in-flight pendingPatch across calls,
    // so an unflushed patch left behind here would otherwise bleed into
    // the next test's own PATCH body assertion.
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ terminal: { voice: { hotkeyEnabled: false } } }),
        }),
      ),
    );
  });

  it("changing the dictation language patches terminal.voice.lang", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="terminal" />);

    await screen.findByText("Dictation language");
    await user.selectOptions(screen.getByRole("combobox"), "de-DE");

    expect(useDashboardStore.getState().settings.terminal.voice.lang).toBe("de-DE");
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ terminal: { voice: { lang: "de-DE" } } }),
        }),
      ),
    );
  });
});
