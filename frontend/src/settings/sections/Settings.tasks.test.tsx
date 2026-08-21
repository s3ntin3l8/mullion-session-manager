// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "../../Settings.js";
import { useDashboardStore } from "../../store/index.js";
import { DEFAULT_SETTINGS } from "../../api/index.js";
import { jsonResponse } from "../../test/jsonResponse.js";

// Task Master Settings UI follow-up — mirrors Settings.sessions.test.tsx's
// fake-in-memory-backend pattern: a fake server over global fetch, not a
// mocked store, so the real updateSettings()/PATCH wiring is exercised.
// The section always shows/writes EFFECTIVE values, never the -1/"inherit"
// sentinels stored settings.taskMaster actually carries — every assertion
// here checks the resolved (env-default-or-override) value.

const TEST_ENV = {
  enabled: false,
  maxConcurrent: 2,
  budgetMinutes: 120,
  progressCommentMinutes: 15,
  skipPermissions: false,
  issueLabel: "mullion-task",
  pollIntervalSeconds: 60,
};

describe("Settings -> Task Master", () => {
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
      settings: DEFAULT_SETTINGS,
      settingsLoaded: true,
      taskMasterEnv: TEST_ENV,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders every field at its environment default when settings carry only inherit sentinels", async () => {
    render(<Settings onClose={vi.fn()} initialSection="tasks" />);

    const enableRow = await screen.findByText("Enable Task Master");
    const enableToggle = enableRow.closest(".settings-row")?.querySelector("button");
    expect(enableToggle).toHaveAttribute("aria-pressed", "false");

    const maxRow = screen.getByText("Max concurrent claims");
    const maxInput = maxRow.closest(".settings-row")?.querySelector("input[type=number]");
    expect(maxInput).toHaveValue(2);

    const budgetRow = screen.getByText("Per-task budget");
    const budgetInput = budgetRow.closest(".settings-row")?.querySelector("input[type=number]");
    expect(budgetInput).toHaveValue(120);

    const throttleRow = screen.getByText("Progress-comment throttle");
    const throttleInput = throttleRow.closest(".settings-row")?.querySelector("input[type=number]");
    expect(throttleInput).toHaveValue(15);

    expect(screen.getByText("mullion-task")).toBeInTheDocument();
    expect(screen.getByText("60s")).toBeInTheDocument();
  });

  it("toggles Enable Task Master and PATCHes the effective on/off state, not a boolean", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="tasks" />);

    const row = await screen.findByText("Enable Task Master");
    const toggle = row.closest(".settings-row")?.querySelector("button") as HTMLElement;
    await user.click(toggle);

    expect(useDashboardStore.getState().settings.taskMaster.enabled).toBe("on");
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ taskMaster: { enabled: "on" } }),
        }),
      ),
    );
  });

  it("disables Pause auto-claim while Task Master resolves to off, with an explanatory hint", async () => {
    render(<Settings onClose={vi.fn()} initialSection="tasks" />);

    const row = await screen.findByText("Pause auto-claim");
    const toggle = row.closest(".settings-row")?.querySelector("button");
    expect(toggle).toBeDisabled();
    expect(screen.getByText(/has no effect right now/i)).toBeInTheDocument();
  });

  it("enables Pause auto-claim once Task Master is resolved on, and PATCHes it", async () => {
    const user = userEvent.setup();
    useDashboardStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        taskMaster: { ...DEFAULT_SETTINGS.taskMaster, enabled: "on" },
      },
    });
    render(<Settings onClose={vi.fn()} initialSection="tasks" />);

    const row = await screen.findByText("Pause auto-claim");
    const toggle = row.closest(".settings-row")?.querySelector("button") as HTMLElement;
    expect(toggle).not.toBeDisabled();

    await user.click(toggle);

    expect(useDashboardStore.getState().settings.taskMaster.autoClaimPaused).toBe(true);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ taskMaster: { autoClaimPaused: true } }),
        }),
      ),
    );
  });

  it("edits Max concurrent claims and PATCHes the concrete override, not the sentinel, once the field is committed", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="tasks" />);

    const row = await screen.findByText("Max concurrent claims");
    const input = row.closest(".settings-row")?.querySelector("input[type=number]");
    expect(input).not.toBeNull();

    await user.clear(input as HTMLInputElement);
    await user.type(input as HTMLInputElement, "5");
    await user.tab();

    expect(useDashboardStore.getState().settings.taskMaster.maxConcurrent).toBe(5);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ taskMaster: { maxConcurrent: 5 } }),
        }),
      ),
    );
  });

  it("clamps Max concurrent claims to its upper bound while typing, so the displayed value never exceeds what's effective", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="tasks" />);

    const row = await screen.findByText("Max concurrent claims");
    const input = row
      .closest(".settings-row")
      ?.querySelector("input[type=number]") as HTMLInputElement;

    await user.clear(input);
    await user.type(input, "25");
    await user.tab();

    // Clamped to 20 (the field's own max), not left at 25 to silently
    // resolve to the -1 sentinel -> env default server-side (independent
    // review, PR #480).
    expect(useDashboardStore.getState().settings.taskMaster.maxConcurrent).toBe(20);
    // Flush the debounced PATCH before this test ends — otherwise its
    // pending patch leaks into (and corrupts the asserted body of) the
    // next test's own PATCH via the store's shared debounce/merge state.
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
  });

  it("clamps a cleared Max concurrent claims field up to 1 on commit, not down to 0 (Hermes review, PR #480, second pass)", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="tasks" />);

    const row = await screen.findByText("Max concurrent claims");
    const input = row
      .closest(".settings-row")
      ?.querySelector("input[type=number]") as HTMLInputElement;

    await user.clear(input);
    await user.tab();

    // 0 has no meaning for this field, and a raw 0 would repair to the -1
    // "inherit" sentinel server-side rather than a fixed default — clamp
    // it up to the field's own min on commit instead.
    expect(useDashboardStore.getState().settings.taskMaster.maxConcurrent).toBe(1);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ taskMaster: { maxConcurrent: 1 } }),
        }),
      ),
    );
  });

  it("edits Per-task budget down to 0 (unlimited) and PATCHes 0, not the -1 sentinel, once the field is committed", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="tasks" />);

    const row = await screen.findByText("Per-task budget");
    const input = row.closest(".settings-row")?.querySelector("input[type=number]");

    await user.clear(input as HTMLInputElement);
    await user.type(input as HTMLInputElement, "0");
    await user.tab();

    expect(useDashboardStore.getState().settings.taskMaster.budgetMinutes).toBe(0);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ taskMaster: { budgetMinutes: 0 } }),
        }),
      ),
    );
  });

  it("does not persist a cleared budget field's transient 0 until the field is committed (blur/Enter)", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="tasks" />);

    const row = await screen.findByText("Per-task budget");
    const input = row
      .closest(".settings-row")
      ?.querySelector("input[type=number]") as HTMLInputElement;

    // Clearing the field fires onChange(0) into local draft state — the
    // displayed value dips to 0, but nothing is committed to the store or
    // patched to the server while the field is still focused. This is the
    // fix for the Hermes review, PR #480 clear-then-pause race.
    await user.clear(input);
    expect(input).toHaveValue(0);
    // Stored setting is still the untouched inherit sentinel, not a
    // persisted 0 — only the on-screen draft dipped to 0.
    expect(useDashboardStore.getState().settings.taskMaster.budgetMinutes).toBe(
      DEFAULT_SETTINGS.taskMaster.budgetMinutes,
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({ method: "PATCH" }),
    );

    await user.type(input, "45");
    await user.tab();

    expect(useDashboardStore.getState().settings.taskMaster.budgetMinutes).toBe(45);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ taskMaster: { budgetMinutes: 45 } }),
        }),
      ),
    );
  });

  it("Reset writes every sentinel back in one patch, from an install with every field overridden", async () => {
    const user = userEvent.setup();
    useDashboardStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        taskMaster: {
          autoClaimPaused: true,
          enabled: "on",
          maxConcurrent: 5,
          budgetMinutes: 30,
          progressCommentMinutes: 5,
          skipPermissions: "on",
          reviewCiWaitMinutes: 30,
          defaultAgent: "codex",
          defaultReviewAgent: "agy",
        },
      },
    });
    render(<Settings onClose={vi.fn()} initialSection="tasks" />);

    const resetRow = await screen.findByText("Reset to environment defaults");
    const resetButton = resetRow.closest(".settings-row")?.querySelector("button") as HTMLElement;
    await user.click(resetButton);

    const tm = useDashboardStore.getState().settings.taskMaster;
    expect(tm.enabled).toBe("inherit");
    expect(tm.maxConcurrent).toBe(-1);
    expect(tm.budgetMinutes).toBe(-1);
    expect(tm.progressCommentMinutes).toBe(-1);
    expect(tm.skipPermissions).toBe("inherit");
    // autoClaimPaused and reviewCiWaitMinutes have no sentinel/inherit
    // concept (settings.ts's own doc comment) — Reset must not silently
    // clear either.
    expect(tm.autoClaimPaused).toBe(true);
    expect(tm.reviewCiWaitMinutes).toBe(30);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            taskMaster: {
              enabled: "inherit",
              maxConcurrent: -1,
              budgetMinutes: -1,
              progressCommentMinutes: -1,
              skipPermissions: "inherit",
            },
          }),
        }),
      ),
    );
  });

  it("surfaces Task Master's own install-wide agent defaults as the lowest resolution tier", async () => {
    render(<Settings onClose={vi.fn()} initialSection="tasks" />);
    expect(await screen.findByText(/Task Master's own install-wide defaults/i)).toBeInTheDocument();
  });

  it("lets the Default agent / Default review agent dropdowns override the install-wide defaults", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="tasks" />);

    const defaultAgentRow = await screen.findByText("Default agent");
    const defaultAgentSelect = defaultAgentRow
      .closest(".settings-row")
      ?.querySelector("select") as HTMLSelectElement;
    await user.selectOptions(defaultAgentSelect, "codex");
    expect(useDashboardStore.getState().settings.taskMaster.defaultAgent).toBe("codex");

    const reviewRow = screen.getByText("Default review agent");
    const reviewSelect = reviewRow
      .closest(".settings-row")
      ?.querySelector("select") as HTMLSelectElement;
    expect(reviewSelect).toHaveValue("none");
    await user.selectOptions(reviewSelect, "agy");
    expect(useDashboardStore.getState().settings.taskMaster.defaultReviewAgent).toBe("agy");
  });

  it("falls back to a sane default before taskMasterEnv has ever loaded", async () => {
    useDashboardStore.setState({ taskMasterEnv: null });
    render(<Settings onClose={vi.fn()} initialSection="tasks" />);

    const maxRow = await screen.findByText("Max concurrent claims");
    const maxInput = maxRow.closest(".settings-row")?.querySelector("input[type=number]");
    // Same fallback table store.ts uses before the first server-info fetch
    // resolves — see FALLBACK_TASK_MASTER_ENV.
    expect(maxInput).toHaveValue(2);
  });
});
