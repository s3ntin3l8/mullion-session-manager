// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useDashboardStore } from "../store/index.js";
import { DEFAULT_SETTINGS } from "../api/index.js";
import { useRunwayQuota, __resetRunwayQuotaCacheForTests } from "./useRunwayQuota.js";
import { jsonResponse } from "../test/jsonResponse.js";

// The quota belongs to the PROVIDER, not to a session row: a sidebar full of
// sessions must still make ONE request. These tests pin that down.

function Probe({ label }: { label: string }) {
  const quota = useRunwayQuota();
  return (
    <div data-testid={label}>{quota === null ? "no quota" : `fetched ${quota.fetchedAt}`}</div>
  );
}

describe("useRunwayQuota", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let unexpectedCalls: string[];

  beforeEach(() => {
    __resetRunwayQuotaCacheForTests();
    useDashboardStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        runway: { ...DEFAULT_SETTINGS.runway, apiUrl: "https://runway.example.com" },
      },
    });
    unexpectedCalls = [];
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/runway/quota" && method === "GET") {
        return Promise.resolve(
          jsonResponse(200, {
            configured: true,
            fetchedAt: "2026-01-01T00:00:00.000Z",
            agents: [],
          }),
        );
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

  it("makes no request at all when the feature is off", () => {
    useDashboardStore.setState({ settings: { ...DEFAULT_SETTINGS } });
    render(<Probe label="probe" />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("probe")).toHaveTextContent("no quota");
  });

  it("serves every row from ONE request", async () => {
    render(
      <>
        <Probe label="first" />
        <Probe label="second" />
      </>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("first")).toHaveTextContent("fetched 2026-01-01T00:00:00.000Z"),
    );
    expect(screen.getByTestId("second")).toHaveTextContent("fetched 2026-01-01T00:00:00.000Z");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("yields nothing when the fetch fails — never a reassuring answer", async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error("Runway is unreachable")));
    render(<Probe label="probe" />);
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("no quota"));
  });
});
