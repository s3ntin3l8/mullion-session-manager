// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SERVER_INFO_FIXTURE } from "../../test/serverInfoFixture.js";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "../../Settings.js";
import { DEFAULT_SETTINGS } from "../../api/index.js";
import { useDashboardStore } from "../../store/index.js";
import { jsonResponse } from "../../test/jsonResponse.js";

// Same fake-server-over-global-fetch pattern as Settings.integrations.test.tsx.
// The key is write-only: nothing here may ever read it back from the server.

const NOT_CONFIGURED_APP = {
  configured: false as const,
  appId: null,
  installationCount: null,
  keyFingerprint: null,
  keyRotatedAt: null,
};

describe("Settings -> Integrations -> Review relay", () => {
  let hermes: { hasKey: boolean; updatedAt: string | null };
  let testResponse: () => Response;
  let settingsPatches: Array<Record<string, unknown>>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let unexpectedCalls: string[];

  beforeEach(() => {
    // The store is a module singleton: an earlier test's committed field must
    // not leak into the next one's initial state.
    useDashboardStore.setState({ settings: DEFAULT_SETTINGS, settingsLoaded: true });
    hermes = { hasKey: false, updatedAt: null };
    testResponse = () => jsonResponse(200, { ok: true });
    settingsPatches = [];
    unexpectedCalls = [];

    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "/api/integrations/github" && method === "GET") {
        return Promise.resolve(
          jsonResponse(200, {
            connected: false,
            tokenType: null,
            login: null,
            scopes: null,
            connectedAt: null,
            deviceFlowAvailable: false,
            webhookEnabled: false,
            webhookBaseUrl: "",
            webhookRegisteredCount: 0,
            githubApp: { ...NOT_CONFIGURED_APP },
            reviewerApp: { ...NOT_CONFIGURED_APP },
          }),
        );
      }
      if (url === "/api/integrations/github/webhooks/status" && method === "GET") {
        return Promise.resolve(jsonResponse(200, { enabled: false }));
      }
      if (url === "/api/integrations/hermes" && method === "GET") {
        return Promise.resolve(jsonResponse(200, hermes));
      }
      if (url === "/api/integrations/hermes/key" && method === "PUT") {
        const { key } = JSON.parse(String(init?.body)) as { key: string };
        if (key === "reject-me") {
          return Promise.resolve(jsonResponse(400, { message: "bad key format" }));
        }
        hermes = { hasKey: true, updatedAt: "2026-01-01T00:00:00.000Z" };
        return Promise.resolve(jsonResponse(200, hermes));
      }
      if (url === "/api/integrations/hermes" && method === "DELETE") {
        hermes = { hasKey: false, updatedAt: null };
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url === "/api/integrations/hermes/test" && method === "POST") {
        return Promise.resolve(testResponse());
      }
      if (url === "/api/settings" && method === "PATCH") {
        settingsPatches.push(JSON.parse(String(init?.body)));
        return Promise.resolve(jsonResponse(200, {}));
      }
      if (url === "/api/settings" && method === "GET") {
        return Promise.resolve(jsonResponse(200, {}));
      }
      if (url === "/api/server-info" && method === "GET") {
        return Promise.resolve(jsonResponse(200, SERVER_INFO_FIXTURE));
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

  async function renderCard() {
    render(<Settings onClose={vi.fn()} initialSection="integrations" />);
    return screen.findByTestId("review-relay-section");
  }

  it("shows the relay as not configured by default", async () => {
    await renderCard();
    expect(await screen.findByText("Review relay not configured")).toBeInTheDocument();
    expect(screen.getByText(/Set the API URL, prompt repository, and API key/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear key" })).not.toBeInTheDocument();
  });

  it("saves the key write-only: clears the input and never shows it back", async () => {
    const user = userEvent.setup();
    await renderCard();
    const input = screen.getByPlaceholderText("Hermes API key");
    expect(input).toHaveAttribute("type", "password");

    await user.type(input, "sekret-key");
    await user.click(screen.getByRole("button", { name: "Save key" }));

    expect(await screen.findByText("API key set")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integrations/hermes/key",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ key: "sekret-key" }) }),
    );
    // The field is emptied and its placeholder now offers a replacement.
    const replaced = screen.getByPlaceholderText("Replace key…");
    expect(replaced).toHaveValue("");
    expect(screen.queryByDisplayValue("sekret-key")).not.toBeInTheDocument();
  });

  it("disables Save while the key field is empty", async () => {
    await renderCard();
    expect(screen.getByRole("button", { name: "Save key" })).toBeDisabled();
  });

  it("shows an inline error when the key is rejected", async () => {
    const user = userEvent.setup();
    await renderCard();
    await user.type(screen.getByPlaceholderText("Hermes API key"), "reject-me");
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(await screen.findByText(/bad key format/)).toBeInTheDocument();
    expect(screen.getByText("Review relay not configured")).toBeInTheDocument();
  });

  it("clears an existing key", async () => {
    hermes = { hasKey: true, updatedAt: "2026-01-01T00:00:00.000Z" };
    const user = userEvent.setup();
    await renderCard();
    await user.click(await screen.findByRole("button", { name: "Clear key" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/integrations/hermes",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Clear key" })).not.toBeInTheDocument(),
    );
  });

  it("commits the API URL, trimmed, on blur", async () => {
    const user = userEvent.setup();
    await renderCard();
    const url = screen.getByPlaceholderText("http://hermes.local:8643");
    await user.type(url, "  http://192.168.2.6:8643  ");
    await user.tab();
    await waitFor(() =>
      expect(settingsPatches).toContainEqual({
        reviewRelay: { apiUrl: "http://192.168.2.6:8643" },
      }),
    );
  });

  it("commits the prompt repository on Enter", async () => {
    const user = userEvent.setup();
    await renderCard();
    await user.type(screen.getByPlaceholderText("owner/repo"), "acme/.github{Enter}");
    await waitFor(() =>
      expect(settingsPatches).toContainEqual({ reviewRelay: { promptRepo: "acme/.github" } }),
    );
  });

  it("doesn't patch settings when a field is blurred unchanged", async () => {
    const user = userEvent.setup();
    await renderCard();
    await user.click(screen.getByPlaceholderText("owner/repo"));
    await user.tab();
    expect(settingsPatches).toEqual([]);
  });

  it("tests the connection and reports success", async () => {
    useDashboardStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        reviewRelay: { ...DEFAULT_SETTINGS.reviewRelay, apiUrl: "http://192.168.2.6:8643" },
      },
    });
    const user = userEvent.setup();
    await renderCard();
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Hermes API is reachable")).toBeInTheDocument();
  });

  it("reports a failed connection test inline", async () => {
    useDashboardStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        reviewRelay: { ...DEFAULT_SETTINGS.reviewRelay, apiUrl: "http://192.168.2.6:8643" },
      },
    });
    testResponse = () =>
      jsonResponse(502, { message: "Hermes API unreachable at http://192.168.2.6:8643/health" });
    const user = userEvent.setup();
    await renderCard();
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/Hermes API unreachable/)).toBeInTheDocument();
    expect(screen.queryByText("Hermes API is reachable")).not.toBeInTheDocument();
  });

  it("disables Test connection until an API URL is set", async () => {
    await renderCard();
    expect(screen.getByRole("button", { name: "Test connection" })).toBeDisabled();
  });
});
