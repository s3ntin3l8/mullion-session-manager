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

  it("shows the relay as not configured by default", async () => {
    await renderCard();
    expect(await screen.findByText("Review relay not configured")).toBeInTheDocument();
    expect(screen.getByText(/Set the API URL and API key/)).toBeInTheDocument();
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
    // Two fields share the "owner/repo" placeholder — the review prompt's
    // and the triage prompt's (#1629). The first is the review one.
    await user.type(screen.getAllByPlaceholderText("owner/repo")[0], "acme/.github{Enter}");
    await waitFor(() =>
      expect(settingsPatches).toContainEqual({ reviewRelay: { promptRepo: "acme/.github" } }),
    );
  });

  it("commits the triage prompt repository and path (#1629)", async () => {
    const user = userEvent.setup();
    await renderCard();
    // The second "owner/repo" field is the triage prompt's (#1629).
    await user.type(screen.getAllByPlaceholderText("owner/repo")[1], "acme/.github{Enter}");
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
    await user.click(screen.getAllByPlaceholderText("owner/repo")[0]);
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
