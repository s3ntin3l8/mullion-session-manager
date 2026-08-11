// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "./Settings.js";
import { useDashboardStore } from "./store.js";
import { DEFAULT_SETTINGS } from "./api.js";
import { jsonResponse } from "./test/jsonResponse.js";

// #95 — the push channel row delegates the actual subscribe/unsubscribe
// side effects to pushClient.ts (its own dedicated test file exercises
// those); mocked here so this suite only asserts Settings.tsx's own wiring
// (the settings write, the disabled/unsupported state, error surfacing).
const pushClientMock = vi.hoisted(() => ({
  isPushSupported: vi.fn(() => true),
  enablePush: vi.fn(() => Promise.resolve()),
  disablePush: vi.fn(() => Promise.resolve()),
}));
vi.mock("./pushClient.js", () => pushClientMock);

// Issue #318 review follow-up — the flat attentionAlerts/exitedAlerts/
// finishedAlerts toggles were replaced by the per-status notification
// matrix below, but the old toggle rows (and the notification-permission
// request wired to the "Attention alerts" toggle) were left in place,
// fully disconnected from notificationChannelEnabled — misleading UI that
// looked functional but did nothing. This suite covers the cleanup: the old
// rows are gone, the permission request now lives on the still-functional
// "Browser notification" channel toggle, and the matrix itself writes
// through the store. Mirrors Settings.sessions.test.tsx's fake-in-memory-
// backend pattern.

// The matrix only renders rows for statuses `isStatusReachable` for the
// union of detected agents' `emits` (sessionStatus.ts) — a fully-capable
// fake agent here so every status (including api_error, which needs
// "stop_failure") actually renders for these tests to interact with.
const FULLY_CAPABLE_AGENT = {
  id: "agent:claude",
  title: "claude",
  command: "claude",
  kind: "agent" as const,
  available: true,
  path: "/usr/bin/claude",
  emits: [
    "stop_failure",
    "tool_failure",
    "permission_request",
    "plan_ready",
    "promote_request",
    "elicitation",
    "question",
    "progress",
    "compact",
    "subagent",
  ],
};

