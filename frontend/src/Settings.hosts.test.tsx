// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "./Settings.js";
import type { Host } from "./api.js";
import { jsonResponse } from "./test/jsonResponse.js";
import { mockFetch } from "./test/mockFetch.js";
import { resetStore } from "./test/resetStore.js";

// Closes the gap Hermes flagged on PR #35 (issue #26, phase 4): "the
// non-trivial 409 -> cascade retry path is entirely unverified." Exercises
// Settings -> Hosts against a fake in-memory backend (not the real HTTP
// server — mirrors backend tests' own fake-server pattern, just over
// global fetch instead of node:http) rather than mocking the store, so the
// real request()/store wiring is what's under test.

describe("Settings -> Hosts", () => {
  let hostsDb: Array<Host & { hasProjects: boolean }>;
  let fetchMock: ReturnType<typeof vi.fn>;
  // Every URL/method this fake backend didn't recognize — asserted empty in
  // afterEach so an unexpected request fails the test with a clear
  // "which URL(s)" message, rather than only the promise-rejection message
  // from wherever the app happened to swallow it (Hermes review, PR #36).
  let unexpectedCalls: string[];

  beforeEach(() => {
    hostsDb = [
      {
        id: "remote-1",
        name: "home-server",
        baseUrl: "http://192.168.1.20:4000",
        isLocal: false,
        hasToken: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        health: "pending",
        lastSeenAt: null,
        lastCheckedAt: null,
        hasProjects: true,
      },
    ];

    ({ fetchMock, unexpectedCalls } = mockFetch({
      "GET /api/hosts": () => jsonResponse(200, hostsDb),
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/sessions": () => jsonResponse(200, []),
      "DELETE /api/hosts/:id": ({ params, query }) => {
        const host = hostsDb.find((h) => h.id === params.id);
        if (!host) return jsonResponse(404, { message: "not found" });
        if (host.hasProjects && query.get("cascade") !== "true") {
          return jsonResponse(409, { message: "host still has 2 project(s) — pass ?cascade=true" });
        }
        hostsDb = hostsDb.filter((h) => h.id !== params.id);
        return jsonResponse(204);
      },
      "POST /api/hosts/:id/ping": () => jsonResponse(200, { online: false }),
      "GET /api/hosts/:id/config": ({ params }) =>
        jsonResponse(200, {
          role: params.id === "local" ? "primary" : "agent",
          version: "0.2.20",
          projectsRoots: params.id === "local" ? ["/home/me/projects"] : ["/remote/projects"],
          sessionsDir:
            params.id === "local" ? "/home/me/.local/state/mullion/sessions" : "/remote/sessions",
          crsConfigDir: params.id === "local" ? "/home/me/.config/crs" : "/remote/.config/crs",
          browserEnabled: false,
        }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    // The store is a module-level singleton — reset it so a previous
    // test's DELETE doesn't leak into this one.
    resetStore({ hosts: [] });
  });

  afterEach(() => {
    expect(unexpectedCalls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("prompts to cascade-delete when the host still owns projects, then removes it on confirm", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="hosts" />);

    const row = await screen.findByTestId("host-row-remote-1");

    await user.click(within(row).getByTitle("More…"));
    // The menu portals to document.body, outside `row` — query the whole
    // screen for it instead.
    await user.click(await screen.findByText("Delete host"));
    await user.click(await screen.findByText("Click again to delete"));

    expect(await screen.findByText(/host still has 2 project\(s\)/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete host and its projects" }));

    await waitFor(() => expect(screen.queryByTestId("host-row-remote-1")).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/hosts/remote-1?cascade=true",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("deletes outright when the host has no projects, without prompting", async () => {
    hostsDb[0].hasProjects = false;
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="hosts" />);

    const row = await screen.findByTestId("host-row-remote-1");

    await user.click(within(row).getByTitle("More…"));
    await user.click(await screen.findByText("Delete host"));
    await user.click(await screen.findByText("Click again to delete"));

    await waitFor(() => expect(screen.queryByTestId("host-row-remote-1")).not.toBeInTheDocument());
    expect(screen.queryByText(/pass \?cascade=true/)).not.toBeInTheDocument();
  });

  // Issue #247 / roadmap 7.4.
  it("shows this machine's own config when its Config button is clicked", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="hosts" />);

    await user.click(await screen.findByText("Config"));

    expect(await screen.findByText("This machine — config")).toBeInTheDocument();
    expect(await screen.findByText("primary")).toBeInTheDocument();
    expect(await screen.findByText("/home/me/projects")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/hosts/local/config",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("shows a remote host's config via its kebab menu's View config item", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="hosts" />);

    const row = await screen.findByTestId("host-row-remote-1");
    await user.click(within(row).getByTitle("More…"));
    await user.click(await screen.findByText("View config"));

    expect(await screen.findByText("home-server — config")).toBeInTheDocument();
    expect(await screen.findByText("agent")).toBeInTheDocument();
    expect(await screen.findByText("/remote/projects")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/hosts/remote-1/config",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });
});
