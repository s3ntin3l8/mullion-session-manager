// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  BrowserFramerateSetting,
  GitHubPollingSettings,
  HostHeartbeatSetting,
  LogLevelSetting,
} from "./RuntimeSettings.js";
import { useDashboardStore } from "../store/index.js";
import { DEFAULT_SETTINGS } from "../api/index.js";
import type { AppSettings, ServerInfo } from "../api/index.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { SERVER_INFO_FIXTURE } from "../test/serverInfoFixture.js";

function stubFetch(info: ServerInfo = SERVER_INFO_FIXTURE) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/server-info" && method === "GET") {
        return Promise.resolve(jsonResponse(200, info));
      }
      if (url === "/api/settings" && method === "PATCH") {
        return Promise.resolve(jsonResponse(200, useDashboardStore.getState().settings));
      }
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    }),
  );
}

function setSettings(patch: Partial<AppSettings>) {
  useDashboardStore.setState({ settings: { ...DEFAULT_SETTINGS, ...patch }, settingsLoaded: true });
}

function rowFor(label: string): HTMLElement {
  return screen.getByText(label).closest(".settings-row") as HTMLElement;
}

describe("runtime settings controls", () => {
  beforeEach(() => {
    stubFetch({
      ...SERVER_INFO_FIXTURE,
      runtimeEnv: { ...SERVER_INFO_FIXTURE.runtimeEnv, githubPollQuietSeconds: 45 },
    });
    setSettings({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the server default while inheriting, with no reset link", async () => {
    render(<GitHubPollingSettings />);
    const row = rowFor("Quiet repositories");
    await waitFor(() => expect(within(row).getByRole("spinbutton")).toHaveValue(45));
    expect(within(row).getByText(/Server default: 45 seconds/)).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Use server default" })).toBeNull();
  });

  it("commits an override on blur, clamped to the allowed range", async () => {
    const user = userEvent.setup();
    render(<GitHubPollingSettings />);
    const input = within(rowFor("Active repositories")).getByRole("spinbutton");
    await user.clear(input);
    await user.type(input, "2");
    await user.tab();
    expect(useDashboardStore.getState().settings.github.pollActiveSeconds).toBe(5);
  });

  it("does not save the server default when a field is only focused and left", async () => {
    const user = userEvent.setup();
    render(<GitHubPollingSettings />);
    const input = within(rowFor("Quiet repositories")).getByRole("spinbutton");
    await waitFor(() => expect(input).toHaveValue(45));
    await user.click(input);
    await user.tab();
    expect(useDashboardStore.getState().settings.github.pollQuietSeconds).toBe(-1);
  });

  it("returns an overridden value to the server default", async () => {
    const user = userEvent.setup();
    setSettings({ hosts: { heartbeatSeconds: 90 } });
    render(<HostHeartbeatSetting />);
    const row = rowFor("Health check interval");
    expect(within(row).getByRole("spinbutton")).toHaveValue(90);

    await user.click(within(row).getByRole("button", { name: "Use server default" }));
    expect(useDashboardStore.getState().settings.hosts.heartbeatSeconds).toBe(-1);
  });

  it("offers the server default as the first log level and saves a chosen level", async () => {
    const user = userEvent.setup();
    render(<LogLevelSetting />);
    const select = within(rowFor("Log level")).getByRole("combobox");
    expect(within(select).getAllByRole("option")[0]).toHaveTextContent("Server default (Info)");

    await user.selectOptions(select, "debug");
    expect(useDashboardStore.getState().settings.server.logLevel).toBe("debug");
  });

  it("explains when the browser pane is off on this server", async () => {
    stubFetch({
      ...SERVER_INFO_FIXTURE,
      features: { ...SERVER_INFO_FIXTURE.features, browser: false },
    });
    render(<BrowserFramerateSetting />);
    expect(
      await screen.findByText(/browser pane is turned off on this server/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Server default: 10 fps/)).toBeInTheDocument();
  });

  it("shows no notice when the browser pane is on", async () => {
    render(<BrowserFramerateSetting />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByText(/turned off on this server/)).toBeNull();
  });
});