describe("Settings -> Notifications", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/settings" && method === "PATCH") {
        return Promise.resolve(jsonResponse(200, DEFAULT_SETTINGS));
      }
      if (url === "/api/agents" && method === "GET") {
        return Promise.resolve(jsonResponse(200, [FULLY_CAPABLE_AGENT]));
      }
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    useDashboardStore.setState({ settings: DEFAULT_SETTINGS, settingsLoaded: true });
    pushClientMock.isPushSupported.mockReturnValue(true);
    pushClientMock.enablePush.mockReset().mockResolvedValue(undefined);
    pushClientMock.disablePush.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("no longer renders the old flat attentionAlerts/exitedAlerts/finishedAlerts toggles", async () => {
    render(<Settings onClose={vi.fn()} initialSection="notifications" />);

    await screen.findByText("Browser permission");
    expect(screen.queryByText("Attention alerts")).not.toBeInTheDocument();
    expect(screen.queryByText("Exited-session alerts")).not.toBeInTheDocument();
    expect(screen.queryByText("Finished alerts")).not.toBeInTheDocument();
  });

  it("still renders the notify/sound/focus matrix and Auto-focus on attention", async () => {
    render(<Settings onClose={vi.fn()} initialSection="notifications" />);

    expect(await screen.findByText("Status notifications")).toBeInTheDocument();
    expect(screen.getByText("Auto-focus on attention")).toBeInTheDocument();
  });

  it("toggling a matrix cell updates notificationMatrix for that status", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="notifications" />);

    // api_error is seeded notify:true by default — flip it off.
    const notifyToggle = await screen.findByTestId("notif-matrix-api_error-notify");
    await user.click(notifyToggle);

    expect(
      useDashboardStore.getState().settings.notifications.notificationMatrix.api_error?.notify,
    ).toBe(false);
  });

  it("PATCHes /api/settings with the changed matrix cell, debounced", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="notifications" />);

    const notifyToggle = await screen.findByTestId("notif-matrix-api_error-notify");
    await user.click(notifyToggle);

    // The onChange handler spreads the full { notify, sound, autoFocus }
    // triple for the changed status (see Settings.tsx), not just the
    // toggled field.
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            notifications: {
              notificationMatrix: {
                api_error: { notify: false, sound: false, autoFocus: false },
              },
            },
          }),
        }),
      ),
    );
  });

  it("renders an awaiting_question row and round-trips its notify toggle (#551)", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="notifications" />);

    // awaiting_question defaults notify:true (DEFAULT_SETTINGS) — flip it off.
    const notifyToggle = await screen.findByTestId("notif-matrix-awaiting_question-notify");
    await user.click(notifyToggle);

    expect(
      useDashboardStore.getState().settings.notifications.notificationMatrix.awaiting_question
        ?.notify,
    ).toBe(false);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            notifications: {
              notificationMatrix: {
                awaiting_question: { notify: false, sound: false, autoFocus: false },
              },
            },
          }),
        }),
      ),
    );
  });

  it("renders a background row under Busy (found alongside #551, same gap for a different status)", async () => {
    render(<Settings onClose={vi.fn()} initialSection="notifications" />);

    // "background" (issue #428) was already present in
    // DEFAULT_SETTINGS.notificationMatrix on both backend and frontend, and
    // reachable via the fixture's pre-existing "progress" emit — it was
    // only ever missing from statusGroups, same shape as #551's gap.
    expect(await screen.findByTestId("notif-matrix-background-notify")).toBeInTheDocument();
  });

  it("requests notification permission when the Browser notification channel is turned on while permission is default", async () => {
    const requestPermission = vi.fn(() => Promise.resolve("granted" as NotificationPermission));
    vi.stubGlobal("Notification", {
      permission: "default" as NotificationPermission,
      requestPermission,
    });
    // channels.browser defaults to true — start it off so the click below
    // is a genuine off->on transition, the case the permission request
    // guards on.
    useDashboardStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        notifications: {
          ...DEFAULT_SETTINGS.notifications,
          channels: { ...DEFAULT_SETTINGS.notifications.channels, browser: false },
        },
      },
      settingsLoaded: true,
    });

    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="notifications" />);

    const toggle = await screen.findByTestId("notif-browser-channel-toggle");
    await user.click(toggle);

    await waitFor(() => expect(requestPermission).toHaveBeenCalled());
  });

  it("does not request permission when turned on while permission is already granted", async () => {
    const requestPermission = vi.fn(() => Promise.resolve("granted" as NotificationPermission));
    vi.stubGlobal("Notification", {
      permission: "granted" as NotificationPermission,
      requestPermission,
    });
    useDashboardStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        notifications: {
          ...DEFAULT_SETTINGS.notifications,
          channels: { ...DEFAULT_SETTINGS.notifications.channels, browser: false },
        },
      },
      settingsLoaded: true,
    });

    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="notifications" />);

    const toggle = await screen.findByTestId("notif-browser-channel-toggle");
    await user.click(toggle);

    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("renders the push channel toggle disabled with explanatory copy when unsupported", async () => {
    pushClientMock.isPushSupported.mockReturnValue(false);
    render(<Settings onClose={vi.fn()} initialSection="notifications" />);

    const toggle = await screen.findByTestId("notif-push-channel-toggle");
    expect(toggle).toBeDisabled();
    expect(screen.getByText(/Requires HTTPS/i)).toBeInTheDocument();
  });

  it("enabling the push channel toggle updates settings.channels.push and calls enablePush()", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="notifications" />);

    const toggle = await screen.findByTestId("notif-push-channel-toggle");
    await user.click(toggle);

    expect(useDashboardStore.getState().settings.notifications.channels.push).toBe(true);
    await waitFor(() => expect(pushClientMock.enablePush).toHaveBeenCalled());
  });

  it("reverts the toggle and surfaces an error message when enablePush() rejects", async () => {
    pushClientMock.enablePush
      .mockReset()
      .mockRejectedValue(new Error("Notification permission denied."));
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="notifications" />);

    const toggle = await screen.findByTestId("notif-push-channel-toggle");
    await user.click(toggle);

    await waitFor(() =>
      expect(useDashboardStore.getState().settings.notifications.channels.push).toBe(false),
    );
    expect(await screen.findByText("Notification permission denied.")).toBeInTheDocument();
  });

  it("turning the push channel toggle off calls disablePush()", async () => {
    useDashboardStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        notifications: {
          ...DEFAULT_SETTINGS.notifications,
          channels: { ...DEFAULT_SETTINGS.notifications.channels, push: true },
        },
      },
      settingsLoaded: true,
    });

    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="notifications" />);

    const toggle = await screen.findByTestId("notif-push-channel-toggle");
    await user.click(toggle);

    expect(useDashboardStore.getState().settings.notifications.channels.push).toBe(false);
    await waitFor(() => expect(pushClientMock.disablePush).toHaveBeenCalled());
  });
});
