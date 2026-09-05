// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "../../Settings.js";
import { useDashboardStore } from "../../store/index.js";
import { DEFAULT_SETTINGS } from "../../api/index.js";
import type { BundleSyncStatus } from "../../api/index.js";
import { jsonResponse } from "../../test/jsonResponse.js";

// Issues #944 (status/re-sync) and #945 (remove) — BundleSyncPanel.tsx, the
// sub-panel directly beneath SessionsSection's "Inject Mullion tooling
// bundle" toggle. Same fake-in-memory-backend pattern as
// Settings.sessions.test.tsx's own suites: a fake server over global fetch,
// not a mocked store, so the real fetch/PATCH wiring is what's under test.

function makeStatus(overrides: Partial<BundleSyncStatus> = {}): BundleSyncStatus {
  return {
    enabled: true,
    bundleHash: "abc123",
    manifestPath: "/home/user/.mullion/sync-manifest.json",
    clis: [
      {
        cli: "claude-code",
        detected: true,
        skills: { status: "synced", root: "/home/user/.claude/skills", count: 3 },
        agents: { status: "synced", root: "/home/user/.claude/agents", count: 1 },
      },
      {
        cli: "opencode",
        detected: true,
        skills: { status: "synced", root: "/home/user/.config/opencode/skills", count: 3 },
        agents: { status: "synced", root: "/home/user/.config/opencode/agent", count: 1 },
      },
      {
        cli: "codex",
        detected: true,
        skills: { status: "synced", root: "/home/user/.agents/skills", count: 3 },
        agents: { status: "n-a", root: null, count: 0 },
      },
      {
        cli: "agy",
        detected: true,
        skills: { status: "synced", root: "/home/user/.gemini/config/skills", count: 3 },
        agents: { status: "synced", root: "/home/user/.gemini/config/agents", count: 1 },
      },
    ],
    ...overrides,
  };
}

