// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "./Settings.js";
import { useDashboardStore } from "./store.js";
import type { Host } from "./api.js";

// Closes the gap Hermes flagged on PR #35 (issue #26, phase 4): "the
// non-trivial 409 -> cascade retry path is entirely unverified." Exercises
// Settings -> Hosts against a fake in-memory backend (not the real HTTP
// server — mirrors backend tests' own fake-server pattern, just over
// global fetch instead of node:http) rather than mocking the store, so the
// real request()/store wiring is what's under test.

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Settings -> Hosts", () => {
  let hostsDb: Array<Host & { hasProjects: boolean }>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    hostsDb = [
      {
        id: "remote-1",
        name: "home-server",
        baseUrl: "http://192.168.1.20:4000",
        isLocal: false,
        hasToken: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        hasProjects: true,
      },
    ];

    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "/api/hosts" && method === "GET") {
        return Promise.resolve(jsonResponse(200, hostsDb));
      }
      if (url === "/api/projects" && method === "GET") {
        return Promise.resolve(jsonResponse(200, []));
      }
      if (url === "/api/sessions" && method === "GET") {
        return Promise.resolve(jsonResponse(200, []));
      }
      const deleteMatch = url.match(/^\/api\/hosts\/([^/?]+)(\?cascade=true)?$/);
      if (deleteMatch && method === "DELETE") {
        const [, id, cascade] = deleteMatch;
        const host = hostsDb.find((h) => h.id === id);
        if (!host) return Promise.resolve(jsonResponse(404, { message: "not found" }));
        if (host.hasProjects && !cascade) {
          return Promise.resolve(
            jsonResponse(409, { message: "host still has 2 project(s) — pass ?cascade=true" }),
          );
        }
        hostsDb = hostsDb.filter((h) => h.id !== id);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      const pingMatch = url.match(/^\/api\/hosts\/([^/]+)\/ping$/);
      if (pingMatch && method === "POST") {
        return Promise.resolve(jsonResponse(200, { online: false }));
      }

      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    // The store is a module-level singleton — reset the slice this test
    // touches so a previous test's DELETE doesn't leak into this one.
    useDashboardStore.setState({ hosts: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prompts to cascade-delete when the host still owns projects, then removes it on confirm", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="hosts" />);

    const hostRow = await screen.findByText("home-server");
    const row = hostRow.closest(".settings-list-row");
    if (!row) throw new Error("expected a .settings-list-row ancestor");

    await user.click(within(row as HTMLElement).getByTitle("More…"));
    // The menu portals to document.body, outside `row` — query the whole
    // screen for it instead.
    await user.click(await screen.findByText("Delete host"));
    await user.click(await screen.findByText("Click again to delete"));

    expect(await screen.findByText(/host still has 2 project\(s\)/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete host and its projects" }));

    await waitFor(() => expect(screen.queryByText("home-server")).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/hosts/remote-1?cascade=true",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("deletes outright when the host has no projects, without prompting", async () => {
    hostsDb[0].hasProjects = false;
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="hosts" />);

    const hostRow = await screen.findByText("home-server");
    const row = hostRow.closest(".settings-list-row");
    if (!row) throw new Error("expected a .settings-list-row ancestor");

    await user.click(within(row as HTMLElement).getByTitle("More…"));
    await user.click(await screen.findByText("Delete host"));
    await user.click(await screen.findByText("Click again to delete"));

    await waitFor(() => expect(screen.queryByText("home-server")).not.toBeInTheDocument());
    expect(screen.queryByText(/pass \?cascade=true/)).not.toBeInTheDocument();
  });
});
