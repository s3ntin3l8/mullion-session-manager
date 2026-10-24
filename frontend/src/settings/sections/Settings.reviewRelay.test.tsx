// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SERVER_INFO_FIXTURE } from "../../test/serverInfoFixture.js";
import { render, screen, waitFor, within } from "@testing-library/react";
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
  let modelOptions: () => Response;
  let reviewRuns: Array<Record<string, unknown>>;
  let reviewsResponse: (() => Response) | null;
  let settingsPatches: Array<Record<string, unknown>>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let unexpectedCalls: string[];

  beforeEach(() => {
    // The store is a module singleton: an earlier test's committed field must
    // not leak into the next one's initial state.
    useDashboardStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        reviewRelay: { ...DEFAULT_SETTINGS.reviewRelay, provider: "hermes" },
      },
      settingsLoaded: true,
    });
    hermes = { hasKey: false, updatedAt: null };
    testResponse = () => jsonResponse(200, { ok: true });
    modelOptions = () => jsonResponse(200, { available: false, reason: "unreachable" });
    reviewRuns = [];
    reviewsResponse = null;
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
      // The Runway section lives next to the review relay in the same
      // settings section — it asks for its own (write-only) key summary.
      if (url === "/api/integrations/runway" && method === "GET") {
        return Promise.resolve(jsonResponse(200, { hasKey: false, updatedAt: null }));
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
      if (url === "/api/integrations/hermes/model-options" && method === "GET") {
        return Promise.resolve(modelOptions());
      }
      if (url === "/api/integrations/hermes/test" && method === "POST") {
        return Promise.resolve(testResponse());
      }
      if (url === "/api/reviews" && method === "GET") {
        return Promise.resolve(reviewsResponse?.() ?? jsonResponse(200, { runs: reviewRuns }));
      }
      if (url.startsWith("/api/reviews/") && url.endsWith("/stop") && method === "POST") {
        const runId = decodeURIComponent(url.slice("/api/reviews/".length, -"/stop".length));
        reviewRuns = reviewRuns.map((r) => (r.runId === runId ? { ...r, status: "cancelled" } : r));
        return Promise.resolve(jsonResponse(200, { runId, status: "stopping" }));
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

  // Scoped to the relay's own section: the Runway section sits next to it in
  // the same settings section and has a "Save key"/"Clear key" button of its
  // own, so an unscoped query would match both.
  function relay() {
    return within(screen.getByTestId("review-relay-section"));
  }

  it("shows the relay as not configured by default", async () => {
    await renderCard();
    expect(await screen.findByText("Review relay not configured")).toBeInTheDocument();
    expect(screen.getByText(/Set the API URL and API key/)).toBeInTheDocument();
    expect(relay().queryByRole("button", { name: "Clear key" })).not.toBeInTheDocument();
  });

  it("saves the key write-only: clears the input and never shows it back", async () => {
    const user = userEvent.setup();
    await renderCard();
    const input = screen.getByPlaceholderText("Hermes API key");
    expect(input).toHaveAttribute("type", "password");

    await user.type(input, "sekret-key");
    await user.click(relay().getByRole("button", { name: "Save key" }));

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
    expect(relay().getByRole("button", { name: "Save key" })).toBeDisabled();
  });

  it("shows an inline error when the key is rejected", async () => {
    const user = userEvent.setup();
    await renderCard();
    await user.type(screen.getByPlaceholderText("Hermes API key"), "reject-me");
    await user.click(relay().getByRole("button", { name: "Save key" }));
    expect(await screen.findByText(/bad key format/)).toBeInTheDocument();
    expect(screen.getByText("Review relay not configured")).toBeInTheDocument();
  });

  it("clears an existing key", async () => {
    hermes = { hasKey: true, updatedAt: "2026-01-01T00:00:00.000Z" };
    const user = userEvent.setup();
    await renderCard();
    await user.click(await relay().findByRole("button", { name: "Clear key" }));
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
    // Named, not positional: the review prompt's and the triage prompt's
    // (#1629) fields share a placeholder, so a query by position would
    // silently re-point if the rows were reordered.
    await user.type(screen.getByLabelText("Prompt repository"), "acme/.github{Enter}");
    await waitFor(() =>
      expect(settingsPatches).toContainEqual({ reviewRelay: { promptRepo: "acme/.github" } }),
    );
  });

  it("commits the triage prompt repository and path (#1629)", async () => {
    const user = userEvent.setup();
    await renderCard();
    await user.type(screen.getByLabelText("Triage prompt repository"), "acme/.github{Enter}");
    await waitFor(() =>
      expect(settingsPatches).toContainEqual({ reviewRelay: { triagePromptRepo: "acme/.github" } }),
    );
    const paths = screen.getAllByDisplayValue("hermes-triage-prompt.md");
    expect(paths.length).toBeGreaterThan(0);
    await user.clear(paths[0]);
    await user.type(paths[0], "custom-triage.md{Enter}");
    await waitFor(() =>
      expect(settingsPatches).toContainEqual({
        reviewRelay: { triagePromptPath: "custom-triage.md" },
      }),
    );
  });

  it("doesn't patch settings when a field is blurred unchanged", async () => {
    const user = userEvent.setup();
    await renderCard();
    await user.click(screen.getByLabelText("Prompt repository"));
    await user.tab();
    expect(settingsPatches).toEqual([]);
  });

  it("tests the connection and reports success", async () => {
    useDashboardStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        reviewRelay: {
          ...DEFAULT_SETTINGS.reviewRelay,
          provider: "hermes",
          apiUrl: "http://192.168.2.6:8643",
        },
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
        reviewRelay: {
          ...DEFAULT_SETTINGS.reviewRelay,
          provider: "hermes",
          apiUrl: "http://192.168.2.6:8643",
        },
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

  it("hides the Hermes fields when the reviewer is None", async () => {
    useDashboardStore.setState({ settings: DEFAULT_SETTINGS });
    await renderCard();
    expect(screen.getByTestId("review-relay-none")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("owner/repo")).not.toBeInTheDocument();
  });

  it("switches the reviewer to Hermes", async () => {
    useDashboardStore.setState({ settings: DEFAULT_SETTINGS });
    const user = userEvent.setup();
    await renderCard();
    await user.click(screen.getByRole("button", { name: "Hermes" }));
    await waitFor(() =>
      expect(settingsPatches).toContainEqual({ reviewRelay: { provider: "hermes" } }),
    );
  });

  it("is ready with just a URL and key, no prompt repository", async () => {
    useDashboardStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        reviewRelay: {
          ...DEFAULT_SETTINGS.reviewRelay,
          provider: "hermes",
          apiUrl: "http://192.168.2.6:8643",
        },
      },
    });
    hermes = { hasKey: true, updatedAt: "2026-01-01T00:00:00.000Z" };
    await renderCard();
    expect(await screen.findByText("Review relay ready")).toBeInTheDocument();
  });

  describe("model picker (#1775)", () => {
    const PROVIDERS = [
      { provider: "anthropic", name: "Anthropic", models: ["claude-sonnet-5-5"] },
      { provider: "openrouter", name: "OpenRouter", models: ["llama3:8b", "x/y:free"] },
    ];
    const picker = () => screen.getByLabelText("Review relay model");

    function configure(reviewRelay: Record<string, unknown> = {}) {
      hermes = { hasKey: true, updatedAt: "2026-01-01T00:00:00.000Z" };
      useDashboardStore.setState({
        settings: {
          ...DEFAULT_SETTINGS,
          reviewRelay: {
            ...DEFAULT_SETTINGS.reviewRelay,
            provider: "hermes",
            apiUrl: "http://192.168.2.6:8642/p/review-bot",
            ...reviewRelay,
          },
        },
        settingsLoaded: true,
      });
    }

    it("defaults to the profile default, then offers Hermes' models", async () => {
      configure();
      modelOptions = () => jsonResponse(200, { available: true, providers: PROVIDERS });
      await renderCard();
      expect(
        await within(picker()).findByRole("option", { name: "claude-sonnet-5-5 (Anthropic)" }),
      ).toBeInTheDocument();
      expect(
        within(picker()).getByRole("option", { name: "llama3:8b (OpenRouter)" }),
      ).toBeInTheDocument();
      expect(picker()).toHaveValue("");
      expect(
        within(picker()).getByRole("option", { name: "Profile default (hermes-agent)" }),
      ).toBeInTheDocument();
    });

    it("stores the model with its provider, splitting only on the first colon", async () => {
      configure();
      modelOptions = () => jsonResponse(200, { available: true, providers: PROVIDERS });
      const user = userEvent.setup();
      await renderCard();
      await within(picker()).findByRole("option", { name: "llama3:8b (OpenRouter)" });
      await user.selectOptions(picker(), "llama3:8b (OpenRouter)");
      await waitFor(() =>
        expect(settingsPatches).toContainEqual({
          reviewRelay: { model: "llama3:8b", modelProvider: "openrouter" },
        }),
      );
    });

    it("goes back to the profile default with the alias and no provider", async () => {
      configure({ model: "claude-sonnet-5-5", modelProvider: "anthropic" });
      modelOptions = () => jsonResponse(200, { available: true, providers: PROVIDERS });
      const user = userEvent.setup();
      await renderCard();
      await within(picker()).findByRole("option", { name: "claude-sonnet-5-5 (Anthropic)" });
      expect(picker()).toHaveValue("anthropic:claude-sonnet-5-5");
      await user.selectOptions(picker(), "Profile default (hermes-agent)");
      await waitFor(() =>
        expect(settingsPatches).toContainEqual({
          reviewRelay: { model: "hermes-agent", modelProvider: "" },
        }),
      );
    });

    it("says so and keeps Custom… working when Hermes can't list models", async () => {
      configure();
      const user = userEvent.setup();
      await renderCard();
      expect(
        await screen.findByText(/Couldn't load the model list from Hermes/),
      ).toBeInTheDocument();
      await user.selectOptions(picker(), "Custom…");
      await user.type(screen.getByLabelText("Review relay model (custom model ID)"), "my-model");
      await user.tab();
      await waitFor(() =>
        expect(settingsPatches).toContainEqual({
          reviewRelay: { model: "my-model", modelProvider: "" },
        }),
      );
    });

    it("explains an empty list instead of showing only Profile default and Custom", async () => {
      configure();
      modelOptions = () => jsonResponse(200, { available: true, providers: [] });
      await renderCard();
      expect(await screen.findByText(/no authenticated provider with models/)).toBeInTheDocument();
    });

    it("keeps the stored provider when an edit under it is committed while the list is down", async () => {
      configure({ model: "llama3:8b", modelProvider: "openrouter" });
      const user = userEvent.setup();
      await renderCard();
      expect(await screen.findByText(/Couldn't load the model list/)).toBeInTheDocument();
      const field = screen.getByLabelText("Review relay model (custom model ID)");
      expect(field).toHaveValue("openrouter:llama3:8b");
      await user.clear(field);
      await user.type(field, "openrouter:llama3:70b");
      await user.tab();
      await waitFor(() =>
        expect(settingsPatches).toContainEqual({
          reviewRelay: { model: "llama3:70b", modelProvider: "openrouter" },
        }),
      );
    });

    it("blames the key when Hermes rejects it", async () => {
      configure();
      modelOptions = () => jsonResponse(200, { available: false, reason: "unauthorized" });
      await renderCard();
      expect(await screen.findByText(/Hermes rejected the API key/)).toBeInTheDocument();
    });

    it("shows a stored model the list doesn't know (e.g. an old bad value) as custom", async () => {
      configure({ model: "review-bot" });
      modelOptions = () => jsonResponse(200, { available: true, providers: PROVIDERS });
      await renderCard();
      expect(await screen.findByDisplayValue("review-bot")).toBeInTheDocument();
      expect(picker()).toHaveValue("__custom__");
    });

    it("asks Hermes nothing until a URL and key are set", async () => {
      await renderCard();
      expect(
        await screen.findByText(/Set the API URL and key to load the model list/),
      ).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalledWith(
        "/api/integrations/hermes/model-options",
        expect.anything(),
      );
    });
  });

  describe("recent reviews", () => {
    const run = (over: Record<string, unknown>) => ({
      runId: "run_1",
      status: "running",
      repo: "acme/widgets",
      prNumber: 7,
      headSha: "abc1234",
      dispatchedAt: "2026-01-01T10:00:00.000Z",
      shuttingDown: false,
      ...over,
    });

    beforeEach(() => {
      hermes = { hasKey: true, updatedAt: "2026-01-01T00:00:00.000Z" };
      useDashboardStore.setState({
        settings: {
          ...DEFAULT_SETTINGS,
          reviewRelay: {
            ...DEFAULT_SETTINGS.reviewRelay,
            provider: "hermes",
            apiUrl: "http://192.168.2.6:8643",
          },
        },
        settingsLoaded: true,
      });
    });

    it("is hidden until the relay is configured", async () => {
      hermes = { hasKey: false, updatedAt: null };
      await renderCard();
      await screen.findByText("Review relay not configured");
      expect(screen.queryByTestId("review-relay-recent")).not.toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalledWith("/api/reviews", expect.anything());
    });

    it("says so when nothing was requested yet", async () => {
      await renderCard();
      expect(await screen.findByText("No reviews requested yet.")).toBeInTheDocument();
    });

    it("lists runs and stops an active one only after the confirm click", async () => {
      reviewRuns = [
        run({}),
        run({ runId: "run_2", prNumber: 8, status: "completed" }),
        run({ runId: "run_3", prNumber: 9, status: "failed", error: "no App credentials" }),
      ];
      const user = userEvent.setup();
      await renderCard();
      const active = await screen.findByTestId("review-run-run_1");
      expect(active).toHaveTextContent("acme/widgets#7");
      expect(active).toHaveTextContent("running");
      expect(screen.getByTestId("review-run-run_3")).toHaveTextContent("no App credentials");
      // Finished runs have nothing to stop.
      expect(screen.getByTestId("review-run-run_2")).not.toHaveTextContent("Stop");

      await user.click(within(active).getByRole("button"));
      expect(fetchMock).not.toHaveBeenCalledWith("/api/reviews/run_1/stop", expect.anything());
      await user.click(within(active).getByRole("button"));
      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/reviews/run_1/stop",
          expect.objectContaining({ method: "POST" }),
        ),
      );
      // The list reloads and shows the new status.
      await waitFor(() =>
        expect(screen.getByTestId("review-run-run_1")).toHaveTextContent("cancelled"),
      );
    });

    it("refreshes on demand", async () => {
      const user = userEvent.setup();
      await renderCard();
      await screen.findByText("No reviews requested yet.");
      reviewRuns = [run({})];
      await user.click(screen.getByRole("button", { name: "Refresh" }));
      expect(await screen.findByTestId("review-run-run_1")).toBeInTheDocument();
    });

    it("shows the server's message when the list can't be loaded", async () => {
      reviewsResponse = () => jsonResponse(503, { message: "The Hermes API is unreachable" });
      await renderCard();
      expect(await screen.findByText(/The Hermes API is unreachable/)).toBeInTheDocument();
    });
  });
});
