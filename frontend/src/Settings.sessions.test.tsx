// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "./Settings.js";
import { useDashboardStore } from "./store.js";
import { DEFAULT_SETTINGS } from "./api.js";

// fix: status-clearing-semantics — "Stale error timeout" is the new Settings
// row surfacing sessions.staleErrorSeconds (previously a reconciler-internal
// knob with no UI). Mirrors Settings.hosts.test.tsx's fake-in-memory-backend
// pattern: a fake server over global fetch, not a mocked store, so the real
// updateSettings()/PATCH wiring is what's under test.

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Settings -> Sessions -> Stale error timeout", () => {
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

    // The store is a module-level singleton — reset the settings slice this
    // test touches so a previous test's patch doesn't leak into this one.
    useDashboardStore.setState({ settings: DEFAULT_SETTINGS, settingsLoaded: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the current value and updates it via the store on change", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="sessions" />);

    const row = await screen.findByText("Stale error timeout");
    const input = row.closest(".settings-row")?.querySelector("input[type=number]");
    expect(input).not.toBeNull();
    expect(input).toHaveValue(DEFAULT_SETTINGS.sessions.staleErrorSeconds);

    await user.clear(input as HTMLInputElement);
    await user.type(input as HTMLInputElement, "60");

    // updateSettings() applies to the store synchronously (see store.ts) —
    // no need to wait out the PATCH debounce for this assertion.
    expect(useDashboardStore.getState().settings.sessions.staleErrorSeconds).toBe(60);
  });

  it("PATCHes /api/settings with the changed field, debounced", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="sessions" />);

    const row = await screen.findByText("Stale error timeout");
    const input = row
      .closest(".settings-row")
      ?.querySelector("input[type=number]") as HTMLInputElement;

    await user.clear(input);
    await user.type(input, "3600");

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ sessions: { staleErrorSeconds: 3600 } }),
        }),
      ),
    );
  });
});

// Issue #320 follow-up — "Stale busy timeout" is the sibling row surfacing
// sessions.staleBusySeconds, the separate (longer-default) TTL for the busy
// latches (compactState/subagentCount). Same fake-in-memory-backend pattern
// as the "Stale error timeout" suite above.
describe("Settings -> Sessions -> Stale busy timeout", () => {
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

  it("renders the current value and updates it via the store on change", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="sessions" />);

    const row = await screen.findByText("Stale busy timeout");
    const input = row.closest(".settings-row")?.querySelector("input[type=number]");
    expect(input).not.toBeNull();
    expect(input).toHaveValue(DEFAULT_SETTINGS.sessions.staleBusySeconds);

    await user.clear(input as HTMLInputElement);
    await user.type(input as HTMLInputElement, "120");

    expect(useDashboardStore.getState().settings.sessions.staleBusySeconds).toBe(120);
  });

  it("PATCHes /api/settings with the changed field, debounced", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="sessions" />);

    const row = await screen.findByText("Stale busy timeout");
    const input = row
      .closest(".settings-row")
      ?.querySelector("input[type=number]") as HTMLInputElement;

    await user.clear(input);
    await user.type(input, "10800");

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ sessions: { staleBusySeconds: 10800 } }),
        }),
      ),
    );
  });
});

// Issue #405 — "Inject agent guide pointer" surfaces sessions.injectAgentGuide,
// the toggle gating the SessionStart auto-inject pointer to the per-session
// agent guide copy. Same Toggle-row pattern as Settings.dock.test.tsx.
describe("Settings -> Sessions -> Inject agent guide pointer", () => {
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

  it("renders the current (default-on) toggle state", async () => {
    render(<Settings onClose={vi.fn()} initialSection="sessions" />);
    const row = await screen.findByText("Inject agent guide pointer");
    const toggle = row.closest(".settings-row")?.querySelector("button");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("toggles the setting and PATCHes /api/settings", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="sessions" />);
    const row = await screen.findByText("Inject agent guide pointer");
    const toggle = row.closest(".settings-row")?.querySelector("button") as HTMLElement;

    await user.click(toggle);

    expect(useDashboardStore.getState().settings.sessions.injectAgentGuide).toBe(false);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ sessions: { injectAgentGuide: false } }),
        }),
      ),
    );
  });
});
