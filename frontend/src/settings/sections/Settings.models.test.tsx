// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelsSection } from "./ModelsSection.js";
import { useDashboardStore } from "../../store/index.js";
import { DEFAULT_SETTINGS } from "../../api/index.js";
import { jsonResponse } from "../../test/jsonResponse.js";

// Ergonomics coverage for ModelsSection — NOT the regression test for the
// route↔client shape mismatch that crashed this pane. That's
// test/routes/opencode-models.test.ts, which pins the actual wire contract;
// a mocked-catalog component test like this one would pass identically
// whether the real route wraps the array or not.
const MODELS = ["anthropic/claude-sonnet-4-5", "openrouter/minimax-m3"];
const AGY_MODELS = ["gemini-3.1-pro-high", "claude-sonnet-4-6"];

describe("Settings -> Models", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const routeFetch = (overrides: Record<string, () => Response> = {}) =>
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && overrides[url]) return Promise.resolve(overrides[url]());
      if (url === "/api/opencode/models" && method === "GET") {
        return Promise.resolve(jsonResponse(200, MODELS));
      }
      if (url === "/api/agy/models" && method === "GET") {
        return Promise.resolve(jsonResponse(200, AGY_MODELS));
      }
      if (url === "/api/settings" && method === "PATCH") {
        return Promise.resolve(jsonResponse(200, DEFAULT_SETTINGS));
      }
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    });

  const patchBodies = () =>
    fetchMock.mock.calls
      .filter(([url, init]) => url === "/api/settings" && init?.method === "PATCH")
      .map(([, init]) => init.body as string);

  // SETTINGS_PATCH_DEBOUNCE_MS (400ms) + headroom for CI load, same as
  // Settings.notifications.test.tsx's equivalent debounce assertion.
  const expectPatch = (body: unknown) =>
    waitFor(() => expect(patchBodies()).toContain(JSON.stringify(body)), { timeout: 2000 });

  const settle = () => new Promise((r) => setTimeout(r, 700));

  beforeEach(() => {
    fetchMock = vi.fn();
    routeFetch();
    vi.stubGlobal("fetch", fetchMock);
    useDashboardStore.setState({ settings: DEFAULT_SETTINGS, settingsLoaded: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("populates the opencode selects from the catalog", async () => {
    render(<ModelsSection />);

    for (const name of ["Implementer model", "Reviewer model", "Small model"]) {
      const select = screen.getByRole("combobox", { name });
      await waitFor(() =>
        expect(Array.from(select.querySelectorAll("option")).map((o) => o.textContent)).toEqual([
          "opencode default",
          ...MODELS,
        ]),
      );
    }
  });

  it("offers opusplan for Claude Code and PATCHes it", async () => {
    const user = userEvent.setup();
    render(<ModelsSection />);

    const select = screen.getByRole("combobox", { name: "Claude Code default model" });
    const options = Array.from(select.querySelectorAll("option")).map((o) =>
      o.getAttribute("value"),
    );
    expect(options).toEqual(expect.arrayContaining(["opusplan", "opusplan[1m]", "__custom__"]));
    await user.selectOptions(select, "opusplan");

    expect(useDashboardStore.getState().settings.claudeCode.defaultModel).toBe("opusplan");
    await expectPatch({ claudeCode: { defaultModel: "opusplan" } });
  });

  it("PATCHes null when a CLI is set back to its default", async () => {
    const user = userEvent.setup();
    useDashboardStore.setState({
      settings: { ...DEFAULT_SETTINGS, codex: { defaultModel: "gpt-5.5" } },
      settingsLoaded: true,
    });
    render(<ModelsSection />);

    const select = screen.getByRole("combobox", { name: "Codex default model" });
    expect(select).toHaveValue("gpt-5.5");
    await user.selectOptions(select, "");

    await expectPatch({ codex: { defaultModel: null } });
  });

  it("saves a custom model ID on blur", async () => {
    const user = userEvent.setup();
    render(<ModelsSection />);

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Claude Code default model" }),
      "__custom__",
    );
    const input = screen.getByRole("textbox", { name: /Claude Code default model \(custom/ });
    // `[[` is user-event's escape for a literal `[`.
    await user.type(input, "claude-opus-4-5[[1m]");
    // Nothing is saved while typing.
    await settle();
    expect(patchBodies()).toEqual([]);
    await user.tab();

    await expectPatch({ claudeCode: { defaultModel: "claude-opus-4-5[1m]" } });
  });

  it("saves a custom model ID on Enter", async () => {
    const user = userEvent.setup();
    render(<ModelsSection />);

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Codex default model" }),
      "__custom__",
    );
    await user.type(
      screen.getByRole("textbox", { name: /Codex default model \(custom/ }),
      "gpt-7{Enter}",
    );

    await expectPatch({ codex: { defaultModel: "gpt-7" } });
  });

  it("rejects an invalid custom model ID with an inline error and no PATCH", async () => {
    const user = userEvent.setup();
    render(<ModelsSection />);

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Claude Code default model" }),
      "__custom__",
    );
    await user.type(
      screen.getByRole("textbox", { name: /Claude Code default model \(custom/ }),
      "bad model;rm",
    );
    await user.tab();

    expect(await screen.findByRole("alert")).toHaveTextContent(/letters, digits/i);
    await settle();
    expect(patchBodies()).toEqual([]);
    expect(useDashboardStore.getState().settings.claudeCode.defaultModel).toBeNull();
  });

  it("clears the setting when the custom field is emptied", async () => {
    const user = userEvent.setup();
    useDashboardStore.setState({
      settings: { ...DEFAULT_SETTINGS, claudeCode: { defaultModel: "claude-opus-4-5" } },
      settingsLoaded: true,
    });
    render(<ModelsSection />);

    const input = screen.getByRole("textbox", { name: /Claude Code default model \(custom/ });
    await user.clear(input);
    await user.tab();

    await expectPatch({ claudeCode: { defaultModel: null } });
  });

  it("opens in custom mode for a stored value the list doesn't know", () => {
    useDashboardStore.setState({
      settings: { ...DEFAULT_SETTINGS, claudeCode: { defaultModel: "claude-opus-4-5" } },
      settingsLoaded: true,
    });
    render(<ModelsSection />);

    expect(screen.getByRole("combobox", { name: "Claude Code default model" })).toHaveValue(
      "__custom__",
    );
    expect(screen.getByRole("textbox", { name: /Claude Code default model \(custom/ })).toHaveValue(
      "claude-opus-4-5",
    );
  });

  it("populates the agy select from /api/agy/models and PATCHes the choice", async () => {
    const user = userEvent.setup();
    render(<ModelsSection />);

    const select = screen.getByRole("combobox", { name: "agy default model" });
    await waitFor(() =>
      expect(within(select).getByText("gemini-3.1-pro-high")).toBeInTheDocument(),
    );
    await user.selectOptions(select, "gemini-3.1-pro-high");

    await expectPatch({ agy: { defaultModel: "gemini-3.1-pro-high" } });
  });

  it("selecting an opencode model PATCHes settings.opencode with the chosen key only", async () => {
    const user = userEvent.setup();
    render(<ModelsSection />);

    const select = screen.getByRole("combobox", { name: "Implementer model" });
    await waitFor(() =>
      expect(within(select).getByText("anthropic/claude-sonnet-4-5")).toBeInTheDocument(),
    );
    await user.selectOptions(select, "anthropic/claude-sonnet-4-5");

    expect(useDashboardStore.getState().settings.opencode?.implementerModel).toBe(
      "anthropic/claude-sonnet-4-5",
    );
    await expectPatch({ opencode: { implementerModel: "anthropic/claude-sonnet-4-5" } });
  });

  it("shows a hint when the opencode catalog fails to load, without blanking agy", async () => {
    routeFetch({ "/api/opencode/models": () => jsonResponse(500, { message: "boom" }) });
    render(<ModelsSection />);

    expect(await screen.findByText(/couldn't load the model list/i)).toBeInTheDocument();
    const agySelect = screen.getByRole("combobox", { name: "agy default model" });
    await waitFor(() =>
      expect(within(agySelect).getByText("gemini-3.1-pro-high")).toBeInTheDocument(),
    );
  });

  // The backend's listOpenCodeModels() swallows every exec failure (including
  // "opencode not installed") into a 200 `[]`, so THIS branch — not the
  // HTTP-error one above — is what a user without opencode actually sees.
  it("shows a hint when the opencode catalog is empty (e.g. opencode not installed)", async () => {
    routeFetch({ "/api/opencode/models": () => jsonResponse(200, []) });
    render(<ModelsSection />);

    expect(
      await screen.findByText(/No models found.*opencode is installed.*provider configured/i),
    ).toBeInTheDocument();
  });

  it("shows hints when the agy catalog fails or is empty", async () => {
    routeFetch({ "/api/agy/models": () => jsonResponse(500, { message: "boom" }) });
    const first = render(<ModelsSection />);
    expect(await screen.findByText(/couldn't load the agy model list/i)).toBeInTheDocument();
    first.unmount();

    routeFetch({ "/api/agy/models": () => jsonResponse(200, []) });
    render(<ModelsSection />);
    expect(await screen.findByText(/agy is installed and signed in/i)).toBeInTheDocument();
  });

  it("tolerates a malformed (non-array) catalog response", async () => {
    routeFetch({ "/api/agy/models": () => jsonResponse(200, { models: AGY_MODELS }) });
    render(<ModelsSection />);

    expect(await screen.findByText(/agy is installed and signed in/i)).toBeInTheDocument();
  });

  it("opening Custom… and leaving the field doesn't reset a stored default", async () => {
    const user = userEvent.setup();
    useDashboardStore.setState({
      settings: { ...DEFAULT_SETTINGS, claudeCode: { defaultModel: "opus" } },
      settingsLoaded: true,
    });
    render(<ModelsSection />);

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Claude Code default model" }),
      "__custom__",
    );
    const input = screen.getByRole("textbox", { name: /Claude Code default model \(custom/ });
    expect(input).toHaveValue("opus");
    await user.click(input);
    await user.tab();

    await settle();
    expect(patchBodies()).toEqual([]);
    expect(useDashboardStore.getState().settings.claudeCode.defaultModel).toBe("opus");
  });

  it("re-syncs the custom field when the stored value changes underneath it", async () => {
    useDashboardStore.setState({
      settings: { ...DEFAULT_SETTINGS, claudeCode: { defaultModel: "claude-opus-4-5" } },
      settingsLoaded: true,
    });
    render(<ModelsSection />);
    const input = screen.getByRole("textbox", { name: /Claude Code default model \(custom/ });
    expect(input).toHaveValue("claude-opus-4-5");

    act(() => {
      useDashboardStore.setState({
        settings: { ...DEFAULT_SETTINGS, claudeCode: { defaultModel: "claude-sonnet-4-6" } },
      });
    });

    await waitFor(() => expect(input).toHaveValue("claude-sonnet-4-6"));
  });
});
