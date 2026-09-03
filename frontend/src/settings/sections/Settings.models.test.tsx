// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "../../Settings.js";
import { useDashboardStore } from "../../store/index.js";
import { DEFAULT_SETTINGS } from "../../api/index.js";
import { jsonResponse } from "../../test/jsonResponse.js";

// Ergonomics coverage for ModelsSection — NOT the regression test for the
// route↔client shape mismatch that crashed this pane. That's
// test/routes/opencode-models.test.ts, which pins the actual wire contract;
// a mocked-catalog component test like this one would pass identically
// whether the real route wraps the array or not.
const MODELS = ["anthropic/claude-sonnet-4-5", "openrouter/minimax-m3"];

describe("Settings -> Models", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/opencode/models" && method === "GET") {
        return Promise.resolve(jsonResponse(200, MODELS));
      }
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

  it("populates all three selects from the model catalog", async () => {
    render(<Settings onClose={vi.fn()} initialSection="models" />);

    const selects = await screen.findAllByRole("combobox");
    expect(selects).toHaveLength(3);
    for (const select of selects) {
      const options = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
      expect(options).toEqual(["— None (CLI default) —", ...MODELS]);
    }
  });

  it("is not disabled when the default agent is not opencode", async () => {
    useDashboardStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        launchers: { ...DEFAULT_SETTINGS.launchers, defaultAgent: "claude" },
      },
      settingsLoaded: true,
    });
    render(<Settings onClose={vi.fn()} initialSection="models" />);

    const selects = await screen.findAllByRole("combobox");
    expect(selects).toHaveLength(3);
    for (const select of selects) {
      expect(select).not.toBeDisabled();
    }
  });

  it("selecting a model PATCHes settings.opencode with the chosen key only", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="models" />);

    const [implementerSelect] = await screen.findAllByRole("combobox");
    // Wait for the catalog fetch to resolve and populate the <option>s
    // before selecting — the selects render immediately (with just the
    // "None" option) while the fetch is still in flight.
    await waitFor(() =>
      expect(
        within(implementerSelect).getByText("anthropic/claude-sonnet-4-5"),
      ).toBeInTheDocument(),
    );
    await user.selectOptions(implementerSelect, "anthropic/claude-sonnet-4-5");

    expect(useDashboardStore.getState().settings.opencode?.implementerModel).toBe(
      "anthropic/claude-sonnet-4-5",
    );

    // SETTINGS_PATCH_DEBOUNCE_MS (400ms) + headroom for CI load, same as
    // Settings.notifications.test.tsx's equivalent debounce assertion.
    await waitFor(
      () =>
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/settings",
          expect.objectContaining({
            method: "PATCH",
            body: JSON.stringify({
              opencode: { implementerModel: "anthropic/claude-sonnet-4-5" },
            }),
          }),
        ),
      { timeout: 2000 },
    );
  });

  it("shows a hint when the catalog fails to load", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/opencode/models" && method === "GET") {
        return Promise.resolve(jsonResponse(500, { message: "boom" }));
      }
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    });
    render(<Settings onClose={vi.fn()} initialSection="models" />);

    expect(await screen.findByText(/couldn't load the model catalog/i)).toBeInTheDocument();
  });

  // Code review caught this branch and the one above swapped relative to
  // reality: the backend's listOpenCodeModels() swallows every exec
  // failure (including "opencode not installed") into a 200 `[]`, so THIS
  // branch — not the HTTP-error one above — is what a user without
  // opencode installed actually sees.
  it("shows a hint when the catalog loads successfully but is empty (e.g. opencode not installed)", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/opencode/models" && method === "GET") {
        return Promise.resolve(jsonResponse(200, []));
      }
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    });
    render(<Settings onClose={vi.fn()} initialSection="models" />);

    expect(
      await screen.findByText(/opencode returned no models.*installed.*configured provider/i),
    ).toBeInTheDocument();
  });
});
