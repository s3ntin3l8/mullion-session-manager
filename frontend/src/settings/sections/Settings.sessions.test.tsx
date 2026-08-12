// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "../../Settings.js";
import { useDashboardStore } from "../../store.js";
import { DEFAULT_SETTINGS } from "../../api.js";
import { jsonResponse } from "../../test/jsonResponse.js";

// fix: status-clearing-semantics — "Stale error timeout" is the new Settings
// row surfacing sessions.staleErrorSeconds (previously a reconciler-internal
// knob with no UI). Mirrors Settings.hosts.test.tsx's fake-in-memory-backend
// pattern: a fake server over global fetch, not a mocked store, so the real
// updateSettings()/PATCH wiring is what's under test.

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

// Issue #445 — "Persist session event history" / "Event history retention"
// surface sessions.eventPersistence / sessions.eventRetentionDays (Phase 4.7,
// issue #213), which were fully wired server-side but had no Settings UI row
// at all. Same fake-in-memory-backend pattern as the suites above.
describe("Settings -> Sessions -> Persist session event history", () => {
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

  it("renders the current (default-off) toggle state", async () => {
    render(<Settings onClose={vi.fn()} initialSection="sessions" />);
    const row = await screen.findByText("Persist session event history");
    const toggle = row.closest(".settings-row")?.querySelector("button");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  it("toggles the setting and PATCHes /api/settings", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="sessions" />);
    const row = await screen.findByText("Persist session event history");
    const toggle = row.closest(".settings-row")?.querySelector("button") as HTMLElement;

    await user.click(toggle);

    expect(useDashboardStore.getState().settings.sessions.eventPersistence).toBe(true);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ sessions: { eventPersistence: true } }),
        }),
      ),
    );
  });
});

// Hermes review, PR #563 round 4 — this field (and the cap-per-session
// field below) used to PATCH on every keystroke like every other Settings
// number field, but unlike those, the settings route triggers a REAL,
// destructive sweep immediately on any change (reconfigureEventRetention
// runs the sweep now, not just re-arms a future timer). Typing "90" as "9"
// then pausing (past the debounce) would persist an intermediate cap-like
// value and run a sweep against it before the rest was ever typed. Fixed by
// switching to onCommit (blur/Enter) — the tests below assert that shape.
describe("Settings -> Sessions -> Event history retention", () => {
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

  it("renders the current value with the server's clamp range; typing updates the display only, not the store", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="sessions" />);

    const row = await screen.findByText("Event history retention");
    const input = row.closest(".settings-row")?.querySelector("input[type=number]");
    expect(input).not.toBeNull();
    expect(input).toHaveValue(DEFAULT_SETTINGS.sessions.eventRetentionDays);
    expect(input).toHaveAttribute("min", "0");
    expect(input).toHaveAttribute("max", "3650");

    await user.clear(input as HTMLInputElement);
    await user.type(input as HTMLInputElement, "90");

    expect(input).toHaveValue(90);
    expect(useDashboardStore.getState().settings.sessions.eventRetentionDays).toBe(
      DEFAULT_SETTINGS.sessions.eventRetentionDays,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("commits and PATCHes /api/settings only once the field loses focus (blur/tab)", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="sessions" />);

    const row = await screen.findByText("Event history retention");
    const input = row
      .closest(".settings-row")
      ?.querySelector("input[type=number]") as HTMLInputElement;

    await user.clear(input);
    await user.type(input, "90");
    await user.tab();

    expect(useDashboardStore.getState().settings.sessions.eventRetentionDays).toBe(90);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ sessions: { eventRetentionDays: 90 } }),
        }),
      ),
    );
  });
});

// Issue #213's own body asked for both an age bound (above) and a
// per-session count bound — same Row/NumberField pattern, independent field.
describe("Settings -> Sessions -> Event history cap per session", () => {
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

  it("renders the current value with the server's clamp range; typing updates the display only, not the store", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="sessions" />);

    const row = await screen.findByText("Event history cap per session");
    const input = row.closest(".settings-row")?.querySelector("input[type=number]");
    expect(input).not.toBeNull();
    expect(input).toHaveValue(DEFAULT_SETTINGS.sessions.eventRetentionPerSession);
    expect(input).toHaveAttribute("min", "0");
    expect(input).toHaveAttribute("max", "100000");

    await user.clear(input as HTMLInputElement);
    await user.type(input as HTMLInputElement, "500");

    expect(input).toHaveValue(500);
    expect(useDashboardStore.getState().settings.sessions.eventRetentionPerSession).toBe(
      DEFAULT_SETTINGS.sessions.eventRetentionPerSession,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("commits and PATCHes /api/settings only once the field loses focus (blur/tab) — this is the field a mid-typing PATCH would have been most destructive for", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="sessions" />);

    const row = await screen.findByText("Event history cap per session");
    const input = row
      .closest(".settings-row")
      ?.querySelector("input[type=number]") as HTMLInputElement;

    await user.clear(input);
    await user.type(input, "500");
    await user.tab();

    expect(useDashboardStore.getState().settings.sessions.eventRetentionPerSession).toBe(500);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ sessions: { eventRetentionPerSession: 500 } }),
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

// Issues #440/#444 — sessions.autoOpenChildPanels and
// sessions.maxChildSessionsPerParent were already fully wired end-to-end
// (backend defaults/sanitizer, App.tsx's auto-open effect, the spawn_child
// cap check) but had no Settings UI row at all. Same fake-in-memory-backend
// pattern as the suites above.
describe("Settings -> Sessions -> Auto-open child session panels", () => {
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

  it("renders the current (default-off) toggle state", async () => {
    render(<Settings onClose={vi.fn()} initialSection="sessions" />);
    const row = await screen.findByText("Auto-open child session panels");
    const toggle = row.closest(".settings-row")?.querySelector("button");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  it("toggles the setting and PATCHes /api/settings", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="sessions" />);
    const row = await screen.findByText("Auto-open child session panels");
    const toggle = row.closest(".settings-row")?.querySelector("button") as HTMLElement;

    await user.click(toggle);

    expect(useDashboardStore.getState().settings.sessions.autoOpenChildPanels).toBe(true);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ sessions: { autoOpenChildPanels: true } }),
        }),
      ),
    );
  });
});

describe("Settings -> Sessions -> Max child sessions per parent", () => {
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

    const row = await screen.findByText("Max child sessions per parent");
    const input = row.closest(".settings-row")?.querySelector("input[type=number]");
    expect(input).not.toBeNull();
    expect(input).toHaveValue(DEFAULT_SETTINGS.sessions.maxChildSessionsPerParent);

    await user.clear(input as HTMLInputElement);
    await user.type(input as HTMLInputElement, "10");

    expect(useDashboardStore.getState().settings.sessions.maxChildSessionsPerParent).toBe(10);
  });

  it("PATCHes /api/settings with the changed field, debounced", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="sessions" />);

    const row = await screen.findByText("Max child sessions per parent");
    const input = row
      .closest(".settings-row")
      ?.querySelector("input[type=number]") as HTMLInputElement;

    await user.clear(input);
    await user.type(input, "12");

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ sessions: { maxChildSessionsPerParent: 12 } }),
        }),
      ),
    );
  });
});
