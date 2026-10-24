// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RunwaySection } from "./RunwaySection.js";
import { DEFAULT_SETTINGS } from "../../api/index.js";
import { useDashboardStore } from "../../store/index.js";
import { jsonResponse } from "../../test/jsonResponse.js";

// Same fake-server-over-global-fetch pattern as Settings.reviewRelay.test.tsx:
// the admin key is write-only, so nothing here may ever read it back.

describe("Settings -> Integrations -> Runway quota", () => {
  let runway: { hasKey: boolean; updatedAt: string | null };
  let settingsPatches: Array<Record<string, unknown>>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let unexpectedCalls: string[];

  beforeEach(() => {
    // The store is a module singleton: an earlier test's committed field must
    // not leak into the next one's initial state.
    useDashboardStore.setState({
      settings: { ...DEFAULT_SETTINGS },
      settingsLoaded: true,
    });
    runway = { hasKey: false, updatedAt: null };
    settingsPatches = [];
    unexpectedCalls = [];

    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "/api/integrations/runway" && method === "GET") {
        return Promise.resolve(jsonResponse(200, runway));
      }
      if (url === "/api/integrations/runway/key" && method === "PUT") {
        const { key } = JSON.parse(String(init?.body)) as { key: string };
        if (key === "reject-me") {
          return Promise.resolve(jsonResponse(400, { message: "bad key format" }));
        }
        runway = { hasKey: true, updatedAt: "2026-01-01T00:00:00.000Z" };
        return Promise.resolve(jsonResponse(200, runway));
      }
      if (url === "/api/integrations/runway" && method === "DELETE") {
        runway = { hasKey: false, updatedAt: null };
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url === "/api/settings" && method === "PATCH") {
        settingsPatches.push(JSON.parse(String(init?.body)));
        return Promise.resolve(jsonResponse(200, {}));
      }

      unexpectedCalls.push(`${method} ${url}`);
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    expect(unexpectedCalls).toEqual([]);
    vi.unstubAllGlobals();
  });

  async function renderSection() {
    render(<RunwaySection />);
    return screen.findByTestId("runway-section");
  }

  function statusDot() {
    return screen.getByTestId("runway-row").querySelector(".settings-status-dot");
  }

  it("renders the section", async () => {
    await renderSection();
    expect(screen.getByText("Runway quota")).toBeInTheDocument();
    expect(screen.getByText(/separate AI-usage tracker/)).toBeInTheDocument();
  });

  it("is not configured until both a URL and a key are there", async () => {
    await renderSection();
    expect(await screen.findByText("Runway quota not configured")).toBeInTheDocument();
    expect(statusDot()).toHaveClass("off");
  });

  it("is ready with a URL and a key", async () => {
    useDashboardStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        runway: { ...DEFAULT_SETTINGS.runway, apiUrl: "https://runway.example.com" },
      },
    });
    runway = { hasKey: true, updatedAt: "2026-01-01T00:00:00.000Z" };
    await renderSection();
    expect(await screen.findByText("Runway quota ready")).toBeInTheDocument();
    expect(statusDot()).toHaveClass("on");
    expect(screen.getByText("API key set")).toBeInTheDocument();
  });

  it("commits the server URL, trimmed, on blur", async () => {
    const user = userEvent.setup();
    await renderSection();
    const url = screen.getByLabelText("Runway server URL");
    await user.type(url, "  https://runway.example.com  ");
    await user.tab();
    await waitFor(() =>
      expect(settingsPatches).toContainEqual({
        runway: { apiUrl: "https://runway.example.com" },
      }),
    );
  });

  it("commits the poll interval", async () => {
    const user = userEvent.setup();
    await renderSection();
    // The poll interval is the section's only number field.
    const field = screen.getByRole("spinbutton");
    await user.clear(field);
    await user.type(field, "120");
    await user.tab();
    await waitFor(() => expect(settingsPatches).toContainEqual({ runway: { pollSeconds: 120 } }));
  });

  it("saves the admin key write-only: clears the input and never shows it back", async () => {
    const user = userEvent.setup();
    await renderSection();
    const input = screen.getByLabelText("Admin key");
    expect(input).toHaveAttribute("type", "password");

    await user.type(input, "sekret-key");
    await user.click(screen.getByRole("button", { name: "Save key" }));

    expect(await screen.findByText("API key set")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integrations/runway/key",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ key: "sekret-key" }) }),
    );
    // The summary is re-read: the server owns the "is a key set" answer.
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => url === "/api/integrations/runway").length,
      ).toBeGreaterThan(1),
    );
    // The field is emptied and its placeholder now offers a replacement.
    expect(screen.getByPlaceholderText("Replace key…")).toHaveValue("");
    expect(screen.queryByDisplayValue("sekret-key")).not.toBeInTheDocument();
  });

  it("shows an inline error when the key is rejected", async () => {
    const user = userEvent.setup();
    await renderSection();
    await user.type(screen.getByLabelText("Admin key"), "reject-me");
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(await screen.findByText(/bad key format/)).toBeInTheDocument();
    expect(screen.getByText("Runway quota not configured")).toBeInTheDocument();
  });

  it("clears an existing key", async () => {
    runway = { hasKey: true, updatedAt: "2026-01-01T00:00:00.000Z" };
    const user = userEvent.setup();
    await renderSection();
    await user.click(await screen.findByRole("button", { name: "Clear key" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/integrations/runway",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Clear key" })).not.toBeInTheDocument(),
    );
  });

  it("commits a valid provider map", async () => {
    const user = userEvent.setup();
    await renderSection();
    const field = screen.getByLabelText("Provider map");
    await user.clear(field);
    await user.click(field);
    await user.paste('{"anthropic":"claude-code"}');
    await user.tab();
    await waitFor(() =>
      expect(settingsPatches).toContainEqual({
        runway: { providerMap: { anthropic: "claude-code" } },
      }),
    );
  });

  it("refuses an invalid provider map and leaves the setting alone", async () => {
    const user = userEvent.setup();
    await renderSection();
    const field = screen.getByLabelText("Provider map");
    await user.clear(field);
    await user.click(field);
    await user.paste("{not json");
    await user.tab();

    expect(await screen.findByText(/not valid JSON/i)).toBeInTheDocument();
    expect(settingsPatches).toEqual([]);
    expect(useDashboardStore.getState().settings.runway.providerMap).toEqual(
      DEFAULT_SETTINGS.runway.providerMap,
    );
  });

  it("refuses a provider map that is not a string-to-string object", async () => {
    const user = userEvent.setup();
    await renderSection();
    const field = screen.getByLabelText("Provider map");
    await user.clear(field);
    await user.click(field);
    await user.paste('{"anthropic": 7}');
    await user.tab();

    expect(await screen.findByText(/must be a JSON object/i)).toBeInTheDocument();
    expect(settingsPatches).toEqual([]);
  });

  it("explains that the map names providers, not agents", async () => {
    await renderSection();
    expect(screen.getByText(/name PROVIDERS/)).toBeInTheDocument();
    expect(screen.getByText(/never quarantined/)).toBeInTheDocument();
  });
});