describe("Settings -> Sessions -> Bundle sync panel", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let statusResponse: BundleSyncStatus;
  let statusCalls: number;

  beforeEach(() => {
    statusResponse = makeStatus();
    statusCalls = 0;
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/settings" && method === "PATCH") {
        return Promise.resolve(jsonResponse(200, DEFAULT_SETTINGS));
      }
      if (url === "/api/bundle-sync/status" && method === "GET") {
        statusCalls += 1;
        return Promise.resolve(jsonResponse(200, statusResponse));
      }
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    useDashboardStore.setState({ settings: DEFAULT_SETTINGS, settingsLoaded: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches status on mount and renders a synced row per detected CLI", async () => {
    render(<Settings onClose={vi.fn()} initialSection="sessions" />);

    await waitFor(() => expect(statusCalls).toBeGreaterThan(0));
    expect(await screen.findByTestId("bundle-sync-row-claude-code")).toBeInTheDocument();
    expect(screen.getByTestId("bundle-sync-row-opencode")).toBeInTheDocument();
    expect(screen.getByTestId("bundle-sync-row-codex")).toBeInTheDocument();
    expect(screen.getByTestId("bundle-sync-row-agy")).toBeInTheDocument();

    // Codex's agents field is "n-a" — a dash, not a fourth "not synced" row.
    const codexRow = screen.getByTestId("bundle-sync-row-codex");
    expect(codexRow.textContent).toContain("—");
  });

  it("renders one clear top-level 'off' state instead of four per-CLI rows when disabled", async () => {
    useDashboardStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        sessions: { ...DEFAULT_SETTINGS.sessions, injectMullionBundle: false },
      },
      settingsLoaded: true,
    });
    statusResponse = makeStatus({
      enabled: false,
      bundleHash: null,
      clis: makeStatus().clis.map((c) => ({
        ...c,
        skills: { ...c.skills, status: "disabled" },
        agents: { ...c.agents, status: c.agents.status === "n-a" ? "n-a" : "disabled" },
      })),
    });

    render(<Settings onClose={vi.fn()} initialSection="sessions" />);

    expect(await screen.findByText(/Bundle delivery is off/)).toBeInTheDocument();
    expect(screen.queryByTestId("bundle-sync-row-claude-code")).not.toBeInTheDocument();
    expect(screen.queryByText("Re-sync now")).not.toBeInTheDocument();
  });

  // Regression guard: the panel's "off" gating must key off the LOCAL toggle
  // value alone, not the freshest GET /api/bundle-sync/status response. Right
  // after turning the toggle ON, the settings PATCH is still debounced
  // (SETTINGS_PATCH_DEBOUNCE_MS) while this panel's own effect already
  // refetches — so a stale server response can still say `enabled: false`
  // for a moment. OR-ing that into the gate would hide the whole panel
  // (Re-sync now included) behind a contradictory "off" banner, with no
  // further refetch ever scheduled to correct it.
  it("keeps showing per-CLI rows when the toggle is locally on even if a stale status response still says disabled", async () => {
    statusResponse = makeStatus({ enabled: false });

    render(<Settings onClose={vi.fn()} initialSection="sessions" />);

    expect(await screen.findByTestId("bundle-sync-row-claude-code")).toBeInTheDocument();
    expect(screen.queryByText(/Bundle delivery is off/)).not.toBeInTheDocument();
  });

  it("shows a stale row with a 're-sync to fix' note", async () => {
    statusResponse = makeStatus({
      clis: makeStatus().clis.map((c) =>
        c.cli === "agy" ? { ...c, skills: { ...c.skills, status: "stale" } } : c,
      ),
    });

    render(<Settings onClose={vi.fn()} initialSection="sessions" />);

    const agyRow = await screen.findByTestId("bundle-sync-row-agy");
    expect(agyRow.textContent).toContain("Stale");
    expect(agyRow.textContent).toMatch(/Re-sync now to fix/);
  });

  it("distinguishes not-synced-with-fallback (claude-code/opencode) from not-synced-with-nothing-delivered (codex/agy)", async () => {
    statusResponse = makeStatus({
      clis: makeStatus().clis.map((c) => {
        if (c.cli === "claude-code" || c.cli === "codex") {
          return { ...c, skills: { ...c.skills, status: "not-synced" } };
        }
        return c;
      }),
    });

    render(<Settings onClose={vi.fn()} initialSection="sessions" />);

    const claudeRow = await screen.findByTestId("bundle-sync-row-claude-code");
    expect(claudeRow.textContent).toMatch(/per-session fallback/);
    expect(claudeRow.textContent).not.toMatch(/nothing is currently delivered/i);

    const codexRow = screen.getByTestId("bundle-sync-row-codex");
    expect(codexRow.textContent).toMatch(/nothing is currently delivered/i);
    expect(codexRow.textContent).not.toMatch(/per-session fallback/);
  });

  it("Re-sync now shows a loading state, then refetches status on success", async () => {
    const user = userEvent.setup();
    let resyncCalls = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/settings" && method === "PATCH") {
        return Promise.resolve(jsonResponse(200, DEFAULT_SETTINGS));
      }
      if (url === "/api/bundle-sync/status" && method === "GET") {
        statusCalls += 1;
        return Promise.resolve(jsonResponse(200, statusResponse));
      }
      if (url === "/api/bundle-sync/resync" && method === "POST") {
        resyncCalls += 1;
        return Promise.resolve(jsonResponse(200, { changed: true }));
      }
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    });

    render(<Settings onClose={vi.fn()} initialSection="sessions" />);
    await screen.findByTestId("bundle-sync-row-claude-code");
    const callsBeforeResync = statusCalls;

    await user.click(screen.getByText("Re-sync now"));

    await waitFor(() => expect(resyncCalls).toBe(1));
    await waitFor(() => expect(statusCalls).toBeGreaterThan(callsBeforeResync));
  });

  it("Re-sync now surfaces a friendly message on a 409 (disabled) response", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/settings" && method === "PATCH") {
        return Promise.resolve(jsonResponse(200, DEFAULT_SETTINGS));
      }
      if (url === "/api/bundle-sync/status" && method === "GET") {
        return Promise.resolve(jsonResponse(200, statusResponse));
      }
      if (url === "/api/bundle-sync/resync" && method === "POST") {
        return Promise.resolve(jsonResponse(409, { error: "disabled" }));
      }
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    });

    render(<Settings onClose={vi.fn()} initialSection="sessions" />);
    await screen.findByTestId("bundle-sync-row-claude-code");

    await user.click(screen.getByText("Re-sync now"));

    expect(await screen.findByText(/turn the toggle above back on/)).toBeInTheDocument();
  });

  it("Remove Mullion content arms, then fires on a second click, disabling the toggle above afterward", async () => {
    const user = userEvent.setup();
    let removeCalls = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/settings" && method === "PATCH") {
        return Promise.resolve(jsonResponse(200, DEFAULT_SETTINGS));
      }
      if (url === "/api/bundle-sync/status" && method === "GET") {
        statusCalls += 1;
        return Promise.resolve(jsonResponse(200, statusResponse));
      }
      if (url === "/api/bundle-sync/remove" && method === "POST") {
        removeCalls += 1;
        return Promise.resolve(
          jsonResponse(200, { removed: 8, legacySwept: 2, settingDisabled: true }),
        );
      }
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    });

    render(<Settings onClose={vi.fn()} initialSection="sessions" />);
    await screen.findByTestId("bundle-sync-row-claude-code");

    const removeButton = screen
      .getByText("Remove Mullion content")
      .closest("button") as HTMLElement;

    // First click arms; the action must not fire yet.
    await user.click(removeButton);
    expect(removeCalls).toBe(0);

    // Second click (same element — ConfirmButton swaps its own label/icon,
    // not the DOM node) actually fires it.
    await user.click(removeButton);

    await waitFor(() => expect(removeCalls).toBe(1));

    // The backend's settingDisabled: true flips the local settings store —
    // the toggle above must re-read as off without a page reload.
    await waitFor(() =>
      expect(useDashboardStore.getState().settings.sessions.injectMullionBundle).toBe(false),
    );
    const toggleRow = await screen.findByText("Inject Mullion tooling bundle");
    const toggle = toggleRow.closest(".settings-row")?.querySelector("button");
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "false"));
  });
});
